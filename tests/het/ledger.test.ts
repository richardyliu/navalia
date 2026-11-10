import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { editAnchors, getAnchors, minutesTenths, ensureDefaultAnchors } from '../../src/main/het/anchors'
import { disabledTransport, parseVerdict, type AssessorTransport } from '../../src/main/het/assessor'
import { correctTask, hetPeriod, hetSummary, hetTasks } from '../../src/main/het/ledger'
import { migrateHet } from '../../src/main/het/schema'
import { DEFAULT_HET_SETTINGS, type HetSettings } from '../../src/main/het/settings'
import { tick } from '../../src/main/het/tick'
import type { AgentEvent } from '../../src/main/het/types'

const BASE = Date.UTC(2025, 8, 1, 0, 0, 0)
const MIN = 60_000
const T = (m: number): number => BASE + m * MIN
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrateHet(db)
  ensureDefaultAnchors(db, BASE)
  return db
}

function ev(sessionId: string, min: number, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    agent: 'claude-code',
    sessionId,
    ts: T(min),
    cwd: `/p/${sessionId}`,
    project: `/p/${sessionId}`,
    role: 'assistant',
    toolNames: [],
    filesWritten: [],
    filesRead: [],
    signals: [],
    summary: `summary ${sessionId} ${min}`,
    sidechain: false,
    source: { file: `/t/${sessionId}.jsonl`, line: Math.round(min * 10) + 1 },
    ...over
  }
}

/** n independent tasks, 2h apart, each: user prompt, edit, commit. */
function backlog(n: number, startMin = 0): AgentEvent[] {
  const out: AgentEvent[] = []
  for (let i = 0; i < n; i++) {
    const s = `s${String(i).padStart(3, '0')}`
    const m = startMin + i * 120
    out.push(
      ev(s, m, { role: 'user', summary: 'do the thing' }),
      ev(s, m + 1, { toolNames: ['Edit'], filesWritten: [`/p/${s}/a.ts`] }),
      ev(s, m + 2, { toolNames: ['Bash'], signals: ['git_commit'] })
    )
  }
  return out
}

const settings = (over: Partial<HetSettings> = {}): HetSettings => ({ ...DEFAULT_HET_SETTINGS, ...over })

function counting(fn: (prompt: string) => { outcome: 'ok' | 'quota' | 'offline' | 'error' | 'budget_unavailable'; text?: string }): AssessorTransport & { calls: number } {
  const t = {
    name: 'mock',
    calls: 0,
    async complete(req: { prompt: string }) {
      t.calls++
      return fn(req.prompt)
    }
  }
  return t
}

const goodVerdict = (prompt: string): string => {
  const hasCommit = prompt.includes('git_commit')
  return JSON.stringify({
    kind: 'coding',
    size: 'm',
    complexity: 'medium',
    agent_share: 0.9,
    adoption: hasCommit ? 'strong' : 'unknown',
    evidence: hasCommit ? ['signal:git_commit'] : []
  })
}
const okTransport = () => counting((p) => ({ outcome: 'ok', text: goodVerdict(p) }))

function snapshot(db: DatabaseSync): string {
  const tables = ['het_tasks', 'het_evidence', 'het_events', 'agent_calls', 'het_meta', 'het_anchors']
  return JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()))
}

const LATER = T(100 * 120 + 24 * 60)

