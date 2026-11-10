import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { toolMeta } from '../../src/main/broker/catalog'
import { TOOLS } from '../../src/main/broker/tools'
import { createWorkflowService } from '../../src/main/workflows/service'
import { WorkflowSchema } from '../../src/main/workflows/schema'
import { connectClient, fakeBackend, startBroker, textOf } from '../identity/broker-helpers'
import { runtimeCopy } from './helpers'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(opts: { withReader?: boolean } = {}) {
  const rt = runtimeCopy()
  cleanups.push(rt.cleanup)
  let svc: ReturnType<typeof createWorkflowService> | null = null
  const backend = fakeBackend(
    opts.withReader === false
      ? {}
      : {
          workflows: {
            list: () => svc!.catalogSync(),
            get: (id: string) => svc!.getSync(id)
          }
        }
  )
  const b = await startBroker(backend)
  // Same wiring as setupBrokerPlane: Lens Store root (paths.root) + Runtime root.
  svc = createWorkflowService({ storeRoot: b.paths.root, runtimeRoot: () => rt.root })
  cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }))
  cleanups.push(() => b.audit.close())
  cleanups.push(() => b.broker.stop())
  return { ...b, backend, svc, rt }
}

describe('Broker workflow tools (Navalia extensions)', () => {
  test('catalog: read-only Navalia extensions, model:search scope, labelled in tools/list', async () => {
    for (const n of ['get_workflow', 'search_workflows']) {
      expect(toolMeta(n)).toEqual({ name: n, origin: 'extension', write: false, llm: false, image: false, scopes: ['model:search'] })
      expect(TOOLS.find((t) => t.name === n)!.description.startsWith('[Navalia extension] ')).toBe(true)
    }
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const tools = (await c.listTools()).tools
    const gw = tools.find((t) => t.name === 'get_workflow')!
    expect(gw.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'search_workflows')).toBeTruthy()
  })

  test('ACCEPTANCE: a fixture skill is readable as a structured Workflow through get_workflow', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const hits = JSON.parse(textOf(await c.callTool({ name: 'search_workflows', arguments: { query: 'weekly report' } })))
    expect(hits.results[0]).toMatchObject({ id: 'rt-weekly-report', provenance: 'observed', source_type: 'runtime_skill_file', steps: 4 })
    const r = await c.callTool({ name: 'get_workflow', arguments: { id: hits.results[0].id } })
    expect(r.isError).toBeFalsy()
    const body = JSON.parse(textOf(r))
    const w = WorkflowSchema.parse(body.workflow)
    expect(w.steps.map((s) => s.text)).toEqual(['Filter closed issues in Tracker', 'Group them by milestone in Notes', 'Draft the summary', 'Mail it to the team list'])
    expect(w.problems[0].solution).toBe('re-run the filter with the reopened label')
    expect(w.evidence.map((e) => e.ref)).toContain('⟨ev-0003:event-2026-10-16.md⟩')
    expect(body.versions).toEqual([])
    // Audited like every other Broker read, with the workflow id as the item.
    const row = b.audit.list({})[0]
    expect(row).toMatchObject({ capability: 'get_workflow', outcome: 'ok', itemIds: ['rt-weekly-report'], itemCount: 1 })
    // Workflow tools never go through the Runtime MCP.
    expect(b.backend.calls).toEqual([])
  })

  test('reads the Navalia Store too: an edited version wins, provenance filter works, unknown id is an honest miss', async () => {
    const b = await setup()
    const o = b.svc.getSync('rt-inbox-triage')!.workflow
    const { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags } = o
    b.svc.store.saveEdit(o.id, 1, { title, goal, context, inputs, tools, steps: [{ order: 1, text: 'Open Mail' }], artifacts, rules, problems, tags }, o)
    const { token } = b.grants.create({ client: 'codex' })
    const c = await connectClient(b.url, token, 'codex')
    cleanups.push(() => c.close())
    const got = JSON.parse(textOf(await c.callTool({ name: 'get_workflow', arguments: { id: o.id } })))
    expect(got.workflow.version).toBe(2)
    expect(got.workflow.provenance.kind).toBe('user_edited')
    expect(got.versions.map((v: { provenance: string }) => v.provenance)).toEqual(['observed', 'user_edited'])
    const edited = JSON.parse(textOf(await c.callTool({ name: 'search_workflows', arguments: { provenance: 'user_edited' } })))
    expect(edited.results.map((h: { id: string }) => h.id)).toEqual([o.id])
    const miss = await c.callTool({ name: 'get_workflow', arguments: { id: '../../etc/passwd' } })
    expect(miss.isError).toBeFalsy()
    expect(JSON.parse(textOf(miss)).workflow).toBeNull()
  })

  test('results are PII-scrubbed like every other Broker read', async () => {
    const b = await setup()
    fs.appendFileSync(
      `${b.rt.root}/memory/skills/skill-inbox-triage.md`,
      '\n## [2026-10-29T09:00] {id: it-0009} #pattern #observed\nstage: observed\n\n**Pattern**: Mails boss@example.com from /Users/someone/notes\n'
    )
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const text = textOf(await c.callTool({ name: 'get_workflow', arguments: { id: 'rt-inbox-triage' } }))
    expect(text).not.toContain('boss@example.com')
    expect(text).not.toContain('/Users/someone')
    expect(text).toContain('[email]')
  })

  test('scoped grant without model:search is refused and audited; argument schema is enforced', async () => {
    const b = await setup()
    const scoped = b.grants.create({ client: 'codex', scopes: ['card:read'] })
    const c = await connectClient(b.url, scoped.token, 'codex')
    cleanups.push(() => c.close())
    for (const name of ['get_workflow', 'search_workflows']) {
      const r = await c.callTool({ name, arguments: name === 'get_workflow' ? { id: 'rt-weekly-report' } : {} })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/^403 scope_denied/)
    }
    expect(b.audit.list({ includeFailures: true }).map((x) => [x.capability, x.outcome])).toEqual([
      ['search_workflows', 'denied'],
      ['get_workflow', 'denied']
    ])
    const ok = b.grants.create({ client: 'claude-code', scopes: ['model:search'] })
    const c2 = await connectClient(b.url, ok.token)
    cleanups.push(() => c2.close())
    expect((await c2.callTool({ name: 'get_workflow', arguments: {} })).isError).toBe(true)
    expect((await c2.callTool({ name: 'search_workflows', arguments: { limit: 500 } })).isError).toBe(true)
    expect((await c2.callTool({ name: 'search_workflows', arguments: { provenance: 'forged' } })).isError).toBe(true)
    expect((await c2.callTool({ name: 'search_workflows', arguments: { limit: 2 } })).isError).toBeFalsy()
  })

  test('fails closed when the backend has no workflow reader', async () => {
    const b = await setup({ withReader: false })
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const r = await c.callTool({ name: 'search_workflows', arguments: {} })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/workflow store is not available/)
  })
})
