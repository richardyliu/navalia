import { COMMIT_SIGNAL, commitSignalDefinition, HET_COUNT_FILTERS, type HetCountFilter, type HetFilteredTasks, type HetWeekCounts } from './api'
import { decCursor, encCursor, toDto, type TaskRow } from './ledger'
import type { SqlDb } from './schema'
import { addDays, dayIn, systemTimeZone } from './tz'

/**
 * S1-R3-04 「本周 AI 工作计数」 (docs/design/PERFORMANCE.md option B, honest minimum).
 *
 * Counts het_tasks rows; nothing else. No minutes, rates, scores, LLM or network. Window = the ISO
 * week (Monday 00:00 .. next Monday 00:00, local to `timezone`) containing `now`; a task belongs to
 * the week its END falls in (same attribution rule as summary / period / weekly).
 *
 *  - accepted / rejected / not_agent: het_tasks.correction (the user's manual correction), any status.
 *  - commit_signal: het_tasks.signals contains COMMIT_SIGNAL ('git_commit'), any status/correction.
 *    See COMMIT_SIGNAL_DEFINITION for the exact adapter rule.
 */

const wallFmtCache = new Map<string, Intl.DateTimeFormat>()
function wallFmt(tz: string): Intl.DateTimeFormat {
  let f = wallFmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    wallFmtCache.set(tz, f)
  }
  return f
}

/** Offset of `tz` at instant `ms`, in ms (local wall clock − UTC). */
function offsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(wallFmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return wall - Math.floor(ms / 1000) * 1000
}

/** First instant of local date `label` (YYYY-MM-DD) in `tz`. DST-safe (also when midnight is skipped). */
export function zonedMidnightMs(label: string, tz: string): number {
  const [y, m, d] = label.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  let t = guess - offsetMs(guess, tz)
  t = guess - offsetMs(t, tz)
  // Midnight skipped by a DST jump: the date then starts later that morning.
  if (dayIn(t, tz) < label) {
    let step = t
    while (dayIn(step, tz) < label) step += 15 * 60_000
    t = step
  }
  // Two candidates (fall-back at midnight): take the earliest instant that is still `label`.
  while (dayIn(t - 15 * 60_000, tz) === label) t -= 15 * 60_000
  return t
}

const dow = (label: string): number => {
  const [y, m, d] = label.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
}

/** ISO 8601 week label for the week starting Monday `mondayLabel` (year = the Thursday's year). */
function isoWeekLabel(mondayLabel: string): string {
  const thu = addDays(mondayLabel, 3)
  const year = Number(thu.slice(0, 4))
  const dayOfYear = (Date.parse(`${thu}T00:00:00Z`) - Date.UTC(year, 0, 1)) / 86_400_000 + 1
  const week = Math.floor((dayOfYear - 1) / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

export interface IsoWeekBounds {
  isoWeek: string
  /** Local Monday label. */
  weekStart: string
  /** Local Sunday label (inclusive). */
  weekEnd: string
  startMs: number
  /** Exclusive: next Monday 00:00 local. */
  endMs: number
}

export function isoWeekBounds(now: number, tz: string): IsoWeekBounds {
  const today = dayIn(now, tz)
  const monday = addDays(today, -((dow(today) + 6) % 7))
  return {
    isoWeek: isoWeekLabel(monday),
    weekStart: monday,
    weekEnd: addDays(monday, 6),
    startMs: zonedMidnightMs(monday, tz),
    endMs: zonedMidnightMs(addDays(monday, 7), tz)
  }
}

/** SQL predicate per filter. Fixed strings only (no user input is interpolated). */
const FILTER_SQL: Record<HetCountFilter, string> = {
  accepted: "correction = 'accepted'",
  rejected: "correction = 'rejected'",
  not_agent: "correction = 'not_agent'",
  commit_signal: `EXISTS (SELECT 1 FROM json_each(het_tasks.signals) WHERE json_each.value = '${COMMIT_SIGNAL}')`
}

function assertFilter(f: unknown): asserts f is HetCountFilter {
  if (!HET_COUNT_FILTERS.includes(f as HetCountFilter)) throw new Error(`invalid count filter ${String(f)}`)
}

export function hetWeekCounts(db: SqlDb, opts: { now: number; timezone?: string }): HetWeekCounts {
  const tz = opts.timezone ?? systemTimeZone()
  const b = isoWeekBounds(opts.now, tz)
  const r = db
    .prepare(
      `SELECT COUNT(*) AS tasks,
              COALESCE(SUM(${FILTER_SQL.accepted}), 0) AS accepted,
              COALESCE(SUM(${FILTER_SQL.rejected}), 0) AS rejected,
              COALESCE(SUM(${FILTER_SQL.not_agent}), 0) AS not_agent,
              COALESCE(SUM(${FILTER_SQL.commit_signal}), 0) AS commit_signal
         FROM het_tasks WHERE end_ms >= ? AND end_ms < ?`
    )
    .get(b.startMs, b.endMs) as { tasks: number; accepted: number; rejected: number; not_agent: number; commit_signal: number }
  return {
    iso_week: b.isoWeek,
    week_start: b.weekStart,
    week_end: b.weekEnd,
    start: new Date(b.startMs).toISOString(),
    end: new Date(b.endMs).toISOString(),
    timezone: tz,
    tasks: Number(r.tasks),
    counts: {
      accepted: Number(r.accepted),
      rejected: Number(r.rejected),
      not_agent: Number(r.not_agent),
      commit_signal: Number(r.commit_signal)
    },
    commit_signal_definition: commitSignalDefinition()
  }
}

/** Click-through list: tasks ending in [start, end) matching `filter`, newest first, cursor-paged. */
export function hetFilteredTasks(
  db: SqlDb,
  opts: { start: number; end: number; filter: HetCountFilter; cursor?: string | null; limit?: number; timezone?: string }
): HetFilteredTasks {
  assertFilter(opts.filter)
  if (!(opts.end > opts.start)) throw new Error('filtered tasks: end must be after start')
  const tz = opts.timezone ?? systemTimeZone()
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200)
  const where = `end_ms >= ? AND end_ms < ? AND ${FILTER_SQL[opts.filter]}`
  const c = opts.cursor ? decCursor(opts.cursor) : null
  const rows = (
    c
      ? db
          .prepare(`SELECT * FROM het_tasks WHERE ${where} AND (end_ms < ? OR (end_ms = ? AND id < ?)) ORDER BY end_ms DESC, id DESC LIMIT ?`)
          .all(opts.start, opts.end, c.end, c.end, c.id, limit + 1)
      : db.prepare(`SELECT * FROM het_tasks WHERE ${where} ORDER BY end_ms DESC, id DESC LIMIT ?`).all(opts.start, opts.end, limit + 1)
  ) as unknown as TaskRow[]
  const page = rows.slice(0, limit)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM het_tasks WHERE ${where}`).get(opts.start, opts.end) as { n: number }).n
  return {
    start: new Date(opts.start).toISOString(),
    end: new Date(opts.end).toISOString(),
    filter: opts.filter,
    timezone: tz,
    tasks: page.map((r) => ({ ...toDto(db, r, false), day: dayIn(r.end_ms, tz) })),
    next_cursor: rows.length > limit ? encCursor(page[page.length - 1].end_ms, page[page.length - 1].id) : null,
    total: Number(total)
  }
}
