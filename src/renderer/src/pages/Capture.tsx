import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CaptureApi,
  CaptureDiagnosticsView,
  CaptureStatusView,
  ExclusionKind,
  RecentFrameView
} from '../../../main/capture/api'
import { StatCard } from '../components/StatCard'
import { OcrStatusPanel } from '../components/ask/OcrStatusPanel'
import { formatDateTime, formatNumber } from '../lib/format'
import { tr } from '../lib/i18n'
import { unwrap, errorMessage } from '../lib/api'

// Typed through the Capture fragment so this page compiles before and after
// the fragment is merged into LensApi.
const capture = (): CaptureApi['capture'] => (window.lens as unknown as CaptureApi).capture

const OUTCOME_LABEL: Record<RecentFrameView['outcome'], string> = {
  get written() { return tr('Written', '已写入') },
  get deduped() { return tr('Deduped', '去重') },
  get skipped() { return tr('Skipped (Runtime paused/locked)', '跳过（Runtime 暂停/锁屏）') },
  get parked() { return tr('Parked for retry', '暂存待重试') },
  get rejected() { return tr('Rejected', '被拒绝') },
  get too_large() { return tr('Over 12 MiB', '超过 12 MiB') },
  get dropped() { return tr('Withdrawn after pause/exclusion', '暂停/排除后撤回') }
}

const OUTCOME_TONE: Record<RecentFrameView['outcome'], string> = {
  written: 'ok',
  deduped: 'subtle',
  skipped: 'warn',
  parked: 'warn',
  rejected: 'bad',
  too_large: 'bad',
  dropped: 'subtle'
}

const SHOT_LABEL: Record<RecentFrameView['screenshot'], string> = {
  get attached() { return tr('Front window', '前台窗口') },
  get not_granted() { return tr('Not granted', '未授权') },
  get disabled() { return tr('Off', '关闭') },
  get unavailable() { return tr('None (AX only)', '无（仅 AX）') },
  get secure_input() { return tr('None (password field focused)', '无（密码框聚焦）') }
}

const SETTING_LABEL: Record<string, string> = {
  get source() { return tr('Capture source', '采集来源') },
  get include_screenshot() { return tr('Attach screenshots', '附带截图') },
  get encrypt_screenshots() { return tr('Encrypt screenshots at rest', '截图静态加密') },
  get buffer_retention_hours() { return tr('Raw frame retention (hours)', '原始帧保留（小时）') },
  get screenshot_retention_hours() { return tr('Screenshot retention (hours)', '截图保留（小时）') },
  get screenshot_max_width() { return tr('Screenshot max width', '截图最大宽度') },
  get enable_ocr_fallback() { return tr('OCR fallback', 'OCR 兜底') },
  get ocr_policy() { return tr('OCR policy', 'OCR 策略') },
  get pause_on_lock() { return tr('Pause on lock', '锁屏暂停') },
  get suppress_secure_input() { return tr('Suppress password fields', '密码框抑制') }
}

const VERDICT_LABEL: Record<NonNullable<CaptureStatusView['textHealth']>['verdict'], string> = {
  get idle() { return tr('Idle (no frames in window)', '空闲（窗口内没有帧）') },
  get no_text() { return tr('No text', '无文本') },
  get partial() { return tr('Partial text', '部分有文本') },
  get ok() { return tr('OK', '正常') }
}

const VERDICT_TONE: Record<NonNullable<CaptureStatusView['textHealth']>['verdict'], 'muted' | 'bad' | 'warn' | 'ok'> = {
  idle: 'muted',
  no_text: 'bad',
  partial: 'warn',
  ok: 'ok'
}

/** Opens both fixed TCC panes through the allowlisted openPrivacy IPC (no URL crosses IPC). */
async function openSystemSettings(): Promise<void> {
  await unwrap(capture().openPrivacy('accessibility'))
  await unwrap(capture().openPrivacy('screenRecording'))
}

function reasonText(reason: string | null): string {
  if (!reason) return ''
  if (reason.includes('capture.source')) {
    return tr(
      'The Runtime is still capturing with its own daemon (capture.source is not "ingest"), so Navalia won\'t capture twice. Switch to ingest, then click "Restart capture".',
      'Runtime 仍由 daemon 自己采集（capture.source 不是 "ingest"），Navalia 不会重复采集。切换到 ingest 后点“重新启动采集”。'
    )
  }
  if (reason.includes('native')) return tr('The native capture module is not loaded: run npm run native:build first.', '原生采集模块没有加载：请先运行 npm run native:build。')
  return reason
}

