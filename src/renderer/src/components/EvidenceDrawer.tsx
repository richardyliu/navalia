import { useMemo, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { CorrectDialog } from './CorrectDialog'
import { useQuery } from '@tanstack/react-query'
import type { AppInfo, EvidenceItem, EvidenceResponse, NodeResponse } from '../../../shared/types'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, truncate } from '../lib/format'
import { asOfActionLabel, asOfCaveat, asOfCaveatText, asOfFormatHint, asOfLabel, toDateTimeLocalValue, validateAsOf } from './evidence/asOf'
import {
  buildEvidenceView,
  droppedFromDeltaReport,
  parseDeltaReport,
  reproduceCommands,
  type DroppedNotice,
  type SelfSource,
  type UnresolvedReceipt
} from './evidence/model'
import './evidence/evidence.css'
import { tr } from '../lib/i18n'

function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="repro-cmd">
      <code className="mono" title={label}>
        {command}
      </code>
      <button
        className="btn ghost small"
        onClick={() => {
          void api.copy(command).then(() => setCopied(true))
        }}
      >
        {copied ? tr('Copied', '已复制') : tr('Copy', '复制')}
      </button>
    </div>
  )
}

export function UnresolvedRow({ item }: { item: UnresolvedReceipt }) {
  return (
    <div className="unresolved-row">
      <div className="unresolved-head">
        <span className="chip warn">{item.marker}</span>
        <span>{item.label}</span>
        <span className="chip subtle">{tr(`Status: ${item.status}`, `状态：${item.status}`)}</span>
        {item.receiptPath ? <span className="chip subtle">{item.receiptPath}</span> : null}
      </div>
      <div>
        {tr(`Reason: ${item.reasonText}`, `原因：${item.reasonText}`)}
        {item.reasonCode ? (
          <span className="mono tiny muted">{tr(` (${item.reasonCode})`, `（${item.reasonCode}）`)}</span>
        ) : null}
      </div>
      {item.receiptPreserved !== null ? (
        <div className="unresolved-note">
          {item.receiptPreserved
            ? tr('The receipt itself is still kept (reported by Runtime)', '回执本身仍保留（Runtime 返回）')
            : tr('The receipt itself was not kept (reported by Runtime)', '回执本身未保留（Runtime 返回）')}
        </div>
      ) : null}
      {item.knownIssue ? <div className="unresolved-note">{item.knownIssue}</div> : null}
      {item.fallback ? (
        <div className="unresolved-note" data-fallback={item.fallback.outcome}>
          {item.fallback.text}
          <span className="tiny muted">
            {tr(
              ` (checked: ${item.fallback.checked.join(', ')})`,
              `（已检查：${item.fallback.checked.join('、')}）`
            )}
          </span>
        </div>
      ) : null}
      <span className="unresolved-ref mono">
        {tr('Reference: ', '引用：')}
        {truncate(item.reference, 160)}
      </span>
    </div>
  )
}

