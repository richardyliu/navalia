// S1-R3-04: 「本周 AI 工作计数」 (PERFORMANCE.md option B, honest minimum). Main side: ISO-week
// bounds, the four counts, the click-through filter, and the IPC/service path. Fixture rows only:
// every het.db here is :memory: or a temp file; nothing reads ~/.persome, ~/.claude or ~/.codex.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, test } from 'vitest'
import { shellSignals } from '../../src/main/het/adapters/common'
import { ensureDefaultAnchors } from '../../src/main/het/anchors'
import { COMMIT_SIGNAL, COMMIT_SIGNAL_DEFINITION, HET_CHANNELS, HET_COUNT_FILTERS, type HetCountFilter } from '../../src/main/het/api'
import { registerHetIpc } from '../../src/main/het/ipc'
import { correctTask, openHetDb, revertCorrection } from '../../src/main/het/ledger'
import { migrateHet, type SqlDb } from '../../src/main/het/schema'
import { createHetService } from '../../src/main/het/service'
import type { TranscriptSource } from '../../src/main/het/sources'
import { hetFilteredTasks, hetWeekCounts, isoWeekBounds, zonedMidnightMs } from '../../src/main/het/weekCounts'

const SH = 'Asia/Shanghai'
// Thursday 2026-11-05 10:00 Shanghai. ISO week 2026-W45 = Mon 11-02 .. Sun 11-08.
const NOW = Date.parse('2026-11-05T02:00:00Z')
const W_START = Date.parse('2026-11-01T16:00:00Z') // Mon 11-02 00:00 Shanghai
const W_END = Date.parse('2026-11-08T16:00:00Z') // Mon 11-09 00:00 Shanghai
const HOUR = 3_600_000

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrateHet(db)
  ensureDefaultAnchors(db, W_START)
  return db
}

let seq = 0
/** Insert one fixture het_tasks row (synthetic; ids match the IPC regex). */
function row(
  db: SqlDb,
  o: { end: number; correction?: 'accepted' | 'rejected' | 'not_agent' | null; signals?: string[]; status?: string; id?: string }
): string {
  const id = o.id ?? `het_${(++seq).toString(16).padStart(20, '0')}`
  db.prepare(
    `INSERT INTO het_tasks (id, agent, project, title, start_ms, end_ms, status, correction, fingerprint, session_ids, stats, signals, created_ms, updated_ms)
     VALUES (?, 'claude-code', '/p/x', NULL, ?, ?, ?, ?, 'fp', '[]', '{}', ?, ?, ?)`
  ).run(id, o.end - 10 * 60_000, o.end, o.status ?? 'needs_assessment', o.correction ?? null, JSON.stringify(o.signals ?? []), o.end, o.end)
  return id
}

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('ISO week bounds', () => {
  test('Shanghai: Thursday → Monday 00:00 .. next Monday 00:00, ISO label', () => {
    const b = isoWeekBounds(NOW, SH)
    expect(b).toMatchObject({ isoWeek: '2026-W45', weekStart: '2026-11-02', weekEnd: '2026-11-08', startMs: W_START, endMs: W_END })
  })

  test('Sunday 23:59:59.999 is still this week; Monday 00:00 is the next week', () => {
    expect(isoWeekBounds(W_END - 1, SH).isoWeek).toBe('2026-W45')
    expect(isoWeekBounds(W_END, SH)).toMatchObject({ isoWeek: '2026-W46', weekStart: '2026-11-09', startMs: W_END })
    expect(isoWeekBounds(W_START, SH).isoWeek).toBe('2026-W45')
    expect(isoWeekBounds(W_START - 1, SH).isoWeek).toBe('2026-W44')
  })

  test('week follows the given zone, not UTC: Mon 01:00 Shanghai is Sun in UTC', () => {
    const t = W_START + HOUR // 2026-11-01T17:00Z = Sunday in UTC
    expect(isoWeekBounds(t, SH).isoWeek).toBe('2026-W45')
    expect(isoWeekBounds(t, 'UTC').isoWeek).toBe('2026-W44')
  })

  test('ISO year boundary: 2027-01-01 (Fri) belongs to 2026-W53; 2027-01-04 is 2027-W01', () => {
    const b = isoWeekBounds(Date.parse('2027-01-01T04:00:00Z'), SH)
    expect(b).toMatchObject({ isoWeek: '2026-W53', weekStart: '2026-12-28', weekEnd: '2027-01-03' })
    expect(isoWeekBounds(Date.parse('2027-01-04T04:00:00Z'), SH).isoWeek).toBe('2027-W01')
    // 2024-12-30 (Mon) starts 2025-W01
    expect(isoWeekBounds(Date.parse('2024-12-31T04:00:00Z'), 'UTC').isoWeek).toBe('2025-W01')
  })

  test('DST week (Europe/Berlin, 2026-10-25 falls back): bounds are local midnights, 169 h long', () => {
    const b = isoWeekBounds(Date.parse('2026-10-22T10:00:00Z'), 'Europe/Berlin')
    expect(b.weekStart).toBe('2026-10-19')
    expect(new Date(b.startMs).toISOString()).toBe('2026-10-18T22:00:00.000Z') // 00:00 CEST
    expect(new Date(b.endMs).toISOString()).toBe('2026-10-25T23:00:00.000Z') // 00:00 CET
    expect((b.endMs - b.startMs) / HOUR).toBe(169)
  })

  test('zonedMidnightMs is the first instant of the local date', () => {
    expect(zonedMidnightMs('2026-11-02', SH)).toBe(W_START)
    expect(zonedMidnightMs('2026-03-30', 'Europe/Berlin')).toBe(Date.parse('2026-03-29T22:00:00Z'))
  })
})

