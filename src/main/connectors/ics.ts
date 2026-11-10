import { tr } from '../../shared/i18n'
/**
 * Minimal iCalendar (.ics, RFC 5545) reader for the local calendar connector (S1-R3-07).
 * Pure, no dependencies, no network. Scope: VEVENT components with SUMMARY / DESCRIPTION /
 * LOCATION / DTSTART / DTEND / DURATION / RRULE / RECURRENCE-ID / STATUS / ORGANIZER / ATTENDEE.
 *
 * Limits (stated in the UI): recurrence rules are kept as text and NOT expanded; VTIMEZONE
 * definitions are not interpreted — a TZID is resolved through the system's IANA zone database
 * (Intl). An unknown TZID is treated as floating local time and reported as a warning.
 */

export interface IcsDate {
  /** ISO 8601 with offset (`2026-11-03T10:00:00+08:00`), or `YYYY-MM-DD` for all-day dates. */
  iso: string
  allDay: boolean
  /** TZID as written in the file, `UTC`, or null for floating / all-day. */
  tz: string | null
}

export interface IcsEvent {
  uid: string | null
  recurrenceId: string | null
  summary: string | null
  description: string | null
  location: string | null
  start: IcsDate | null
  end: IcsDate | null
  duration: string | null
  rrule: string | null
  status: string | null
  organizer: string | null
  attendees: number
  sequence: number | null
}

export interface IcsParseResult {
  calendarName: string | null
  events: IcsEvent[]
  warnings: string[]
}

export const MAX_ICS_EVENTS = 5000

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** RFC 5545 §3.1: a CRLF followed by a single space or tab continues the previous line. */
export function unfold(text: string): string[] {
  const raw = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
  const out: string[] = []
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1)
    else out.push(line)
  }
  return out.filter((l) => l.length > 0)
}

/** `NAME;P1=a;P2="b:c":value` → {name, params, value}. Quoted parameter values may contain : ; , */
export function parseLine(line: string): Prop | null {
  let i = 0
  let inQuote = false
  let colon = -1
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (c === ':' && !inQuote) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts: string[] = []
  let cur = ''
  inQuote = false
  for (const c of head) {
    if (c === '"') inQuote = !inQuote
    if (c === ';' && !inQuote) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  const name = parts[0].trim().toUpperCase()
  if (!name) return null
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name, params, value }
}

/** TEXT value unescape (RFC 5545 §3.3.11). */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0')

function offsetString(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

/** Offset (minutes east of UTC) of an IANA zone at a UTC instant, via Intl. Null for an unknown zone. */
export function zoneOffsetMinutes(zone: string, utcMs: number): number | null {
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return null
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]))
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - utcMs) / 60_000)
}

/** Local wall time in `zone` → offset minutes (two-pass, handles DST edges well enough for display). */
function wallTimeOffset(zone: string, y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const o1 = zoneOffsetMinutes(zone, guess)
  if (o1 === null) return null
  const o2 = zoneOffsetMinutes(zone, guess - o1 * 60_000)
  return o2 ?? o1
}

/** Local offset of this machine at a wall time (floating times). */
function localOffset(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return -new Date(y, mo - 1, d, h, mi, s).getTimezoneOffset()
}

