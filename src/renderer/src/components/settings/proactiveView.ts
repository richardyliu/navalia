// S1-R4-05 Settings 「本机通知」 view helpers (pure).
import { tr } from '../../lib/i18n'
import type { NotificationPermissionState, ProactiveView } from '../../../../main/proactive/api'

export const PERMISSION_TEXT: Record<NotificationPermissionState, string> = {
  get not_asked() {
    return tr(
      'Permission to show notifications has not been requested yet. Turning on the master switch sends a test notification (macOS asks for permission the first time).',
      '还没有请求过通知权限。打开总开关时会发一条测试通知（macOS 第一次会询问是否允许）。'
    )
  },
  get shown() {
    return tr(
      'The test notification was shown. If you did not actually see it (e.g. it is turned off in System Settings → Notifications), click "I didn\'t see a notification" and Navalia will stop sending.',
      '测试通知已显示。如果你其实没看到（例如在 系统设置 → 通知 里关掉了），请点「我没看到通知」，Navalia 就不再发送。'
    )
  },
  get not_shown() {
    return tr(
      'The test notification was not shown. Navalia will not send any notifications or nag you in the app. If needed, allow Navalia in System Settings → Notifications → Navalia, then click "Test again".',
      '测试通知没有显示成功。Navalia 不会发送任何通知，也不会在应用内催你。需要时可在 系统设置 → 通知 → Navalia 打开后点「重新测试」。'
    )
  },
  get unsupported() {
    return tr(
      'This machine does not support system notifications. Navalia will not send notifications or fall back to in-app reminders.',
      '这台机器不支持系统通知。Navalia 不会发送通知，也不会改用应用内提醒。'
    )
  },
  get denied() {
    return tr(
      'You said you did not see the notification or denied it. Navalia will not send notifications or nag you in the app. After allowing it in System Settings, click "Test again".',
      '你表示没有看到通知或已拒绝。Navalia 不会发送通知，也不会在应用内催你。在系统设置里允许后可以点「重新测试」。'
    )
  }
}

export function permissionTone(s: NotificationPermissionState): 'ok' | 'warn' | 'bad' | 'subtle' {
  if (s === 'shown') return 'ok'
  if (s === 'not_asked') return 'subtle'
  return 'warn'
}

/** One-line status for the card head. */
export function proactiveStatusLine(v: ProactiveView): string {
  if (v.settingsError) return tr('Settings file invalid; everything is off', '设置文件无效，全部关闭')
  if (!v.settings.enabled) return tr('Off', '已关闭')
  if (v.permission.state !== 'shown') return tr('On, but no notification permission: nothing will be sent', '已开启，但没有通知权限：不会发送')
  const on = Object.values(v.settings.triggers).filter(Boolean).length
  if (on === 0) return tr('On, but no notifications selected', '已开启，但没有选择任何提醒')
  return tr(
    `${on} on · ${v.sentToday}/${v.dailyCap} sent today${v.quietNow ? ' · quiet hours now' : ''}`,
    `已开启 ${on} 项 · 今天已发 ${v.sentToday}/${v.dailyCap}${v.quietNow ? ' · 现在是安静时段' : ''}`
  )
}