describe('anchors (E3.3)', () => {
  test('deterministic minutes, integer tenths, float-noise safe', () => {
    expect(minutesTenths({ anchorMinutes: 45, size: 'm', complexity: 'medium', adoption: 'strong' })).toBe(383) // 38.25→382.5→383
    expect(minutesTenths({ anchorMinutes: 45, size: 'm', complexity: 'medium', adoption: 'rejected' })).toBe(0)
    expect(minutesTenths({ anchorMinutes: 20, size: 'xl', complexity: 'high', adoption: 'confirmed' })).toBe(1200)
    expect(minutesTenths({ anchorMinutes: 10, size: 'xs', complexity: 'low', adoption: 'unknown' })).toBe(6) // 0.5625 min
    const a = Array.from({ length: 50 }, () => minutesTenths({ anchorMinutes: 30, size: 'l', complexity: 'low', adoption: 'weak' }))
    expect(new Set(a).size).toBe(1)
  })

  test('same corpus → identical minutes across independent runs', async () => {
    const run = async () => {
      const db = freshDb()
      await tick({ db, transport: okTransport(), settings: settings({ perTickCap: 50, perDayCap: 100 }), input: { events: backlog(10) }, dayOf: utcDay }, LATER)
      return db.prepare('SELECT id, minutes_tenths, anchor_version FROM het_tasks ORDER BY id').all()
    }
    const [r1, r2] = [await run(), await run()]
    expect(r1).toEqual(r2)
    expect(r1.every((r) => (r as { minutes_tenths: number }).minutes_tenths === 383)).toBe(true)
  })

  test('edits create a new version; old versions immutable', () => {
    const db = freshDb()
    const v2 = editAnchors(db, { coding: 60 }, T(1))
    expect(v2).toBe(2)
    expect(getAnchors(db, 1).coding.minutes).toBe(45)
    expect(getAnchors(db, 2).coding.minutes).toBe(60)
    expect(getAnchors(db, 2).writing.minutes).toBe(30)
    expect(() => db.prepare("UPDATE het_anchors SET minutes = 1 WHERE version = 1 AND kind = 'coding'").run()).toThrow(/immutable/)
    expect(() => db.prepare('DELETE FROM het_anchors WHERE version = 1').run()).toThrow(/immutable/)
    expect(() => editAnchors(db, { coding: -1 }, T(2))).toThrow()
  })
})

describe('assessor verdict validation (E3.3)', () => {
  const ids = new Set(['ev_1'])
  const base = { kind: 'coding', size: 'm', complexity: 'low', agent_share: 0.5, adoption: 'strong', evidence: ['event:ev_1'] }
  test('accepts a valid verdict (also fenced)', () => {
    expect(parseVerdict(JSON.stringify(base), ids, []).ok).toBe(true)
    expect(parseVerdict('```json\n' + JSON.stringify(base) + '\n```', ids, []).ok).toBe(true)
  })
  test('rejects minutes, extra keys, bad refs, unbacked adoption, non-JSON', () => {
    expect(parseVerdict(JSON.stringify({ ...base, minutes: 30 }), ids, [])).toEqual({ ok: false, reason: 'minutes_forbidden' })
    expect(parseVerdict(JSON.stringify({ ...base, note: 'x' }), ids, [])).toEqual({ ok: false, reason: 'schema' })
    expect(parseVerdict(JSON.stringify({ ...base, evidence: ['event:ev_x'] }), ids, [])).toEqual({ ok: false, reason: 'unresolved_evidence' })
    expect(parseVerdict(JSON.stringify({ ...base, evidence: [] }), ids, [])).toEqual({ ok: false, reason: 'adoption_without_evidence' })
    expect(parseVerdict(JSON.stringify({ ...base, adoption: 'confirmed' }), ids, [])).toEqual({ ok: false, reason: 'schema' })
    expect(parseVerdict('sure! here you go', ids, [])).toEqual({ ok: false, reason: 'not_json' })
  })
})

describe('T-HET-02: only completed assessment counts', () => {
  test('pending excluded, then counted after assessment', async () => {
    const db = freshDb()
    const input = { events: backlog(1) }
    const s = settings()
    // budget unavailable → pending
    const r1 = await tick({ db, transport: disabledTransport, settings: s, input, dayOf: utcDay }, T(60))
    expect(r1.assess.outcomes).toEqual({ budget_unavailable: 1 })
    let sum = hetSummary(db, { now: T(60), days: 7, dayOf: utcDay })
    expect(sum.total_minutes_tenths).toBe(0)
    expect(sum.pending).toBe(1)
    expect(sum.state).toBe('onePending')
    expect(hetTasks(db)[0]).toMatchObject({ status: 'needs_assessment', minutes: null, counted: false })
    // within backoff: blocked, no call
    const t = okTransport()
    const r2 = await tick({ db, transport: t, settings: s, input, dayOf: utcDay }, T(61))
    expect(r2.assess.skipped).toBe('blocked')
    expect(t.calls).toBe(0)
    // after backoff: assessed and counted
    await tick({ db, transport: t, settings: s, input, dayOf: utcDay }, T(60) + s.backoffMs)
    expect(t.calls).toBe(1)
    sum = hetSummary(db, { now: T(60) + s.backoffMs, days: 7, dayOf: utcDay })
    expect(sum.total_minutes_tenths).toBe(383)
    expect(sum.pending).toBe(0)
    expect(sum.state).toBe('ready')
  })
})

