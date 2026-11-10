// Pure view-model for the Settings backup / restore section (tested in tests/backup/view.test.ts).
import { tr } from '../../lib/i18n'
import { formatBytes } from '../../lib/format'
import type { BackupExportResult, BackupInspection, RestorePreview, RestoreReport, WorkflowRestoreAction } from '../../../../main/backup/api'

/** Lines shown after a successful export. Null when the dialog was cancelled. */
export function exportLines(r: BackupExportResult): string[] | null {
  if (r.cancelled || !r.path) return null
  const lines = [
    tr(`Saved to: ${r.path}`, `已保存到：${r.path}`),
    tr(
      `${r.files} files · ${formatBytes(r.bytes)} · Model snapshot: ${r.modelSnapshot === 'included' ? 'included (redacted, not the raw database)' : 'not included'}` +
        ` · Access log: ${typeof r.accessLogRows === 'number' ? `${r.accessLogRows} records included` : 'not included'}`,
      `${r.files} 个文件 · ${formatBytes(r.bytes)} · 模型快照：${r.modelSnapshot === 'included' ? '已包含（已脱敏，不是原始数据库）' : '未包含'}` +
        ` · Access log：${typeof r.accessLogRows === 'number' ? `已包含 ${r.accessLogRows} 条` : '未包含'}`
    )
  ]
  if (r.signed === true)
    lines.push(
      tr(
        'Signed with your Navalia identity key: when restored on this Mac (or with an earlier identity of this Mac), Workflows can be restored as-is under their original IDs.',
        '已用你的 Navalia 身份密钥签名：以后在本机（或用本机以前的身份）恢复时，Workflow 可按原 ID 原样恢复。'
      )
    )
  else if (r.signed === false)
    lines.push(
      tr(
        `Unsigned (${r.signReason ?? 'no Navalia identity'}): on restore, Workflows can only be restored as imported copies (new IDs).`,
        `未签名（${r.signReason ?? '没有 Navalia 身份'}）：恢复时 Workflow 只能以导入副本（新 ID）恢复。`
      )
    )
  if (r.encrypted)
    lines.push(
      tr(
        'Encrypted (AES-256-GCM): restoring needs the same passphrase; it is not stored and cannot be recovered.',
        '已加密（AES-256-GCM）：恢复时需要同一口令；口令不保存、无法找回。'
      )
    )
  if (r.userData && r.userData.chat + r.userData.meetings + r.userData.moments > 0) {
    lines.push(
      tr(
        `Optional data: chats ${r.userData.chat} files · meeting transcripts ${r.userData.meetings} files · shared moments ${r.userData.moments} files (no recordings)`,
        `可选数据：聊天 ${r.userData.chat} 个文件 · 会议转写 ${r.userData.meetings} 个文件 · 共享时刻 ${r.userData.moments} 个文件（不含录音）`
      )
    )
  }
  if (r.skipped.length)
    lines.push(
      tr(
        `Skipped ${r.skipped.length} items (symlink / not a regular file / too large / no transcript): ${r.skipped.slice(0, 3).map((s) => s.path).join(', ')}`,
        `跳过 ${r.skipped.length} 项（符号链接 / 非普通文件 / 过大 / 无转写）：${r.skipped.slice(0, 3).map((s) => s.path).join('，')}`
      )
    )
  return lines
}

/** C21: export options as the UI holds them (all opt-ins default false). */
export interface ExportForm {
  withoutModel: boolean
  includeAccessLog: boolean
  includeChat: boolean
  includeMeetings: boolean
  includeMoments: boolean
  encrypt: boolean
  passphrase: string
  passphraseAgain: string
}

export const EXPORT_FORM_DEFAULT: ExportForm = {
  withoutModel: false,
  includeAccessLog: false,
  includeChat: false,
  includeMeetings: false,
  includeMoments: false,
  encrypt: false,
  passphrase: '',
  passphraseAgain: ''
}

/** Null when the form can be submitted; otherwise the reason (active UI locale). */
export function exportFormError(f: ExportForm): string | null {
  if (!f.encrypt) return null
  if (f.passphrase.length < 8) return tr('Passphrase must be at least 8 characters.', '口令至少 8 个字符。')
  if (f.passphrase !== f.passphraseAgain) return tr('The two passphrases do not match.', '两次输入的口令不一致。')
  return null
}

