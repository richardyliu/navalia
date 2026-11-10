import http from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { openAuditLog, type AuditLog } from '../../src/main/broker/audit'
import { createBroker, scrubRestBody, type Broker } from '../../src/main/broker/server'
import type { BrokerBackend } from '../../src/main/broker/tools'
import { createGrantStore, type GrantStore } from '../../src/main/identity/grants'
import { ensureStore, storePaths } from '../../src/main/store/paths'
import { getAnchors, minutesTenths } from '../../src/main/het/anchors'
import type { AssessorTransport } from '../../src/main/het/assessor'
import { HET_CHANNELS, HET_DEFINITION } from '../../src/main/het/api'
import { registerHetIpc } from '../../src/main/het/ipc'
import { createHetRestRouter } from '../../src/main/het/rest'
import { createHetService, type HetService } from '../../src/main/het/service'
import type { TranscriptSource } from '../../src/main/het/sources'
import { fakeBackend } from '../identity/broker-helpers'

/**
 * OG-08 / HET-05: REST `/het/*` on the Broker loopback server. Temp roots only: transcripts come
 * from tests/fixtures/het/claude (synthetic), het.db / grants / audit.db live under os.tmpdir().
 * The only fake is the assessor TRANSPORT (boundary); gate, verdict parsing, anchors, ledger and
 * the HTTP stack are the real modules.
 */

const FIX = join(__dirname, '..', 'fixtures', 'het')
const A = 'het_0ebde115074148232698'
const B = 'het_c6321821a6a457af5367'
const C = 'het_cf6caafab90e4f757cc3'
const T0 = Date.UTC(2025, 8, 2)
const RANGE = 'start=2025-08-01T00:00:00Z&end=2025-09-03T00:00:00Z&timezone=UTC'

const dirs: string[] = []
const tmp = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `het-rest-${label}-`))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

interface Harness {
  dir: string
  svc: HetService
  broker: Broker
  grants: GrantStore
  audit: AuditLog
  base: string
  port: number
  token: string
  clock: { now: number }
  calls: string[]
}
const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.broker.stop()
    await h.svc.stop()
    h.audit.close()
  }
})

const VERDICT = { kind: 'coding', size: 'm', complexity: 'medium', agent_share: 0.5, adoption: 'unknown', evidence: [] }

/** Transport double at the boundary: returns whatever `reply` says; records task ids. */
function boundaryTransport(calls: string[], reply: () => { outcome: 'ok' | 'quota'; text?: string }): AssessorTransport {
  return {
    name: 'test-boundary',
    async complete(req) {
      calls.push(req.taskId)
      return reply()
    }
  }
}

async function harness(
  opts: { claudeRoot?: string; transport?: (calls: string[]) => AssessorTransport; enable?: boolean; source?: TranscriptSource; backend?: BrokerBackend } = {}
): Promise<Harness> {
  const dir = tmp('h')
  const clock = { now: T0 }
  const calls: string[] = []
  const transport = opts.transport?.(calls)
  const svc = createHetService({
    dbFile: join(dir, 'het.db'),
    settingsFile: join(dir, 'het-settings.json'),
    env: { LENS_HET_CLAUDE_ROOT: opts.claudeRoot ?? join(FIX, 'claude'), LENS_HET_CODEX_ROOT: '' },
    transport,
    budget: transport ? () => ({ available: true }) : undefined,
    source: opts.source,
    now: () => clock.now
  })
  if (opts.enable) svc.setAssessorEnabled(true)
  await svc.tickNow()
  const paths = ensureStore(storePaths(join(dir, 'store')))
  const grants = createGrantStore(paths)
  const audit = openAuditLog(paths.auditDb)
  const broker = createBroker({ grants, audit, backend: opts.backend ?? fakeBackend(), port: 0, rest: [createHetRestRouter({ service: () => svc })] })
  const info = await broker.start()
  const { token } = grants.create({ client: 'claude-code' })
  const h = { dir, svc, broker, grants, audit, base: `http://127.0.0.1:${info.port}`, port: info.port, token, clock, calls }
  open.push(h)
  return h
}

async function call(h: Harness, method: 'GET' | 'POST', path: string, body?: unknown, token: string | null = h.token) {
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(h.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: JSON.parse(text) as Record<string, any> }
}