describe('assessor caps under a 100-task backlog', () => {
  test('quota transport: ≤ cap calls, all 100 needs_assessment, stops and backs off', async () => {
    const db = freshDb()
    const s = settings({ perTickCap: 5, perDayCap: 20 })
    const q = counting(() => ({ outcome: 'quota' }))
    const input = { events: backlog(100) }
    const r = await tick({ db, transport: q, settings: s, input, dayOf: utcDay }, LATER)
    expect(r.upserts.inserted).toBe(100)
    expect(q.calls).toBe(1) // stops on first quota error; no retry within tick
    expect(r.assess.stoppedOn).toBe('quota')
    // hammer ticks every minute until the end of the same UTC day (LATER is 08:00 UTC)
    const dayEnd = Date.UTC(new Date(LATER).getUTCFullYear(), new Date(LATER).getUTCMonth(), new Date(LATER).getUTCDate() + 1)
    for (let at = LATER + MIN; at < dayEnd; at += MIN) await tick({ db, transport: q, settings: s, input, dayOf: utcDay }, at)
    expect(q.calls).toBe(s.perDayCap) // quota responses reached a model → they consume the daily cap
    // next day: cap resets, still one call per backoff window at most
    for (let at = dayEnd; at < dayEnd + 60 * MIN; at += MIN) await tick({ db, transport: q, settings: s, input, dayOf: utcDay }, at)
    expect(q.calls).toBe(s.perDayCap + 4)
    const st = db.prepare('SELECT status, COUNT(*) AS n FROM het_tasks GROUP BY status').all()
    expect(st).toEqual([{ status: 'needs_assessment', n: 100 }])
    expect(hetSummary(db, { now: LATER, days: 30, dayOf: utcDay }).total_minutes_tenths).toBe(0)
    const calls = db.prepare('SELECT COUNT(*) AS n FROM agent_calls').get() as { n: number }
    expect(calls.n).toBe(q.calls)
  })

  test('ok transport: per-tick and per-day caps hold exactly', async () => {
    const db = freshDb()
    const s = settings({ perTickCap: 5, perDayCap: 20 })
    const t = okTransport()
    const input = { events: backlog(100) }
    const r = await tick({ db, transport: t, settings: s, input, dayOf: utcDay }, LATER)
    expect(r.assess.calls).toBe(5)
    for (let m = 1; m <= 60; m++) await tick({ db, transport: t, settings: s, input, dayOf: utcDay }, LATER + m * MIN)
    expect(t.calls).toBe(20)
    const assessed = db.prepare("SELECT COUNT(*) AS n FROM het_tasks WHERE status = 'assessed'").get() as { n: number }
    expect(assessed.n).toBe(20)
  })

  test('invalid output (minutes key) → needs_assessment, counted attempts, then failed', async () => {
    const db = freshDb()
    const s = settings({ perTickCap: 5, maxAttempts: 2 })
    const bad = counting((p) => ({ outcome: 'ok', text: JSON.stringify({ ...JSON.parse(goodVerdict(p)), minutes: 99 }) }))
    const input = { events: backlog(1) }
    await tick({ db, transport: bad, settings: s, input, dayOf: utcDay }, LATER)
    expect(hetTasks(db)[0]).toMatchObject({ status: 'needs_assessment', last_error: 'invalid:minutes_forbidden', minutes: null })
    await tick({ db, transport: bad, settings: s, input, dayOf: utcDay }, LATER + 1) // within backoff → not retried
    expect(bad.calls).toBe(1)
    await tick({ db, transport: bad, settings: s, input, dayOf: utcDay }, LATER + s.backoffMs)
    expect(bad.calls).toBe(2)
    expect(hetTasks(db)[0].status).toBe('failed')
    expect(hetSummary(db, { now: LATER, days: 30, dayOf: utcDay }).state).toBe('oneFailed')
  })
})