describe('week counts', () => {
  function seeded(): { db: DatabaseSync; ids: Record<string, string> } {
    const db = freshDb()
    const ids = {
      a: row(db, { end: W_START, correction: 'accepted', signals: ['git_commit'] }), // first instant of week
      b: row(db, { end: W_START + 30 * HOUR, correction: 'rejected' }),
      c: row(db, { end: W_START + 50 * HOUR, correction: 'not_agent', signals: ['git_commit', 'git_push'] }),
      d: row(db, { end: W_START + 60 * HOUR, signals: ['git_push', 'pr_create', 'pr_link'] }), // no commit
      e: row(db, { end: W_END - 1, signals: ['git_commit'], status: 'unsettled' }), // last instant
      f: row(db, { end: W_START - 1, correction: 'accepted', signals: ['git_commit'] }), // previous week
      g: row(db, { end: W_END, correction: 'rejected', signals: ['git_commit'] }) // next week
    }
    return { db, ids }
  }

  test('each count, week window [Mon 00:00, next Mon 00:00) by task end', () => {
    const { db } = seeded()
    const c = hetWeekCounts(db, { now: NOW, timezone: SH })
    expect(c.iso_week).toBe('2026-W45')
    expect(c.start).toBe(new Date(W_START).toISOString())
    expect(c.end).toBe(new Date(W_END).toISOString())
    expect(c.tasks).toBe(5)
    expect(c.counts).toEqual({ accepted: 1, rejected: 1, not_agent: 1, commit_signal: 3 })
    expect(c.commit_signal_definition).toBe(COMMIT_SIGNAL_DEFINITION)
  })

  test('counts move with corrections and their undo (no cache)', () => {
    const { db, ids } = seeded()
    correctTask(db, ids.d, 'accepted', NOW)
    expect(hetWeekCounts(db, { now: NOW, timezone: SH }).counts.accepted).toBe(2)
    correctTask(db, ids.a, 'rejected', NOW) // accepted → rejected
    expect(hetWeekCounts(db, { now: NOW, timezone: SH }).counts).toMatchObject({ accepted: 1, rejected: 2 })
    revertCorrection(db, ids.b, NOW)
    expect(hetWeekCounts(db, { now: NOW, timezone: SH }).counts).toMatchObject({ accepted: 1, rejected: 1, not_agent: 1 })
  })

  test('empty ledger / empty week: tasks 0 and all counts 0 (renderer shows the empty state)', () => {
    const db = freshDb()
    expect(hetWeekCounts(db, { now: NOW, timezone: SH })).toMatchObject({ tasks: 0, counts: { accepted: 0, rejected: 0, not_agent: 0, commit_signal: 0 } })
    row(db, { end: W_START - 1, correction: 'accepted', signals: ['git_commit'] })
    expect(hetWeekCounts(db, { now: NOW, timezone: SH }).tasks).toBe(0)
  })

  test('commit signal is exactly git_commit in het_tasks.signals; a signal-like substring elsewhere does not count', () => {
    const db = freshDb()
    row(db, { end: W_START + HOUR, signals: ['git_commit'] })
    row(db, { end: W_START + 2 * HOUR, signals: ['git_push'] })
    row(db, { end: W_START + 3 * HOUR, signals: ['pr_create'] })
    db.prepare(`UPDATE het_tasks SET title = 'git_commit' WHERE signals = '["git_push"]'`).run()
    expect(hetWeekCounts(db, { now: NOW, timezone: SH }).counts.commit_signal).toBe(1)
    expect(COMMIT_SIGNAL).toBe('git_commit')
  })

  test('the stated definition matches the adapter regex that produces git_commit', () => {
    const src = readFileSync(join(__dirname, '../../src/main/het/adapters/common.ts'), 'utf8')
    const m = /if \((\/[^\n]*\/)\.test\(cmd\)\) out\.push\('git_commit'\)/.exec(src)
    expect(m).not.toBeNull()
    expect(COMMIT_SIGNAL_DEFINITION).toContain(m![1])
    expect(shellSignals('git commit -m x')).toContain('git_commit')
    expect(shellSignals('git -C /repo commit -m x')).toContain('git_commit')
    expect(shellSignals('git push')).not.toContain('git_commit')
    expect(COMMIT_SIGNAL_DEFINITION).not.toMatch(/performance/i)
  })
})

