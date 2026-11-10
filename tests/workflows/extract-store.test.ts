// S2-07: saving a pasted extraction — provenance, fresh ids (never rt-*), dedupe, IPC.
import { afterEach, describe, expect, test } from 'vitest'
import type { S1Deps } from '../../src/main/s1/deps'
import { WORKFLOW_CHANNELS } from '../../src/main/workflows/api'
import { parseExtraction, type ExtractionDraft } from '../../src/main/workflows/extract'
import { registerWorkflowsIpc } from '../../src/main/workflows/ipc'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { contentHash, createWorkflowStore } from '../../src/main/workflows/store'
import { createWorkflowService, isForeignWorkflow } from '../../src/main/workflows/service'
import { redactForShare } from '../../src/main/skillshare/package'
import { provenanceBadge, provenanceLine, workflowListItems } from '../../src/renderer/src/components/workflows/viewModel'
import { FIXTURE_RUNTIME, PATTERNS_JSON, runtimeCopy, tempDir } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const NOW = new Date(Date.UTC(2026, 10, 5, 9, 0, 0))
function store() {
  const t = tempDir('extract')
  cleanups.push(t.cleanup)
  return createWorkflowStore(t.dir, () => NOW)
}
const draft = (json: unknown): ExtractionDraft => {
  const r = parseExtraction(JSON.stringify(json))
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.draft
}
const observed = () => readRuntimeSkills(FIXTURE_RUNTIME).workflows

describe('store.saveExtracted', () => {
  test('user_edited: fresh ext-* id, extraction provenance, evidence kept but marked unverified, empty fields stay empty', () => {
    const s = store()
    const item = s.saveExtracted(draft({ title: 'T', goal: 'G', evidence: [{ kind: 'quote', ref: '原话' }] }), { as: 'user_edited', agent: ' Claude Code ' }, observed())
    expect(item.outcome).toBe('imported')
    expect(item.id).toMatch(/^ext-[0-9a-f]{12}$/)
    const w = s.latest(item.id)!
    expect(w.version).toBe(1)
    expect(w.provenance).toMatchObject({
      kind: 'user_edited',
      edited_at: NOW.toISOString(),
      from: 'Claude Code',
      original_kind: null,
      extraction: { source: 'external_agent', agent: 'Claude Code', extracted_at: NOW.toISOString() }
    })
    expect(w.evidence).toEqual([{ ref: '原话', kind: 'quote', timestamp: null, origin: 'imported' }])
    expect([w.context, w.inputs, w.tools, w.steps, w.artifacts, w.rules, w.problems, w.tags, w.evidence_note]).toEqual(['', [], [], [], [], [], [], [], ''])
    expect(w.source).toMatchObject({ type: 'lens_store', path: null, entry_ids: [] })
    expect(isForeignWorkflow(w)).toBe(true)
    expect(provenanceBadge(w)).toEqual({ label: 'Externally extracted', edited: false })
    expect(provenanceLine(w)).toContain('Extracted by external agent: Claude Code (2026-11-05)')
    expect(workflowListItems({ workflows: [w], sources: { runtimeFiles: 'ok', behaviorPatterns: 'ok', store: 1 } })[0].habit).toBeNull()
  })

  test('imported: provenance imported + extraction record', () => {
    const s = store()
    const item = s.saveExtracted(draft({ goal: 'G2' }), { as: 'imported', agent: 'Codex' })
    expect(s.latest(item.id)!.provenance).toMatchObject({ kind: 'imported', imported_at: NOW.toISOString(), from: 'Codex', extraction: { agent: 'Codex' } })
  })

  test('never overwrites an observed id: pasting a full rt-* Workflow lands under ext-*; same content → duplicate of the observed id', () => {
    const s = store()
    const o = observed().find((w) => w.id === 'rt-weekly-report')!
    const dup = s.saveExtracted(draft(o), { as: 'imported', agent: 'Codex' }, observed())
    expect(dup).toMatchObject({ outcome: 'duplicate', id: 'rt-weekly-report', detail: 'rt-weekly-report' })
    expect(s.latest('rt-weekly-report')).toBeNull()
    const changed = s.saveExtracted(draft({ ...o, goal: 'changed' }), { as: 'imported', agent: 'Codex' }, observed())
    expect(changed.outcome).toBe('imported')
    expect(changed.id).toMatch(/^ext-/)
    expect(s.latest('rt-weekly-report')).toBeNull()
  })

  test('dedupe: identical content saved twice → second is a duplicate, one version on disk', () => {
    const s = store()
    const a = s.saveExtracted(draft({ goal: 'same', steps: ['a'] }), { as: 'user_edited', agent: 'Claude Code' })
    const b = s.saveExtracted(draft({ goal: 'same', steps: [{ order: 1, text: 'a' }] }), { as: 'imported', agent: 'Codex' })
    expect(b).toMatchObject({ outcome: 'duplicate', id: a.id })
    expect(s.listLatest()).toHaveLength(1)
    expect(s.versions(a.id)).toHaveLength(1)
  })

  test('an existing id is never reused: a taken ext-<hash> gets the ~suffix', () => {
    const s = store()
    const d = draft({ goal: 'collide' })
    const h = contentHash({ ...d })
    const fake = { ...observed()[0], id: `ext-${h.slice(0, 12)}`, goal: 'other content' }
    const item = s.saveExtracted(d, { as: 'imported', agent: 'Codex' }, [fake])
    expect(item.id).toBe(`ext-${h.slice(0, 12)}~${h.slice(12, 20)}`)
  })

  test('empty agent label is rejected', () => {
    expect(() => store().saveExtracted(draft({ goal: 'g' }), { as: 'imported', agent: '  ' })).toThrow(/agent/)
  })

  test('a later manual edit keeps the extraction record; sharing scrubs the agent label', () => {
    const s = store()
    const item = s.saveExtracted(draft({ goal: 'g' }), { as: 'user_edited', agent: 'Claude Code' })
    const w = s.latest(item.id)!
    const { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags } = w
    const edited = s.saveEdit(item.id, 1, { title, goal: 'g2', context, inputs, tools, steps, artifacts, rules, problems, tags }, null).workflow
    expect(edited.version).toBe(2)
    expect(edited.provenance.extraction).toEqual(w.provenance.extraction)
    const leaky = { ...w, provenance: { ...w.provenance, extraction: { ...w.provenance.extraction!, agent: 'agent of alice@example.com' } } }
    const red = redactForShare(leaky)
    expect(red.redacted).toContain('provenance.extraction.agent')
    expect(red.workflow.provenance.extraction!.agent).not.toContain('alice@example.com')
  })
})