describe('tick idempotency and reopen (E3.4)', () => {
  test('same tick twice changes nothing', async () => {
    for (const transport of [disabledTransport, okTransport()]) {
      const db = freshDb()
      const deps = { db, transport, settings: settings(), input: { events: backlog(8) }, dayOf: utcDay }
      await tick(deps, LATER)
      const a = snapshot(db)
      const r = await tick(deps, LATER)
      expect(snapshot(db)).toBe(a)
      expect(r.upserts.unchanged).toBe(8)
      expect(r.assess.skipped).toBe('replayed_tick')
    }
  })

  test('unsettled task settles later; grown assessed task reopens with superseded verdict', async () => {
    const db = freshDb()
    const s = settings()
    const t = okTransport()
    const base = backlog(1)
    const r0 = await tick({ db, transport: t, settings: s, input: { events: base }, dayOf: utcDay }, T(5))
    expect(r0.upserts.inserted).toBe(1)
    expect(hetTasks(db)[0].status).toBe('unsettled')
    expect(t.calls).toBe(0)
    const r1 = await tick({ db, transport: t, settings: s, input: { events: base }, dayOf: utcDay }, T(40))
    expect(r1.upserts.settled).toBe(1)
    expect(hetTasks(db)[0]).toMatchObject({ status: 'assessed', minutes: 38.3 })
    // a late-flushed event extends the session within the idle gap
    const grown = [...base, ev('s000', 20, { toolNames: ['Edit'], filesWritten: ['/p/s000/b.ts'] })]
    const r2 = await tick({ db, transport: t, settings: s, input: { events: grown }, dayOf: utcDay }, T(41))
    expect(r2.upserts.reopened).toBe(1)
    const task = hetTasks(db)[0]
    expect(task).toMatchObject({ status: 'unsettled', minutes: null, kind: 'unassessed', anchor_version: null })
    const reopened = db.prepare("SELECT payload FROM het_events WHERE kind = 'reopened'").get() as { payload: string }
    expect(JSON.parse(reopened.payload).superseded).toMatchObject({ status: 'assessed', kind: 'coding', minutes_tenths: 383 })
    // settles again → reassessed
    await tick({ db, transport: t, settings: s, input: { events: grown }, dayOf: utcDay }, T(60))
    expect(hetTasks(db)[0]).toMatchObject({ status: 'assessed', minutes: 38.3 })
    expect(t.calls).toBe(2)
  })
})

describe('corrections (accepted / rejected / not_agent)', () => {
  test('each recomputes and audits; repeated action is a no-op', async () => {
    const db = freshDb()
    await tick({ db, transport: okTransport(), settings: settings({ perTickCap: 10 }), input: { events: backlog(3) }, dayOf: utcDay }, LATER)
    const [a, b, c] = hetTasks(db).map((t) => t.id)
    const total = () => hetSummary(db, { now: LATER, days: 60, dayOf: utcDay }).total_minutes_tenths
    expect(total()).toBe(3 * 383)

    expect(correctTask(db, a, 'accepted', LATER + 1)).toEqual({ minutesTenths: 450, changed: true }) // confirmed 1.0
    expect(correctTask(db, b, 'rejected', LATER + 2)).toEqual({ minutesTenths: 0, changed: true })
    expect(correctTask(db, c, 'not_agent', LATER + 3)).toEqual({ minutesTenths: 0, changed: true })
    expect(total()).toBe(450)
    expect(hetTasks(db).find((t) => t.id === c)).toMatchObject({ counted: false, minutes: null, correction: 'not_agent' })
    expect(hetTasks(db).find((t) => t.id === a)).toMatchObject({ adoption: 'confirmed', minutes: 45 })

    const audit = db.prepare("SELECT task_id, kind, actor, payload FROM het_events WHERE actor = 'user' ORDER BY id").all() as Array<{
      task_id: string
      kind: string
      payload: string
    }>
    expect(audit.map((r) => [r.task_id, r.kind])).toEqual([
      [a, 'corrected'], [a, 'recomputed'], [b, 'corrected'], [b, 'recomputed'], [c, 'corrected'], [c, 'recomputed']
    ])
    expect(JSON.parse(audit[1].payload)).toEqual({ before: 383, after: 450 })

    expect(correctTask(db, a, 'accepted', LATER + 4).changed).toBe(false)
    expect((db.prepare("SELECT COUNT(*) AS n FROM het_events WHERE actor = 'user'").get() as { n: number }).n).toBe(6)
    // flip back
    expect(correctTask(db, b, 'accepted', LATER + 5).minutesTenths).toBe(450)
    expect(() => correctTask(db, a, 'override' as never, LATER)).toThrow()
  })

  test('rejected / not_agent pending tasks are not sent to the assessor', async () => {
    const db = freshDb()
    const input = { events: backlog(2) }
    await tick({ db, transport: disabledTransport, settings: settings(), input, dayOf: utcDay }, LATER)
    const [a, b] = hetTasks(db).map((t) => t.id)
    correctTask(db, a, 'not_agent', LATER + 1)
    correctTask(db, b, 'rejected', LATER + 2)
    const t = okTransport()
    await tick({ db, transport: t, settings: settings(), input, dayOf: utcDay }, LATER + DEFAULT_HET_SETTINGS.backoffMs)
    expect(t.calls).toBe(0)
    expect(hetSummary(db, { now: LATER, days: 60, dayOf: utcDay }).pending).toBe(0)
  })
})

