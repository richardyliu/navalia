// S1-09 daily brief: a deterministic Markdown template. NO LLM call, no I/O, no clock reads —
// `now` and `timezone` are injected. Pure so the renderer can import it and tests can snapshot it.
//
// Rules:
// - Only data the Runtime / HET returned is used. `下一步` (S2-08, formerly 明天建议) restates real
//   items only: explicitly unfinished lines (`- [ ]`, `TODO:`, `待办：`) in today's and yesterday's
//   records, and learned habits quoted verbatim; never invents. It is not a Performance score.
// - Every line that rests on an inference (Runtime-summarised memory, HET estimates, template
//   extraction of “unfinished” lines) carries the explicit label 「未核实」.
// - Quoted source text keeps the original wording (“引用原话”), trimmed to one line.
import type { BehaviorPatterns, MemorySearchHit, RecentActivityResponse } from '../../shared/types'
import type { HetSummary } from '../het/api'

export const UNVERIFIED = '未核实'

export interface BriefInput {
  now: Date | number
  /** IANA time zone used for the day boundary (e.g. `Asia/Shanghai`). */
  timezone: string
  recent: RecentActivityResponse | null
  recentError?: string | null
  patterns: BehaviorPatterns | null
  patternsError?: string | null
  het: HetSummary | null
  hetError?: string | null
}

export interface BriefDoneItem {
  time: string | null
  path: string
  quote: string
  ref: string
}

/** Where a 下一步 item came from. Every item has one; an item without a source is never emitted. */
export type NextStepSource =
  | {
      kind: 'record'
      /** recent_activity entry id (receipt for EvidenceDrawer). */
      ref: string
      path: string
      /** Local date / time of the record in the brief's time zone. */
      date: string
      time: string | null
      /** The original line, verbatim (trimmed). */
      line: string
    }
  | { kind: 'habit'; observations: number | null; confidence: number | null }

export interface NextStepItem {
  /** Stable key (normalized text) used for dedupe and React keys. */
  key: string
  kind: 'todo' | 'habit'
  /** Verbatim text: the unfinished item, or the Face signature. */
  text: string
  /** Always 「未核实」. */
  label: typeof UNVERIFIED
  /** `today` / `yesterday` for records, null for habits. */
  day: 'today' | 'yesterday' | null
  source: NextStepSource
}

export interface Brief {
  date: string
  timezone: string
  markdown: string
  /** S2-08 下一步, in the order they appear in the markdown. */
  nextSteps: NextStepItem[]
  counts: { done: number; todo: number; review: number; recentTotal: number; recentToday: number }
}

const MAX_DONE = 40
const MAX_TODO = 20
const MAX_QUOTE = 160
const MAX_HABITS = 3

function formatter(timezone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', ...opts })
}

