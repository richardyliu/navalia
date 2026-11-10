import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, test } from 'vitest'
import { ensureDefaultAnchors } from '../../src/main/het/anchors'
import { HET_CHANNELS } from '../../src/main/het/api'
import { disabledTransport, type AssessorTransport } from '../../src/main/het/assessor'
import { registerHetIpc } from '../../src/main/het/ipc'
import { ACTIVITY_MAX_MARKERS, hetActivity, hetPeriod, hetSummary } from '../../src/main/het/ledger'
import { migrateHet } from '../../src/main/het/schema'
import { createHetService } from '../../src/main/het/service'
import { DEFAULT_HET_SETTINGS } from '../../src/main/het/settings'
import { tick } from '../../src/main/het/tick'
import type { AgentEvent } from '../../src/main/het/types'
import { addDays, dayIn, daysBetween, isValidTimeZone, lastDays } from '../../src/main/het/tz'

const H = 3_600_000
const iso = (s: string): number => Date.parse(s)
const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function ev(s: string, ts: number, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    agent: 'claude-code', sessionId: s, ts, cwd: `/p/${s}`, project: `/p/${s}`, role: 'assistant', toolNames: [], filesWritten: [],
    filesRead: [], signals: [], summary: '', sidechain: false, source: { file: `/t/${s}.jsonl`, line: Math.floor(ts / 1000) % 1e6 }, ...over
  }
}
/** One task per entry: [session, end instant]; starts 1 minute before. */
const taskEvents = (spec: Array<[string, number, Partial<AgentEvent>?]>): AgentEvent[] =>
  spec.flatMap(([s, end, over]) => [ev(s, end - 60_000, { role: 'user', ...over }), ev(s, end, over)])
const ok: AssessorTransport = {
  name: 'mock',
  async complete() {
    return { outcome: 'ok', text: JSON.stringify({ kind: 'coding', size: 'm', complexity: 'medium', agent_share: 1, adoption: 'unknown', evidence: [] }) }
  }
}
const freshDb = () => {
  const db = new DatabaseSync(':memory:')
  migrateHet(db)
  ensureDefaultAnchors(db, 0)
  return db
}

