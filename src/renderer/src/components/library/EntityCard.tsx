import type { LibraryEntity } from '../../../../main/library/api'
import { formatDateTime, truncate } from '../../lib/format'
import { useEntityGraph } from './useLibrary'
import { tr } from '../../lib/i18n'

const KIND_LABEL: Record<string, [string, string]> = {
  person: ['Person', '人'],
  project: ['Project', '项目'],
  org: ['Organization', '组织'],
  event: ['Event', '事件'],
  artifact: ['Artifact', '产物']
}

export function kindLabel(kind: string | null): string {
  if (!kind) return tr('No type from Runtime', 'Runtime 未给类型')
  const l = KIND_LABEL[kind]
  return l ? tr(l[0], l[1]) : kind
}

export function EntityCard({
  entity,
  expanded,
  onToggle,
  onEvidence
}: {
  entity: LibraryEntity
  expanded: boolean
  onToggle: () => void
  onEvidence: (reference: string) => void
}) {
  const graph = useEntityGraph(expanded ? entity.name : null)
  const first = entity.points[0]
  const quote = entity.relations.find((r) => r.quote)?.quote
  return (
    <article className="lib-item">
      <header className="lib-item-head">
        <strong className="lib-item-name">{entity.name}</strong>
        {entity.column === 'unclassified' ? <span className="chip subtle">{kindLabel(entity.rawKind)}</span> : null}
        <span className="tiny muted">{entity.lastSeen ? formatDateTime(entity.lastSeen) : tr('Time unknown', '时间未知')}</span>
      </header>
      {first ? <p className="lib-item-body small">{truncate(first.content, 140)}</p> : null}
      {quote ? <p className="lib-item-quote small">{truncate(quote, 140)}</p> : null}
      <div className="lib-item-meta tiny muted">
        {tr(`${entity.points.length} Points · ${entity.relations.length} relations`, `${entity.points.length} 个 Point · ${entity.relations.length} 条关系`)}
      </div>
      <div className="lib-item-actions">
        <button
          className="btn small"
          disabled={!entity.evidenceRef}
          title={entity.evidenceRef ? entity.evidenceRef : tr('Runtime gave no evidence reference', 'Runtime 没有给出证据引用')}
          onClick={() => entity.evidenceRef && onEvidence(entity.evidenceRef)}
        >
          {tr('Evidence', '证据')}
        </button>
        <button className="btn small ghost" onClick={onToggle}>
          {expanded ? tr('Hide relations', '收起关系') : tr('Relations (entity_graph)', '关系（entity_graph）')}
        </button>
      </div>
      {expanded ? (
        <div className="lib-graph small">
          {graph.isLoading ? <p className="muted">{tr('Reading entity_graph…', '正在读取 entity_graph…')}</p> : null}
          {graph.isError ? <div className="banner bad compact">{graph.error.message}</div> : null}
          {graph.data && graph.data.resolved === null ? <p className="muted">{graph.data.note}</p> : null}
          {graph.data && graph.data.resolved !== null ? (
            <>
              {graph.data.chainToUser ? <p className="mono tiny">{graph.data.chainToUser}</p> : null}
              {graph.data.edges.length === 0 ? <p className="muted">{tr('No active relation edges.', '没有生效中的关系边。')}</p> : null}
              <ul className="lib-edges">
                {graph.data.edges.map((e, i) => (
                  <li key={`${e.src}-${e.predicate}-${e.dst}-${i}`}>
                    <span className="mono">{e.src}</span> →{e.predicate}{e.label ? `（${e.label}）` : ''}→ <span className="mono">{e.dst}</span>
                    {e.observations != null ? <span className="tiny muted"> {tr(`· observed ${e.observations} times`, `· 观察 ${e.observations} 次`)}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {entity.relations.length > 0 ? (
            <>
              <div className="tiny muted">{tr('Relations in the model snapshot', '模型快照里的关系')}</div>
              <ul className="lib-edges">
                {entity.relations.map((r, i) => (
                  <li key={`${r.id ?? i}-${r.direction}`}>
                    {r.direction === 'out' ? '→' : '←'} {r.predicate}
                    {r.label ? `（${r.label}）` : ''} <span className="mono">{r.other}</span>
                    {r.receipt ? (
                      <button className="btn small ghost" onClick={() => onEvidence(r.receipt as string)}>
                        {tr('Evidence', '证据')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