describe('click-through filter', () => {
  test('each filter returns exactly the tasks behind its count, newest first', () => {
    const db = freshDb()
    const acc = row(db, { end: W_START + HOUR, correction: 'accepted' })
    const rej = row(db, { end: W_START + 2 * HOUR, correction: 'rejected', signals: ['git_commit'] })
    const na = row(db, { end: W_START + 3 * HOUR, correction: 'not_agent' })
    const com = row(db, { end: W_START + 4 * HOUR, signals: ['git_commit'] })
    row(db, { end: W_START + 5 * HOUR }) // uncorrected, no signal
    row(db, { end: W_START - 1, correction: 'accepted', signals: ['git_commit'] }) // other week
    const expected: Record<HetCountFilter, string[]> = { accepted: [acc], rejected: [rej], not_agent: [na], commit_signal: [com, rej] }
    const counts = hetWeekCounts(db, { now: NOW, timezone: SH })
    for (const f of HET_COUNT_FILTERS) {
      const r = hetFilteredTasks(db, { start: W_START, end: W_END, filter: f, timezone: SH })
      expect(r.tasks.map((t) => t.id)).toEqual(expected[f])
      expect(r.total).toBe(counts.counts[f])
      expect(r.filter).toBe(f)
    }
  })

  test('filtered list pages with a cursor and never repeats or drops a row', () => {
    const db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(row(db, { end: W_START + i * HOUR, signals: ['git_commit'] }))
    ids.push(row(db, { end: W_START + 2 * HOUR, signals: ['git_commit'] })) // same end_ms as ids[2]
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const p = hetFilteredTasks(db, { start: W_START, end: W_END, filter: 'commit_signal', cursor, limit: 2, timezone: SH })
      expect(p.total).toBe(6)
      seen.push(...p.tasks.map((t) => t.id))
      cursor = p.next_cursor
    } while (cursor)
    expect(seen.length).toBe(6)
    expect(new Set(seen)).toEqual(new Set(ids))
  })

  test('unknown filter is rejected', () => {
    const db = freshDb()
    expect(() => hetFilteredTasks(db, { start: W_START, end: W_END, filter: 'minutes' as HetCountFilter })).toThrow(/filter/)
  })
})

describe('service + IPC', () => {
  const noSource: TranscriptSource = {
    refresh: async () => {
      throw new Error('not used in this test')
    }
  }

  test('weekCounts / filteredTasks go through the HET service over IPC (temp het.db)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'het-weekcounts-'))
    dirs.push(dir)
    const dbFile = join(dir, 'het.db')
    const seed = openHetDb(dbFile, W_START)
    const acc = row(seed, { end: W_START + HOUR, correction: 'accepted', signals: ['git_commit'] })
    row(seed, { end: W_START + 2 * HOUR, correction: 'not_agent' })
    seed.close()

    const service = createHetService({ dbFile, settingsFile: join(dir, 'het-settings.json'), source: noSource, env: {}, now: () => NOW })
    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    registerHetIpc({ handle: (ch: string, fn: (e: unknown, a: unknown) => unknown) => void handlers.set(ch, fn) } as never, {
      service,
      chooseExportPath: async () => null
    })
    const wc = (await handlers.get(HET_CHANNELS.weekCounts)!(null, { timezone: SH })) as { ok: boolean; data: { tasks: number; counts: Record<string, number>; start: string; end: string } }
    expect(wc.ok).toBe(true)
    expect(wc.data.tasks).toBe(2)
    expect(wc.data.counts).toEqual({ accepted: 1, rejected: 0, not_agent: 1, commit_signal: 1 })

    const ft = (await handlers.get(HET_CHANNELS.filteredTasks)!(null, { start: wc.data.start, end: wc.data.end, filter: 'accepted', timezone: SH })) as {
      ok: boolean
      data: { tasks: Array<{ id: string }>; total: number }
    }
    expect(ft.ok).toBe(true)
    expect(ft.data.tasks.map((t) => t.id)).toEqual([acc])

    const bad = (await handlers.get(HET_CHANNELS.filteredTasks)!(null, { start: wc.data.start, end: wc.data.end, filter: 'score' })) as { ok: boolean }
    expect(bad.ok).toBe(false)
    const bad2 = (await handlers.get(HET_CHANNELS.weekCounts)!(null, { timezone: 'Mars/Base' })) as { ok: boolean }
    expect(bad2.ok).toBe(false)
    await service.stop()
  })
})