/** `YYYY-MM-DD` of an instant in `timezone`. Throws RangeError for an unknown zone. */
export function localDateIn(instant: Date | number, timezone: string): string {
  const parts = formatter(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function localTimeIn(instant: Date | number, timezone: string): string {
  const parts = formatter(timezone, { hour: '2-digit', minute: '2-digit' }).formatToParts(instant)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('hour')}:${get('minute')}`
}

const OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/
const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/

/**
 * Place a Runtime timestamp on the brief's local calendar.
 * - With an offset / `Z`: an exact instant, converted into `timezone`.
 * - Naive (`2026-11-05T09:30`, `2026-11-05`): taken as wall-clock time in `timezone`
 *   (the Runtime writes local wall time); no conversion.
 * - Anything else: null (the entry goes to 待核对 as “时间未知”).
 */
export function placeTimestamp(value: string | undefined | null, timezone: string): { date: string; time: string | null; sort: string } | null {
  if (!value || typeof value !== 'string') return null
  const v = value.trim()
  if (OFFSET_RE.test(v)) {
    const t = Date.parse(v)
    if (Number.isNaN(t)) return null
    const date = localDateIn(t, timezone)
    const time = localTimeIn(t, timezone)
    return { date, time, sort: `${date}T${time}` }
  }
  const m = NAIVE_RE.exec(v)
  if (!m) return null
  const time = m[2] ? `${m[2]}:${m[3]}` : null
  if (Number.isNaN(Date.parse(`${m[1]}T${time ?? '00:00'}:00Z`))) return null
  // Sort key is local wall-clock text, so exact and naive timestamps order on one calendar.
  return { date: m[1], time, sort: `${m[1]}T${time ?? '00:00'}` }
}

/** One-line verbatim quote: first non-empty line, markdown heading/bullet markers stripped. */
export function quoteLine(text: string, max = MAX_QUOTE): string {
  const line =
    String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*)/, '').trim())
      .find(Boolean) ?? ''
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function clip(text: string, max = MAX_QUOTE): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const OPEN_BOX_RE = /^\s*[-*+]\s+\[ \]\s+(.+)$/
const DONE_BOX_RE = /^\s*[-*+]\s+\[[xX]\]\s+(.+)$/
// S2-08: only the three explicit markers. Case-sensitive `TODO` (a prose “todo” is not a marker).
const TODO_RE = /^\s*(?:[-*+]\s+)?(?:TODO|待办)\s*[:：]\s*(.+)$/

/** Lines in a record that explicitly say they are unfinished (`- [ ] …`, `TODO: …`, `待办：…`). */
export function extractTodoLines(entry: MemorySearchHit): Array<{ quote: string; line: string }> {
  const out: Array<{ quote: string; line: string }> = []
  for (const line of String(entry.content ?? '').split(/\r?\n/)) {
    const m = OPEN_BOX_RE.exec(line) ?? TODO_RE.exec(line)
    if (m && m[1].trim()) out.push({ quote: clip(m[1]), line: clip(line, 300) })
  }
  return out
}

/** Lines explicitly checked off (`- [x] …`) in a record. */
function extractDoneLines(entry: MemorySearchHit): string[] {
  const out: string[] = []
  for (const line of String(entry.content ?? '').split(/\r?\n/)) {
    const m = DONE_BOX_RE.exec(line)
    if (m && m[1].trim()) out.push(clip(m[1]))
  }
  return out
}

/** Dedupe key: NFKC, whitespace fold, casefold, trailing punctuation dropped. */
export function nextStepKey(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s.。!！?？;；,，:：…]+$/u, '')
}

/** Calendar day before `date` (`YYYY-MM-DD`), pure date arithmetic (no zone involved). */
export function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d - 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

type Placed = { entry: MemorySearchHit; date: string; time: string | null; sort: string }

/**
 * S2-08 下一步. Deterministic: depends only on the arguments. Records are today's and yesterday's
 * (local calendar in the brief's zone); undated records are excluded (they go to 待核对).
 * Order: today before yesterday, then time, entry id, line order. An item is dropped when a record
 * at the same time or later checks the same text off (`- [x]`). Habits: Faces in the Runtime's
 * HUMAN.md order (observations desc, confidence desc), text verbatim.
 */
export function buildNextSteps(placed: Placed[], today: string, patterns: BehaviorPatterns | null): NextStepItem[] {
  const yesterday = previousDate(today)
  const window = placed
    .filter((p) => p.date === today || p.date === yesterday)
    .sort((a, b) => (a.date === b.date ? 0 : a.date === today ? -1 : 1) || a.sort.localeCompare(b.sort) || a.entry.id.localeCompare(b.entry.id))
  const done = window.flatMap((p) => extractDoneLines(p.entry).map((t) => ({ key: nextStepKey(t), sort: p.sort })))
  const out: NextStepItem[] = []
  const seen = new Set<string>()
  for (const p of window) {
    const ref = String(p.entry.id ?? '').trim()
    if (!ref) continue // no receipt → no item (no fabrication)
    for (const t of extractTodoLines(p.entry)) {
      const key = nextStepKey(t.quote)
      if (!key || seen.has(key)) continue
      if (done.some((d) => d.key === key && d.sort >= p.sort)) continue
      seen.add(key)
      out.push({
        key,
        kind: 'todo',
        text: t.quote,
        label: UNVERIFIED,
        day: p.date === today ? 'today' : 'yesterday',
        source: { kind: 'record', ref, path: String(p.entry.path ?? ''), date: p.date, time: p.time, line: t.line.trim() }
      })
    }
  }
  const faces = (Array.isArray(patterns?.faces) ? patterns.faces : [])
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f && typeof f.signature === 'string' && f.signature.trim())
    .sort((a, b) => (b.f.observations ?? 0) - (a.f.observations ?? 0) || (b.f.confidence ?? 0) - (a.f.confidence ?? 0) || a.i - b.i)
    .slice(0, MAX_HABITS)
  for (const { f } of faces) {
    const text = f.signature.replace(/\s+/g, ' ').trim()
    const key = `habit:${nextStepKey(text)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      kind: 'habit',
      text,
      label: UNVERIFIED,
      day: null,
      source: {
        kind: 'habit',
        observations: typeof f.observations === 'number' ? f.observations : null,
        confidence: typeof f.confidence === 'number' ? f.confidence : null
      }
    })
  }
  return out
}