/** DATE / DATE-TIME property → IcsDate. Returns null (with a warning) for an unparseable value. */
export function parseIcsDate(p: Prop, warn: (w: string) => void): IcsDate | null {
  const v = p.value.trim()
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (dm || p.params.VALUE === 'DATE') {
    if (!dm) {
      warn(tr(`Unreadable date: ${v.slice(0, 40)}`, `无法解析的日期：${v.slice(0, 40)}`))
      return null
    }
    return { iso: `${dm[1]}-${dm[2]}-${dm[3]}`, allDay: true, tz: null }
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)
  if (!m) {
    warn(tr(`Unreadable time: ${v.slice(0, 40)}`, `无法解析的时间：${v.slice(0, 40)}`))
    return null
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  if (m[7] === 'Z') return { iso: `${wall}+00:00`, allDay: false, tz: 'UTC' }
  const tzid = p.params.TZID?.replace(/^\//, '') ?? null
  if (tzid) {
    const off = wallTimeOffset(tzid, y, mo, d, h, mi, s)
    if (off !== null) return { iso: `${wall}${offsetString(off)}`, allDay: false, tz: tzid }
    warn(tr(`Unknown time zone ${tzid.slice(0, 60)}: read in the local time zone`, `未知时区 ${tzid.slice(0, 60)}：按本机时区解释`))
  }
  return { iso: `${wall}${offsetString(localOffset(y, mo, d, h, mi, s))}`, allDay: false, tz: null }
}

function cn(p: Prop): string | null {
  const name = p.params.CN?.trim()
  return name ? name : null
}

export function parseIcs(text: string): IcsParseResult {
  const warnings = new Set<string>()
  const warn = (w: string): void => {
    if (warnings.size < 50) warnings.add(w)
  }
  const events: IcsEvent[] = []
  let calendarName: string | null = null
  const stack: string[] = []
  let cur: IcsEvent | null = null
  let sawCalendar = false
  let truncated = false

  for (const line of unfold(text)) {
    const p = parseLine(line)
    if (!p) {
      warn(tr('Skipped unreadable lines', '跳过了无法解析的行'))
      continue
    }
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase()
      stack.push(comp)
      if (comp === 'VCALENDAR') sawCalendar = true
      if (comp === 'VEVENT' && stack.length === 2) {
        cur = {
          uid: null,
          recurrenceId: null,
          summary: null,
          description: null,
          location: null,
          start: null,
          end: null,
          duration: null,
          rrule: null,
          status: null,
          organizer: null,
          attendees: 0,
          sequence: null
        }
      }
      continue
    }
    if (p.name === 'END') {
      const comp = stack.pop()
      if (comp === 'VEVENT' && cur && stack.length === 1) {
        if (events.length >= MAX_ICS_EVENTS) truncated = true
        else events.push(cur)
        cur = null
      }
      continue
    }
    const top = stack[stack.length - 1]
    if (top === 'VCALENDAR' && p.name === 'X-WR-CALNAME') calendarName = unescapeText(p.value).trim() || null
    if (!cur || top !== 'VEVENT') continue // VALARM / VTIMEZONE / other nested components are ignored
    switch (p.name) {
      case 'UID':
        cur.uid = p.value.trim() || null
        break
      case 'RECURRENCE-ID':
        cur.recurrenceId = p.value.trim() || null
        break
      case 'SUMMARY':
        cur.summary = unescapeText(p.value).trim() || null
        break
      case 'DESCRIPTION':
        cur.description = unescapeText(p.value).trim() || null
        break
      case 'LOCATION':
        cur.location = unescapeText(p.value).trim() || null
        break
      case 'DTSTART':
        cur.start = parseIcsDate(p, warn)
        break
      case 'DTEND':
        cur.end = parseIcsDate(p, warn)
        break
      case 'DURATION':
        cur.duration = p.value.trim() || null
        break
      case 'RRULE':
        cur.rrule = p.value.trim() || null
        break
      case 'STATUS':
        cur.status = p.value.trim().toUpperCase() || null
        break
      case 'ORGANIZER':
        cur.organizer = cn(p)
        break
      case 'ATTENDEE':
        cur.attendees++
        break
      case 'SEQUENCE': {
        const n = Number(p.value)
        cur.sequence = Number.isFinite(n) ? n : null
        break
      }
    }
  }
  if (!sawCalendar) warn(tr('No BEGIN:VCALENDAR in the file; it does not look like an .ics calendar', '文件里没有 BEGIN:VCALENDAR，不像 .ics 日历文件'))
  if (truncated) warn(tr(`More than ${MAX_ICS_EVENTS} events; only the first ${MAX_ICS_EVENTS} were read`, `事件超过 ${MAX_ICS_EVENTS} 个，只读取了前 ${MAX_ICS_EVENTS} 个`))
  if (events.some((e) => e.rrule)) warn(tr('Recurring events are imported once, as defined (RRULE is not expanded)', '重复事件只按原始定义导入一次（不展开 RRULE）'))
  return { calendarName, events, warnings: [...warnings] }
}
