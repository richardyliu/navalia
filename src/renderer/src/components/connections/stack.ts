import type { AccessLogDay } from '../../../../main/broker/api'
import { tr } from '../../lib/i18n'

export const TYPING_CHARS_PER_MINUTE = 300

export interface DayStack {
  day: string
  total: number
  segments: Array<{ client: string; reads: number }>
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 30 consecutive local days ending today, each with per-client read counts (zeros included). */
export function stackDays(rows: AccessLogDay[], today: Date = new Date(), days = 30): { stacks: DayStack[]; clients: string[]; max: number } {
  const clients = [...new Set(rows.map((r) => r.client))].sort()
  const byDay = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const m = byDay.get(r.day) ?? new Map<string, number>()
    m.set(r.client, (m.get(r.client) ?? 0) + r.reads)
    byDay.set(r.day, m)
  }
  const stacks: DayStack[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const day = localDay(d)
    const m = byDay.get(day)
    const segments = clients.map((client) => ({ client, reads: m?.get(client) ?? 0 }))
    stacks.push({ day, total: segments.reduce((s, x) => s + x.reads, 0), segments })
  }
  return { stacks, clients, max: Math.max(1, ...stacks.map((s) => s.total)) }
}

/** Original Access log metric: response characters / 300 per minute. Not time saved. */
export function typingMinutes(chars: number): number {
  return Math.round((chars / TYPING_CHARS_PER_MINUTE) * 10) / 10
}

/**
 * ID-13 copy, per reference §5.2 / §9.6: response chars ÷ 300 字/分 = “打字时间”, explicitly
 * “不代表节省时间”. Kept as one string so the UI and tests share the exact wording.
 */
export function typingTimeCopy(chars: number): string {
  return tr(
    `Typing time ≈ ${typingMinutes(chars)} min (response chars ÷ ${TYPING_CHARS_PER_MINUTE} chars/min; not time saved)`,
    `打字时间 ≈ ${typingMinutes(chars)} 分钟（返回字符 ÷ ${TYPING_CHARS_PER_MINUTE} 字/分；不代表节省时间）`
  )
}