function UnresolvedSection({
  rootUnresolved,
  items,
  dropped,
  pointWithoutSources,
  commands
}: {
  rootUnresolved: UnresolvedReceipt | null
  items: UnresolvedReceipt[]
  dropped: DroppedNotice | null
  pointWithoutSources: boolean
  commands: { evidence: string; deltaReport: string }
}) {
  const all = rootUnresolved ? [rootUnresolved, ...items] : items
  if (all.length === 0 && !dropped && !pointWithoutSources) return null
  if (all.length === 0 && pointWithoutSources && !dropped) {
    // The Point's own 证据未解析 row is rendered under 直接来源; keep only the repro commands here.
    return (
      <section className="drawer-section">
        <h4>{tr('Reproduce', '复现')}</h4>
        <div className="repro-block">
          <span className="tiny muted">
            {tr(
              'Repro commands (your shell reads the token from the env file; it never appears in the command):',
              '复现命令（token 由你的 shell 从 env 文件读取，不会出现在命令里）：'
            )}
          </span>
          <CopyCommand label={tr('Resolve this evidence', '解析这条证据')} command={commands.evidence} />
          <CopyCommand label={tr('Show drop counts', '查看丢弃计数')} command={commands.deltaReport} />
        </div>
      </section>
    )
  }
  return (
    <section className="drawer-section">
      <h4>
        {tr('Unresolved and dropped', '未解析与丢弃')}
        {all.length ? <span className="count">{all.length}</span> : null}
      </h4>
      <p className="section-note">
        {tr(
          'These are not sources and do not count toward "Direct sources". Reasons show only what Runtime actually returned.',
          '这些不是来源，不计入“直接来源”。原因只显示 Runtime 实际返回的内容。'
        )}
      </p>
      {all.length ? (
        <div className="evidence-list">
          {all.map((item, index) => (
            <UnresolvedRow key={`${item.reference}-${index}`} item={item} />
          ))}
        </div>
      ) : null}
      {dropped ? <p className="small">{dropped.text}</p> : null}
      <div className="repro-block">
        <span className="tiny muted">
          {tr(
            'Repro commands (your shell reads the token from the env file; it never appears in the command):',
            '复现命令（token 由你的 shell 从 env 文件读取，不会出现在命令里）：'
          )}
        </span>
        <CopyCommand label={tr('Resolve this evidence', '解析这条证据')} command={commands.evidence} />
        <CopyCommand label={tr('Show drop counts', '查看丢弃计数')} command={commands.deltaReport} />
      </div>
    </section>
  )
}

export function AsOfBar({
  asOf,
  onApply,
  response
}: {
  asOf: string | undefined
  onApply: (value: string | undefined) => void
  /** The as-of response, when loaded: decides between the MOD-12 caveats. */
  response?: EvidenceResponse | null
}) {
  const [draft, setDraft] = useState(asOf ?? '')
  const [error, setError] = useState<string | null>(null)
  const apply = (value: string) => {
    const check = validateAsOf(value)
    if (!check.ok) {
      setError(check.error)
      return
    }
    setError(null)
    onApply(check.value)
  }
  const caveat = asOfCaveat(asOf, response)
  return (
    <div className="asof-bar">
      <span className="asof-label">{asOfLabel(asOf)}</span>
      {caveat ? (
        <p className="asof-caveat muted small" role="note">
          {caveat}
        </p>
      ) : null}
      <div className="asof-controls">
        <input
          type="datetime-local"
          aria-label={tr('Pick as-of time', '选择截至时间')}
          value={toDateTimeLocalValue(draft)}
          onChange={(event) => setDraft(event.target.value)}
        />
        <input
          type="text"
          aria-label={tr('As-of time (ISO)', '截至时间（ISO）')}
          placeholder={asOfFormatHint()}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply(draft)
          }}
        />
        <button className="btn small" title={asOfCaveatText()} onClick={() => apply(draft)}>
          {asOfActionLabel()}
        </button>
        <button
          className="btn ghost small"
          disabled={!asOf}
          onClick={() => {
            setDraft('')
            setError(null)
            onApply(undefined)
          }}
        >
          {tr('Back to now', '回到现在')}
        </button>
      </div>
      {error ? <p className="asof-error">{error}</p> : null}
    </div>
  )
}

function EvidenceRow({
  item,
  onNavigate
}: {
  item: EvidenceItem
  onNavigate: (reference: string) => void
}) {
  return (
    <button className="evidence-row" onClick={() => item.reference && onNavigate(item.reference)}>
      <span className="evidence-row-main">
        <span className="evidence-row-label">{item.label || item.reference}</span>
        <span className="evidence-row-meta">
          {item.kind ? <span className="chip subtle">{item.kind}</span> : null}
          {item.timestamp ? <span>{formatDateTime(item.timestamp)}</span> : null}
          {item.status && item.status !== 'ok' ? <span className="chip warn">{item.status}</span> : null}
        </span>
        <span className="evidence-row-ref mono">{truncate(item.reference, 96)}</span>
      </span>
      <span className="evidence-row-arrow">›</span>
    </button>
  )
}

