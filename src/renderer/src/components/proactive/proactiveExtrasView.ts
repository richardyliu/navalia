// S1-FULL C17 「本机提醒 · 进阶」 view helpers (pure, tested in tests/proactive/extrasView.test.ts).
import {
  DECISION_REASON_LABEL,
  TRIGGER_CODE,
  type ProactiveDecision,
  type ProactiveShortcutStatus
} from '../../../../main/proactive/api'
import { tr } from '../../lib/i18n'

export function decisionLine(d: ProactiveDecision): string {
  const who = d.trigger === 'all' ? tr('All', '全部') : TRIGGER_CODE[d.trigger]
  const reason = d.reason ? DECISION_REASON_LABEL[d.reason] : '—'
  const what = d.outcome === 'fired' ? tr('Sent', '已发送') : tr(`Not sent: ${reason}`, `未发送：${reason}`)
  const gate =
    d.count !== null
      ? tr(` · items ${d.count}${d.threshold !== null ? ` / threshold ${d.threshold}` : ''}`, ` · 条目 ${d.count}${d.threshold !== null ? ` / 门槛 ${d.threshold}` : ''}`)
      : ''
  const rep = d.repeat > 1 ? tr(` · ${d.repeat} times in a row (latest ${d.last_time})`, ` · 连续 ${d.repeat} 次（最近 ${d.last_time}）`) : ''
  return `${d.time} · ${who} · ${what}${gate}${rep}`
}

export function shortcutText(s: ProactiveShortcutStatus): { tone: 'ok' | 'warn' | 'subtle'; text: string } {
  if (s.state === 'registered') return { tone: 'ok', text: tr(`Registered ${s.accelerator}: press it to open the page of the latest notification`, `已注册 ${s.accelerator}：按下打开最近一条提醒对应的页面`) }
  if (s.state === 'failed') return { tone: 'warn', text: s.message }
  return { tone: 'subtle', text: tr('Not registered (off)', '未注册（关闭中）') }
}

/** Parses a threshold input; null when not an integer in 1..max. */
export function parseThreshold(text: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= 1 && n <= max ? n : null
}