/** Raw request with arbitrary Host / Origin (fetch forbids setting Host). */
function raw(h: Harness, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path, method: 'GET', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

const ENDPOINTS: Array<['GET' | 'POST', string, unknown?]> = [
  ['GET', '/het/summary?days=7'],
  ['GET', '/het/tasks?limit=100&include_activity=true'],
  ['GET', `/het/period?${RANGE}`],
  ['GET', `/het/activity?${RANGE}`],
  ['POST', '/het/tasks/correction', { task_id: A, action: 'rejected' }],
  ['POST', '/het/tasks/correction/revert', { task_id: A }],
  ['POST', '/het/retry', {}]
]

describe('HET REST: auth + transport security (same Broker server)', () => {
  test('every endpoint: 401 + WWW-Authenticate without / with a bad token; denied reads are Access-logged', async () => {
    const h = await harness()
    for (const [m, p, b] of ENDPOINTS) {
      const none = await call(h, m, p, b, null)
      expect(none.status, `${m} ${p}`).toBe(401)
      expect(none.headers.get('www-authenticate')).toBe('Bearer')
      expect(none.json.error.code).toBe('invalid_token')
      const bad = await call(h, m, p, b, 'lens_' + 'x'.repeat(43))
      expect(bad.status).toBe(401)
    }
    const rows = h.audit.list({ includeFailures: true, limit: 100 })
    expect(rows.filter((r) => r.outcome === 'unauthorized').length).toBe(ENDPOINTS.length * 2)
    expect(new Set(rows.map((r) => r.capability))).toEqual(
      new Set(['het_summary', 'het_tasks', 'het_period', 'het_activity', 'het_correction', 'het_correction_revert', 'het_retry'])
    )
    // Unauthorized correction attempts changed nothing.
    expect(h.svc.tasks(10).every((t) => t.correction === null)).toBe(true)
  })

  test('foreign Host (DNS rebinding) and browser Origin are refused before auth', async () => {
    const h = await harness()
    expect(await raw(h, '/het/summary', { host: `evil.example:${h.port}`, authorization: `Bearer ${h.token}` })).toBe(421)
    expect(await raw(h, '/het/summary', { host: `127.0.0.1:${h.port}`, origin: 'https://evil.example', authorization: `Bearer ${h.token}` })).toBe(403)
  })

  test('revoked grant → 401/403 class error; scoped grant: reports:read may read, never correct', async () => {
    const h = await harness()
    const { grant, token } = h.grants.create({ client: 'codex', scopes: ['reports:read'] }, { replaceExisting: true })
    expect((await call(h, 'GET', '/het/summary', undefined, token)).status).toBe(200)
    const corr = await call(h, 'POST', '/het/tasks/correction', { task_id: A, action: 'rejected' }, token)
    expect(corr.status).toBe(403)
    expect(corr.json.error.code).toBe('scope_denied')
    const other = h.grants.create({ client: 'cursor', scopes: ['card:read'] }).token
    expect((await call(h, 'GET', '/het/tasks', undefined, other)).status).toBe(403)
    h.grants.revoke(grant.id)
    expect((await call(h, 'GET', '/het/summary', undefined, token)).status).toBeGreaterThanOrEqual(401)
    expect(h.svc.tasks(10).every((t) => t.correction === null)).toBe(true)
  })

  test('unknown path 404, wrong method 405 (both after auth), MCP path unaffected', async () => {
    const h = await harness()
    expect((await call(h, 'GET', '/het/nope')).status).toBe(404)
    expect((await call(h, 'POST', '/het/summary', {})).status).toBe(405)
    expect((await call(h, 'GET', '/het/tasks/correction')).status).toBe(405)
    expect((await call(h, 'GET', '/het/nope', undefined, null)).status).toBe(401)
    const mcp = await fetch(`${h.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(mcp.status).toBe(401)
  })
})

describe('HET REST: validation and sanitized errors', () => {
  test('zod-validated query/body; errors carry codes, never the offending value', async () => {
    const h = await harness()
    const SECRET = 'SECRET-sk-abcdef0123456789'
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/het/summary?days=0'],
      ['GET', '/het/summary?days=367'],
      ['GET', `/het/summary?timezone=${SECRET}`],
      ['GET', `/het/summary?${SECRET}=1`],
      ['GET', '/het/summary?days=7&days=8'],
      ['GET', '/het/tasks?limit=201'],
      ['GET', `/het/tasks?include_activity=${SECRET}`],
      ['GET', '/het/period?start=2025-09-02T00:00:00Z&end=2025-09-01T00:00:00Z'],
      ['GET', `/het/period?${RANGE}&cursor=${SECRET}`],
      ['GET', '/het/period?start=yesterday&end=today'],
      ['GET', '/het/activity?start=2025-01-01T00:00:00Z&end=2025-09-01T00:00:00Z'],
      ['POST', '/het/tasks/correction', { task_id: A, action: SECRET }],
      ['POST', '/het/tasks/correction', { task_id: SECRET, action: 'accepted' }],
      ['POST', '/het/tasks/correction', { task_id: A, action: 'accepted', minutes: 999 }],
      ['POST', '/het/tasks/correction/revert', { task_id: A, extra: SECRET }]
    ]
    for (const [m, p, b] of cases) {
      const r = await call(h, m as 'GET' | 'POST', p, b)
      expect(r.status, `${m} ${p}`).toBe(400)
      expect(r.text).not.toContain(SECRET)
      expect(r.text).not.toMatch(/\/Users\/|\bat \w+ \(|node:/)
      expect(typeof r.json.error.code).toBe('string')
    }
    const raw400 = await fetch(`${h.base}/het/tasks/correction`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` }, body: '{not json' })
    expect(raw400.status).toBe(400)
    const unknown = await call(h, 'POST', '/het/tasks/correction', { task_id: 'het_ffffffffffffffffffff', action: 'accepted' })
    expect(unknown.status).toBe(404)
    expect(unknown.json).toEqual({ error: { code: 'unknown_task', message: 'no task with that id' } })
  })

  test('ledger unavailable → 503 with a fixed message', async () => {
    const h = await harness()
    await h.svc.stop()
    const r = await call(h, 'GET', '/het/summary')
    expect(r.status).toBe(503)
    expect(r.json.error.code).toBe('ledger_closed')
  })
})