const SOURCE_TONE: Record<CaptureDiagnosticsView['config']['source'], string> = {
  ingest: 'ok',
  daemon: 'warn',
  unknown: 'bad'
}

const CONFIG_STATE_LABEL: Record<CaptureDiagnosticsView['config']['state'], string> = {
  get ok() { return tr('read', '已读取') },
  get missing() { return tr('not found', '未找到') },
  get unreadable() { return tr('unreadable', '无法读取') },
  get malformed() { return tr('malformed', '格式错误') }
}

function useCaptureDiagnostics() {
  return useQuery<CaptureDiagnosticsView>({
    queryKey: ['capture', 'diagnostics'],
    queryFn: () => unwrap(capture().diagnostics()),
    refetchInterval: 10000
  })
}

function useCaptureStatus() {
  return useQuery<CaptureStatusView>({
    queryKey: ['capture', 'status'],
    queryFn: () => unwrap(capture().status()),
    refetchInterval: 2000
  })
}

export function Capture() {
  const qc = useQueryClient()
  const status = useCaptureStatus()
  const diag = useCaptureDiagnostics()
  const [copied, setCopied] = useState(false)
  const [appName, setAppName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const invalidate = () => qc.invalidateQueries({ queryKey: ['capture'] })

  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error))
  })
  const run = (fn: () => Promise<unknown>) => {
    setNotice(null)
    act.mutate(fn)
  }

  const s = status.data
  const d = diag.data

  async function copyDiagnostics(): Promise<void> {
    if (!d) return
    setNotice(null)
    try {
      await unwrap(window.lens.app.copy(d.text))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }
  const paused = s?.pause.paused ?? false

  function removeExclusion(kind: ExclusionKind, value: string): void {
    run(() => unwrap(capture().excludeRemove(kind, value)))
  }

  return (
    <div className="page capture-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Capture</div>
          <h2>{tr('Capture', '采集')}</h2>
          <p className="muted">
            {tr(
              "Navalia reads the screen itself (Accessibility + Screen Recording are granted only to Navalia) and pushes each frame to the Runtime's /captures/ingest. This page shows frame metadata only, never screenshots or screen text.",
              'Navalia 自己读取屏幕（辅助功能 + 屏幕录制权限只授予 Navalia），逐帧推送给 Runtime 的 /captures/ingest。这里只显示帧的元数据，不显示截图或屏幕文字。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost capture-restart" onClick={() => run(() => unwrap(capture().restart()))}>
            {tr('Restart capture', '重新启动采集')}
          </button>
        </div>
      </header>

      {status.isError ? <div className="banner bad compact">{errorMessage(status.error)}</div> : null}
      {notice ? <div className="banner bad compact">{notice}</div> : null}
      {s && !s.started ? (
        <div className="banner warn compact capture-inactive">
          <span>
            <strong>{tr('Capture is not running. ', '采集未运行。')}</strong>
            {reasonText(s.reason)}
            <br />
            <span className="mono tiny">{s.reason}</span>
          </span>
        </div>
      ) : null}
      {s?.started && s.degraded ? (
        <div className="banner warn compact">
          <span>
            <strong>{tr('Degraded: ', '降级运行：')}</strong>
            {tr(
              'Navalia has no Accessibility permission yet, so frames carry no AX text (the Runtime records ax_unavailable), only app switches and window info.',
              'Navalia 还没有辅助功能权限，帧里没有 AX 文本（Runtime 记为 ax_unavailable），只有应用切换与窗口信息。'
            )}
          </span>
        </div>
      ) : null}
      {s?.settingsError ? <div className="banner warn compact">{s.settingsError}</div> : null}
      {s?.textHealth?.banner ? (
        <div className="banner bad compact capture-text-health-banner" role="alert">
          <span>
            <strong>{s.textHealth.banner}</strong>
            {s.textHealth.lastShotIssue ? (
              <span className="muted tiny">
                {tr(
                  ` (last no-screenshot reason: ${s.textHealth.lastShotIssue.label})`,
                  `（最近无截图原因：${s.textHealth.lastShotIssue.label}）`
                )}
              </span>
            ) : null}
          </span>
          <button className="btn small capture-open-settings" onClick={() => run(openSystemSettings)}>
            {tr('Open System Settings', '打开系统设置')}
          </button>
        </div>
      ) : null}

      <section className="grid stats">
        <StatCard
          label={tr('Status', '状态')}
          value={
            !s
              ? '—'
              : !s.started
                ? tr('Not running', '未运行')
                : paused
                  ? tr('Paused', '已暂停')
                  : s.degraded
                    ? tr('Running (degraded)', '运行中（降级）')
                    : tr('Running', '运行中')
          }
          detail={s?.startedAt ? tr(`Started ${formatDateTime(s.startedAt)}`, `启动于 ${formatDateTime(s.startedAt)}`) : undefined}
          tone={!s ? 'muted' : !s.started ? 'bad' : paused || s.degraded ? 'warn' : 'ok'}
        />
        <StatCard
          label={tr('Written', '已写入')}
          value={formatNumber(s?.ingest.written ?? 0)}
          detail={tr(
            `Deduped ${formatNumber(s?.ingest.deduped ?? 0)} · skipped ${formatNumber(s?.ingest.skipped ?? 0)}`,
            `去重 ${formatNumber(s?.ingest.deduped ?? 0)} · 跳过 ${formatNumber(s?.ingest.skipped ?? 0)}`
          )}
          tone="ok"
        />
        <StatCard
          label={tr('Pending retry / rejected', '待重试 / 被拒')}
          value={`${formatNumber(s?.ingest.parked ?? 0)} / ${formatNumber(s?.ingest.rejected ?? 0)}`}
          detail={(() => {
            const retries = formatNumber(s?.ingest.retries ?? 0)
            const queued = formatNumber(s?.ingest.queued ?? 0)
            const dropped = formatNumber(
              (s?.ingest.dropped.paused ?? 0) + (s?.ingest.dropped.locked ?? 0) + (s?.ingest.dropped.excluded_app ?? 0)
            )
            return tr(
              `${retries} retries · queued ${queued} · withdrawn ${dropped}`,
              `重试 ${retries} 次 · 队列 ${queued} · 撤回 ${dropped}`
            )
          })()}
          tone={(s?.ingest.parked ?? 0) + (s?.ingest.rejected ?? 0) > 0 ? 'warn' : 'muted'}
        />
        <StatCard
          label="Runtime"
          value={s ? `127.0.0.1:${s.runtime.port}` : '—'}
          detail={d ? `source = ${d.config.source}` : s ? `source = "${s.runtime.source}"` : undefined}
          tone={d ? (d.config.source === 'ingest' ? 'ok' : 'warn') : s?.runtime.source === 'ingest' ? 'ok' : 'warn'}
        />
        <StatCard
          label={tr(
            `Text coverage (last ${s?.textHealth?.windowMinutes ?? 30} min)`,
            `文本覆盖（近 ${s?.textHealth?.windowMinutes ?? 30} 分钟）`
          )}
          value={
            s?.textHealth?.coverage === null || s?.textHealth?.coverage === undefined
              ? '—'
              : `${Math.round(s.textHealth.coverage * 100)}%`
          }
          detail={
            s?.textHealth
              ? tr(
                  `Frames ${formatNumber(s.textHealth.frames)} · with text ${formatNumber(s.textHealth.textFrames)} (AX ${formatNumber(
                    s.textHealth.axTextFrames
                  )} / OCR ${formatNumber(s.textHealth.ocrFrames)}) · ${VERDICT_LABEL[s.textHealth.verdict]}`,
                  `帧 ${formatNumber(s.textHealth.frames)} · 有文本 ${formatNumber(s.textHealth.textFrames)}（AX ${formatNumber(
                    s.textHealth.axTextFrames
                  )} / OCR ${formatNumber(s.textHealth.ocrFrames)}）· ${VERDICT_LABEL[s.textHealth.verdict]}`
                )
              : undefined
          }
          tone={s?.textHealth ? VERDICT_TONE[s.textHealth.verdict] : 'muted'}
        />
      </section>

      <section className="card capture-diagnostics">
        <div className="card-head">
          <h3>{tr('Capture diagnostics', '采集状态诊断')}</h3>
          <span className="muted small">
            {tr('Read-only: Runtime config.toml + Navalia local state, refreshed every 10 s', '只读：Runtime config.toml + Navalia 本地状态，每 10 秒刷新')}
          </span>
        </div>
        {diag.isError ? <div className="banner bad compact">{errorMessage(diag.error)}</div> : null}
        <dl className="kv">
          <div>
            <dt>{tr('Capture source', '采集来源')}</dt>
            <dd>
              <span className={`chip ${d ? SOURCE_TONE[d.config.source] : 'subtle'}`}>{d ? d.config.source : '—'}</span>{' '}
              <span className="muted tiny">
                {d
                  ? `config.toml ${CONFIG_STATE_LABEL[d.config.state]}${d.config.sourceOrigin === 'default' ? tr(' · default', ' · 缺省值') : ''}${
                      d.config.error ? ` · ${d.config.error}` : ''
                    }`
                  : ''}
              </span>
              {d ? <div className="small" style={{ marginTop: 4 }}>{d.sourceExplanation}</div> : null}
            </dd>
          </div>
          <div>
            <dt>OCR</dt>
            <dd>
              <span className="small">{d ? d.ocrLabel : '—'}</span>
              <OcrStatusPanel diag={d} failed={diag.isError} testId="capture-ocr-status" />
              {d?.config.invalidKeys.length ? (
                <div className="muted tiny">
                  {tr(
                    `Settings the Runtime will reject: ${d.config.invalidKeys.join(', ')}`,
                    `Runtime 会拒绝的配置项：${d.config.invalidKeys.join(', ')}`
                  )}
                </div>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{tr('Permissions', '权限')}</dt>
            <dd className="small">
              {tr('Accessibility', '辅助功能')} {s ? (s.permissions.accessibility ? tr('granted', '已授权') : tr('not granted', '未授权')) : '—'} ·{' '}
              {tr('Screen Recording', '屏幕录制')} {s ? (s.permissions.screenRecording ? tr('granted', '已授权') : tr('not granted', '未授权')) : '—'}
            </dd>
          </div>
          <div>
            <dt>{tr('Last frame', '最近一帧')}</dt>
            <dd className="small">
              {d?.frames.lastAt
                ? `${formatDateTime(d.frames.lastAt)} · ${d.frames.lastApp ?? '—'} · ${
                    d.frames.lastOutcome ? OUTCOME_LABEL[d.frames.lastOutcome as RecentFrameView['outcome']] ?? d.frames.lastOutcome : '—'
                  }`
                : tr('No frames since this launch', '本次启动以来还没有帧')}
              {d ? (
                <span className="muted tiny">
                  {tr(
                    ` (Runtime has received ${formatNumber(d.frames.accepted)} frames this launch)`,
                    `（本次启动 Runtime 已接收 ${formatNumber(d.frames.accepted)} 帧）`
                  )}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{tr('Text health', '文本健康')}</dt>
            <dd className="small capture-text-health">
              {s?.textHealth
                ? (() => {
                    const h = s.textHealth
                    const cov = h.coverage === null ? '—' : `${Math.round(h.coverage * 100)}%`
                    const verdict = VERDICT_LABEL[h.verdict]
                    return tr(
                      `Last ${h.windowMinutes} min: frames ${h.frames} · with text ${h.textFrames} · with pixels ${h.screenshotFrames} · coverage ${cov} · ${verdict}`,
                      `近 ${h.windowMinutes} 分钟：帧 ${h.frames} · 有文本 ${h.textFrames} · 带像素 ${h.screenshotFrames} · 覆盖率 ${cov} · ${verdict}`
                    )
                  })()
                : '—'}
              {s?.textHealth?.lastShotIssue ? (
                <div className="muted tiny">
                  {tr(
                    `Last no-screenshot reason: ${s.textHealth.lastShotIssue.label} (${s.textHealth.lastShotIssue.reason}, ${formatDateTime(s.textHealth.lastShotIssue.at)})`,
                    `最近无截图原因：${s.textHealth.lastShotIssue.label}（${s.textHealth.lastShotIssue.reason}，${formatDateTime(s.textHealth.lastShotIssue.at)}）`
                  )}
                </div>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{tr('Exclusions', '排除')}</dt>
            <dd className="small">{d ? d.exclusions.summary : '—'}</dd>
          </div>
          <div>
            <dt>{tr('Pause', '暂停')}</dt>
            <dd className="small">
              {!s
                ? '—'
                : !s.pause.paused
                  ? tr('Not paused', '未暂停')
                  : s.pause.until
                    ? tr(`Paused until ${formatDateTime(s.pause.until)}`, `暂停到 ${formatDateTime(s.pause.until)}`)
                    : tr('Paused until resumed manually', '已暂停，直到手动恢复')}
            </dd>
          </div>
        </dl>
        <details>
          <summary className="small">
            {tr(
              'Diagnostics (copyable; tokens / keys redacted; no window titles, URLs or screenshots)',
              '诊断信息（可复制，已隐藏 token / 密钥，不含窗口标题、URL、截图）'
            )}
          </summary>
          <pre className="mono tiny capture-diagnostics-text" style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>
            {d?.text ?? '—'}
          </pre>
        </details>
        <div className="card-foot wrap">
          <button className="btn ghost small capture-copy-diagnostics" disabled={!d} onClick={() => void copyDiagnostics()}>
            {copied ? tr('Copied', '已复制') : tr('Copy diagnostics', '复制诊断信息')}
          </button>
          <button className="btn ghost small" onClick={() => void diag.refetch()}>
            {tr('Refresh', '刷新')}
          </button>
        </div>
      </section>

      <section className="grid two">
        <div className="card">
          <div className="card-head">
            <h3>{tr('Permissions', '权限')}</h3>
            <span className="muted small">{tr('Only these two; Full Disk Access is not needed', '只需要这两项，不需要完全磁盘访问')}</span>
          </div>
          <dl className="kv">
            <div>
              <dt>{tr('Accessibility', '辅助功能')}</dt>
              <dd>
                <span className={`chip ${s?.permissions.accessibility ? 'ok' : 'warn'}`}>
                  {s?.permissions.accessibility ? tr('Granted', '已授权') : tr('Not granted', '未授权')}
                </span>{' '}
                <span className="muted small">{tr('Reads window structure and text (AX tree)', '读取窗口结构与文字（AX tree）')}</span>
              </dd>
            </div>
            <div>
              <dt>{tr('Screen Recording', '屏幕录制')}</dt>
              <dd>
                <span className={`chip ${s?.permissions.screenRecording ? 'ok' : 'warn'}`}>
                  {s?.permissions.screenRecording ? tr('Granted', '已授权') : tr('Not granted', '未授权')}
                </span>{' '}
                <span className="muted small">{tr("Captures only the front app's window, never the whole screen", '只截前台应用的窗口，不截整个屏幕')}</span>
              </dd>
            </div>
          </dl>
          <p className="muted small">
            {tr(
              'To grant: System Settings → Privacy & Security → Accessibility / Screen & System Audio Recording, turn on “Navalia” (“Electron” in dev mode; possibly your terminal app when launched from a terminal). Then click "Restart capture". Screen Recording is requested only when you click the button below.',
              '授权方式：系统设置 → 隐私与安全性 → 辅助功能 / 屏幕与系统录音，打开 “Navalia”（开发模式下是 “Electron”；从终端启动时可能是终端 App）。授权后点“重新启动采集”。屏幕录制只会在你点下面按钮时请求。'
            )}
          </p>
          <div className="card-foot wrap">
            <button className="btn ghost small" onClick={() => run(() => unwrap(capture().requestAccessibility()))}>
              {tr('Request Accessibility', '请求辅助功能')}
            </button>
            <button className="btn ghost small" onClick={() => run(() => unwrap(capture().openPrivacy('accessibility')))}>
              {tr('Open Accessibility settings', '打开辅助功能设置')}
            </button>
            <button
              className="btn ghost small capture-request-screen"
              onClick={() => run(() => unwrap(capture().requestScreenRecording()))}
            >
              {tr('Grant Screen Recording…', '授权屏幕录制…')}
            </button>
            <button className="btn ghost small" onClick={() => run(() => unwrap(capture().openPrivacy('screenRecording')))}>
              {tr('Open Screen Recording settings', '打开屏幕录制设置')}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>{tr('Pause', '暂停')}</h3>
            <span className={`chip ${paused ? 'warn' : 'ok'}`}>{paused ? tr('Paused', '已暂停') : tr('Capturing', '采集中')}</span>
          </div>
          <p className="muted small">
            {paused
              ? s?.pause.until
                ? tr(
                    `Paused until ${formatDateTime(s.pause.until)} (resumes automatically at midnight); survives a Navalia restart.`,
                    `暂停到 ${formatDateTime(s.pause.until)}（次日 0 点自动恢复），重启 Navalia 后仍然有效。`
                  )
                : tr(
                    `Paused since ${formatDateTime(s?.pause.since)} until resumed manually; survives a Navalia restart.`,
                    `从 ${formatDateTime(s?.pause.since)} 起暂停，直到手动恢复；重启 Navalia 后仍然有效。`
                  )
              : tr(
                  'While paused, no frames are produced and ingest is never called. Capture pauses automatically when the screen locks.',
                  '暂停期间不产生任何帧，也不调用 ingest。锁屏时自动暂停。'
                )}
          </p>
          <div className="card-foot wrap">
            <button className="btn ghost small" disabled={paused} onClick={() => run(() => unwrap(capture().pause('now')))}>
              {tr('Pause now', '立即暂停')}
            </button>
            <button className="btn ghost small" onClick={() => run(() => unwrap(capture().pause('untilMidnight')))}>
              {tr('Pause until midnight', '暂停到今晚 0 点')}
            </button>
            <button className="btn primary small" disabled={!paused} onClick={() => run(() => unwrap(capture().resume()))}>
              {tr('Resume', '恢复')}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>{tr('Excluded apps', '排除的应用')}</h3>
          <span className="muted small">
            {tr('Dropped before AX is read or a screenshot taken: no frame, no ingest call', '在读取 AX 和截图之前丢弃：不生成帧、不调用 ingest')}
          </span>
        </div>
        {s?.excluded.builtIn.map((b) => (
          <div key={b.label} className="capture-builtin" style={{ marginBottom: 8 }}>
            <span className="chip subtle">{tr(`Always excluded: ${b.label}`, `始终排除：${b.label}`)}</span>{' '}
            <span className="muted tiny">
              {tr(
                'Built in, cannot be removed (neither Navalia itself nor other Navalia instances ever become evidence)',
                '内置，不能移除（Navalia 自己和其他 Navalia 实例都不会成为证据）'
              )}
            </span>
            <div className="mono tiny muted">{[...b.bundleIds, ...b.bundlePaths].join(' · ')}</div>
          </div>
        ))}
        {s && s.excluded.bundleIds.length + s.excluded.appNames.length === 0 ? (
          <p className="muted small">{tr('No manually excluded apps yet.', '还没有手动排除的应用。')}</p>
        ) : null}
        <ul className="capture-exclusions" style={{ listStyle: 'none', padding: 0, margin: '0 0 8px', display: 'grid', gap: 6 }}>
          {s?.excluded.bundleIds.map((b) => (
            <li key={`b:${b}`}>
              <span className="mono small">{b}</span> <span className="muted tiny">bundle id</span>{' '}
              <button className="btn ghost small" onClick={() => removeExclusion('bundleId', b)}>
                {tr('Remove', '移除')}
              </button>
            </li>
          ))}
          {s?.excluded.appNames.map((a) => (
            <li key={`a:${a}`}>
              <span>{a}</span> <span className="muted tiny">{tr('app name', '应用名')}</span>{' '}
              <button className="btn ghost small" onClick={() => removeExclusion('appName', a)}>
                {tr('Remove', '移除')}
              </button>
            </li>
          ))}
        </ul>
        <div className="card-foot wrap">
          <button className="btn ghost small" onClick={() => run(() => unwrap(capture().pickApp()))}>
            {tr('Choose app…', '选择应用…')}
          </button>
          <input
            className="input"
            placeholder={tr('Or type an app name, e.g. 1Password', '或输入应用名，例如 1Password')}
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
          />
          <button
            className="btn ghost small"
            disabled={!appName.trim()}
            onClick={() => {
              const value = appName.trim()
              setAppName('')
              run(() => unwrap(capture().excludeAdd('appName', value)))
            }}
          >
            {tr('Exclude by name', '按名称排除')}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>{tr('Recent frames', '最近的帧')}</h3>
          <span className="muted small">{tr('Since this launch, up to 50; metadata only', '本次启动以来，最多 50 条；只含元数据')}</span>
        </div>
        {s && s.recentFrames.length === 0 ? <p className="muted small">{tr('No frames yet.', '还没有帧。')}</p> : null}
        {s && s.recentFrames.length > 0 ? (
          <table className="table capture-frames">
            <thead>
              <tr>
                <th style={{ width: 150 }}>{tr('Time', '时间')}</th>
                <th style={{ width: 150 }}>{tr('App', '应用')}</th>
                <th>{tr('Window / URL', '窗口 / URL')}</th>
                <th style={{ width: 150 }}>{tr('Trigger', '触发')}</th>
                <th style={{ width: 54 }}>AX</th>
                <th style={{ width: 92 }}>{tr('Screenshot', '截图')}</th>
                <th style={{ width: 110 }}>{tr('Result', '结果')}</th>
              </tr>
            </thead>
            <tbody>
              {s.recentFrames.map((f) => (
                <tr key={`${f.at}:${f.bundleId}:${f.id ?? ''}`}>
                  <td className="small">{formatDateTime(f.at)}</td>
                  <td>
                    <div>{f.appName || '—'}</div>
                    <div className="mono tiny muted ellipsis">{f.bundleId}</div>
                  </td>
                  <td>
                    <div className="ellipsis">{f.windowTitle || <span className="muted">{tr('(untitled)', '（无标题）')}</span>}</div>
                    {f.url ? <div className="mono tiny muted ellipsis">{f.url}</div> : null}
                  </td>
                  <td className="mono tiny">{f.trigger}</td>
                  <td className="small">{f.axAvailable ? tr('Yes', '有') : tr('No', '无')}</td>
                  <td className="small">{SHOT_LABEL[f.screenshot]}</td>
                  <td>
                    <span className={`chip ${OUTCOME_TONE[f.outcome]}`}>{OUTCOME_LABEL[f.outcome]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="grid two">
        <div className="card">
          <div className="card-head">
            <h3>{tr('By app', '按应用')}</h3>
            <span className="muted small">{tr('Since this launch', '本次启动以来')}</span>
          </div>
          {s && s.perApp.length === 0 ? <p className="muted small">—</p> : null}
          {s && s.perApp.length > 0 ? (
            <table className="table capture-per-app">
              <thead>
                <tr>
                  <th>{tr('App', '应用')}</th>
                  <th style={{ width: 60 }}>{tr('Written', '写入')}</th>
                  <th style={{ width: 60 }}>{tr('Deduped', '去重')}</th>
                  <th style={{ width: 60 }}>{tr('Skipped', '跳过')}</th>
                  <th style={{ width: 60 }}>{tr('Failed', '失败')}</th>
                  <th style={{ width: 140 }}>{tr('Latest', '最近')}</th>
                </tr>
              </thead>
              <tbody>
                {s.perApp.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <div>{r.appName || '—'}</div>
                      <div className="mono tiny muted ellipsis">{r.bundleId}</div>
                    </td>
                    <td>{r.written}</td>
                    <td>{r.deduped}</td>
                    <td>{r.skipped}</td>
                    <td>{r.failed}</td>
                    <td className="small">{formatDateTime(r.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>{tr('Retention / OCR / screenshots', '保留 / OCR / 截图')}</h3>
            <span className="muted small">{tr('Runtime [capture] config, read-only', 'Runtime [capture] 配置，只读')}</span>
          </div>
          <dl className="kv">
            {s?.runtime.settings.map((row) => (
              <div key={row.key}>
                <dt>{SETTING_LABEL[row.key] ?? row.key}</dt>
                <dd>
                  <span className="mono small">{String(row.value)}</span>{' '}
                  <span className="muted tiny">{row.fromConfig ? 'config.toml' : tr('default', '默认值')}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="muted tiny mono">{s?.runtime.root}/config.toml</p>
        </div>
      </section>
    </div>
  )
}