describe('weekly sum equality', () => {
  test('summary total = Σ days; period total = Σ rows across pages', async () => {
    const db = freshDb()
    // 30 tasks spread over ~5 days (every 4h), mixed adoption
    const events: AgentEvent[] = []
    for (let i = 0; i < 30; i++) {
      const s = `w${String(i).padStart(2, '0')}`
      const m = i * 240
      events.push(ev(s, m, { role: 'user' }), ev(s, m + 3, i % 3 ? { signals: ['git_commit'] } : {}))
    }
    const now = T(30 * 240 + 120)
    await tick({ db, transport: okTransport(), settings: settings({ perTickCap: 50, perDayCap: 100 }), input: { events }, dayOf: utcDay }, now)
    const ids = hetTasks(db, { limit: 200 }).map((t) => t.id)
    correctTask(db, ids[0], 'rejected', now + 1)
    correctTask(db, ids[1], 'not_agent', now + 2)
    correctTask(db, ids[2], 'accepted', now + 3)

    const sum = hetSummary(db, { now, days: 7, dayOf: utcDay })
    expect(sum.total_minutes_tenths).toBe(sum.days.reduce((a, d) => a + d.minutes_tenths, 0))
    expect(sum.total_minutes).toBe(sum.total_minutes_tenths / 10)

    const start = T(0)
    const end = now
    let cursor: string | null = null
    let rowsSum = 0
    let rows = 0
    let total = -1
    do {
      const p = hetPeriod(db, { start, end, cursor, limit: 7 })
      total = p.total_minutes_tenths
      rowsSum += p.tasks.reduce((a, t) => a + (t.minutes_tenths ?? 0), 0)
      rows += p.tasks.length
      cursor = p.next_cursor
    } while (cursor)
    expect(rows).toBe(30)
    expect(rowsSum).toBe(total)
    expect(total).toBe(sum.total_minutes_tenths)
    expect(total).toBeGreaterThan(0)
  })
})

describe('persistence boundary', () => {
  test('persistSummaries=false stores no summaries or titles', async () => {
    const db = freshDb()
    await tick(
      { db, transport: disabledTransport, settings: settings({ persistSummaries: false }), input: { events: backlog(3), sessionTitles: { s000: 'secret title' } }, dayOf: utcDay },
      LATER
    )
    const s = db.prepare("SELECT COUNT(*) AS n FROM het_evidence WHERE summary != ''").get() as { n: number }
    expect(s.n).toBe(0)
    const t = db.prepare('SELECT COUNT(*) AS n FROM het_tasks WHERE title IS NOT NULL').get() as { n: number }
    expect(t.n).toBe(0)
  })

  test('persistSummaries=true stores ≤200-char summaries; DB rejects longer', async () => {
    const db = freshDb()
    await tick({ db, transport: disabledTransport, settings: settings(), input: { events: backlog(2), sessionTitles: { s000: 'title' } }, dayOf: utcDay }, LATER)
    const r = db.prepare('SELECT MAX(length(summary)) AS m, COUNT(*) AS n FROM het_evidence').get() as { m: number; n: number }
    expect(r.n).toBeGreaterThan(0)
    expect(r.m).toBeLessThanOrEqual(200)
    expect(() =>
      db
        .prepare("INSERT INTO het_evidence (task_id, event_id, ts_ms, role, summary, source_file, source_line) VALUES (?, 'x', 0, 'user', ?, 'f', 1)")
        .run(hetTasks(db)[0].id, 'y'.repeat(201))
    ).toThrow()
  })
})
