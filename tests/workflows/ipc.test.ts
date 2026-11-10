import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { S1Deps } from '../../src/main/s1/deps'
import { WORKFLOW_CHANNELS } from '../../src/main/workflows/api'
import { registerWorkflowsIpc } from '../../src/main/workflows/ipc'
import { PATTERNS_JSON, runtimeCopy, tempDir } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

type Handler = (e: unknown, raw?: unknown) => Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }>

function setup(opts: { ossTool?: S1Deps['ossTool'] } = {}) {
  const rt = runtimeCopy()
  const store = tempDir('ipc-store')
  const out = tempDir('ipc-out')
  cleanups.push(rt.cleanup, store.cleanup, out.cleanup)
  const calls: string[] = []
  const dialog = { save: path.join(out.dir, 'export.json') as string | null, open: null as string | null }
  const deps: S1Deps = {
    storeRoot: store.dir,
    runtimeRoot: () => rt.root,
    persomeBin: () => null,
    runtime: () => {
      throw new Error('REST not used by workflows')
    },
    ossTool:
      opts.ossTool ??
      (async (name) => {
        calls.push(name)
        if (name !== 'behavior_patterns') throw new Error(`unexpected tool ${name}`)
        return PATTERNS_JSON
      }),
    homeDir: () => out.dir,
    saveDialog: async () => dialog.save,
    openDialog: async () => dialog.open
  }
  const handlers = new Map<string, Handler>()
  registerWorkflowsIpc({ handle: (ch: string, fn: any) => void handlers.set(ch, fn) } as never, deps)
  const call = (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw)
  return { call, handlers, calls, dialog, rt, store, out }
}