export const WORKFLOW_ACTION_LABEL: Record<WorkflowRestoreAction, string> = {
  get restore() {
    return tr('Restore under original ID (all versions)', '按原 ID 恢复（全部版本）')
  },
  get merge() {
    return tr('Append newer versions from the backup', '追加备份里更新的版本')
  },
  get unchanged() {
    return tr('Same as this Mac', '与本机相同')
  },
  get local_newer() {
    return tr('Newer on this Mac, keeping local', '本机更新，保留本机')
  },
  get copy() {
    return tr('Versions diverged, saved as an imported copy', '版本分叉，另存为导入副本')
  },
  get duplicate() {
    return tr('Identical content already exists', '已存在相同内容')
  },
  get failed() {
    return tr('Invalid, skipped', '无效，跳过')
  }
}

/** C21: per-item plan shown before the restore button. */
export function previewLines(p: RestorePreview): string[] {
  const lines = p.workflows.map((w) =>
    tr(
      `Workflow "${w.title}": ${WORKFLOW_ACTION_LABEL[w.action]}${w.versions ? ` (writes ${w.versions} versions)` : ''}${w.detail ? ` — ${w.detail}` : ''}`,
      `Workflow「${w.title}」：${WORKFLOW_ACTION_LABEL[w.action]}${w.versions ? `（写入 ${w.versions} 个版本）` : ''}${w.detail ? ` — ${w.detail}` : ''}`
    )
  )
  lines.push(
    tr(
      `Cards: ${p.cards.valid} verified${p.cards.invalid ? `, ${p.cards.invalid} invalid will be skipped` : ''}; ${p.peers} peer records (each verified again)`,
      `卡片：验签通过 ${p.cards.valid} 张${p.cards.invalid ? `，${p.cards.invalid} 张无效将跳过` : ''}；朋友记录 ${p.peers} 份（逐张重新验签）`
    )
  )
  const u = p.userData
  if (u.chat + u.meetings + u.moments)
    lines.push(
      tr(
        `Optional data: chats ${u.chat} · meeting transcripts ${u.meetings} · shared moments ${u.moments} (only files missing on this Mac are written, nothing is overwritten)`,
        `可选数据：聊天 ${u.chat} · 会议转写 ${u.meetings} · 共享时刻 ${u.moments}（只写入本机没有的文件，不覆盖）`
      )
    )
  return lines
}

/** C21: which restore mode applies and why. */
export function trustLine(t: NonNullable<BackupInspection['trust']>): string {
  return t.mode === 'mine'
    ? tr(
        `Signature: ${t.reason} (${(t.fingerprint ?? '').slice(0, 12)}…) → Workflows are restored as-is under their original IDs.`,
        `签名：${t.reason}（${(t.fingerprint ?? '').slice(0, 12)}…）→ Workflow 按原 ID、原样恢复。`
      )
    : tr(
        `Signature: ${t.reason} → Workflows are restored only as imported copies (new IDs, marked as imported), not under their original IDs.`,
        `签名：${t.reason} → Workflow 只以导入副本（新 ID，标为导入）恢复，不使用原 ID。`
      )
}

export function inspectionLines(i: BackupInspection): string[] | null {
  if (i.cancelled || !i.inspectionId) return null
  const c = i.counts
  return [
    tr(
      `${i.name ?? ''}${i.encrypted ? ' (encrypted backup, decrypted and verified with the passphrase)' : ''} · created ${i.createdAt ?? 'unknown'}${i.appVersion ? ` · Navalia ${i.appVersion}` : ''}`,
      `${i.name ?? ''}${i.encrypted ? '（加密备份，已用口令解密校验）' : ''} · 创建于 ${i.createdAt ?? '未知'}${i.appVersion ? ` · Navalia ${i.appVersion}` : ''}`
    ),
    tr(
      `Verified: ${c.files} files (${formatBytes(c.bytes)}), ${c.workflows} Workflows${c.workflowVersions ? ` (${c.workflowVersions} versions in total)` : ''}, ${c.peers} peers, ${c.cards} cards`,
      `校验通过：${c.files} 个文件（${formatBytes(c.bytes)}），Workflow ${c.workflows} 个${c.workflowVersions ? `（共 ${c.workflowVersions} 个版本）` : ''}，朋友 ${c.peers} 位，卡片 ${c.cards} 张`
    ),
    i.modelSnapshot
      ? tr(
          'Includes a model snapshot (redacted, not the raw database or screenshots): archive only, never written into Runtime (restore it on the Runtime side).',
          '含模型快照（已脱敏，不是原始数据库或截图）：仅供存档，不会写入 Runtime（需由 Runtime 侧恢复）。'
        )
      : tr('No model snapshot.', '不含模型快照。'),
    ...(i.accessLog ? [tr("Includes the Access log: archive only, never written back to this Mac's Access log.", '含 Access log：仅存档，不会写回本机 Access log。')] : []),
    ...(i.trust ? [trustLine(i.trust)] : []),
    ...(i.preview ? previewLines(i.preview) : [])
  ]
}