describe('time zones', () => {
  test('IANA validation', () => {
    for (const z of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Shanghai', 'Australia/Lord_Howe']) expect(isValidTimeZone(z), z).toBe(true)
    for (const z of ['Mars/Base', '', 'EST5EDT;drop', 'x'.repeat(80)]) expect(isValidTimeZone(z), z).toBe(false)
  })

  test('DST fall-back (America/New_York, 2025-11-02 is 25 h): labels neither repeat nor skip', () => {
    const tz = 'America/New_York'
    expect(dayIn(iso('2025-11-02T04:30:00Z'), tz)).toBe('2025-11-02') // 00:30 EDT
    expect(dayIn(iso('2025-11-03T04:30:00Z'), tz)).toBe('2025-11-02') // 23:30 EST, still Nov 2
    const now = iso('2025-11-03T04:30:00Z')
    expect(lastDays(now, 3, tz)).toEqual(['2025-10-31', '2025-11-01', '2025-11-02'])
    // the naive "now − i × 24 h" method repeats Nov 2 here — the bug this avoids
    const naive = [2, 1, 0].map((i) => dayIn(now - i * 24 * H, tz))
    expect(naive).toEqual(['2025-11-01', '2025-11-02', '2025-11-02'])
  })

  test('DST spring-forward (Europe/Berlin, 2025-03-30 is 23 h)', () => {
    const tz = 'Europe/Berlin'
    expect(daysBetween(iso('2025-03-29T23:00:00Z'), iso('2025-03-31T22:00:00Z'), tz)).toEqual(['2025-03-30', '2025-03-31'])
    expect(lastDays(iso('2025-03-30T22:30:00Z'), 2, tz)).toEqual(['2025-03-30', '2025-03-31']) // 00:30 CEST Mar 31
    expect(addDays('2025-03-30', 1)).toBe('2025-03-31')
  })

  test('summary buckets by the requested zone across the DST boundary', async () => {
    const db = freshDb()
    // ends at 2025-11-03T03:30Z = 22:30 EST Nov 2 (NY) but Nov 3 in UTC
    const events = taskEvents([['late', iso('2025-11-03T03:30:00Z')], ['early', iso('2025-11-02T05:30:00Z')]])
    const now = iso('2025-11-03T12:00:00Z')
    await tick({ db, transport: ok, settings: { ...DEFAULT_HET_SETTINGS, perTickCap: 5 }, input: { events } }, now)
    const ny = hetSummary(db, { now, days: 3, timezone: 'America/New_York' })
    expect(ny.timezone).toBe('America/New_York')
    expect(ny.days.map((d) => [d.date, d.tasks])).toEqual([['2025-11-01', 0], ['2025-11-02', 2], ['2025-11-03', 0]])
    const utc = hetSummary(db, { now, days: 3, timezone: 'UTC' })
    expect(utc.days.map((d) => [d.date, d.tasks])).toEqual([['2025-11-01', 0], ['2025-11-02', 1], ['2025-11-03', 1]])
    expect(ny.total_minutes_tenths).toBe(utc.total_minutes_tenths)
    const p = hetPeriod(db, { start: iso('2025-11-01T00:00:00Z'), end: now, timezone: 'America/New_York' })
    expect(p.timezone).toBe('America/New_York')
    expect(p.tasks.map((t) => t.day)).toEqual(['2025-11-02', '2025-11-02'])
  })
})

describe('activity (Lens-defined shape)', () => {
  test('per-day buckets incl. by_agent and pending; total = Σ days; markers capped at 500', async () => {
    const db = freshDb()
    const base = iso('2025-09-01T12:00:00Z')
    const spec: Array<[string, number, Partial<AgentEvent>?]> = []
    for (let i = 0; i < 520; i++) spec.push([`t${String(i).padStart(3, '0')}`, base + i * 2 * H, i % 4 === 0 ? { agent: 'codex' } : {}])
    const events = taskEvents(spec)
    const now = base + 520 * 2 * H + 2 * H
    await tick({ db, transport: ok, settings: { ...DEFAULT_HET_SETTINGS, perTickCap: 10, perDayCap: 100 }, input: { events } }, now)
    await tick({ db, transport: disabledTransport, settings: DEFAULT_HET_SETTINGS, input: { events } }, now + 1)
    const a = hetActivity(db, { start: base - H, end: now, timezone: 'UTC' })
    expect(a.timezone).toBe('UTC')
    expect(a.days[0].date).toBe('2025-09-01')
    expect(a.total_minutes_tenths).toBe(a.days.reduce((s, d) => s + d.minutes_tenths, 0))
    expect(a.total_minutes_tenths).toBe(10 * 135) // 10 assessed × coding/m/medium/unknown (45 × 0.3 = 13.5 min)
    const counted = a.days.reduce((s, d) => s + d.tasks, 0)
    const pending = a.days.reduce((s, d) => s + d.pending, 0)
    expect(counted).toBe(10)
    expect(pending).toBe(510)
    const byAgent = a.days.reduce<Record<string, number>>((acc, d) => {
      for (const [k, v] of Object.entries(d.by_agent)) acc[k] = (acc[k] ?? 0) + v.tasks
      return acc
    }, {})
    expect(Object.values(byAgent).reduce((x, y) => x + y, 0)).toBe(10)
    expect(a.markers).toHaveLength(ACTIVITY_MAX_MARKERS)
    expect(a.markers_total).toBe(520)
    expect(a.markers_truncated).toBe(true)
    expect(a.markers[0]).toMatchObject({ agent: 'codex', counted: true, minutes_tenths: 135 })
    expect(a.markers.every((m, i) => i === 0 || m.start >= a.markers[i - 1].start)).toBe(true)
  })

  test('bounds: ≤ 92 days, end > start', () => {
    const db = freshDb()
    expect(() => hetActivity(db, { start: 0, end: 92 * 24 * H })).not.toThrow()
    expect(() => hetActivity(db, { start: 0, end: 92 * 24 * H + 1 })).toThrow(/92 days/)
    expect(() => hetActivity(db, { start: 5, end: 5 })).toThrow(/after start/)
    expect(hetActivity(db, { start: 0, end: 3 * 24 * H, timezone: 'UTC' }).days.map((d) => d.date)).toEqual(['1970-01-01', '1970-01-02', '1970-01-03'])
  })

  test('IPC: activity channel; timezone validated on summary/period/activity', async () => {
    const d = mkdtempSync(join(tmpdir(), 'het-act-'))
    dirs.push(d)
    const svc = createHetService({ dbFile: join(d, 'het.db'), settingsFile: join(d, 's.json'), env: { LENS_HET_CLAUDE_ROOT: '', LENS_HET_CODEX_ROOT: '' } })
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<{ ok: boolean; data?: any }>>()
    registerHetIpc({ handle: (ch: string, fn: any) => void handlers.set(ch, fn) }, { service: svc, chooseExportPath: async () => null })
    const call = (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw)
    const range = { start: '2025-09-01T00:00:00Z', end: '2025-09-08T00:00:00Z' }
    // 7 UTC days span 8 local dates at +08:00
    const sh = (await call(HET_CHANNELS.activity, { ...range, timezone: 'Asia/Shanghai' })).data
    expect(sh.days.map((x: { date: string }) => x.date)).toEqual(['2025-09-01', '2025-09-02', '2025-09-03', '2025-09-04', '2025-09-05', '2025-09-06', '2025-09-07', '2025-09-08'])
    expect((await call(HET_CHANNELS.activity, { ...range, timezone: 'UTC' })).data.days).toHaveLength(7)
    expect((await call(HET_CHANNELS.activity, { ...range, timezone: 'Mars/Base' })).ok).toBe(false)
    expect((await call(HET_CHANNELS.activity, { start: range.start, end: '2026-01-01T00:00:00Z' })).ok).toBe(false)
    expect((await call(HET_CHANNELS.activity, { ...range, extra: 1 })).ok).toBe(false)
    expect((await call(HET_CHANNELS.summary, { days: 7, timezone: 'Europe/Berlin' })).data.timezone).toBe('Europe/Berlin')
    expect((await call(HET_CHANNELS.summary, { days: 7, timezone: 'Nope/Zone' })).ok).toBe(false)
    expect((await call(HET_CHANNELS.summary)).data.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect((await call(HET_CHANNELS.period, { ...range, timezone: 'UTC' })).data.timezone).toBe('UTC')
    expect((await call(HET_CHANNELS.period, { ...range, timezone: 'bad' })).ok).toBe(false)
    await svc.stop()
  })
})
