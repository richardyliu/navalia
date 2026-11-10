// S1-R3-09 OCR status panel (Capture + Ask). Reads the capture diagnostics query (Runtime /health).
// Actions: copy a terminal command (S1-R4-08) and the existing Recovery restart, behind an in-page
// confirmation. Lens never edits ~/.persome/config.toml and never runs `persome ocr setup` itself.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CaptureApi, CaptureDiagnosticsView } from '../../../../main/capture/api'
import { Modal } from '../Modal'
import { ocrStatusView, type OcrStatusKind } from './ocrStatus'
import { tr } from '../../lib/i18n'
import { unwrap } from '../../lib/api'

const capture = (): CaptureApi['capture'] => (window.lens as unknown as CaptureApi).capture

/**
 * Same key and fetcher as the Capture page, so both pages share one cache entry. No polling here
 * (Capture polls while it is open); the Ask page refetches on mount / window focus only.
 */
export function useOcrDiagnostics() {
  return useQuery<CaptureDiagnosticsView>({
    queryKey: ['capture', 'diagnostics'],
    queryFn: () => unwrap(capture().diagnostics())
  })
}

const TONE: Record<OcrStatusKind, string> = { on: 'ok', off: 'bad', degraded: 'warn', unknown: 'warn' }

export function OcrStatusPanel({
  diag,
  testId = 'ocr-status',
  failed = false
}: {
  diag: CaptureDiagnosticsView | undefined
  testId?: string
  /** S1-R4-08: the diagnostics query itself failed → show the "unknown" state instead of nothing. */
  failed?: boolean
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  if (!diag && !failed) return null
  const v = diag ? ocrStatusView(diag.runtimeOcr, diag.config.ocr) : ocrStatusView(null, null)

  async function copy(command: string): Promise<void> {
    // Copy goes through main (`lens:app:copy`), like every other copy button; the renderer has no
    // clipboard permission of its own (OG1).
    try {
      const r = await window.lens.app.copy(command)
      if (r.ok && r.data) setCopied(command)
      else setNotice({ tone: 'bad', text: tr(
          `Copy failed: ${r.ok ? 'clipboard unavailable' : r.error.message}`,
          `复制失败：${r.ok ? '剪贴板不可用' : r.error.message}`
        )
      })
    } catch (error) {
      setNotice({ tone: 'bad', text: tr(
          `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
          `复制失败：${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
  }

  async function restart(): Promise<void> {
    setConfirming(false)
    setBusy(true)
    setNotice(null)
    try {
      await unwrap(window.lens.recovery.restartRuntime())
      setNotice({ tone: 'ok', text: tr('Runtime restarted', 'Runtime 已重启') })
      await qc.invalidateQueries({ queryKey: ['capture'] })
    } catch (error) {
      setNotice({ tone: 'bad', text: tr(
          `Failed to restart Runtime: ${error instanceof Error ? error.message : String(error)}`,
          `重启 Runtime 失败：${error instanceof Error ? error.message : String(error)}`
        )
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`banner compact stack ${TONE[v.kind]}`} data-testid={testId} data-ocr-kind={v.kind}>
      <div>
        <strong>{v.title}</strong>
        {v.fields.length ? (
          <span className="mono tiny muted">
            {' '}
            · Runtime /health：{v.fields.map(([k, val]) => `${k}=${val}`).join(' ')}
          </span>
        ) : null}
      </div>
      {v.wechatWarning ? (
        <p className="small" data-testid={`${testId}-wechat-warning`} style={{ margin: '6px 0 0' }}>
          {v.wechatWarning}
        </p>
      ) : null}
      {v.steps.length ? (
        <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
          {v.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : null}
      {v.commands.length ? (
        <div className="small" data-testid={`${testId}-commands`} style={{ marginTop: 6 }}>
          <div className="tiny muted">
            {tr(
              'Run in a terminal (Navalia only copies the text; it does not run it for you or change ~/.persome/config.toml):',
              '在终端里运行（Navalia 只复制文字，不替你执行，也不会改 ~/.persome/config.toml）：'
            )}
          </div>
          {v.commands.map((c) => (
            <div key={c.command} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <code className="mono" data-testid={`${testId}-command`}>
                {c.command}
              </code>
              <button className="btn small ghost" data-command={c.command} onClick={() => void copy(c.command)}>
                {copied === c.command ? tr('Copied', '已复制') : tr('Copy', '复制')}
              </button>
              <span className="tiny muted">{c.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {v.canRestart ? (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn small ghost" disabled={busy} onClick={() => setConfirming(true)}>
            {busy ? tr('Restarting…', '重启中…') : tr('Restart Runtime…', '重启 Runtime…')}
          </button>
          {notice ? <span className={`tiny tone-${notice.tone}`}>{notice.text}</span> : null}
        </div>
      ) : notice ? (
        <span className={`tiny tone-${notice.tone}`}>{notice.text}</span>
      ) : null}
      {confirming ? (
        <Modal
          title={tr('Restart Runtime?', '重启 Runtime？')}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn ghost" autoFocus onClick={() => setConfirming(false)}>
                {tr('Cancel', '取消')}
              </button>
              <button className="btn primary" onClick={() => void restart()}>
                {tr('Restart', '重启')}
              </button>
            </>
          }
        >
          <p className="small">
            {tr('Navalia runs ', 'Navalia 会运行 ')}
            <code>persome stop</code>
            {tr(', waits for Runtime to exit, then runs ', '，等 Runtime 退出后再 ')}
            <code>persome start</code>
            {tr(' to load the OCR settings in config.toml.', '，以加载 config.toml 里的 OCR 设置。')}
          </p>
          <ul className="small">
            <li>
              {tr(
                'While restarting (usually a few seconds to a few tens of seconds), screen capture and search are unavailable.',
                '重启期间（通常几秒到几十秒）屏幕采集和搜索不可用。'
              )}
            </li>
            <li>
              {tr("Navalia does not modify config.toml; if you haven't run ", 'Navalia 不修改 config.toml；如果你还没有运行 ')}
              <code>persome ocr setup</code>
              {tr(' or edited the config by hand, OCR is still off after the restart.', ' 或手动改配置，重启后 OCR 仍然是关闭的。')}
            </li>
          </ul>
        </Modal>
      ) : null}
    </div>
  )
}
