import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CaptureStatusView } from '../../../../main/capture/api'
import {
  DELETE_TARGETS,
  deleteAction,
  type DeleteTarget,
  type PrivacyChallenge,
  type RetentionView
} from '../../../../main/privacy/api'
import { Modal } from '../Modal'
import { useNav } from '../../lib/nav'
import {
  DELETE_TARGET_LABEL,
  configStateText,
  defaultBackupFirst,
  deleteResultLines,
  retentionRows,
  updateLines,
  withdrawResultLines
} from './privacyView'
import './settings.css'
import { intlLocale, tr } from '../../lib/i18n'
import { unwrap, errorMessage } from '../../lib/api'

type Pending = { kind: 'delete'; target: DeleteTarget; backupFirst: boolean; challenge: PrivacyChallenge } | { kind: 'withdraw'; challenge: PrivacyChallenge }

/** Settings → 隐私 / 更新 / 恢复 / 会议 (OG-09). Mounted once from Settings.tsx. */
export function PrivacySection() {
  const { go } = useNav()
  const qc = useQueryClient()
  const privacy = window.lens.privacy
  const retention = useQuery<RetentionView>({ queryKey: ['privacy', 'retention'], queryFn: () => unwrap(privacy.retention()), staleTime: 10_000 })
  const capture = useQuery<CaptureStatusView>({ queryKey: ['capture', 'status'], queryFn: () => unwrap(window.lens.capture.status()), refetchInterval: 5000 })

  const [target, setTarget] = useState<DeleteTarget>('captures')
  const [backupFirst, setBackupFirst] = useState(defaultBackupFirst('captures'))
  const [pending, setPending] = useState<Pending | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ title: string; lines: string[]; output?: string } | null>(null)
  const [update, setUpdate] = useState<string[] | null>(null)

  async function guard(fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const pause = capture.data?.pause
  const excludedCount = capture.data ? capture.data.excluded.bundleIds.length + capture.data.excluded.appNames.length : null

  return (
    <section className="card settings-privacy" data-testid="settings-privacy">
      <div className="card-head">
        <h3>{tr('Privacy', '隐私')}</h3>
        <span className="chip subtle">{tr('These actions run on this Mac, offline; cloud data is not deleted', '以下操作在本机执行，不联网；不删除云端数据')}</span>
      </div>

      {error ? <div className="banner bad compact" role="alert">{error}</div> : null}
      {result ? (
        <div className="banner ok compact">
          <strong>{result.title}</strong>
          {result.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          {result.output ? <pre className="mono tiny settings-output">{result.output}</pre> : null}
        </div>
      ) : null}

      <div className="settings-privacy-grid">
        <div>
          <h4>{tr('Pause and exclusions', '暂停与排除')}</h4>
          <p className="muted small">
            {capture.isError
              ? tr('Capture status unavailable.', '采集状态不可用。')
              : pause
                ? pause.paused
                  ? pause.until
                    ? tr(`Capture is paused until ${new Date(pause.until).toLocaleString(intlLocale())}.`, `采集已暂停，到 ${new Date(pause.until).toLocaleString(intlLocale())}。`)
                    : tr('Capture is paused.', '采集已暂停。')
                  : tr('Capture is not paused.', '采集未暂停。')
                : tr('Loading…', '读取中…')}
            {excludedCount !== null
              ? tr(` ${excludedCount} apps excluded (plus Navalia itself, always excluded).`, ` 已排除 ${excludedCount} 个 App（另有 Navalia 自身，始终排除）。`)
              : ''}
          </p>
          <div className="card-foot wrap">
            {pause?.paused ? (
              <button className="btn ghost small" disabled={busy} onClick={() => void guard(async () => { await unwrap(window.lens.capture.resume()); await qc.invalidateQueries({ queryKey: ['capture'] }) })}>
                {tr('Resume capture', '恢复采集')}
              </button>
            ) : (
              <button className="btn ghost small" disabled={busy || !capture.data} onClick={() => void guard(async () => { await unwrap(window.lens.capture.pause('now')); await qc.invalidateQueries({ queryKey: ['capture'] }) })}>
                {tr('Pause capture', '暂停采集')}
              </button>
            )}
            <button className="btn ghost small" onClick={() => go('capture')}>
              {tr('Manage per-app exclusions →', '管理按 App 排除 →')}
            </button>
          </div>
        </div>

        <div data-testid="settings-retention">
          <h4>{tr('Retention (read-only)', '保留期（只读）')}</h4>
          {retention.isError ? <p className="muted small">{errorMessage(retention.error)}</p> : null}
          {retention.data ? (
            <>
              <dl className="kv">
                {retentionRows(retention.data).map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>
                      <span className={`chip ${r.tone}`}>{r.value}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="tiny muted">{configStateText(retention.data)}</p>
              <details className="tiny">
                <summary>{tr('How to change', '如何修改')}</summary>
                <ol>
                  {retention.data.howToChange.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <ul>
                  {retention.data.notes.map((s) => (
                    <li key={s} className="muted">{s}</li>
                  ))}
                </ul>
              </details>
            </>
          ) : null}
        </div>

        <div>
          <h4>{tr('Export', '导出')}</h4>
          <p className="muted small">
            {tr(
              'To export, use "Export personal database" below (model snapshot + Navalia data). Private keys, grants and the Access log are not in the backup.',
              '导出用下方的「导出个人数据库」（模型快照 + Navalia 数据）。私钥、授权和 Access log 不在备份里。'
            )}
          </p>
        </div>

        <div>
          <h4>{tr('Delete local data', '删除本地数据')}</h4>
          <p className="muted small">
            {tr(
              'Runtime itself runs persome clean; Navalia never edits the Runtime database directly. Runtime is stopped briefly.',
              '由 Runtime 自己执行 persome clean；Navalia 不直接改 Runtime 的数据库。会短暂停止 Runtime。'
            )}
          </p>
          <div className="card-foot wrap">
            <select
              className="input"
              value={target}
              aria-label={tr('What to delete', '删除范围')}
              onChange={(e) => {
                const t = e.target.value as DeleteTarget
                setTarget(t)
                setBackupFirst(defaultBackupFirst(t))
              }}
            >
              {DELETE_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {DELETE_TARGET_LABEL[t]}
                </option>
              ))}
            </select>
            <label className="tiny">
              <input type="checkbox" checked={backupFirst} onChange={(e) => setBackupFirst(e.target.checked)} /> {tr('Export a backup first', '先导出备份')}
            </label>
            <button
              className="btn ghost small danger"
              disabled={busy}
              onClick={() =>
                void guard(async () => {
                  const challenge = await unwrap(privacy.confirmIssue(deleteAction(target)))
                  setTyped('')
                  setResult(null)
                  setPending({ kind: 'delete', target, backupFirst, challenge })
                })
              }
            >
              {tr('Delete…', '删除…')}
            </button>
          </div>
        </div>

        <div>
          <h4>{tr('Withdraw Agent access', '撤回 Agent 访问')}</h4>
          <p className="muted small">
            {tr(
              'Disconnects every connected Agent and revokes all grants. The Access log is kept; clear it in Connections.',
              '断开所有已连接的 Agent 并撤销全部授权。Access log 保留，清空请到「连接」页。'
            )}
          </p>
          <div className="card-foot wrap">
            <button
              className="btn ghost small danger"
              disabled={busy}
              onClick={() =>
                void guard(async () => {
                  const challenge = await unwrap(privacy.confirmIssue('withdraw-all'))
                  setTyped('')
                  setResult(null)
                  setPending({ kind: 'withdraw', challenge })
                })
              }
            >
              {tr('Withdraw all connections…', '撤回全部连接…')}
            </button>
            <button className="btn ghost small" onClick={() => go('connections')}>
              {tr('Connections and Access log →', '连接与 Access log →')}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-privacy-grid settings-privacy-lower">
        <div data-testid="settings-updates">
          <h4>{tr('Updates', '更新')}</h4>
          <p className="muted small">
            {tr(
              'Click "Check for updates" to show the current version and status. Checking never goes online and never polls (OG-D4).',
              '点「检查更新」显示当前版本和状态。检查不会联网，也不轮询（OG-D4）。'
            )}
          </p>
          {update ? (
            <ul className="tiny">
              {update.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}
          <div className="card-foot">
            <button className="btn ghost small" disabled={busy} onClick={() => void guard(async () => setUpdate(updateLines(await unwrap(privacy.updateCheck()))))}>
              {tr('Check for updates', '检查更新')}
            </button>
          </div>
        </div>

        <div>
          <h4>{tr('Recovery and diagnostics', '恢复与诊断')}</h4>
          <p className="muted small">
            {tr(
              'Runtime health checks, doctor, restart and diagnostics export are on the Recovery page.',
              'Runtime 健康检查、doctor、重启和诊断导出在「恢复」页。'
            )}
          </p>
          <div className="card-foot">
            <button className="btn ghost small" onClick={() => go('recovery')}>
              {tr('Open Recovery →', '打开恢复页 →')}
            </button>
          </div>
        </div>

        <div>
          <h4>{tr('Meeting audio', '会议音频')}</h4>
          <p className="muted small">
            {tr(
              'Navalia has no meeting recording or transcription and does not request microphone permission. The original uploaded meeting audio in chunks to the cloud for transcription; Navalia does not connect to that cloud (OG-D1), so this item is BLOCKED.',
              'Navalia 没有会议录音或转写功能，不申请麦克风权限。原版会把会议音频分片上传到云端转写；Navalia 不接云（OG-D1），这一项是 BLOCKED。'
            )}
          </p>
        </div>
      </div>

      {pending ? (
        <Modal
          title={
            pending.kind === 'delete'
              ? tr(`Delete: ${DELETE_TARGET_LABEL[pending.target]}`, `删除：${DELETE_TARGET_LABEL[pending.target]}`)
              : tr('Withdraw all connections', '撤回全部连接')
          }
          onClose={() => setPending(null)}
          footer={
            <>
              <button className="btn ghost small" onClick={() => setPending(null)}>
                {tr('Cancel', '取消')}
              </button>
              <button
                className="btn primary small danger"
                disabled={busy || typed.trim() !== pending.challenge.phrase}
                onClick={() => {
                  const p = pending
                  setPending(null)
                  void guard(async () => {
                    if (p.kind === 'delete') {
                      const r = await unwrap(privacy.deleteRun(p.target, p.challenge.nonce, typed, p.backupFirst))
                      setResult({ title: r.ok ? tr('Deletion complete', '删除完成') : tr('Deletion not completed', '删除未完成'), lines: deleteResultLines(r), output: r.output })
                      await qc.invalidateQueries()
                    } else {
                      const r = await unwrap(privacy.withdrawRun(p.challenge.nonce, typed))
                      setResult({ title: tr('Withdrawn', '已撤回'), lines: withdrawResultLines(r) })
                      await qc.invalidateQueries({ queryKey: ['connections'] })
                    }
                  })
                }}
              >
                {tr('Confirm and run', '确认执行')}
              </button>
            </>
          }
        >
          <p className="small">{pending.challenge.warning}</p>
          {pending.kind === 'delete' ? <p className="tiny muted">{pending.backupFirst
                ? tr('You will first be asked where to save a backup; cancelling the backup cancels the deletion.', '执行前会先让你选择备份位置；取消备份则不删除。')
                : tr('No backup first.', '不先备份。')}</p> : null}
          <p className="small">
            {tr('Type', '请输入')} <strong>{pending.challenge.phrase}</strong>{' '}
            {tr('to confirm (valid for 60 seconds, single use):', '确认（60 秒内有效，只能用一次）：')}
          </p>
          <input className="input" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} aria-label={tr('Confirmation phrase', '确认短语')} />
        </Modal>
      ) : null}
    </section>
  )
}
