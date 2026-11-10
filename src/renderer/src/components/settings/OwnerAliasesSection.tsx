import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { OwnerAliasList, OwnerAliasStatus } from '../../../../main/runtime/owner-aliases'
import {
  OWNER_ALIAS_TABS,
  untrustedQuoteNote,
  aliasRows,
  decideAndRelist,
  emptyText,
  listAliases,
  rawAliasAt,
  type AliasRowView,
  type OwnerAliasBridge
} from './ownerAliasesView'
import './settings.css'
import { tr } from '../../lib/i18n'

export interface OwnerAliasesPanelProps {
  tab: OwnerAliasStatus
  rows: AliasRowView[]
  loading: boolean
  error: string | null
  notice: { tone: 'ok' | 'warn' | 'bad'; message: string } | null
  busy: boolean
  onTab(tab: OwnerAliasStatus): void
  onDecide(kind: 'confirm' | 'reject', index: number): void
  onRefresh(): void
}

/** Presentational part (props only) so it can be rendered statically in tests. */
export function OwnerAliasesPanel(p: OwnerAliasesPanelProps) {
  return (
    <section className="card settings-aliases" data-testid="settings-owner-aliases">
      <div className="card-head">
        <h3>{tr('Owner aliases', '身份别名')}</h3>
        <span className="chip subtle">{tr('Takes effect only after you confirm', '只有你确认后才生效')}</span>
      </div>
      <p className="muted small">
        {tr(
          'When Persome sees a name or account on screen or in a session that might be you, it is first recorded as pending. Clicking Confirm or Reject opens a system dialog; it is written to Runtime only after you confirm there. Cancelling changes nothing.',
          'Persome 在屏幕 / 会话里看到“可能是你”的名字或账号时，会先记为待确认。点「确认」或「拒绝」后会弹出系统对话框，再次确认才会写入 Runtime；取消则不做任何更改。'
        )}
      </p>
      <div className="alias-tabs" role="tablist">
        {OWNER_ALIAS_TABS.map((t) => (
          <button
            key={t.status}
            role="tab"
            aria-selected={p.tab === t.status}
            className={`btn small ${p.tab === t.status ? '' : 'ghost'}`}
            data-testid={`alias-tab-${t.status}`}
            onClick={() => p.onTab(t.status)}
          >
            {t.label}
          </button>
        ))}
        <button className="btn ghost small" disabled={p.loading || p.busy} onClick={p.onRefresh}>
          {tr('Refresh', '刷新')}
        </button>
      </div>

      {p.notice ? (
        <div className={`banner ${p.notice.tone} compact`} role="status" data-testid="alias-notice">
          {p.notice.message}
        </div>
      ) : null}
      {p.error ? (
        <div className="banner bad compact" role="alert" data-testid="alias-error">
          {p.error}
        </div>
      ) : null}
      {p.loading ? <p className="muted small">{tr('Loading…', '读取中…')}</p> : null}
      {!p.loading && !p.error && p.rows.length === 0 ? (
        <p className="muted small" data-testid="alias-empty">
          {emptyText(p.tab)}
        </p>
      ) : null}

      <ul className="alias-list">
        {p.rows.map((row, index) => (
          <li key={`${row.status}:${row.alias}:${index}`} className="alias-row" data-testid="alias-row">
            <div className="alias-row-head">
              <strong className="mono">{row.alias}</strong>
              <span className={`chip ${row.status === 'active' ? 'ok' : row.status === 'rejected' ? 'subtle' : 'warn'}`}>{row.statusLabel}</span>
              <span className="muted small">
                {tr(
                  `Evidence ${row.evidenceCount} · confidence ${row.confidence} · last seen ${row.lastSeen}`,
                  `证据 ${row.evidenceCount} 条 · 置信度 ${row.confidence} · 最近 ${row.lastSeen}`
                )}
              </span>
            </div>
            {row.evidence.length > 0 ? (
              <div className="alias-evidence">
                <div className="muted tiny">{untrustedQuoteNote()}</div>
                {row.evidence.map((ev) => (
                  <figure key={ev.key} className="alias-quote">
                    <blockquote className="untrusted" data-untrusted="true">
                      {ev.quote || tr('(empty)', '（空）')}
                    </blockquote>
                    <figcaption className="muted tiny">
                      {tr('Source', '来源')} {ev.source} · {tr('session', '会话')} <span className="mono">{ev.session}</span> · {ev.when}
                    </figcaption>
                  </figure>
                ))}
                {row.shownNote ? <div className="muted tiny">{row.shownNote}</div> : null}
              </div>
            ) : (
              <div className="muted tiny">{tr('Runtime returned no original excerpt.', 'Runtime 没有返回原文摘录。')}</div>
            )}
            <div className="card-foot wrap">
              {row.canConfirm ? (
                <button className="btn small" disabled={p.busy} data-testid="alias-confirm" onClick={() => p.onDecide('confirm', index)}>
                  {tr('Confirm', '确认')}
                </button>
              ) : null}
              {row.canReject ? (
                <button className="btn ghost small" disabled={p.busy} data-testid="alias-reject" onClick={() => p.onDecide('reject', index)}>
                  {tr('Reject', '拒绝')}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Settings → 身份别名 (S1-R3-01). Reads via `window.lens.ownerAliases`; main owns the dialog. */
export function OwnerAliasesSection({ bridge = window.lens.ownerAliases as OwnerAliasBridge }: { bridge?: OwnerAliasBridge }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<OwnerAliasStatus>('pending')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<OwnerAliasesPanelProps['notice']>(null)
  const key = ['owner-aliases', tab]
  const list = useQuery<OwnerAliasList>({ queryKey: key, queryFn: () => listAliases(bridge, tab), staleTime: 5_000, retry: false })

  async function decide(kind: 'confirm' | 'reject', index: number): Promise<void> {
    const alias = rawAliasAt(list.data, index)
    if (alias === null) return
    setBusy(true)
    setNotice(null)
    try {
      const out = await decideAndRelist(bridge, kind, alias, tab)
      setNotice({ tone: out.tone, message: out.listError ? tr(`${out.message} Reloading the list failed: ${out.listError}`, `${out.message} 重新读取列表失败：${out.listError}`) : out.message })
      if (out.list) qc.setQueryData(key, out.list)
      // Other tabs changed too (pending → active / rejected).
      await qc.invalidateQueries({ queryKey: ['owner-aliases'], refetchType: 'none' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <OwnerAliasesPanel
      tab={tab}
      rows={aliasRows(list.data)}
      loading={list.isLoading}
      error={list.isError ? (list.error instanceof Error ? list.error.message : String(list.error)) : null}
      notice={notice}
      busy={busy}
      onTab={(t) => {
        setTab(t)
        setNotice(null)
      }}
      onDecide={(kind, index) => void decide(kind, index)}
      onRefresh={() => void list.refetch()}
    />
  )
}