function ref(id: string): string {
  return id ? ` ⟨${id}⟩` : ''
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function buildBrief(input: BriefInput): Brief {
  const { timezone } = input
  const now = typeof input.now === 'number' ? input.now : input.now.getTime()
  const date = localDateIn(now, timezone)
  const entries = Array.isArray(input.recent?.entries) ? input.recent.entries : []

  const today: Array<{ entry: MemorySearchHit; time: string | null; sort: string }> = []
  const undated: MemorySearchHit[] = []
  const placedAll: Placed[] = []
  for (const entry of entries) {
    const placed = placeTimestamp(entry.timestamp, timezone)
    if (!placed) undated.push(entry)
    else {
      placedAll.push({ entry, ...placed })
      if (placed.date === date) today.push({ entry, time: placed.time, sort: placed.sort })
    }
  }
  today.sort((a, b) => a.sort.localeCompare(b.sort) || a.entry.id.localeCompare(b.entry.id))

  const done: BriefDoneItem[] = today.map(({ entry, time }) => ({
    time,
    path: entry.path,
    quote: quoteLine(entry.content),
    ref: entry.id
  }))
  const nextSteps = buildNextSteps(placedAll, date, input.patterns)
  const todos = nextSteps.filter((n) => n.kind === 'todo')
  const habits = nextSteps.filter((n) => n.kind === 'habit')

  const md: string[] = []
  md.push(`# 今日 brief · ${date}`)
  md.push('')
  md.push(`> 时区 ${timezone} · 生成于 ${date} ${localTimeIn(now, timezone)} · 按固定模板从本地数据生成，未调用 LLM。`)
  md.push(`> 标「${UNVERIFIED}」的行来自 Runtime 自动整理的记忆或模板推断，请自行核对。`)
  md.push('')

  // ── 今天做了什么 ──
  md.push('## 今天做了什么')
  md.push('')
  if (input.recentError) {
    md.push(`- 最近活动读取失败：${clip(input.recentError)}`)
  } else if (done.length === 0) {
    md.push('- 今天还没有记录到活动。')
  } else {
    for (const d of done.slice(0, MAX_DONE)) {
      md.push(`- ${d.time ?? '--:--'} · \`${d.path}\`：“${d.quote}”${ref(d.ref)}（${UNVERIFIED}）`)
    }
    if (done.length > MAX_DONE) md.push(`- 另有 ${done.length - MAX_DONE} 条未列出。`)
  }
  md.push(...hetLines(input, date))
  md.push('')

  // ── 下一步 (S2-08) ──
  md.push('## 下一步')
  md.push('')
  md.push(`> 只列今天 / 昨天记录里明确写着未完成的事（\`- [ ]\`、\`TODO:\`、\`待办：\`）和已学到的习惯原文；每条都${UNVERIFIED}。`)
  md.push('')
  if (input.recentError) {
    md.push('- 最近活动读取失败，无法列出未完成事项。')
  } else if (todos.length === 0) {
    md.push('- 今天和昨天的记录里没有标为未完成的事项，因此不列待办。')
  } else {
    for (const t of todos.slice(0, MAX_TODO)) {
      const src = t.source.kind === 'record' ? t.source : null
      const when = src ? `${t.day === 'today' ? '今天' : '昨天'} ${src.time ?? '--:--'}` : ''
      md.push(`- [ ] “${t.text}”（${UNVERIFIED}；来源 ${when} \`${src?.path ?? ''}\`${ref(src?.ref ?? '')}）`)
    }
    if (todos.length > MAX_TODO) md.push(`- 另有 ${todos.length - MAX_TODO} 条未列出。`)
  }
  for (const h of habits) {
    const src = h.source.kind === 'habit' ? h.source : null
    const obs = src?.observations !== null && src?.observations !== undefined ? `观察 ${src.observations} 次` : '观察次数未知'
    const conf = src?.confidence !== null && src?.confidence !== undefined ? `，置信 ${pct(src.confidence)}` : ''
    md.push(`- 已学到的习惯：“${h.text}”（${UNVERIFIED}；来源 behavior_patterns，${obs}${conf}）`)
  }
  if (input.patternsError) md.push(`- 行为模式读取失败：${clip(input.patternsError)}`)
  md.push('')

  // ── 待核对 ──
  md.push('## 待核对')
  md.push('')
  const review: string[] = []
  if (done.length > 0) review.push(`- [ ] 核对「今天做了什么」的 ${done.length} 条是否准确（由 Runtime 自动整理）`)
  if (todos.length > 0) review.push(`- [ ] 确认 ${todos.length} 条“未完成”事项是否仍未完成`)
  for (const u of undated.slice(0, MAX_TODO)) {
    review.push(`- [ ] 时间未知，无法判断是否属于今天：\`${u.path}\`：“${quoteLine(u.content)}”${ref(u.id)}`)
  }
  const het = input.het
  if (het && !input.hetError) {
    if (het.pending > 0) review.push(`- [ ] HET 有 ${het.pending} 个任务等待评估，评估前计 0 分钟`)
    if (het.failed > 0) review.push(`- [ ] HET 有 ${het.failed} 个任务评估失败，不计入总数`)
    if (het.unsettled > 0) review.push(`- [ ] HET 有 ${het.unsettled} 个会话仍在进行`)
  }
  if (review.length === 0) review.push('- 没有需要核对的条目。')
  md.push(...review)
  md.push('')

  // ── 来源 ──
  md.push('## 来源')
  md.push('')
  md.push(
    input.recentError
      ? '- recent_activity：读取失败'
      : `- recent_activity：${entries.length} 条（今天 ${today.length} 条，时间未知 ${undated.length} 条）`
  )
  md.push(
    input.patternsError || !input.patterns
      ? '- behavior_patterns：不可用'
      : `- behavior_patterns：${input.patterns.faces?.length ?? 0} 个模式，${input.patterns.skills?.length ?? 0} 个技能`
  )
  md.push(input.hetError || !het ? '- HET summary：不可用' : `- HET summary：状态 ${het.state}`)
  md.push('')

  return {
    date,
    timezone,
    markdown: md.join('\n'),
    nextSteps,
    counts: {
      done: done.length,
      todo: todos.length,
      review: review.filter((l) => l.startsWith('- [ ]')).length,
      recentTotal: entries.length,
      recentToday: today.length
    }
  }
}

function hetLines(input: BriefInput, date: string): string[] {
  if (input.hetError) return [`- AI 协作时间（HET）：读取失败：${clip(input.hetError)}`]
  const het = input.het
  if (!het) return ['- AI 协作时间（HET）：不可用']
  const day = Array.isArray(het.days) ? het.days.find((d) => d.date === date) : undefined
  const minutes = day?.minutes ?? 0
  const tasks = day?.tasks ?? 0
  const zoneNote = het.timezone && het.timezone !== input.timezone ? `；HET 按 ${het.timezone} 分日` : ''
  if (tasks === 0 && minutes === 0) {
    return [
      `- AI 协作时间（HET）：今天 0 分钟，0 个已评估任务（状态 ${het.state}${zoneNote}；评估器未开启或尚无完成的评估时为 0）`
    ]
  }
  return [`- AI 协作时间（HET）：今天约 ${minutes} 分钟，${tasks} 个已评估任务（状态 ${het.state}${zoneNote}；HET 是估算，${UNVERIFIED}）`]
}