export function restoreLines(r: RestoreReport): string[] {
  const w = r.workflows
  const p = r.peers
  const lines = [
    tr(
      `Workflows: restored under original ID ${w.restored ?? 0}, new versions appended ${w.merged ?? 0}, identical ${w.unchanged ?? 0}, newer local kept ${w.localNewer ?? 0}, diverged saved as copy ${w.imported}` +
        `${w.duplicates ? `, already present ${w.duplicates}` : ''}${w.failed ? `, failed ${w.failed}` : ''} (existing local versions are never overwritten)`,
      `Workflow：按原 ID 恢复 ${w.restored ?? 0}，追加新版本 ${w.merged ?? 0}，相同 ${w.unchanged ?? 0}，本机较新保留 ${w.localNewer ?? 0}，分叉另存副本 ${w.imported}` +
        `${w.duplicates ? `，已存在 ${w.duplicates}` : ''}${w.failed ? `，失败 ${w.failed}` : ''}（从不覆盖本机已有版本）`
    ),
    tr(
      `Peers: added ${p.added}, updated ${p.updated}, unchanged ${p.unchanged}${p.failed ? `, signature check failed ${p.failed}` : ''}`,
      `朋友：新增 ${p.added}，更新 ${p.updated}，未变 ${p.unchanged}${p.failed ? `，验签失败 ${p.failed}` : ''}`
    )
  ]
  const versions = w.items.reduce((a, i) => a + (i.versions ?? 0), 0)
  if (versions)
    lines.push(
      tr(
        `Workflow version history: ${versions} versions restored (latest and older versions are all kept)`,
        `Workflow 版本历史：共恢复 ${versions} 个版本（最新版与历史版本都保留）`
      )
    )
  if (r.cards) {
    const k = r.cards
    lines.push(
      tr(
        `Cards: restored ${k.restored}, archived (issuer is not the current identity) ${k.archived}, unchanged ${k.unchanged}${k.failed ? `, signature check failed ${k.failed}` : ''}`,
        `卡片：恢复 ${k.restored}，存档（签发者不是当前身份）${k.archived}，未变 ${k.unchanged}${k.failed ? `，验签失败 ${k.failed}` : ''}`
      )
    )
    for (const it of k.items.filter((i) => i.outcome === 'failed'))
      lines.push(tr(`Card ${it.cardId} failed: ${it.detail ?? ''}`, `卡片 ${it.cardId} 失败：${it.detail ?? ''}`))
  }
  for (const it of w.items.filter((i) => i.outcome === 'failed'))
    lines.push(tr(`Workflow failed: ${it.title} (${it.detail ?? ''})`, `Workflow 失败：${it.title}（${it.detail ?? ''}）`))
  for (const it of p.items.filter((i) => i.outcome === 'failed'))
    lines.push(tr(`Peer ${it.fingerprint.slice(0, 12)}… failed: ${it.detail ?? ''}`, `朋友 ${it.fingerprint.slice(0, 12)}… 失败：${it.detail ?? ''}`))
  if (r.userData) {
    const u = r.userData
    lines.push(
      tr(
        `Optional data: chats restored ${u.chat.restored}/unchanged ${u.chat.unchanged}/skipped ${u.chat.skipped} · meeting transcripts restored ${u.meetings.restored}/unchanged ${u.meetings.unchanged}/skipped ${u.meetings.skipped} · shared moments restored ${u.moments.restored}/unchanged ${u.moments.unchanged}/skipped ${u.moments.skipped} (skipped = a different version already exists on this Mac, not overwritten)`,
        `可选数据：聊天 恢复 ${u.chat.restored}/未变 ${u.chat.unchanged}/跳过 ${u.chat.skipped} · 会议转写 恢复 ${u.meetings.restored}/未变 ${u.meetings.unchanged}/跳过 ${u.meetings.skipped} · 共享时刻 恢复 ${u.moments.restored}/未变 ${u.moments.unchanged}/跳过 ${u.moments.skipped}（跳过 = 本机已有不同版本，未覆盖）`
      )
    )
  }
  if (r.accessLog)
    lines.push(
      r.accessLog.included
        ? tr(
            `Access log: the backup contains${r.accessLog.rows !== null ? ` ${r.accessLog.rows}` : ''} records, archived only, not written back to this Mac's Access log`,
            `Access log：备份中含${r.accessLog.rows !== null ? ` ${r.accessLog.rows} 条` : ''}记录，仅存档，未写回本机 Access log`
          )
        : tr('Access log: this backup does not contain the Access log', 'Access log：这份备份不含 Access log')
    )
  if (r.notRestored.length)
    lines.push(tr(`Not restored (archive only): ${r.notRestored.join('; ')}`, `未恢复（仅存档）：${r.notRestored.join('；')}`))
  return lines
}