describe('service + IPC lens:workflows:extract', () => {
  function setup() {
    const rt = runtimeCopy()
    const st = tempDir('extract-ipc')
    cleanups.push(rt.cleanup, st.cleanup)
    const deps: S1Deps = {
      storeRoot: st.dir,
      runtimeRoot: () => rt.root,
      persomeBin: () => null,
      runtime: () => {
        throw new Error('REST not used')
      },
      ossTool: async () => PATTERNS_JSON,
      homeDir: () => st.dir,
      saveDialog: async () => null,
      openDialog: async () => null
    }
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<any>>()
    registerWorkflowsIpc({ handle: (ch: string, fn: any) => void handlers.set(ch, fn) } as never, deps)
    return { call: (raw: unknown) => handlers.get(WORKFLOW_CHANNELS.extract)!({}, raw), deps, root: st.dir }
  }

  test('valid paste is saved and appears in the catalog; invalid paste returns schema error with Chinese path messages', async () => {
    const { call, deps } = setup()
    const r = await call({ text: '{"title":"周报","goal":"g","steps":["a","b"]}', as: 'user_edited', agent: 'Claude Code' })
    expect(r.ok).toBe(true)
    expect(r.data.item.id).toMatch(/^ext-/)
    expect(r.data.form).toBe('extraction')
    const svc = createWorkflowService({ storeRoot: deps.storeRoot, runtimeRoot: deps.runtimeRoot, ossTool: deps.ossTool })
    const cat = await svc.catalog()
    expect(cat.workflows.map((w) => w.id)).toContain(r.data.item.id)
    expect(cat.workflows.filter((w) => w.id.startsWith('rt-')).length).toBe(4)
    const again = await call({ text: '{"title":"周报","goal":"g","steps":["a","b"]}', as: 'imported', agent: 'Codex' })
    expect(again.data.item).toMatchObject({ outcome: 'duplicate', detail: r.data.item.id })

    const bad = await call({ text: '{"goal": 1}', as: 'imported', agent: 'Codex' })
    expect(bad.ok).toBe(false)
    expect(bad.error.code).toBe('schema')
    expect(bad.error.message).toBe('goal: wrong type, expected text')
    const syntax = await call({ text: '{goal}', as: 'imported', agent: 'Codex' })
    expect(syntax.error.message).toMatch(/JSON syntax error/)
  })

  test('IPC args are strict: unknown keys, bad provenance choice, empty agent rejected', async () => {
    const { call } = setup()
    expect((await call({ text: '{"goal":"g"}', as: 'observed', agent: 'x' })).ok).toBe(false)
    expect((await call({ text: '{"goal":"g"}', as: 'imported', agent: ' ' })).ok).toBe(false)
    expect((await call({ text: '{"goal":"g"}', as: 'imported', agent: 'x', id: 'rt-weekly-report' })).ok).toBe(false)
    expect((await call(undefined)).ok).toBe(false)
  })
})