describe('HET REST: empty ledger = 未测量, not zeros pretending measurement', () => {
  test('no transcripts: zero tasks, null minutes, measurement unmeasured, reads Access-logged with count 0', async () => {
    const empty = tmp('empty')
    mkdirSync(join(empty, 'projects'), { recursive: true })
    const h = await harness({ claudeRoot: empty })
    const s = await call(h, 'GET', '/het/summary?days=7&timezone=UTC')
    expect(s.status).toBe(200)
    expect(s.json).toMatchObject({
      definition: HET_DEFINITION,
      measurement: 'unmeasured',
      label: '未测量',
      state: 'notStarted',
      total_minutes: null,
      total_minutes_tenths: null,
      pending: 0,
      failed: 0,
      timezone: 'UTC'
    })
    expect(s.json.days).toHaveLength(7)
    expect(s.json.days.every((d: { minutes: unknown; tasks: number }) => d.minutes === null && d.tasks === 0)).toBe(true)
    expect(s.json.assessor).toMatchObject({ enabled: false, state: 'disabled' })
    const t = await call(h, 'GET', '/het/tasks')
    expect(t.json.tasks).toEqual([])
    const p = await call(h, 'GET', `/het/period?${RANGE}`)
    expect(p.json).toMatchObject({ tasks: [], next_cursor: null, measurement: 'unmeasured', total_minutes: null, total_minutes_tenths: null })
    const a = await call(h, 'GET', `/het/activity?${RANGE}`)
    expect(a.json).toMatchObject({ shape: 'lens-defined', measurement: 'unmeasured', total_minutes: null, markers: [], markers_total: 0 })
    const ok = h.audit.list({ limit: 50 })
    expect(ok.map((r) => r.capability).sort()).toEqual(['het_activity', 'het_period', 'het_summary', 'het_tasks'])
    expect(ok.every((r) => r.outcome === 'ok' && r.itemCount === 0 && r.client === 'claude-code')).toBe(true)
  })
})

