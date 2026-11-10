// S1-FULL C17: the 「提醒」 entries the menu bar icon menu may show (pure model, renderer-safe types).
// Proactive does not create a second Tray: the shell tray (src/main/shell/**) owns the icon and asks
// for these items through the wiring request in docs/design/s1full-log/C16-C17.md. Empty unless both
// the master switch and the tray switch are on. Labels carry counts only.
import { tr } from '../../shared/i18n'
import type { ProactiveSettings, ProactiveTrayItem } from './api'

export function proactiveTrayItems(v: { settings: ProactiveSettings; settingsError: string | null; sentToday: number; quietNow: boolean }): ProactiveTrayItem[] {
  if (v.settingsError || !v.settings.enabled || !v.settings.tray) return []
  return [
    {
      kind: 'info',
      label: tr(
        `Proactive: ${v.sentToday}/${v.settings.dailyCap} sent today${v.quietNow ? ' (quiet hours)' : ''}`,
        `提醒：今天已发 ${v.sentToday}/${v.settings.dailyCap}${v.quietNow ? '（安静时段）' : ''}`
      )
    },
    { kind: 'action', id: 'proactive_open_log', label: tr('View proactive log…', '查看提醒记录…') },
    { kind: 'action', id: 'proactive_pause_all', label: tr('Turn off all proactive notifications', '关闭全部提醒') }
  ]
}
