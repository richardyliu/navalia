import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { WORKFLOW_EXPORT_FORMAT, type Workflow, type WorkflowEdit } from '../../src/main/workflows/schema'
import { contentHash, createWorkflowStore, WorkflowError } from '../../src/main/workflows/store'
import { FIXTURE_RUNTIME, tempDir } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function store() {
  const t = tempDir('store')
  cleanups.push(t.cleanup)
  let tick = 0
  return { root: t.dir, s: createWorkflowStore(t.dir, () => new Date(Date.UTC(2026, 10, 5, 8, 0, tick++))) }
}

const observed = (): Workflow => readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((w) => w.id === 'rt-weekly-report')!

function editOf(w: Workflow, patch: Partial<WorkflowEdit> = {}): WorkflowEdit {
  const { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags } = w
  return { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags, ...patch }
}

describe('workflow store: edits', () => {
  test('first edit keeps the observed original as v1 and writes v2 user_edited; owner-only perms', () => {
    const { root, s } = store()
    const o = observed()
    const r = s.saveEdit(o.id, 1, editOf(o, { rules: [...o.rules, 'send before 17:00'] }), o)
    expect(r.unchanged).toBe(false)
    expect(r.workflow.version).toBe(2)
    expect(r.workflow.provenance).toMatchObject({ kind: 'user_edited', based_on_version: 1, original_kind: 'observed', observed_at: o.provenance.observed_at })
    expect(r.workflow.evidence).toEqual(o.evidence)
    const [v1, v2] = s.versions(o.id)
    expect(v1).toEqual(o)
    expect(v2.rules.at(-1)).toBe('send before 17:00')
    const dir = path.join(root, 'workflows')
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dir, o.id)).mode & 0o777).toBe(0o700)
    for (const f of fs.readdirSync(path.join(dir, o.id))) expect(fs.statSync(path.join(dir, o.id, f)).mode & 0o777).toBe(0o600)
  })

  test('stale base version is a conflict; unchanged edit writes nothing; unknown id is not_found', () => {
    const { s } = store()
    const o = observed()
    s.saveEdit(o.id, 1, editOf(o, { title: 'renamed' }), o)
    expect(() => s.saveEdit(o.id, 1, editOf(o, { title: 'again' }), null)).toThrow(WorkflowError)
    const same = s.saveEdit(o.id, 2, editOf(s.latest(o.id)!), null)
    expect(same.unchanged).toBe(true)
    expect(s.versions(o.id)).toHaveLength(2)
    expect(() => s.saveEdit('rt-nope', 1, editOf(o), null)).toThrow(/not found/)
    const third = s.saveEdit(o.id, 2, editOf(s.latest(o.id)!, { goal: 'g3' }), null)
    expect(third.workflow.version).toBe(3)
    expect(third.workflow.provenance).toMatchObject({ based_on_version: 2, original_kind: 'observed' })
  })

  test('edits cannot smuggle evidence / provenance / id through the edit object', () => {
    const { s } = store()
    const o = observed()
    const bad = { ...editOf(o), evidence: [] } as unknown as WorkflowEdit
    // strict schema at the IPC boundary and again inside the store
    expect(() => s.saveEdit(o.id, 1, bad, o)).toThrow()
  })
})

describe('workflow store: export / import', () => {
  test('export envelope round-trips into another store as provenance imported with foreign evidence', () => {
    const a = store()
    const o = observed()
    const json = a.s.exportJson([o])
    const env = JSON.parse(json)
    expect(env.format).toBe(WORKFLOW_EXPORT_FORMAT)
    const b = store()
    const rep = b.s.importWorkflows(b.s.parseImport(json), '/some/where/team-share.json')
    expect(rep).toMatchObject({ file: 'team-share.json', imported: 1, duplicates: 0 })
    expect(b.s.latest(o.id)).toBeNull()
    const got = b.s.latest(rep.items[0].id)!
    expect(got.id).toMatch(/^imp-[0-9a-f]{12}$/)
    expect(got.provenance).toMatchObject({ kind: 'imported', from: 'team-share.json', original_id: o.id, original_version: 1, original_kind: 'observed' })
    expect(got.source.type).toBe('import_file')
    expect(got.evidence.every((e) => e.origin === 'imported')).toBe(true)
    expect(contentHash(got)).toBe(contentHash(o))
  })

  test('dedupe: same content (stored or known observed) is skipped; other content lands under imp-<hash>', () => {
    const { s } = store()
    const o = observed()
    const json = s.exportJson([o])
    // Known live observed copy with the same content → duplicate, nothing written.
    expect(s.importWorkflows(s.parseImport(json), 'x.json', [o])).toMatchObject({ imported: 0, duplicates: 1 })
    expect(s.listLatest()).toEqual([])
    expect(s.importWorkflows(s.parseImport(json), 'x.json')).toMatchObject({ imported: 1 })
    expect(s.importWorkflows(s.parseImport(json), 'x.json')).toMatchObject({ imported: 0, duplicates: 1 })
    const changed = s.exportJson([{ ...o, goal: 'a different goal' }])
    const r = s.importWorkflows(s.parseImport(changed), 'y.json')
    expect(r.items[0].outcome).toBe('imported')
    expect(r.items[0].id).toMatch(/^imp-[0-9a-f]{12}$/)
    expect(r.items[0].detail).toBe(o.id)
    expect(s.latest(o.id)).toBeNull()
    expect(s.latest(r.items[0].id)!.goal).toBe('a different goal')
  })

  test('a bare Workflow JSON is accepted; invalid files are rejected and write nothing', () => {
    const { s } = store()
    const o = observed()
    expect(s.parseImport(JSON.stringify(o))).toHaveLength(1)
    expect(() => s.parseImport('not json')).toThrow(/JSON/)
    expect(() => s.parseImport(JSON.stringify({ format: WORKFLOW_EXPORT_FORMAT, format_version: 1, exported_at: 'x', workflows: [{ ...o, id: '../escape' }] }))).toThrow(WorkflowError)
    expect(() => s.parseImport(JSON.stringify({ ...o, steps: [{ order: 0, text: '' }] }))).toThrow(WorkflowError)
    expect(() => s.parseImport(JSON.stringify({ ...o, extra: 1 }))).toThrow(WorkflowError)
    expect(() => s.parseImport('x'.repeat(3 * 1024 * 1024))).toThrow(/larger/)
    expect(s.listLatest()).toEqual([])
  })

  test('an imported id the Broker scrubber would mangle is replaced by imp-<hash>; original id kept in provenance', () => {
    const { s } = store()
    const o = observed()
    const r = s.importWorkflows([{ ...o, id: 'sk-abcdefghijklmnop' }], 'k.json')
    expect(r.items[0].id).toMatch(/^imp-[0-9a-f]{12}$/)
    expect(s.latest(r.items[0].id)!.provenance.original_id).toBe('sk-abcdefghijklmnop')
  })

  test('imported claims of provenance are not trusted: a file saying "observed" lands as imported', () => {
    const { s } = store()
    const o = observed()
    const r = s.importWorkflows([{ ...o, id: 'claimed-observed', provenance: { ...o.provenance, kind: 'observed' } }], 'z.json')
    expect(s.latest(r.items[0].id)!.provenance).toMatchObject({ kind: 'imported', original_id: 'claimed-observed', original_kind: 'observed' })
  })
})