export function Section({
  title,
  note,
  items,
  onNavigate,
  unresolved,
  selfSource
}: {
  title: string
  note?: string
  items: EvidenceItem[]
  onNavigate: (reference: string) => void
  /** Shown instead of "无" so an empty list is never silent (MOD-07 Point with sources=[]). */
  unresolved?: UnresolvedReceipt | null
  /** S1-R5-03: a `remember` memory is its own record — shown instead of "无", not counted. */
  selfSource?: SelfSource | null
}) {
  return (
    <section className="drawer-section">
      <h4>
        {title}
        {items.length ? <span className="count">{items.length}</span> : null}
      </h4>
      {note ? <p className="section-note">{note}</p> : null}
      {items.length === 0 && selfSource ? (
        <div className="evidence-list" data-self-source={selfSource.tag}>
          <p className="small">{selfSource.label}</p>
          <p className="muted tiny">{selfSource.detail}</p>
        </div>
      ) : items.length === 0 && unresolved ? (
        <div className="evidence-list">
          <UnresolvedRow item={unresolved} />
        </div>
      ) : items.length === 0 ? (
        <p className="muted small">{tr('None', '无')}</p>
      ) : (
        <div className="evidence-list">
          {items.map((item, index) => (
            <EvidenceRow key={`${item.reference}-${index}`} item={item} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </section>
  )
}

function NodeSection({ rootId }: { rootId: string }) {
  const [open, setOpen] = useState(false)
  const query = useQuery<NodeResponse>({
    queryKey: ['node', rootId],
    queryFn: () => api.node(rootId),
    enabled: open,
    staleTime: 60_000
  })

  return (
    <section className="drawer-section">
      <div className="section-head">
        <h4>{tr('Relations and raw receipts', '关系与原始回执')}</h4>
        <button className="btn ghost small" onClick={() => setOpen((value) => !value)}>
          {open ? tr('Collapse', '收起') : tr('Expand', '展开')}
        </button>
      </div>
      {open ? (
        query.isLoading ? (
          <p className="muted small">{tr('Loading…', '加载中…')}</p>
        ) : query.isError ? (
          <p className="bad small">{errorMessage(query.error)}</p>
        ) : (
          <div className="node-block">
            {query.data?.raw?.length ? (
              query.data.raw.map((raw, index) => (
                <div key={index} className="node-raw">
                  <div className="node-raw-head">
                    <span>{formatDateTime(raw.ts)}</span>
                    <span className="mono small muted">{raw.receipt}</span>
                  </div>
                  <p>{raw.text}</p>
                </div>
              ))
            ) : (
              <p className="muted small">{tr('No raw receipts to show.', '没有可展示的原始回执。')}</p>
            )}
            {query.data?.tree ? (
              <details className="tree">
                <summary>{tr('Relation tree', '关系树')}</summary>
                <pre>{JSON.stringify(query.data.tree, null, 2)}</pre>
              </details>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  )
}

export function EvidenceDrawer({
  reference,
  onClose,
  onNavigate
}: {
  reference: string
  onClose: () => void
  onNavigate: (reference: string) => void
}) {
  const [correctOpen, setCorrectOpen] = useState(false)
  const [asOf, setAsOf] = useState<string | undefined>(undefined)
  const query = useQuery<EvidenceResponse>({
    queryKey: ['evidence', reference, asOf ?? null],
    queryFn: () => api.evidence(reference, asOf),
    staleTime: 30_000
  })
  const info = useQuery<AppInfo>({ queryKey: ['app-info'], queryFn: api.info, staleTime: 60_000 })
  const view = useMemo(() => (query.data ? buildEvidenceView(query.data) : null), [query.data])
  // Only fetch Runtime-wide drop counters when this item has no per-item count but looks unresolved.
  const needsGlobalDrops = Boolean(
    view && !view.dropped && (view.pointWithoutSources || view.rootUnresolved || view.unresolvedSources.length)
  )
  const deltaReport = useQuery({
    queryKey: ['delta-report'],
    queryFn: () => api.deltaReport(20),
    enabled: needsGlobalDrops,
    staleTime: 60_000,
    retry: false
  })
  const globalDropped = needsGlobalDrops ? droppedFromDeltaReport(parseDeltaReport(deltaReport.data)) : null
  const commands = reproduceCommands({
    reference,
    asOf,
    root: info.data?.root,
    port: info.data?.port
  })

  return (
    <Dialog.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="drawer-backdrop" />
        <Dialog.Popup className="drawer" aria-label={tr('Evidence', '证据')}>
        <header className="drawer-head">
          <div>
            <div className="eyebrow">Evidence</div>
            <Dialog.Title className="drawer-title">{query.data?.label || tr('Evidence', '证据')}</Dialog.Title>
            <div className="drawer-meta">
              {query.data ? <span className="chip subtle">{query.data.kind}</span> : null}
              {query.data ? (
                <span className={`chip ${query.data.status === 'ok' ? 'ok' : 'warn'}`}>
                  {query.data.status}
                </span>
              ) : null}
              {query.data?.timestamp ? <span>{formatDateTime(query.data.timestamp)}</span> : null}
            </div>
            <AsOfBar asOf={asOf} onApply={setAsOf} response={query.data} />
          </div>
          <div className="drawer-head-actions">
            <button className="btn ghost small" onClick={() => setCorrectOpen(true)}>
              {tr('Correct', '纠正')}
            </button>
            <Dialog.Close className="icon-btn" aria-label={tr('Close', '关闭')}>
              ✕
            </Dialog.Close>
          </div>
        </header>

        <div className="drawer-body">
          {query.isLoading ? <p className="muted">{tr('Resolving evidence…', '正在解析证据…')}</p> : null}
          {query.isError ? <p className="bad">{errorMessage(query.error)}</p> : null}

          {query.data && view ? (
            <>
              {query.data.summary ? <p className="summary">{query.data.summary}</p> : null}
              {view.asOfStatus ? (
                <div className="banner compact" role="note" data-asof-status={view.asOfStatus.statusAt}>
                  {view.asOfStatus.text}
                </div>
              ) : null}
              {view.rootUnresolved ? (
                <div className="banner warn compact">
                  {view.rootUnresolved.marker}
                  {tr(': ', '：')}
                  {view.rootUnresolved.reasonText}
                </div>
              ) : null}

              <Section
                title={tr('Direct sources', '直接来源')}
                note={tr(
                  'Explicit sources stored by Runtime; they count as proof. Unresolved receipts are not here.',
                  'Runtime 存储的显式来源，可以作为证明。未解析的回执不在这里。'
                )}
                items={view.sources}
                onNavigate={onNavigate}
                unresolved={view.pointUnresolved}
                selfSource={view.selfSource}
              />
              <UnresolvedSection
                rootUnresolved={view.rootUnresolved}
                items={view.unresolvedSources}
                dropped={view.dropped ?? globalDropped}
                pointWithoutSources={view.pointWithoutSources}
                commands={commands}
              />
              <Section
                title={tr('Nearby context', '邻近上下文')}
                note={tr(
                  'Captures close in time; not direct evidence for this conclusion.',
                  '时间上相邻的采集，不是这条结论的直接证据。'
                )}
                items={view.context}
                onNavigate={onNavigate}
              />
              <Section
                title={tr('Version history', '版本历史')}
                note={tr("This Point's supersede chain.", '这条 Point 的 supersede 链。')}
                items={view.history}
                onNavigate={onNavigate}
              />
              <NodeSection rootId={query.data.id} />
            </>
          ) : null}
        </div>
        </Dialog.Popup>
      </Dialog.Portal>
      {correctOpen ? (
        <CorrectDialog label={query.data?.label ?? reference} onClose={() => setCorrectOpen(false)} />
      ) : null}
    </Dialog.Root>
  )
}
