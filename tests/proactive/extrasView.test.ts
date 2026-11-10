// S1-FULL C17 Settings 「本机提醒 · 进阶」 view helpers (pure).
import { describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { decisionLine, parseThreshold, shortcutText } from '../../src/renderer/src/components/proactive/proactiveExtrasView'

describe('proactive extras view', () => {
  it('decision lines say fired / not fired with the reason, gate numbers and folded repeats', () => {
    const base = { time: '2026-11-05T04:00:00.000Z', last_time: '2026-11-05T05:00:00.000Z', source_ids: [] as string[] }
    expect(decisionLine({ ...base, repeat: 1, trigger: 'meeting_ready', outcome: 'fired', reason: null, count: 4, threshold: 3 })).toBe(
      '2026-11-05T04:00:00.000Z · T8 · Sent · items 4 / threshold 3'
    )
    const s = decisionLine({ ...base, repeat: 3, trigger: 'daily_brief', outcome: 'suppressed', reason: 'below_threshold', count: 1, threshold: 2 })
    expect(s).toContain('T1 · Not sent: Not enough content (below threshold): staying silent · items 1 / threshold 2')
    expect(s).toContain('3 times in a row')
    expect(decisionLine({ ...base, repeat: 1, trigger: 'all', outcome: 'suppressed', reason: 'permission', count: null, threshold: null })).toContain('All · Not sent: No notification permission')
    setLocale('zh')
    try {
      expect(decisionLine({ ...base, repeat: 3, trigger: 'daily_brief', outcome: 'suppressed', reason: 'below_threshold', count: 1, threshold: 2 })).toContain(
        'T1 · 未发送：内容不足（低于门槛）：保持沉默 · 条目 1 / 门槛 2'
      )
      expect(decisionLine({ ...base, repeat: 1, trigger: 'all', outcome: 'suppressed', reason: 'permission', count: null, threshold: null })).toContain('全部 · 未发送：没有通知权限')
    } finally {
      setLocale('en')
    }
  })

  it('shortcut status text and threshold parsing', () => {
    expect(shortcutText({ state: 'off', accelerator: 'Alt+K', message: null }).tone).toBe('subtle')
    expect(shortcutText({ state: 'failed', accelerator: 'Alt+K', message: '冲突' })).toEqual({ tone: 'warn', text: '冲突' })
    expect(shortcutText({ state: 'registered', accelerator: 'Alt+K', message: null }).text).toContain('Alt+K')
    expect(parseThreshold('3', 50)).toBe(3)
    for (const bad of ['0', '51', '1.5', '', 'x', '-1']) expect(parseThreshold(bad, 50)).toBeNull()
  })
})
