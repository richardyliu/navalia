// Pure view helpers for the Settings → Privacy / Updates section (OG-09). No React, no IPC.
import type { DeleteRunResult, DeleteTarget, RetentionView, UpdateCheckResult, WithdrawResult } from '../../../../main/privacy/api'
import { tr } from '../../../../shared/i18n'

export const DELETE_TARGET_LABEL: Record<DeleteTarget, string> = {
  get captures() {
    return tr('Raw captures (capture-buffer + capture index)', '原始采集（capture-buffer + 采集索引）')
  },
  get timeline() {
    return tr('Timeline (minute blocks)', '时间线（分钟块）')
  },
  get memory() {
    return tr('All memory and the personal model', '全部记忆与个人模型')
  },
  get all() {
    return tr('All Runtime personal data', '全部 Runtime 个人数据')
  }
}

/** Backup-first is the default where the backup actually contains what is being deleted (model snapshot). */
/** OG-D7: destructive actions back up first by default; the user may opt out per run. */
export function defaultBackupFirst(_target: DeleteTarget): boolean {
  return true
}

export function retentionRows(view: RetentionView): Array<{ label: string; value: string; tone: 'ok' | 'warn' | 'bad' }> {
  return view.values.map((v) => ({
    label: v.label,
    value: v.display,
    tone: v.origin === 'invalid' ? 'bad' : v.origin === 'default' ? 'warn' : 'ok'
  }))
}

export function configStateText(view: RetentionView): string {
  if (view.configState === 'missing') return tr(`${view.configPath} not found; showing Runtime defaults.`, `没有找到 ${view.configPath}，显示的是 Runtime 默认值。`)
  if (view.configState === 'unreadable') return tr(`Cannot read ${view.configPath}; showing Runtime defaults.`, `无法读取 ${view.configPath}，显示的是 Runtime 默认值。`)
  return tr(`Source: the [capture] section of ${view.configPath} (the Runtime config file).`, `来源：${view.configPath} 的 [capture] 段落（Runtime 的配置文件）。`)
}

export function deleteResultLines(r: DeleteRunResult): string[] {
  const lines = [
    r.ok
      ? tr(`Deleted: ${DELETE_TARGET_LABEL[r.target]}`, `已删除：${DELETE_TARGET_LABEL[r.target]}`)
      : tr(
          `Deletion did not succeed (exit code ${r.exitCode ?? 'none'}${r.timedOut ? ', timed out' : ''})`,
          `删除未成功（退出码 ${r.exitCode ?? '无'}${r.timedOut ? '，超时' : ''}）`
        )
  ]
  if (r.backup) lines.push(tr(`Backed up before deleting: ${r.backup.name} (${r.backup.files} files)`, `删除前已备份：${r.backup.name}（${r.backup.files} 个文件）`))
  if (r.truncated)
    lines.push(
      tr(
        'Runtime output is too long; only the start and end are shown below (the deletion itself ran in full).',
        'Runtime 输出过长，下方只显示开头和结尾（删除本身已完整执行）。'
      )
    )
  lines.push(
    r.runtimeRestarted
      ? tr('Runtime was restarted.', 'Runtime 已重新启动。')
      : tr('Runtime was not restarted (it was not running before the deletion, or the restart failed; see output).', 'Runtime 没有被重新启动（删除前未运行，或重启失败，见输出）。')
  )
  return lines
}

export function withdrawResultLines(r: WithdrawResult): string[] {
  const lines = [
    r.agentsDisconnected.length > 0
      ? tr(`Disconnected: ${r.agentsDisconnected.join(', ')}`, `已断开：${r.agentsDisconnected.join('、')}`)
      : tr('No entries needed removing from client configs.', '没有需要从客户端配置中移除的条目。'),
    tr(`Revoked ${r.grantsRevoked} grants; ${r.activeAfter} active grants remain.`, `撤销授权 ${r.grantsRevoked} 个；剩余有效授权 ${r.activeAfter} 个。`),
    tr('Access log unchanged (clear it separately in Connections).', 'Access log 未改动（清空在「连接」页单独操作）。')
  ]
  for (const w of r.warnings) lines.push(tr(`Note: ${w}`, `注意：${w}`))
  return lines
}

export function updateLines(r: UpdateCheckResult): string[] {
  return [
    tr(`Current version: ${r.currentVersion ?? 'unknown'}`, `当前版本：${r.currentVersion ?? '未知'}`),
    tr('Status: BLOCKED (no network request was made)', '状态：BLOCKED（未发出任何网络请求）'),
    ...r.reasons
  ]
}
