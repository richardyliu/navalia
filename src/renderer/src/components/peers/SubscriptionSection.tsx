// S2-09 「订阅文件夹」 section of the Peers page. Thin: logic lives in peersView.ts.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PeersApi, SubscriptionRefreshReport, SubscriptionStatus } from '../../../../main/peers/api'
import { autoScanHint, autoScanLine, clampInterval, formatLocal, SUBSCRIPTION, subscriptionRows, subscriptionState, subscriptionSummary } from './peersView'
import { tr } from '../../lib/i18n'
import { unwrap, errorMessage } from '../../lib/api'

const peers = (): PeersApi['peers'] => (window.lens as unknown as PeersApi).peers

export function SubscriptionSection() {
  const qc = useQueryClient()
  const status = useQuery<SubscriptionStatus>({ queryKey: ['peers', 'subscription'], queryFn: () => unwrap(peers().subStatus()) })
  const [report, setReport] = useState<SubscriptionRefreshReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const onStatus = (s: SubscriptionStatus | null) => {
    setError(null)
    if (s) qc.setQueryData(['peers', 'subscription'], s)
  }
  const choose = useMutation({ mutationFn: () => unwrap(peers().subChoose()), onSuccess: onStatus, onError: (e) => setError(errorMessage(e)) })
  const enable = useMutation({ mutationFn: () => unwrap(peers().subEnable()), onSuccess: onStatus, onError: (e) => setError(errorMessage(e)) })
  const disable = useMutation({ mutationFn: () => unwrap(peers().subDisable()), onSuccess: onStatus, onError: (e) => setError(errorMessage(e)) })
  const [interval, setIntervalText] = useState<string | null>(null)
  const autoScan = useMutation({
    mutationFn: (v: { enabled: boolean; intervalMinutes: number }) => unwrap(peers().subSetAutoScan(v.enabled, v.intervalMinutes)),
    onSuccess: (st) => {
      setIntervalText(null)
      onStatus(st)
    },
    onError: (e) => setError(errorMessage(e))
  })
  const refresh = useMutation({
    mutationFn: () => unwrap(peers().subRefresh()),
    onSuccess: (r) => {
      setReport(r)
      setError(null)
      void qc.invalidateQueries({ queryKey: ['peers'] })
    },
    onError: (e) => setError(errorMessage(e))
  })

  const s = status.data
  const state = subscriptionState(s)
  const busy = choose.isPending || enable.isPending || disable.isPending || refresh.isPending || autoScan.isPending
  const autoLine = autoScanLine(s)

  return (
    <section className="card peers-sub">
      <div className="section-head">
        <h3>{tr('Subscription folder', '订阅文件夹')}</h3>
        <span className={`chip ${state.tone}`}>{state.text}</span>
      </div>
      <p className="muted tiny">{SUBSCRIPTION.reason}</p>
      {s?.folder ? (
        <div className="tiny">
          {tr('Folder: ', '文件夹：')}<span className="mono">{s.folder}</span>
          {s.lastRefreshAt ? <span className="muted"> · {tr(`Last refresh ${formatLocal(s.lastRefreshAt)}`, `上次刷新 ${formatLocal(s.lastRefreshAt)}`)}</span> : null}
          <span className="muted"> · {tr(`${s.ledgerSize} files recorded`, `已记录 ${s.ledgerSize} 个文件`)}</span>
        </div>
      ) : null}
      {s?.folderProblem ? <div className="banner warn compact">{s.folderProblem}</div> : null}
      {s ? (
        <p className="muted tiny">
          {tr(
            `Top level of the folder only; symbolic links are not followed; each file ≤ ${Math.round(s.limits.maxFileBytes / 1024)} KB, at most ${s.limits.maxFiles} files per refresh. Files already processed (by content hash) are skipped.`,
            `只看文件夹第一层；不跟随符号链接；单个文件 ≤ ${Math.round(s.limits.maxFileBytes / 1024)} KB，每次最多 ${s.limits.maxFiles} 个文件。已处理过的文件（按内容 hash）会跳过。`
          )}
        </p>
      ) : null}
      <div className="page-actions">
        <button className="btn" disabled={busy} onClick={() => choose.mutate()}>
          {s?.folder ? tr('Change folder', '更换文件夹') : tr('Choose folder', '选择文件夹')}
        </button>
        {s?.folder && !s.enabled ? (
          <button className="btn" disabled={busy} onClick={() => enable.mutate()}>
            {tr('Re-enable', '重新启用')}
          </button>
        ) : null}
        {s?.enabled ? (
          <>
            <button className="btn primary" disabled={busy} onClick={() => refresh.mutate()}>
              {refresh.isPending ? tr('Refreshing…', '刷新中…') : tr('Refresh', '刷新')}
            </button>
            <button className="btn" disabled={busy} onClick={() => disable.mutate()}>
              {tr('Stop', '停用')}
            </button>
          </>
        ) : null}
      </div>
      {s?.folder ? (
        <div className="tiny peers-sub-auto">
          <label>
            <input
              type="checkbox"
              checked={s.autoScan.enabled}
              disabled={busy}
              onChange={(e) => autoScan.mutate({ enabled: e.target.checked, intervalMinutes: clampInterval(interval ?? s.autoScan.intervalMinutes, s.autoScan) })}
            />{' '}
            {tr('Periodic scan (off by default) · every', '定期扫描（默认关闭）· 每')}
          </label>{' '}
          <input
            type="number"
            className="mono"
            style={{ width: '5em' }}
            min={s.autoScan.minMinutes}
            max={s.autoScan.maxMinutes}
            value={interval ?? String(s.autoScan.intervalMinutes)}
            disabled={busy}
            onChange={(e) => setIntervalText(e.target.value)}
            onBlur={() => {
              if (interval === null) return
              const v = clampInterval(interval, s.autoScan)
              if (v !== s.autoScan.intervalMinutes) autoScan.mutate({ enabled: s.autoScan.enabled, intervalMinutes: v })
              else setIntervalText(null)
            }}
          />{' '}
          {tr(`min (${s.autoScan.minMinutes}–${s.autoScan.maxMinutes})`, `分钟（${s.autoScan.minMinutes}–${s.autoScan.maxMinutes}）`)}
          <div className="muted">{autoScanHint()}</div>
          {autoLine ? <div className="muted">{autoLine}</div> : null}
        </div>
      ) : null}
      {status.isError ? <div className="banner bad compact">{errorMessage(status.error)}</div> : null}
      {error ? <div className="banner bad compact">{error}</div> : null}
      {report ? (
        <div className="peers-sub-report">
          <div className="tiny">{subscriptionSummary(report)}</div>
          <ul>
            {subscriptionRows(report).map((r) => (
              <li key={r.key}>
                <span className={`chip ${r.tone}`}>{r.label}</span> <span className="chip subtle">{r.kind}</span> <span className="mono tiny">{r.name}</span>
                {r.note ? <div className="tiny muted">{r.note}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
