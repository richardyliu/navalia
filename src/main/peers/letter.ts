// S1-11 weekly letter ("每周信") draft: a deterministic Markdown template. NO LLM, no I/O,
// no clock reads — `now` and `timezone` are injected. The per-friend draft is never sent anywhere;
// the user edits it, then copies or exports it. (The broadcast variant is reused by the cloud
// subscriptions draft, cloud/subs.ts, which signs and sends only after a native confirm.)
//
// Rules:
// - Only the user's own local data (recent_activity) and the friend's verified card are used.
// - Quoted lines keep the original wording, trimmed to one line, with their ⟨id⟩.
// - Every line resting on Runtime-summarised memory carries 「未核实」.
// - S1-FULL C11 / C18: 共同经历 come ONLY from shared moments both people signed (accepted, both
//   signatures verified offline) whose visibility is `letters`; never from keyword / memory overlap.
// - Sections the user must write are left as HTML comments, never filled in for them.
import type { MemorySearchHit } from '../../shared/types'
import { UNVERIFIED, type LetterDraft } from './api'

const WINDOW_DAYS = 7
const MAX_WEEK_LINES = 30
const MAX_EXPERIENCES = 20
const MAX_QUOTE = 160

export interface LetterPeer {
  fingerprint: string
  displayName: string | null
  cardId: string
  cardIssuedAt: string
}

/** One accepted, doubly-signed shared moment the letter may mention (C11). */
export interface LetterExperience {
  momentId: string
  title: string
  start: string
  end: string
  /** Friend's display name from their verified card, or a short fingerprint. */
  friend: string
}

export interface LetterInput {
  now: Date | number
  timezone: string
  peer: LetterPeer
  recent: MemorySearchHit[] | null
  recentError?: string | null
  /**
   * C11: shared moments to list, already filtered by the caller (accepted + both signatures
   * verified + visibility `letters` + in the window). Omitted / null ⇒ empty section.
   */
  experiences?: LetterExperience[] | null
  experiencesError?: string | null
  /** `friend` (default): per-friend letter; `broadcast`: the subscribers' letter (names the friend). */
  audience?: 'friend' | 'broadcast'
}

function fmt(timezone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', ...opts })
}

/** `YYYY-MM-DD` of an instant in `timezone`. Throws RangeError for an unknown zone. */
export function localDate(instant: Date | number, timezone: string): string {
  const parts = fmt(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function localTime(instant: Date | number, timezone: string): string {
  const parts = fmt(timezone, { hour: '2-digit', minute: '2-digit' }).formatToParts(instant)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('hour')}:${get('minute')}`
}

/** Calendar arithmetic on the label itself (UTC date math), so DST never skips a day. */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

const OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/
const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/

/**
 * Place a Runtime timestamp on the local calendar. With an offset: converted into `timezone`.
 * Naive: taken as wall-clock time in `timezone`. Anything else: null (counted as undated).
 */
export function placeTimestamp(value: unknown, timezone: string): { date: string; time: string | null; sort: string } | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const v = value.trim()
  if (OFFSET_RE.test(v)) {
    const t = Date.parse(v)
    if (Number.isNaN(t)) return null
    const date = localDate(t, timezone)
    const time = localTime(t, timezone)
    return { date, time, sort: `${date}T${time}` }
  }
  const m = NAIVE_RE.exec(v)
  if (!m) return null
  const time = m[2] ? `${m[2]}:${m[3]}` : null
  if (Number.isNaN(Date.parse(`${m[1]}T${time ?? '00:00'}:00Z`))) return null
  return { date: m[1], time, sort: `${m[1]}T${time ?? '00:00'}` }
}

export function quoteLine(text: unknown, max = MAX_QUOTE): string {
  const line =
    String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*)/, '').trim())
      .find(Boolean) ?? ''
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Inclusive 7-day window ending on the local date of `now`. */
export function letterWindow(now: Date | number, timezone: string): { start: string; end: string } {
  const end = localDate(now, timezone)
  return { start: addDays(end, -(WINDOW_DAYS - 1)), end }
}

export function peerName(peer: Pick<LetterPeer, 'displayName' | 'fingerprint'>): string {
  return peer.displayName?.trim() || `朋友（${peer.fingerprint.slice(0, 8)}）`
}

function ref(id: unknown): string {
  if (typeof id !== 'string' || !id) return ''
  return id.startsWith('⟨') ? ` ${id}` : ` ⟨${id}⟩`
}

function md(text: string): string {
  // Neutralise characters that would break the template (backticks in paths).
  return text.replace(/`/g, "'")
}

export const EXPERIENCE_HEADING = { friend: '## 这周和你的共同经历', broadcast: '## 这周和朋友的共同经历' } as const