describe('lens:workflows:* IPC', () => {
  test('registers exactly the five channels', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(WORKFLOW_CHANNELS).sort())
  })

  test('list merges Runtime skill files with behavior_patterns playbooks (file version wins)', async () => {
    const { call, calls } = setup()
    const r = await call(WORKFLOW_CHANNELS.list)
    expect(r.ok).toBe(true)
    const ids = r.data.workflows.map((w: { id: string }) => w.id).sort()
    expect(ids).toEqual(['rt-inbox-triage', 'rt-legacy-standup', 'rt-mcp-only', 'rt-weekly-report'])
    const weekly = r.data.workflows.find((w: { id: string }) => w.id === 'rt-weekly-report')
    expect(weekly.source.type).toBe('runtime_skill_file')
    expect(weekly.steps).toHaveLength(4)
    const mcpOnly = r.data.workflows.find((w: { id: string }) => w.id === 'rt-mcp-only')
    expect(mcpOnly.source.type).toBe('runtime_behavior_patterns')
    expect(r.data.sources).toEqual({ runtimeFiles: 'ok', behaviorPatterns: 'ok', store: 0 })
    expect(calls).toEqual(['behavior_patterns'])
  })

  test('Runtime MCP down: list still works from files and reports the failure', async () => {
    const { call } = setup({
      ossTool: async () => {
        throw new Error('persome binary not found')
      }
    })
    const r = await call(WORKFLOW_CHANNELS.list)
    expect(r.ok).toBe(true)
    expect(r.data.workflows).toHaveLength(3)
    expect(r.data.sources.behaviorPatterns).toBe('persome binary not found')
  })

  test('zod validation: bad payloads are rejected before anything runs', async () => {
    const { call } = setup()
    expect((await call(WORKFLOW_CHANNELS.list, { x: 1 })).ok).toBe(false)
    expect((await call(WORKFLOW_CHANNELS.get, { id: '../../etc' })).error?.code).toBe('schema')
    expect((await call(WORKFLOW_CHANNELS.save, { id: 'rt-weekly-report', baseVersion: 1, edit: { title: 'x' } })).ok).toBe(false)
    expect((await call(WORKFLOW_CHANNELS.export, { ids: [] })).ok).toBe(false)
  })

  test('get → save edit → get shows v2 user_edited with v1 observed kept; stale save is refused', async () => {
    const { call, store } = setup()
    const d = (await call(WORKFLOW_CHANNELS.get, { id: 'rt-weekly-report' })).data
    expect(d.versions).toEqual([])
    const w = d.workflow
    const edit = { title: w.title, goal: w.goal, context: w.context, inputs: w.inputs, tools: w.tools, steps: [...w.steps, { order: 5, text: 'Archive the report' }], artifacts: w.artifacts, rules: w.rules, problems: w.problems, tags: w.tags }
    const saved = await call(WORKFLOW_CHANNELS.save, { id: w.id, baseVersion: 1, edit })
    expect(saved.ok).toBe(true)
    expect(saved.data.workflow.version).toBe(2)
    const d2 = (await call(WORKFLOW_CHANNELS.get, { id: w.id })).data
    expect(d2.versions.map((v: { version: number; provenance: string }) => [v.version, v.provenance])).toEqual([
      [1, 'observed'],
      [2, 'user_edited']
    ])
    expect(d2.observed.steps).toHaveLength(4)
    expect(d2.runtimeChanged).toBe(false)
    expect(fs.existsSync(path.join(store.dir, 'workflows', w.id, 'v000001.json'))).toBe(true)
    const stale = await call(WORKFLOW_CHANNELS.save, { id: w.id, baseVersion: 1, edit })
    expect(stale.ok).toBe(false)
    expect(stale.error?.message).toMatch(/version 2/)
  })

  test('runtimeChanged when the Runtime file gains evidence after the edit', async () => {
    const { call, rt } = setup()
    const w = (await call(WORKFLOW_CHANNELS.get, { id: 'rt-inbox-triage' })).data.workflow
    await call(WORKFLOW_CHANNELS.save, { id: w.id, baseVersion: 1, edit: { title: 'Inbox triage', goal: w.goal, context: '', inputs: [], tools: [], steps: [], artifacts: [], rules: [], problems: [], tags: w.tags } })
    fs.appendFileSync(path.join(rt.root, 'memory/skills/skill-inbox-triage.md'), '\n## [2026-10-28T09:00] {id: it-0002} #pattern #observed\nstage: observed\n\n**Pattern**: same\n')
    expect((await call(WORKFLOW_CHANNELS.get, { id: w.id })).data.runtimeChanged).toBe(true)
  })

  test('export via save dialog writes an owner-only file; cancel writes nothing; import via open dialog', async () => {
    const a = setup()
    fs.chmodSync(a.out.dir, 0o755)
    const r = await a.call(WORKFLOW_CHANNELS.export, { ids: ['rt-weekly-report', 'rt-mcp-only'] })
    expect(r.data).toEqual({ path: a.dialog.save, count: 2 })
    expect(fs.statSync(a.dialog.save!).mode & 0o777).toBe(0o600)
    // The user's chosen folder keeps its permissions.
    expect(fs.statSync(a.out.dir).mode & 0o777).toBe(0o755)
    a.dialog.save = null
    expect((await a.call(WORKFLOW_CHANNELS.export, { ids: ['rt-weekly-report'] })).data).toEqual({ path: null, count: 0 })
    expect((await a.call(WORKFLOW_CHANNELS.export, { ids: ['rt-missing'] })).ok).toBe(false)

    // Same machine: re-importing observed content is a duplicate.
    a.dialog.open = path.join(a.out.dir, 'export.json')
    expect((await a.call(WORKFLOW_CHANNELS.import)).data).toMatchObject({ imported: 0, duplicates: 2 })

    // Another Lens (empty runtime): both import as provenance imported.
    const b = setup()
    fs.rmSync(path.join(b.rt.root, 'memory'), { recursive: true })
    b.dialog.open = a.dialog.open
    const imp = await b.call(WORKFLOW_CHANNELS.import)
    expect(imp.data).toMatchObject({ file: 'export.json', imported: 1, duplicates: 1 })
    // rt-mcp-only is also served by b's behavior_patterns fake with identical content → duplicate.
    // b's behavior_patterns also has a *different* rt-weekly-report → the import gets imp-<hash> (never a foreign id), the observed one is untouched.
    const renamed = imp.data.items.find((i: { outcome: string }) => i.outcome === 'imported')
    expect(renamed.id).toMatch(/^imp-[0-9a-f]{12}$/)
    expect(renamed.detail).toBe('rt-weekly-report')
    const list = (await b.call(WORKFLOW_CHANNELS.list)).data.workflows
    expect(list.find((w: { id: string }) => w.id === renamed.id).provenance.kind).toBe('imported')
    expect(list.find((w: { id: string }) => w.id === 'rt-weekly-report').provenance.kind).toBe('observed')
    expect((await b.call(WORKFLOW_CHANNELS.list)).data.sources.store).toBe(1)

    b.dialog.open = null
    expect((await b.call(WORKFLOW_CHANNELS.import)).data).toBeNull()
    const bad = path.join(b.out.dir, 'bad.json')
    fs.writeFileSync(bad, JSON.stringify({ format: 'something-else' }))
    b.dialog.open = bad
    const rej = await b.call(WORKFLOW_CHANNELS.import)
    expect(rej.ok).toBe(false)
    expect(rej.error?.message).toMatch(/Not a valid Workflow export file/)
  })
})
