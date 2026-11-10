// S1-FULL C15: Workflow automatic content.
// Upstream mapping (Runtime R8 behavior_patterns → observed Workflow), session context build
// (redaction / caps / no paths or tokens), preview → send of exactly the selected items through the
// cloud client, reply parse + validation (fence, cite filtering, malformed ⇒ nothing saved), draft
// edit + save with provenance `cloud_extracted` and edit markers, old files still load, cloud OFF /
// signed out ⇒ zero fetch, and no fetch outside src/main/cloud/client.ts.
import fs from 'node:fs'
import { redactForShare } from '../../src/main/skillshare/package'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { CHAT_LIMITS } from '../../src/main/cloud/chat-api'
import { WORKFLOW_CHANNELS } from '../../src/main/workflows/api'
import { draftEditedFields, parseCloudReply, type CloudDraft } from '../../src/main/workflows/cloud-draft'
import { createCloudExtractService, WORKFLOW_EXTRACT_TASK } from '../../src/main/workflows/cloud-extract'
import { registerWorkflowsIpc } from '../../src/main/workflows/ipc'
import { CONTENT_KEYS, WorkflowSchema, provenance, source, emptyWorkflow, type Workflow, type WorkflowEdit } from '../../src/main/workflows/schema'
import { createWorkflowService, parsePatternSkills } from '../../src/main/workflows/service'
import { createSessionSource, sessionCandidates } from '../../src/main/workflows/sessions'
import { workflowFromPatternSkill } from '../../src/main/workflows/parse'
import { addItem, cloudGate, editedLabels, moveItem, removeItem, updateItem } from '../../src/renderer/src/components/workflows/cloudExtractView'
import { provenanceBadge, provenanceLine } from '../../src/renderer/src/components/workflows/viewModel'
import type { S1Deps } from '../../src/main/s1/deps'
import { fakeBox, fakeIpc, LOOPBACK, startFakeServer, testIdentity, type FakeServer } from '../cloud/helpers'
import { guardedTemp, installExtractRoute, KNOWN_SECRET, writeSession, type ReplyMode } from './cloud-helpers'

// Most assertions below check the Chinese UI strings; English is covered by the `English locale` block.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const cleanups: Array<() => void> = []
const editOf = (w: Workflow): WorkflowEdit => Object.fromEntries(CONTENT_KEYS.map((k) => [k, w[k]])) as WorkflowEdit
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const c of cleanups.splice(0)) c()
})

function temp(): string {
  const t = guardedTemp()
  cleanups.push(t.cleanup)
  return t.dir
}

const SECRET_TURNS = [
  { user: `Set up the release checklist for /Users/alice/projects/acme/app, token ${KNOWN_SECRET}`, assistant: 'I will draft RELEASE.md and run the tests first.', write: '/Users/alice/projects/acme/app/RELEASE.md' },
  { user: 'Contact bob@example.com if the build fails; key sk-ant-abcdefghijklmnop1234', assistant: 'Tests pass. Tagging v1.2.0 next.' },
  { user: 'Now publish the release notes', assistant: 'Published notes to the changelog.', write: '/Users/alice/projects/acme/app/CHANGELOG.md' },
  { user: 'Post a summary in the team channel', assistant: 'Posted.' }
]

// ---------------------------------------------------------------------------------------------
// 1. Upstream path
// ---------------------------------------------------------------------------------------------