function flat(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** The letter line for one shared moment (exported so callers can find / extend it). */
export function experienceLine(e: LetterExperience, audience: 'friend' | 'broadcast' = 'friend'): string {
  const when = e.start === e.end ? e.start : `${e.start} 至 ${e.end}`
  const who = audience === 'broadcast' ? ` · 和 ${flat(e.friend)}` : ''
  return `- ${when} · 「${flat(e.title)}」${who}（双方签名确认）`
}

/** The user's own reflective note, as an indented line under its moment (only when they opt in). */
export function experienceNoteLine(note: string): string {
  return `  - 我写的：“${flat(note)}”`
}

export function buildLetter(input: LetterInput): LetterDraft {
  const { timezone, peer } = input
  const audience = input.audience ?? 'friend'
  const now = typeof input.now === 'number' ? input.now : input.now.getTime()
  const range = letterWindow(now, timezone)
  const name = peerName(peer)
  const inRange = (d: string): boolean => d >= range.start && d <= range.end

  const recent = Array.isArray(input.recent) ? input.recent : []
  const week: Array<{ e: MemorySearchHit; date: string; time: string | null; sort: string }> = []
  let undated = 0
  for (const e of recent) {
    if (!e || typeof e !== 'object') continue
    const p = placeTimestamp(e.timestamp, timezone)
    if (!p) undated++
    else if (inRange(p.date) && quoteLine(e.content)) week.push({ e, ...p })
  }
  week.sort((a, b) => a.sort.localeCompare(b.sort) || String(a.e.id).localeCompare(String(b.e.id)))

  const experiences = (Array.isArray(input.experiences) ? input.experiences : [])
    .filter((x) => x && x.start <= range.end && x.end >= range.start)
    .sort((a, b) => a.start.localeCompare(b.start) || a.momentId.localeCompare(b.momentId))

  const out: string[] = []
  out.push(`# 每周信 · 致 ${name}`)
  out.push('')
  out.push(
    `> 草稿 · ${range.start} 至 ${range.end}（${timezone}）· 生成于 ${localDate(now, timezone)} ${localTime(now, timezone)} · 按固定模板从本机数据生成，未调用 LLM，不会发送到任何地方。`
  )
  out.push(`> 标「${UNVERIFIED}」的行来自 Runtime 自动整理的记忆，寄出前请自己核对、改写或删掉。`)
  out.push('')
  out.push(`${name}，你好：`)
  out.push('')
  out.push('<!-- 在这里写一句开场白 -->')
  out.push('')

  out.push('## 这周我在做的事')
  out.push('')
  if (input.recentError) {
    out.push(`- 最近活动读取失败：${quoteLine(input.recentError)}`)
  } else if (week.length === 0) {
    out.push('- 这 7 天没有记录到活动。')
  } else {
    for (const w of week.slice(0, MAX_WEEK_LINES)) {
      out.push(`- ${w.date.slice(5)} ${w.time ?? '--:--'} · \`${md(String(w.e.path ?? ''))}\`：“${quoteLine(w.e.content)}”${ref(w.e.id)}（${UNVERIFIED}）`)
    }
    if (week.length > MAX_WEEK_LINES) out.push(`- 另有 ${week.length - MAX_WEEK_LINES} 条未列出。`)
  }
  out.push('')

  // C11 / C18: only moments both people signed and agreed may appear in letters. Nothing inferred.
  out.push(EXPERIENCE_HEADING[audience])
  out.push('')
  if (input.experiencesError) out.push(`- 读取本机共同经历失败：${quoteLine(input.experiencesError)}`)
  else if (experiences.length === 0) out.push('- 这 7 天没有双方签名确认、并且允许写进周信的共同经历。')
  else {
    for (const e of experiences.slice(0, MAX_EXPERIENCES)) out.push(experienceLine(e, audience))
    if (experiences.length > MAX_EXPERIENCES) out.push(`- 另有 ${experiences.length - MAX_EXPERIENCES} 条未列出。`)
  }
  out.push('')

  out.push('## 我想说的')
  out.push('')
  out.push('<!-- 自己写：这周最想和 TA 分享的一件事，或者一个感受 -->')
  out.push('')
  out.push('## 想问你的')
  out.push('')
  out.push('<!-- 自己写：想问 TA 的问题 -->')
  out.push('')
  out.push('## 下周打算')
  out.push('')
  out.push('<!-- 自己写 -->')
  out.push('')
  out.push('——')
  out.push('<!-- 署名 -->')
  out.push('')
  out.push('---')
  out.push('')
  out.push(
    input.recentError
      ? '- 来源 recent_activity：读取失败'
      : `- 来源 recent_activity：${recent.length} 条（7 天内 ${week.length} 条，时间未知 ${undated} 条未列入）`
  )
  out.push(`- 共同经历：${experiences.length} 条（双方签名确认、可见范围「可以写进周信」、日期在这 7 天内）`)
  out.push(`- 对方卡片：${peer.cardId}，签发于 ${peer.cardIssuedAt}，密钥指纹 ${peer.fingerprint.slice(0, 16)}…`)
  out.push('')

  return {
    fingerprint: peer.fingerprint,
    markdown: out.join('\n'),
    timezone,
    range,
    counts: { inWindow: week.length, recentTotal: recent.length, undated, experiences: experiences.length },
    suggestedFileName: `persome-letter-${range.end}-${peer.fingerprint.slice(0, 8)}.md`
  }
}
