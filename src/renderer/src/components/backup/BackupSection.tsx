import { useState } from 'react'
import {
  accessLogWarningText,
  BACKUP_EXCLUDED,
  BACKUP_INCLUDED,
  encryptionNote,
  modelSnapshotNoteText,
  USER_DATA_OPTIONS,
  type BackupApi,
  type BackupInspection
} from '../../../../main/backup/api'
import { EXPORT_FORM_DEFAULT, exportFormError, exportLines, inspectionLines, restoreLines, type ExportForm } from './backupView'
import './backup.css'
import { getLocale, tr } from '../../lib/i18n'
import { unwrap, errorMessage } from '../../lib/api'

const backup = (): BackupApi['backup'] => (window.lens as unknown as BackupApi).backup

/** Settings: “导出个人数据库” + “恢复 Lens 数据” (S2-02). */
export function BackupSection() {
  // X8 / C21: every opt-in defaults off; nothing here is persisted (the passphrase never leaves this form + the IPC call).
  const [form, setForm] = useState<ExportForm>(EXPORT_FORM_DEFAULT)
  const set = (patch: Partial<ExportForm>): void => setForm((f) => ({ ...f, ...patch }))
  const formError = exportFormError(form)
  const [restorePass, setRestorePass] = useState('')
  const [busy, setBusy] = useState<null | 'export' | 'inspect' | 'restore'>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string[] | null>(null)
  const [inspection, setInspection] = useState<BackupInspection | null>(null)
  const [restored, setRestored] = useState<string[] | null>(null)

  async function act<T>(kind: 'export' | 'inspect' | 'restore', fn: () => Promise<T>, onOk: (v: T) => void): Promise<void> {
    setBusy(kind)
    setError(null)
    try {
      onOk(await fn())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const inspectLines = inspection ? inspectionLines(inspection) : null

  return (
    <section className="card backup-section">
      <div className="card-head">
        <h3>{tr('Export personal database', '导出个人数据库')}</h3>
      </div>
      <p className="muted small">
        {getLocale() === 'zh' ? (
          <>
            选择一个文件夹，Navalia 会在里面新建 <code>navalia-backup-时间</code> 目录；勾选加密时改为单个{' '}
            <code>navalia-backup-时间.navaliabackup</code> 文件（写完才出现，失败不留半成品）。manifest 会用你的 Navalia
            身份密钥签名；没有身份时导出为未签名备份并提示。
          </>
        ) : (
          <>
            Choose a folder and Navalia creates a <code>navalia-backup-&lt;time&gt;</code> folder inside it; with encryption
            checked it writes a single <code>navalia-backup-&lt;time&gt;.navaliabackup</code> file instead (it appears only
            once complete; a failure leaves nothing half-written). The manifest is signed with your Navalia identity key;
            without an identity the backup is exported unsigned and you are told so.
          </>
        )}
      </p>
      <p className="muted tiny backup-note">{modelSnapshotNoteText()}</p>
      <div className="backup-lists">
        <div>
          <div className="tiny muted">{tr('Included', '包含')}</div>
          <ul className="tiny">
            {BACKUP_INCLUDED.map((i) => (
              <li key={i.path}>
                <span className="mono">{i.path}</span> — {i.label}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="tiny muted">{tr('Not included', '不包含')}</div>
          <ul className="tiny">
            {BACKUP_EXCLUDED.map((i) => (
              <li key={i.path}>
                <span className="mono">{i.path}</span> — {i.shown}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card-foot wrap">
        <label className="tiny">
          <input type="checkbox" checked={form.withoutModel} onChange={(e) => set({ withoutModel: e.target.checked })} /> {tr('Exclude model snapshot (back up Navalia data only)', '不包含模型快照（只备份 Navalia 数据）')}
        </label>
        <label className="tiny">
          <input type="checkbox" checked={form.includeAccessLog} onChange={(e) => set({ includeAccessLog: e.target.checked })} /> {tr('Include Access log (off by default)', '包含 Access log（默认不包含）')}
        </label>
        {USER_DATA_OPTIONS.map((o) => {
          const key = o.key === 'chat' ? 'includeChat' : o.key === 'meetings' ? 'includeMeetings' : 'includeMoments'
          return (
            <label key={o.key} className="tiny" title={o.detail}>
              <input type="checkbox" checked={form[key]} onChange={(e) => set({ [key]: e.target.checked } as Partial<ExportForm>)} /> {tr(`Include ${o.label.toLowerCase()} (off by default; ${o.detail})`, `包含${o.label}（默认不包含；${o.detail}）`)}
            </label>
          )
        })}
      </div>
      <div className="card-foot wrap">
        <label className="tiny">
          <input type="checkbox" checked={form.encrypt} onChange={(e) => set({ encrypt: e.target.checked, passphrase: '', passphraseAgain: '' })} /> {tr('Encrypt backup (AES-256-GCM, needs a passphrase)', '加密备份（AES-256-GCM，需要口令）')}
        </label>
        {form.encrypt ? (
          <>
            <input
              className="input backup-pass"
              type="password"
              autoComplete="new-password"
              placeholder={tr('Passphrase (at least 8 characters)', '口令（至少 8 个字符）')}
              value={form.passphrase}
              onChange={(e) => set({ passphrase: e.target.value })}
            />
            <input
              className="input backup-pass"
              type="password"
              autoComplete="new-password"
              placeholder={tr('Enter it again', '再输入一次')}
              value={form.passphraseAgain}
              onChange={(e) => set({ passphraseAgain: e.target.value })}
            />
          </>
        ) : null}
        <button
          className="btn primary small"
          disabled={busy !== null || formError !== null}
          onClick={() =>
            void act(
              'export',
              () =>
                unwrap(
                  backup().exportBackup({
                    withoutModel: form.withoutModel,
                    includeAccessLog: form.includeAccessLog,
                    includeChat: form.includeChat,
                    includeMeetings: form.includeMeetings,
                    includeMoments: form.includeMoments,
                    ...(form.encrypt ? { passphrase: form.passphrase } : {})
                  })
                ),
              (r) => {
                setDone(exportLines(r))
                set({ passphrase: '', passphraseAgain: '' })
              }
            )
          }
        >
          {busy === 'export' ? tr('Exporting…', '导出中…') : tr('Choose location and export', '选择位置并导出')}
        </button>
      </div>
      {form.encrypt ? <p className="muted tiny backup-note">{encryptionNote()}</p> : null}
      {form.encrypt && formError ? <div className="muted tiny">{formError}</div> : null}
      {form.includeAccessLog ? <div className="banner warn compact">{accessLogWarningText()}</div> : null}
      {form.includeChat || form.includeMeetings || form.includeMoments ? (
        <div className="banner warn compact">
          {form.encrypt
            ? tr(
                'Chat history / meeting transcripts / shared moments are your personal content and are written into the backup encrypted; meeting recordings are never exported. On restore only files missing on this Mac are written, nothing is overwritten.',
                '聊天记录 / 会议转写 / 共享时刻是你的个人内容，会加密后写入备份；会议录音从不导出。恢复时只写入本机没有的文件，不覆盖。'
              )
            : tr(
                'Chat history / meeting transcripts / shared moments are your personal content and are written into the backup in plain text; meeting recordings are never exported. On restore only files missing on this Mac are written, nothing is overwritten.',
                '聊天记录 / 会议转写 / 共享时刻是你的个人内容，会以明文写入备份；会议录音从不导出。恢复时只写入本机没有的文件，不覆盖。'
              )}
        </div>
      ) : null}
      {done ? (
        <div className="banner ok compact">
          <div>
            <strong>{tr('Backup complete', '备份完成')}</strong>
            {done.map((l) => (
              <div key={l} className="mono tiny">
                {l}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card-head backup-restore-head">
        <h3>{tr('Restore Navalia data', '恢复 Navalia 数据')}</h3>
      </div>
      <p className="muted small">
        {tr(
          'The whole backup is verified first (sha256 of every file in the manifest; for encrypted backups, every chunk too), and how each item will be restored is listed. Nothing is written until you confirm. ' +
            'Workflows: only backups signed by your Navalia identity (current or earlier key) are merged by version under their original IDs (all versions restored if missing locally; only newer versions appended to the same history; newer local versions kept; diverged ones saved as imported copies). ' +
            'Unsigned backups or backups signed by someone else are always restored as imported copies (new IDs); a backup with an invalid signature is rejected entirely. ' +
            'Each card is verified again (invalid ones are skipped and listed; cards issued by a different identity go to cards/archive/). Your identity key, grants and Access log are never changed. ' +
            'The model snapshot and Access log are archive only; Navalia never writes them into Runtime.',
          '先校验整份备份（manifest 中每个文件的 sha256；加密备份还要校验每个数据块），并列出每一项将如何恢复，确认后才写入：' +
            'Workflow：只有由你的 Navalia 身份（当前或以前的密钥）签名的备份才按原 ID 按版本合并（本机没有的恢复全部版本；同一历史只追加更新的版本；本机更新的保留本机；分叉的另存为导入副本）；' +
            '未签名或别人签名的备份一律以导入副本（新 ID）恢复，签名无效的整份拒绝。' +
            '卡片逐张重新验签（无效的跳过并列出；签发者不是当前身份的存入 cards/archive/）。不会改动你的身份密钥、授权或 Access log。' +
            '模型快照与 Access log 仅供存档，Navalia 不会写入 Runtime。'
        )}
      </p>
      <div className="card-foot wrap">
        <button
          className="btn small"
          disabled={busy !== null}
          onClick={() =>
            void act('inspect', () => unwrap(backup().inspect()), (r) => {
              setRestored(null)
              setInspection(r.cancelled ? null : r)
            })
          }
        >
          {busy === 'inspect' ? tr('Verifying…', '校验中…') : tr('Choose backup folder and verify', '选择备份目录并校验')}
        </button>
        <input
          className="input backup-pass"
          type="password"
          autoComplete="off"
          placeholder={tr('Passphrase of the encrypted backup', '加密备份的口令')}
          value={restorePass}
          onChange={(e) => setRestorePass(e.target.value)}
        />
        <button
          className="btn small"
          disabled={busy !== null || restorePass.length < 8}
          onClick={() =>
            void act('inspect', () => unwrap(backup().inspect({ encrypted: true, passphrase: restorePass })), (r) => {
              setRestored(null)
              setRestorePass('')
              setInspection(r.cancelled ? null : r)
            })
          }
        >
          {busy === 'inspect' ? tr('Decrypting and verifying…', '解密校验中…') : tr('Choose an encrypted .navaliabackup and verify', '选择 .navaliabackup 加密备份并校验')}
        </button>
      </div>
      {inspection && inspectLines ? (
        <div className="banner warn compact">
          <div>
            {inspectLines.map((l) => (
              <div key={l} className="tiny">
                {l}
              </div>
            ))}
          </div>
          <span className="page-actions">
            <button
              className="btn primary small"
              disabled={busy !== null}
              onClick={() =>
                void act('restore', () => unwrap(backup().restore(inspection.inspectionId!, true)), (r) => {
                  setInspection(null)
                  setRestored(restoreLines(r))
                })
              }
            >
              {busy === 'restore' ? tr('Restoring…', '恢复中…') : tr('Confirm and restore (merge)', '确认合并恢复')}
            </button>
            <button className="btn ghost small" onClick={() => setInspection(null)}>
              {tr('Cancel', '取消')}
            </button>
          </span>
        </div>
      ) : null}
      {restored ? (
        <div className="banner ok compact">
          <div>
            <strong>{tr('Restore complete', '恢复完成')}</strong>
            {restored.map((l) => (
              <div key={l} className="tiny">
                {l}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <pre className="banner bad compact backup-error">{error}</pre> : null}
    </section>
  )
}