describe('HET REST: shapes, gate closed by default (X3), HET-02 / HET-06 / HET-09 / HET-10', () => {
  test('default gate: tasks recorded, 0 transport calls, all pending, minutes null, unmeasured', async () => {
    const h = await harness({ transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'ok', text: JSON.stringify(VERDICT) })) })
    expect(h.calls).toEqual([]) // switch off ⇒ the injected transport is never called
    const s = await call(h, 'GET', '/het/summary?days=366&timezone=UTC')
    expect(s.json).toMatchObject({ measurement: 'unmeasured', total_minutes: null, pending: 3, state: 'manyPending' })
    expect(s.json.assessor.state).toBe('disabled')
    const t = await call(h, 'GET', '/het/tasks?limit=100&include_activity=true')
    expect(t.json.tasks).toHaveLength(3)
    for (const task of t.json.tasks) {
      // HET-06 fields
      for (const k of ['id', 'start', 'end', 'agent', 'kind', 'minutes', 'status', 'adoption', 'correction', 'counted', 'evidence']) expect(task).toHaveProperty(k)
      expect(task).toMatchObject({ status: 'needs_assessment', minutes: null, counted: false, last_error: 'assessor_disabled', agent: 'claude-code' })
      // HET-10: every evidence item resolves back to a transcript file:line
      expect(task.evidence.length).toBeGreaterThan(0)
      for (const e of task.evidence) expect(e.source).toMatchObject({ file: expect.stringMatching(/\.jsonl$/), line: expect.any(Number) })
    }
    // HET-09: no runtime-duration field anywhere in the REST payloads
    for (const body of [s.text, t.text]) expect(body).not.toMatch(/"(runtime|duration|duration_ms|elapsed|time_saved)[a-z_]*"\s*:/)
    expect(s.json.definition).toContain('It is not Agent runtime or proven time saved.')
  })

  test('period cursor pagination is complete and bounded; activity bounded', async () => {
    const h = await harness()
    const ids: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const q: string = `/het/period?${RANGE}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const p = await call(h, 'GET', q)
      expect(p.json.tasks.length).toBeLessThanOrEqual(1)
      ids.push(...p.json.tasks.map((t: { id: string }) => t.id))
      expect(p.json.counts.tasks).toBe(3)
      cursor = p.json.next_cursor
      if (!cursor) break
    }
    expect(ids.sort()).toEqual([A, B, C].sort())
    const a = await call(h, 'GET', `/het/activity?${RANGE}`)
    expect(a.json.markers_total).toBe(3)
    expect(a.json.markers_truncated).toBe(false)
  })
})

describe('HET REST: minutes come from anchors only (HET-07), only completed assessments count (HET-02)', () => {
  test('fake transport verdict → minutes = anchor formula; summary total = Σ rows; weekly agrees', async () => {
    const h = await harness({ enable: true, transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'ok', text: JSON.stringify(VERDICT) })) })
    expect(h.calls.sort()).toEqual([A, B, C].sort())
    const db = new DatabaseSync(join(h.dir, 'het.db'), { readOnly: true })
    const expected = minutesTenths({ anchorMinutes: getAnchors(db, 1).coding.minutes, size: 'm', complexity: 'medium', adoption: 'unknown' })
    db.close()
    const t = await call(h, 'GET', '/het/tasks')
    for (const task of t.json.tasks) expect(task).toMatchObject({ status: 'assessed', minutes_tenths: expected, counted: true, anchor_version: 1 })
    const s = await call(h, 'GET', '/het/summary?days=366&timezone=UTC')
    expect(s.json.measurement).toBe('measured')
    expect(s.json.total_minutes_tenths).toBe(3 * expected)
    expect(s.json.days.reduce((a: number, d: { minutes_tenths: number }) => a + d.minutes_tenths, 0)).toBe(3 * expected)
    const p = await call(h, 'GET', `/het/period?${RANGE}`)
    expect(p.json.total_minutes_tenths).toBe(3 * expected)
    // Weekly Review builder over the same ledger: total == Σ its rows == REST period total for that week.
    const ws = Date.UTC(2025, 7, 27)
    const weekly = h.svc.exportWeekly(ws, null)
    const wp = await call(h, 'GET', `/het/period?start=${new Date(ws).toISOString()}&end=${new Date(ws + 7 * 86_400_000).toISOString()}`)
    expect(weekly.rows).toBe(3)
    expect(weekly.total_minutes_tenths).toBe(weekly.rows * expected)
    expect(weekly.total_minutes_tenths).toBe(wp.json.total_minutes_tenths)
  })

  test('assessor output carrying minutes is rejected; nothing counted; the number never surfaces', async () => {
    const h = await harness({
      enable: true,
      transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'ok', text: JSON.stringify({ ...VERDICT, minutes: 987 }) }))
    })
    expect(h.calls.length).toBe(3)
    const t = await call(h, 'GET', '/het/tasks')
    expect(t.json.tasks.every((x: { status: string; minutes: unknown; last_error: string }) => x.status === 'needs_assessment' && x.minutes === null && x.last_error === 'invalid:minutes_forbidden')).toBe(true)
    const s = await call(h, 'GET', '/het/summary?days=366')
    expect(s.json).toMatchObject({ measurement: 'unmeasured', total_minutes: null })
    expect(s.text + t.text).not.toContain('987')
  })

  test('quota at the transport: one call, stop, pending excluded (T-HET-02 step 3)', async () => {
    const h = await harness({ enable: true, transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'quota' })) })
    expect(h.calls.length).toBe(1)
    const s = await call(h, 'GET', '/het/summary?days=366')
    expect(s.json).toMatchObject({ measurement: 'unmeasured', total_minutes: null, pending: 3 })
  })
})

describe('HET REST: corrections are applied, audited and reversible (HET-04, D17)', () => {
  test('rejected / accepted / not_agent → recompute; revert restores the anchor value; het_events trail', async () => {
    const h = await harness({ enable: true, transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'ok', text: JSON.stringify(VERDICT) })) })
    const total = async () => (await call(h, 'GET', '/het/summary?days=366')).json.total_minutes_tenths as number
    const base = await total()
    const per = base / 3
    const r1 = await call(h, 'POST', '/het/tasks/correction', { task_id: A, action: 'rejected' })
    expect(r1.status).toBe(200)
    expect(r1.json).toMatchObject({ task_id: A, action: 'rejected', changed: true })
    expect(await total()).toBe(base - per)
    expect((await call(h, 'POST', '/het/tasks/correction', { task_id: A, action: 'rejected' })).json.changed).toBe(false)
    const rv = await call(h, 'POST', '/het/tasks/correction/revert', { task_id: A })
    expect(rv.json).toMatchObject({ task_id: A, changed: true, minutes_tenths: per, extension: true })
    expect(await total()).toBe(base)
    expect((await call(h, 'POST', '/het/tasks/correction/revert', { task_id: A })).json.changed).toBe(false)

    const acc = await call(h, 'POST', '/het/tasks/correction', { task_id: B, action: 'accepted' })
    expect(acc.json.minutes_tenths).toBeGreaterThan(per) // adoption → confirmed weight (anchor table, not model)
    expect(await total()).toBe(base - per + acc.json.minutes_tenths)
    await call(h, 'POST', '/het/tasks/correction/revert', { task_id: B })
    expect(await total()).toBe(base)

    const na = await call(h, 'POST', '/het/tasks/correction', { task_id: C, action: 'not_agent' })
    expect(na.json.minutes_tenths).toBe(0)
    const tasks = (await call(h, 'GET', '/het/tasks')).json.tasks as Array<{ id: string; counted: boolean; minutes: unknown; correction: string | null }>
    expect(tasks.find((t) => t.id === C)).toMatchObject({ counted: false, minutes: null, correction: 'not_agent' })
    expect(await total()).toBe(base - per)
    await call(h, 'POST', '/het/tasks/correction/revert', { task_id: C })
    expect(await total()).toBe(base)

    const db = new DatabaseSync(join(h.dir, 'het.db'), { readOnly: true })
    const ev = db.prepare("SELECT task_id, kind, payload FROM het_events WHERE actor = 'user' AND kind = 'corrected' ORDER BY id").all() as Array<{ task_id: string; payload: string }>
    db.close()
    const actions = ev.map((e) => [e.task_id, JSON.parse(e.payload).action])
    expect(actions).toEqual([[A, 'rejected'], [A, null], [B, 'accepted'], [B, null], [C, 'not_agent'], [C, null]])
    // Corrections are Access-logged as writes by the grant's client.
    const log = h.audit.list({ limit: 100 }).filter((r) => r.capability.startsWith('het_correction'))
    expect(log.length).toBe(8)
  })
})

describe('HET REST: updateFailed + retry (HET-08)', () => {
  test('a failed ledger update → state updateFailed with a path-free code; next good tick clears it', async () => {
    let fail = true
    const good: TranscriptSource = { refresh: async () => ({ events: [], warnings: {}, files: 0, reparsed: 0, partial: 0 }) }
    const source: TranscriptSource = {
      refresh: async (signal) => {
        if (fail) throw Object.assign(new Error('EACCES: permission denied, open /Users/someone/.claude/projects/x.jsonl'), { code: 'EACCES' })
        return good.refresh(signal)
      }
    }
    const h = await harness({ source })
    const s = await call(h, 'GET', '/het/summary')
    expect(s.json.state).toBe('updateFailed')
    expect(s.json.ledger_state).toBe('notStarted')
    expect(s.json.update).toMatchObject({ failed: true, error: 'update_failed:EACCES', consecutive_failures: 1 })
    expect(s.text).not.toContain('/Users/')
    expect(s.json.total_minutes).toBeNull()
    fail = false
    h.clock.now += 60_000
    await h.svc.tickNow()
    const s2 = await call(h, 'GET', '/het/summary')
    expect(s2.json.state).toBe('notStarted')
    expect(s2.json.update).toMatchObject({ failed: false, error: null, consecutive_failures: 0 })
  })

  test('invalid verdicts → failed after maxAttempts (never guessed); POST /het/retry re-queues; counted only after assessment', async () => {
    let reply: { outcome: 'ok'; text: string } = { outcome: 'ok', text: 'not json' }
    const h = await harness({ enable: true, transport: (calls) => boundaryTransport(calls, () => reply) })
    for (let i = 0; i < 3; i++) {
      h.clock.now += 16 * 60_000 // past backoff
      await h.svc.tickNow()
    }
    expect(h.calls.length).toBe(9) // 3 tasks × maxAttempts 3, no extra retries
    h.clock.now += 16 * 60_000
    await h.svc.tickNow()
    expect(h.calls.length).toBe(9) // failed tasks are not retried automatically (no loop)
    const s = await call(h, 'GET', '/het/summary?days=366')
    expect(s.json).toMatchObject({ state: 'manyFailed', failed: 3, measurement: 'unmeasured', total_minutes: null })

    reply = { outcome: 'ok', text: JSON.stringify(VERDICT) }
    h.clock.now += 60_000
    const r = await call(h, 'POST', '/het/retry', {})
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ extension: true, requeued: 3 })
    expect(h.calls.length).toBe(12) // the retry's single tick, within perTickCap 5
    const s2 = await call(h, 'GET', '/het/summary?days=366')
    expect(s2.json).toMatchObject({ state: 'ready', failed: 0, measurement: 'measured' })
    expect(s2.json.total_minutes_tenths).toBeGreaterThan(0)
  })

  test('retry with the gate closed makes no transport call and counts nothing', async () => {
    const h = await harness({ transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'ok', text: JSON.stringify(VERDICT) })) })
    h.clock.now += 60_000
    const r = await call(h, 'POST', '/het/retry', {})
    expect(r.json).toMatchObject({ requeued: 0, assessor: { state: 'disabled' } })
    expect(h.calls).toEqual([])
    expect((await call(h, 'GET', '/het/summary?days=366')).json.total_minutes).toBeNull()
  })
})

describe('HET IPC parity for the OG-08 additions (revert / retry)', () => {
  test('zod-validated channels; revert round-trip; retry runs gated', async () => {
    const h = await harness({ enable: true, transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'ok', text: JSON.stringify(VERDICT) })) })
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<{ ok: boolean; data?: any }>>()
    registerHetIpc({ handle: (ch: string, fn: any) => void handlers.set(ch, fn) }, { service: h.svc, chooseExportPath: async () => null })
    const ipc = (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw)
    const before = h.svc.summary(366).total_minutes_tenths
    expect((await ipc(HET_CHANNELS.correct, { taskId: A, action: 'rejected' })).ok).toBe(true)
    expect(h.svc.summary(366).total_minutes_tenths).toBeLessThan(before)
    expect((await ipc(HET_CHANNELS.revertCorrection, { taskId: A })).data).toMatchObject({ changed: true })
    expect(h.svc.summary(366).total_minutes_tenths).toBe(before)
    expect((await ipc(HET_CHANNELS.revertCorrection, { taskId: 'nope' })).ok).toBe(false)
    expect((await ipc(HET_CHANNELS.revertCorrection, { taskId: A, action: 'x' })).ok).toBe(false)
    expect((await ipc(HET_CHANNELS.retry)).data).toEqual({ requeued: 0 })
    expect((await ipc(HET_CHANNELS.retry, { force: true })).ok).toBe(false)
  })
})

describe('HET UI controls for OG-08 (pure label helpers used by TaskTable / Het.tsx)', () => {
  test('撤销修正 only when a correction exists; 重试失败任务 only on failed tasks or updateFailed, honest about the gate', async () => {
    const { undoCorrectionLabel, retryControl } = await import('../../src/renderer/src/components/het/labels')
    expect(undoCorrectionLabel({ correction: null }).show).toBe(false)
    expect(undoCorrectionLabel({ correction: 'rejected' })).toMatchObject({ show: true, text: 'Undo correction' })
    expect(retryControl(undefined, undefined).show).toBe(false)
    expect(retryControl({ failed: 0, state: 'manyPending' }, { state: 'disabled' }).show).toBe(false)
    const off = retryControl({ failed: 2, state: 'manyFailed' }, { state: 'disabled' })
    expect(off).toMatchObject({ show: true, text: 'Retry failed tasks' })
    expect(off.hint).toContain('no model will be called')
    expect(retryControl({ failed: 0, state: 'updateFailed' }, { state: 'ready' }).hint).not.toContain('no model will be called')
  })
})

/** Copy the synthetic fixtures, rewriting `/work/…` to `/Users/alice/work/…` (cwd, file paths, dir names). */
function aliceFixture(): string {
  const root = tmp('alice')
  const dst = join(root, 'Users', 'alice', '.claude', 'projects')
  mkdirSync(dst, { recursive: true })
  cpSync(join(FIX, 'claude'), dst, { recursive: true })
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.jsonl')) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('"/work/', '"/Users/alice/work/').replaceAll('mail me', 'alice@example.com'))
    }
  }
  walk(dst)
  for (const n of readdirSync(dst)) if (n.startsWith('-work-')) renameSync(join(dst, n), join(dst, n.replace('-work-', '-Users-alice-work-')))
  return dst
}

describe('security review F2: REST bodies are PII-scrubbed and carry no absolute paths', () => {
  test('fixture with /Users/alice/... paths → no /Users/, no account name, no temp root in any REST response', async () => {
    const claudeRoot = aliceFixture()
    const h = await harness({ claudeRoot })
    // Sanity: the ledger itself does hold the absolute paths (so the test exercises the mapping).
    const raw = JSON.stringify(h.svc.tasks(100, true))
    expect(raw).toContain('/Users/alice/work/')
    const bodies: string[] = []
    for (const p of ['/het/summary?days=366', '/het/tasks?limit=100&include_activity=true', `/het/period?${RANGE}&include_activity=true`, `/het/activity?${RANGE}`]) {
      const r = await call(h, 'GET', p)
      expect(r.status, p).toBe(200)
      bodies.push(r.text)
    }
    const all = bodies.join('\n')
    expect(all).not.toContain('/Users/')
    expect(all).not.toContain('alice')
    expect(all).not.toContain(claudeRoot)
    expect(all).not.toContain(tmpdir())
    const t = JSON.parse(bodies[1]).tasks as Array<{ id: string; project: string; files_written: string[]; evidence: Array<{ files: string[]; source: { file: string; line: number } }> }>
    expect(t).toHaveLength(3)
    expect(new Set(t.map((x) => x.id))).toEqual(new Set([A, B, C]))
    expect(new Set(t.map((x) => x.project))).toEqual(new Set(['demo-app', 'other']))
    expect(t.flatMap((x) => x.files_written)).toContain('export.ts')
    for (const x of t) {
      for (const f of x.files_written) expect(f).not.toContain('/')
      for (const e of x.evidence) {
        for (const f of e.files) expect(f).not.toContain('/')
        // HET-10 still resolvable: transcript basename + line, never the absolute path.
        expect(e.source.file).toMatch(/^[^/]+\.jsonl$/)
        expect(typeof e.source.line).toBe('number')
      }
    }
    // The Access-log preview is the same scrubbed text.
    const rows = h.audit.list({ limit: 20 })
    for (const row of rows) expect(JSON.stringify(h.audit.preview(row.id))).not.toContain('/Users/')
  })

  test('scrubRestBody: opaque keys pass only with a path/email-free charset; everything else is deepScrubbed', () => {
    const cursor = Buffer.from(`1756771200000:${A}`).toString('base64url')
    const out = scrubRestBody(
      { next_cursor: cursor, id: '/Users/alice/x', note: 'see /Users/alice/proj and a@b.co', nested: [{ task_id: 'bob@example.com' }] },
      new Set(['next_cursor', 'id', 'task_id'])
    ) as Record<string, any>
    expect(out.next_cursor).toBe(cursor)
    expect(out.id).toBe('[path]')
    expect(out.note).not.toMatch(/Users|a@b/)
    expect(out.nested[0].task_id).toBe('[email]')
  })
})

describe('security review F10: authorize on headers first; body errors audited; invalid input never consumes a use', () => {
  test('unauthenticated POST with a malformed body → 401 (not 400), Access-logged without the body', async () => {
    const h = await harness()
    const r = await fetch(`${h.base}/het/tasks/correction`, { method: 'POST', body: '{not json SECRET-BODY' })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe('Bearer')
    const rows = h.audit.list({ includeFailures: true, limit: 10 })
    expect(rows.map((x) => [x.capability, x.outcome])).toEqual([['het_correction', 'unauthorized']])
    expect(JSON.stringify([rows, h.audit.preview(rows[0].id)])).not.toContain('SECRET-BODY')
  })

  test('authorized body errors (invalid JSON, > 1 MiB) are error rows with no echo, and consume no use', async () => {
    const h = await harness()
    const { token } = h.grants.create({ client: 'codex', maxReads: 1 }, { replaceExisting: true })
    const bad = await fetch(`${h.base}/het/tasks/correction`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{not json SECRET-BODY' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('invalid_json')
    const big = await fetch(`${h.base}/het/tasks/correction`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(1024 * 1024 + 10) }).catch(() => null)
    if (big) expect(big.status).toBe(413)
    const rows = h.audit.list({ includeFailures: true, limit: 10 }).filter((x) => x.client === 'codex')
    expect(rows.map((x) => x.errorCode).sort()).toEqual(['body_too_large', 'invalid_json'])
    expect(rows.every((x) => x.outcome === 'error')).toBe(true)
    expect(JSON.stringify(rows.map((x) => h.audit.preview(x.id)))).not.toContain('SECRET-BODY')
    // The single allowed read is still available.
    expect((await call(h, 'GET', '/het/summary', undefined, token)).status).toBe(200)
    expect((await call(h, 'GET', '/het/summary', undefined, token)).status).toBe(403)
  })

  test('query/body validation failures (400) do not consume a grant use; are Access-logged as errors', async () => {
    const h = await harness()
    const { token } = h.grants.create({ client: 'codex', maxReads: 1 }, { replaceExisting: true })
    for (const [m, p, b] of [
      ['GET', '/het/summary?days=0'],
      ['GET', '/het/period?start=2025-09-02T00:00:00Z&end=2025-09-01T00:00:00Z'],
      ['POST', '/het/tasks/correction', { task_id: A, action: 'nope' }],
      ['POST', '/het/retry', { force: true }]
    ] as Array<['GET' | 'POST', string, unknown?]>) {
      expect((await call(h, m, p, b, token)).status, p).toBe(400)
    }
    const rows = h.audit.list({ includeFailures: true, limit: 10 }).filter((x) => x.client === 'codex')
    expect(rows).toHaveLength(4)
    expect(rows.every((x) => x.outcome === 'error' && x.httpStatus === 400)).toBe(true)
    expect((await call(h, 'GET', '/het/tasks', undefined, token)).status).toBe(200)
    const after = await call(h, 'GET', '/het/tasks', undefined, token)
    expect([after.status, after.json.error.code]).toEqual([403, 'exhausted'])
  })
})

describe('security review F11: POST /het/retry is behind the agent LLM budget gate', () => {
  for (const [label, budget] of [
    ['disabled', { enabled: false, exhausted: false }],
    ['exhausted', { enabled: true, exhausted: true }]
  ] as const) {
    test(`budget ${label}: 429 budget_exhausted, nothing re-queued, no transport call, no use consumed`, async () => {
      const h = await harness({
        enable: true,
        backend: fakeBackend({ budget: () => budget }),
        transport: (calls) => boundaryTransport(calls, () => ({ outcome: 'ok', text: 'not json' }))
      })
      for (let i = 0; i < 3; i++) {
        h.clock.now += 16 * 60_000
        await h.svc.tickNow()
      }
      const failedBefore = h.svc.summary(366).failed
      expect(failedBefore).toBe(3)
      const callsBefore = h.calls.length
      const { token } = h.grants.create({ client: 'codex', maxReads: 1 }, { replaceExisting: true })
      const r = await call(h, 'POST', '/het/retry', {}, token)
      expect(r.status).toBe(429)
      expect(r.json.error.code).toBe('budget_exhausted')
      expect(h.calls.length).toBe(callsBefore)
      expect(h.svc.summary(366).failed).toBe(failedBefore)
      const row = h.audit.list({ includeFailures: true, limit: 5 }).find((x) => x.capability === 'het_retry')!
      expect([row.outcome, row.httpStatus, row.errorCode]).toEqual(['denied', 429, 'budget_exhausted'])
      // Reads that cannot spend budget are unaffected, and the gate consumed no use.
      expect((await call(h, 'GET', '/het/summary', undefined, token)).status).toBe(200)
    })
  }
})