describe('C15 upstream: Runtime pattern_detector (R8 behavior_patterns) → Workflow', () => {
  it('maps real structured steps / artifacts / rules / problems with provenance observed (runtime) and evidence', () => {
    const json = fs.readFileSync(path.join(__dirname, 'fixtures', 'runtime-r8', 'behavior_patterns.json'), 'utf8')
    const [skill] = parsePatternSkills(json)
    const w = workflowFromPatternSkill(skill)
    expect(w.provenance.kind).toBe('observed')
    expect(w.source.type).toBe('runtime_behavior_patterns')
    expect(w.steps.length).toBeGreaterThanOrEqual(3)
    expect(w.steps[0].text).toContain('Linear triage view')
    expect(w.steps.every((s) => (s.evidence ?? []).length > 0)).toBe(true)
    expect(w.artifacts.length).toBeGreaterThan(0)
    expect(w.rules.length).toBeGreaterThan(0)
    expect(w.problems.length).toBeGreaterThan(0)
    expect(w.provenance.extraction).toBeUndefined()
  })

  it('an empty upstream (live state today: skills = []) yields no Workflow — nothing is invented', () => {
    expect(parsePatternSkills(JSON.stringify({ root: null, faces: [], skills: [], rendered: '' }))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// 2. Context build from a fixture session
// ---------------------------------------------------------------------------------------------

describe('C15 sessions → context items', () => {
  it('lists the session with an opaque key and a redacted title (no path, no token)', () => {
    const root = temp()
    writeSession(root, SECRET_TURNS)
    const src = createSessionSource({ claudeRoot: root, codexRoot: null, knownSecrets: () => [KNOWN_SECRET] })
    const list = src.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ agent: 'claude-code', userTurns: 4 })
    expect(list[0].key).toMatch(/^[0-9a-f]{16}$/)
    const blob = JSON.stringify(list)
    expect(blob).not.toContain('/Users/')
    expect(blob).not.toContain(KNOWN_SECRET)
    expect(blob).not.toContain(root)
  })

  it('one recent item per turn; redacted (token, key, email, abs paths); file names only; caps hold', async () => {
    const root = temp()
    writeSession(root, SECRET_TURNS)
    const svc = createCloudExtractService({
      workflows: { saveCloudExtracted: vi.fn() },
      cloud: null,
      sessions: createSessionSource({ claudeRoot: root, codexRoot: null }),
      sources: { claudeCode: true, codex: false },
      knownSecrets: () => [KNOWN_SECRET]
    })
    const key = svc.sessions().sessions[0].key
    const p = svc.preview(key)
    expect(p.items).toHaveLength(4)
    expect(p.items.every((i) => i.kind === 'recent')).toBe(true)
    expect(p.items.map((i) => i.id)).toEqual(['ctx-1', 'ctx-2', 'ctx-3', 'ctx-4'])
    const blob = JSON.stringify(p)
    for (const bad of [KNOWN_SECRET, 'sk-ant-abcdefghijklmnop1234', 'bob@example.com', '/Users/', 'alice/projects', root]) expect(blob).not.toContain(bad)
    expect(p.items[0].text).toContain('RELEASE.md')
    expect(p.items[0].ref).toMatch(/^claude-code:[0-9a-f]{16}#1$/)
  })

  it('a long session: ≤ 8000 chars per item, ≤ 60000 total, merged turns keep order, honest warnings', () => {
    const big = Array.from({ length: 150 }, (_, i) => ({ user: `step ${i} ${'x'.repeat(180)}`, assistant: `did ${i} ${'y'.repeat(180)}` }))
    const summary = { key: '0123456789abcdef', agent: 'claude-code' as const, title: 't', startedAt: null, endedAt: null, userTurns: 150, events: 300 }
    const events = big.flatMap((t, i) => [
      { agent: 'claude-code' as const, sessionId: 's', ts: i * 2, cwd: null, project: null, role: 'user' as const, toolNames: [], filesWritten: [], filesRead: [], signals: [], summary: t.user, sidechain: false, source: { file: 'f', line: i } },
      { agent: 'claude-code' as const, sessionId: 's', ts: i * 2 + 1, cwd: null, project: null, role: 'assistant' as const, toolNames: [], filesWritten: [], filesRead: [], signals: [], summary: t.assistant, sidechain: false, source: { file: 'f', line: i } }
    ])
    const cands = sessionCandidates(summary, events)
    expect(cands.length).toBeLessThanOrEqual(60)
    expect(cands[0].text).toContain('step 0')
    expect(cands[1].title).toContain('第 4–6 轮')
    // Caps through the same builder the service uses.
    const root = temp()
    writeSession(root, Array.from({ length: 70 }, (_, i) => ({ user: `turn ${i} ` + 'z'.repeat(190), assistant: 'ok '.repeat(60) })))
    const svc = createCloudExtractService({ workflows: { saveCloudExtracted: vi.fn() }, cloud: null, sessions: createSessionSource({ claudeRoot: root, codexRoot: null }), sources: { claudeCode: true, codex: false } })
    const p = svc.preview(svc.sessions().sessions[0].key)
    expect(p.totalChars).toBeLessThanOrEqual(CHAT_LIMITS.maxTotalChars)
    for (const i of p.items) expect(i.text.length).toBeLessThanOrEqual(CHAT_LIMITS.maxItemChars)
    expect(p.items.reduce((n, i) => n + i.chars, 0)).toBe(p.totalChars)
  })

  it('unknown session key → not_found; nothing parked', () => {
    const svc = createCloudExtractService({ workflows: { saveCloudExtracted: vi.fn() }, cloud: null, sessions: createSessionSource({ claudeRoot: temp(), codexRoot: null }), sources: { claudeCode: true, codex: false } })
    expect(() => svc.preview('0123456789abcdef')).toThrow(/找不到这个会话/)
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Reply parsing (pure)
// ---------------------------------------------------------------------------------------------

describe('C15 reply parse + validate', () => {
  const sent = ['ctx-1', 'ctx-2']

  it('fenced block → draft; surrounding prose tolerated only around the fence', () => {
    const r = parseCloudReply('好的：\n```json\n{"title":"T","steps":[{"title":"A","detail":"d","cites":["ctx-1"]}]}\n```\n', sent)
    expect(r).toEqual({ ok: true, draft: { title: 'T', steps: [{ title: 'A', detail: 'd', cites: ['ctx-1'] }], artifacts: [], rules: [], problems: [] }, droppedItems: 0, strippedCites: 0 })
  })

  it('cites outside the sent ids are stripped; items with no valid cite are dropped', () => {
    const r = parseCloudReply(
      '```json\n' +
        JSON.stringify({
          title: 'T',
          steps: [
            { title: 'keep', cites: ['ctx-2', 'ctx-9'] },
            { title: 'invented', cites: ['ctx-9'] },
            { title: 'uncited', cites: [] }
          ],
          rules: [{ text: 'r', cites: ['ctx-50'] }]
        }) +
        '\n```',
      sent
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.draft.steps).toEqual([{ title: 'keep', detail: '', cites: ['ctx-2'] }])
    expect(r.draft.rules).toEqual([])
    expect(r.droppedItems).toBe(3)
    expect(r.strippedCites).toBe(3)
  })

  it('malformed / off-schema / no fence / no surviving step → rejected whole', () => {
    expect(parseCloudReply('just prose', sent)).toMatchObject({ ok: false })
    expect(parseCloudReply('```json\n{"steps": [\n```', sent)).toMatchObject({ ok: false })
    expect(parseCloudReply('```json\n{"steps": "x"}\n```', sent)).toMatchObject({ ok: false })
    expect(parseCloudReply('```json\n{"steps": [{"title": "a", "cites": ["ctx-7"]}]}\n```', sent)).toMatchObject({ ok: false })
  })
})

// ---------------------------------------------------------------------------------------------
// 4. Preview → send → draft → edit → save, against a fake cloud server
// ---------------------------------------------------------------------------------------------

describe('C15 preview → send → draft → save (fake cloud server)', () => {
  let server: FakeServer
  let mode: ReplyMode
  let bodies: Array<Record<string, unknown>>
  let store: string
  let cloud: CloudService
  let sessionsRoot: string

  beforeEach(async () => {
    server = await startFakeServer()
    mode = 'mock'
    bodies = installExtractRoute(server, () => mode)
    const t = temp()
    store = path.join(t, 'store')
    sessionsRoot = path.join(t, 'claude')
    writeSession(sessionsRoot, SECRET_TURNS)
    writeCloudConfig(cloudPaths(store).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
    const id = testIdentity()
    cloud = createCloudService({ storeRoot: store, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true })
    await cloud.signIn()
  })
  afterEach(async () => {
    await server.close()
  })

  function make() {
    const workflows = createWorkflowService({ storeRoot: store, runtimeRoot: () => path.join(store, 'no-runtime'), now: () => new Date('2026-11-06T09:00:00Z') })
    const svc = createCloudExtractService({
      workflows,
      cloud,
      sessions: createSessionSource({ claudeRoot: sessionsRoot, codexRoot: null }),
      sources: { claudeCode: true, codex: false },
      knownSecrets: () => [KNOWN_SECRET],
      now: () => new Date('2026-11-06T09:00:00Z')
    })
    return { workflows, svc }
  }

  it('sends exactly the selected parked items with task workflow_extract; preview is single use', async () => {
    const { svc } = make()
    const p = svc.preview(svc.sessions().sessions[0].key, '发版流程')
    const pick = [p.items[0].id, p.items[2].id]
    const r = await svc.run(p.previewId, pick)

    expect(bodies).toHaveLength(1)
    const body = bodies[0] as { messages: Array<{ role: string; content: string }>; context: { items: unknown[] }; task: string }
    expect(Object.keys(body).sort()).toEqual(['context', 'messages', 'task'])
    expect(body.task).toBe(WORKFLOW_EXTRACT_TASK)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toContain('发版流程')
    expect(body.context.items).toEqual([p.items[0], p.items[2]].map(({ id, kind, title, text, ref }) => (ref === null ? { id, kind, title, text } : { id, kind, title, text, ref })))
    const wire = JSON.stringify(bodies)
    for (const bad of [KNOWN_SECRET, '/Users/', 'bob@example.com']) expect(wire).not.toContain(bad)

    // Mock: one step per sent item (≤3), cites = that item.
    expect(r.draft.steps.map((s) => s.cites)).toEqual([[pick[0]], [pick[1]]])
    expect(r.model).toBe('mock-extract')
    expect(r.sent.map((i) => i.id)).toEqual(pick)
    await expect(svc.run(p.previewId, pick)).rejects.toThrow(/预览已失效/)
    // Nothing saved until the user confirms.
    expect(fs.existsSync(path.join(store, 'workflows'))).toBe(false)
  })

  it('refuses ids that are not in the preview (renderer cannot add context)', async () => {
    const { svc } = make()
    const p = svc.preview(svc.sessions().sessions[0].key)
    await expect(svc.run(p.previewId, ['ctx-1', 'ctx-42'])).rejects.toThrow(/预览里没有 ctx-42/)
    expect(bodies).toHaveLength(0)
  })

  it('edit (reorder, edit, delete, add) + save → cloud_extracted with session ref, model, cited snapshots, edit markers', async () => {
    const { workflows, svc } = make()
    const p = svc.preview(svc.sessions().sessions[0].key)
    const r = await svc.run(p.previewId, ['ctx-1', 'ctx-2', 'ctx-3', 'ctx-4'])
    expect(r.draft.steps).toHaveLength(3)
    let d: CloudDraft = moveItem(r.draft, 'steps', 2, -1)
    d = updateItem(d, 'steps', 0, { title: '准备发版清单' })
    d = removeItem(d, 'steps', 2)
    d = addItem(d, 'rules')
    d = updateItem(d, 'rules', 0, { text: '先跑测试再打 tag' })
    expect(editedLabels(r.draft, d)).toEqual(['步骤', '规则'])

    const saved = await svc.save(r.extractionId, d)
    expect(saved.item.outcome).toBe('imported')
    expect(saved.item.id).toMatch(/^ext-[0-9a-f]{12}$/)
    expect(saved.editedFields).toEqual(['steps', 'rules'])
    const w = workflows.store.latest(saved.item.id)!
    expect(w.steps.map((s) => s.text)).toEqual([`准备发版清单：${r.draft.steps[0].detail}`, `${r.draft.steps[2].title}：${r.draft.steps[2].detail}`])
    expect(w.rules).toEqual(['先跑测试再打 tag'])
    expect(w.goal).toBe('')
    expect(w.evidence).toEqual([])
    const e = w.provenance.extraction!
    expect(e).toMatchObject({ source: 'cloud_extracted', agent: 'Navalia 云端', model: 'mock-extract', sent_ids: ['ctx-1', 'ctx-2', 'ctx-3', 'ctx-4'], edited_fields: ['steps', 'rules'] })
    expect(e.session).toMatchObject({ agent: 'claude-code', key: p.session.key })
    expect(e.cited_items!.map((i) => i.id)).toEqual(['ctx-1', 'ctx-3'])
    expect(e.cited_items![0].text).toBe(p.items[0].text)
    expect(e.item_cites).toEqual({ steps: [['ctx-1'], ['ctx-3']], artifacts: [], rules: [[]], problems: [] })
    expect(provenanceBadge(w)).toEqual({ label: '云端抽取', edited: true })
    // Lead (Phase 4 gate): a shared .navaliaskill keeps the provenance but never the session snapshot / cited items.
    const shared = redactForShare(w).workflow.provenance.extraction!
    expect(shared.source).toBe('cloud_extracted')
    expect(shared).not.toHaveProperty('cited_items')
    expect(shared).not.toHaveProperty('session')
    expect(provenanceLine(w)).toContain('云端抽取（模型 mock-extract')
    // File permissions + the draft is single use.
    const file = path.join(store, 'workflows', w.id, 'v000001.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    await expect(svc.save(r.extractionId, d)).rejects.toThrow(/草稿已失效/)

    // A later manual edit keeps the record, unions markers, and drops the cite alignment of the edited field.
    const v2 = workflows.store.saveEdit(w.id, 1, { ...editOf(w), problems: [{ problem: '构建失败', solution: '重跑' }] }, null)
    const e2 = v2.workflow.provenance.extraction!
    expect(v2.workflow.provenance.kind).toBe('user_edited')
    expect(v2.workflow.provenance.original_kind).toBe('imported')
    expect(e2.edited_fields).toEqual(['steps', 'rules', 'problems'])
    expect(e2.item_cites!.steps).toEqual([['ctx-1'], ['ctx-3']])
    expect(e2.cited_items).toEqual(e.cited_items)
  })

  it('save rejects a cite that was not sent, and an empty step list', async () => {
    const { svc } = make()
    const p = svc.preview(svc.sessions().sessions[0].key)
    const r = await svc.run(p.previewId, ['ctx-1', 'ctx-2'])
    await expect(svc.save(r.extractionId, updateItem(r.draft, 'steps', 0, { cites: ['ctx-4'] }))).rejects.toThrow(/ctx-4 不在已发送/)
    await expect(svc.save(r.extractionId, { ...r.draft, steps: [] })).rejects.toThrow(/至少需要一个步骤/)
    expect(fs.existsSync(path.join(store, 'workflows'))).toBe(false)
    expect(draftEditedFields(r.draft, r.draft)).toEqual([])
  })

  it('foreign cites are filtered: invented items never reach the draft', async () => {
    const { svc } = make()
    mode = 'foreign_cites'
    const p = svc.preview(svc.sessions().sessions[0].key)
    const r = await svc.run(p.previewId, ['ctx-1', 'ctx-2'])
    expect(r.draft.steps).toEqual([{ title: '有效步骤', detail: '', cites: ['ctx-1'] }])
    expect(r.draft.artifacts.map((a) => a.name)).toEqual(['report.md'])
    expect(r.droppedItems).toBe(3)
    expect(r.strippedCites).toBe(3)
  })

  it.each([
    ['no_fence', /代码块/],
    ['bad_json', /无法解析/],
    ['bad_schema', /不符合抽取格式/],
    ['length', /截断/],
    ['error_event', /没有生成草稿/]
  ] as const)('%s → honest error, no draft, nothing saved', async (m, re) => {
    const { svc } = make()
    mode = m
    const p = svc.preview(svc.sessions().sessions[0].key)
    await expect(svc.run(p.previewId, ['ctx-1'])).rejects.toThrow(re)
    expect(fs.existsSync(path.join(store, 'workflows'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// 5. Cloud OFF / signed out / not wired ⇒ zero fetch; upstream still works
// ---------------------------------------------------------------------------------------------

describe('C15 cloud disabled ⇒ zero fetch', () => {
  async function svcWith(cfg: { enabled: boolean; signIn: boolean } | null) {
    const t = temp()
    const store = path.join(t, 'store')
    const root = path.join(t, 'claude')
    writeSession(root, SECRET_TURNS)
    const spy = vi.fn(async () => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', spy)
    let cloud: CloudService | null = null
    if (cfg) {
      writeCloudConfig(cloudPaths(store).configFile, { enabled: cfg.enabled, baseUrl: 'http://127.0.0.1:9' }, LOOPBACK)
      const id = testIdentity()
      cloud = createCloudService({ storeRoot: store, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true, fetch: spy })
    }
    const svc = createCloudExtractService({
      workflows: { saveCloudExtracted: vi.fn() },
      cloud,
      sessions: createSessionSource({ claudeRoot: root, codexRoot: null }),
      sources: { claudeCode: true, codex: false }
    })
    return { svc, spy }
  }

  it.each([
    ['not wired', null, /没有接入/],
    ['cloud OFF', { enabled: false, signIn: false }, /云端未开启/],
    ['signed out', { enabled: true, signIn: false }, /未登录/]
  ] as const)('%s: status explains, run refuses before any network call', async (_n, cfg, re) => {
    const { svc, spy } = await svcWith(cfg)
    const s = svc.status()
    expect(s.signedIn).toBe(false)
    expect(s.reason).toMatch(re)
    expect(cloudGate(s).ready).toBe(false)
    expect(cloudGate(s).message).toContain('Runtime 观察到的 Workflow 不受影响')
    const p = svc.preview(svc.sessions().sessions[0].key) // local only
    await expect(svc.run(p.previewId, ['ctx-1'])).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('the upstream catalog still works with cloud not wired (IPC list + cloudStatus)', async () => {
    const t = temp()
    const rt = path.join(t, 'runtime')
    fs.cpSync(path.join(__dirname, 'fixtures', 'runtime-r8'), rt, { recursive: true })
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const ipc = fakeIpc()
    const deps = { storeRoot: path.join(t, 'store'), runtimeRoot: () => rt } as unknown as S1Deps
    registerWorkflowsIpc(ipc as unknown as Parameters<typeof registerWorkflowsIpc>[0], deps, { sessionRoots: { claudeRoot: null, codexRoot: null } })
    const list = (await ipc.invoke(WORKFLOW_CHANNELS.list)) as { ok: boolean; data: { workflows: Array<{ steps: unknown[] }> } }
    expect(list.ok).toBe(true)
    expect(list.data.workflows.some((w) => w.steps.length > 0)).toBe(true)
    const st = (await ipc.invoke(WORKFLOW_CHANNELS.cloudStatus)) as { ok: boolean; data: { available: boolean } }
    expect(st).toMatchObject({ ok: true, data: { available: false } })
    const sessions = (await ipc.invoke(WORKFLOW_CHANNELS.cloudSessions)) as { ok: boolean; data: { sessions: unknown[]; sources: unknown } }
    expect(sessions).toEqual({ ok: true, data: { sessions: [], sources: { claudeCode: false, codex: false } } })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
// 6. IPC validation, compatibility, no fetch outside client.ts
// ---------------------------------------------------------------------------------------------

describe('C15 IPC + compatibility + egress', () => {
  it('IPC rejects renderer-supplied context text / unknown fields (strictObject)', async () => {
    const ipc = fakeIpc()
    registerWorkflowsIpc(ipc as unknown as Parameters<typeof registerWorkflowsIpc>[0], { storeRoot: temp(), runtimeRoot: () => '/nonexistent' } as unknown as S1Deps, { sessionRoots: { claudeRoot: null, codexRoot: null } })
    const run = (await ipc.invoke(WORKFLOW_CHANNELS.cloudRun, { previewId: 'a'.repeat(32), includeIds: ['ctx-1'], items: [{ text: 'injected' }] })) as { ok: boolean; error: { code: string } }
    expect(run).toMatchObject({ ok: false, error: { code: 'schema' } })
    const bad = (await ipc.invoke(WORKFLOW_CHANNELS.cloudRun, { previewId: 'a'.repeat(32), includeIds: ['../x'] })) as { ok: boolean }
    expect(bad.ok).toBe(false)
    const save = (await ipc.invoke(WORKFLOW_CHANNELS.cloudSave, { extractionId: 'b'.repeat(32), draft: { title: '', steps: [], artifacts: [], rules: [], problems: [], provenance: 'observed' } })) as { ok: boolean; error: { code: string } }
    expect(save).toMatchObject({ ok: false, error: { code: 'schema' } })
    const missing = (await ipc.invoke(WORKFLOW_CHANNELS.cloudRun, { previewId: 'a'.repeat(32), includeIds: ['ctx-1'] })) as { ok: boolean; error: { code: string } }
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('old Workflow files (v1 without extraction, S2-07 external_agent extraction) still load', () => {
    const store = temp()
    const svc = createWorkflowService({ storeRoot: store, runtimeRoot: () => path.join(store, 'none') })
    const old = { ...emptyWorkflow('imp-aaaaaaaaaaaa', provenance('imported', { imported_at: '2026-10-01T00:00:00Z', from: 'a.json' }), source('import_file')), title: 'old', steps: [{ order: 1, text: 'a' }] }
    const s207 = {
      ...emptyWorkflow('ext-bbbbbbbbbbbb', provenance('user_edited', { edited_at: '2026-11-01T00:00:00Z', from: 'Claude Code' }), source('lens_store')),
      title: 's2-07',
      provenance: { ...provenance('user_edited', { edited_at: '2026-11-01T00:00:00Z', from: 'Claude Code' }), extraction: { source: 'external_agent', agent: 'Claude Code', extracted_at: '2026-11-01T00:00:00Z' } }
    }
    for (const w of [old, s207]) {
      const dir = path.join(store, 'workflows', w.id)
      fs.mkdirSync(dir, { recursive: true })
      // Written as raw JSON exactly like an older Lens did (no C15 fields).
      fs.writeFileSync(path.join(dir, 'v000001.json'), JSON.stringify(w))
      expect(WorkflowSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, 'v000001.json'), 'utf8'))).success).toBe(true)
    }
    const ids = svc.store.listLatest().map((w) => w.id)
    expect(ids).toEqual(['ext-bbbbbbbbbbbb', 'imp-aaaaaaaaaaaa'])
    const ext = svc.store.latest('ext-bbbbbbbbbbbb')!
    expect(provenanceBadge(ext).label).toBe('外部抽取')
    // An S2-07 extraction edit keeps its record unchanged (no C15 markers are added).
    const v2 = svc.store.saveEdit(ext.id, 1, { ...editOf(ext), title: 'changed' }, null)
    expect(v2.workflow.provenance.extraction).toEqual({ source: 'external_agent', agent: 'Claude Code', extracted_at: '2026-11-01T00:00:00Z' })
  })

  it('no fetch / network module in the workflows code; the only network path is src/main/cloud/client.ts', () => {
    const roots = ['src/main/workflows', 'src/renderer/src/components/workflows', 'src/preload/workflows.ts', 'src/renderer/src/pages/Playbook.tsx']
    const files: string[] = []
    const walk = (p: string): void => {
      const st = fs.statSync(p)
      if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n))
      else if (/\.(ts|tsx)$/.test(p)) files.push(p)
    }
    for (const r of roots) walk(path.resolve(r))
    expect(files.length).toBeGreaterThan(10)
    const banned = [/\bfetch\s*\(/, /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram)['"]/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bnet\.request\b/, /@anthropic-ai|openai/i]
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      for (const re of banned) expect({ f, hit: re.test(text) }).toEqual({ f, hit: false })
    }
    // The cloud extraction goes through the cloud client's stream() only.
    expect(fs.readFileSync(path.resolve('src/main/workflows/cloud-extract.ts'), 'utf8')).toMatch(/client\.stream\(/)
  })
})

describe('English locale', () => {
  beforeEach(() => setLocale('en'))
  it('the cloud gate and draft errors are English by default', () => {
    expect(cloudGate(undefined).message).toBe('Reading cloud status…')
    expect(cloudGate({ available: true, enabled: false, signedIn: false, reason: 'Cloud is off' }).message).toBe('Cloud is off. Workflows observed by Runtime are not affected.')
    expect(parseCloudReply('no fence here', ['ctx-1'])).toEqual({ ok: false, error: 'The cloud reply has no ```json code block; no draft was generated' })
  })
})
