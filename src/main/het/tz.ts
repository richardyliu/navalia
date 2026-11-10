/**
 * IANA time-zone helpers for HET day bucketing (reference §11.1 `timezone=` on period).
 * Pure; uses Intl only. Day labels are `YYYY-MM-DD` in the given zone; calendar arithmetic
 * is done on the label (UTC date math), so DST days (23 h / 25 h) never skip or repeat.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>()

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    if (!isValidTimeZone(tz)) throw new Error(`invalid time zone: ${tz}`)
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    fmtCache.set(tz, f)
  }
  return f
}

/** Local calendar date of `ms` in `tz`. */
export function dayIn(ms: number, tz: string): string {
  const parts = fmt(tz).formatToParts(new Date(ms))
  const get = (t: string): string => parts.find((p) => p.type === t)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** `YYYY-MM-DD` shifted by `n` calendar days (zone-independent). */
export function addDays(label: string, n: number): string {
  const [y, m, d] = label.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** The `days` calendar labels ending with today's label in `tz`, oldest first. */
export function lastDays(now: number, days: number, tz: string): string[] {
  const today = dayIn(now, tz)
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(addDays(today, -i))
  return out
}

/** Calendar labels covering [startMs, endMs) in `tz`. */
export function daysBetween(startMs: number, endMs: number, tz: string): string[] {
  if (endMs <= startMs) return []
  const first = dayIn(startMs, tz)
  const last = dayIn(endMs - 1, tz)
  const out: string[] = []
  for (let l = first; l <= last; l = addDays(l, 1)) out.push(l)
  return out
}
