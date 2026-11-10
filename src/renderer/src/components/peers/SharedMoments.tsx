// S1-R3-05 Peers detail: keyword overlap (demoted in S1-FULL C18: NOT 共同经历, never cited in
// letters; real shared experiences are the signed moments in components/moments). Presentational view (props only, statically renderable
// in tests) + a small container. Fetches on demand / manual refresh only, never on a timer.
import { useQuery } from '@tanstack/react-query'
import { MIN_SEARCH_SCORE, SHARED_KIND_LABEL, UNVERIFIED as UNVERIFIED_LABEL, type PeersApi, type SharedMomentEntry, type SharedMoments } from '../../../../main/peers/api'
import { formatLocal, TOPIC_SOURCE_LABEL } from './peersView'
import { tr } from '../../lib/i18n'
import { unwrap } from '../../lib/api'

const USER_SOURCE_LABEL: Record<SharedMomentEntry['userSource'], string> = {
  get root() {
    return tr('Your model · Summary', '你的模型 · 概述')
  },
  get volume() {
    return tr('Your model · Topic', '你的模型 · 主题')
  },
  get face() {
    return tr('Your model · Habit', '你的模型 · 习惯')
  },
  get point() {
    return tr('Your model · Memory point', '你的模型 · 记忆点')
  },
  get memory() {
    return tr('Your memory', '你的记忆')
  }
}

function matchText(e: SharedMomentEntry): string {
  const score = typeof e.score === 'number' ? tr(`, relevance ${e.score.toFixed(2)} ≥ ${MIN_SEARCH_SCORE}`, `，相关度 ${e.score.toFixed(2)} ≥ ${MIN_SEARCH_SCORE}`) : ''
  if (e.match === 'literal') return tr(`Literal overlap: ${e.shared.join(', ')}`, `字面重合：${e.shared.join('、')}`)
  if (e.match === 'both') return tr(`Local search #${e.rank ?? '?'}, plus literal overlap: ${e.shared.join(', ')}${score}`, `本地检索第 ${e.rank ?? '?'} 条，且字面重合：${e.shared.join('、')}${score}`)
  return tr(`Local search #${e.rank ?? '?'}${score} (Runtime search order, not checked by a person)`, `本地检索第 ${e.rank ?? '?'} 条${score}（Runtime search 的排序，未经人工核对）`)
}

/** S1-R4-09: the sort / criteria note shown above the list. */
export function momentsCriteria(): string {
  return tr(
    `Criteria: literal overlap + Runtime search + relevance threshold. A search result with a numeric relevance (score) must be ≥ ${MIN_SEARCH_SCORE}. ` +
      'The current Runtime search returns no relevance, so a search result must also literally overlap their topic (≥1 English word or ≥2 Chinese two-character words), or it is not shown. ' +
      'Order: grouped in the order of the topics on their card; within a group, topic overlaps first (most literal overlap first), then dated memory overlaps (in Runtime search order).',
    `条件：字面重合 + Runtime search + 相关度门槛。检索结果带数值相关度（score）时要 ≥ ${MIN_SEARCH_SCORE}；` +
      '当前 Runtime 的 search 不返回相关度，所以检索结果还必须和 TA 的话题有字面重合（≥1 个英文词或 ≥2 个中文双字词），否则不显示。' +
      '排序：按 TA 卡片话题的顺序分组；组内先共同话题（字面重合多的在前），后共同经历（按 Runtime 检索顺序）。'
  )
}

export interface SharedMomentsViewProps {
  data: SharedMoments | undefined
  loading: boolean
  error: string | null
  onEvidence(reference: string): void
  onRefresh(): void
}

export function SharedMomentsView(p: SharedMomentsViewProps) {
  const d = p.data
  return (
    <div className="peers-moments" data-testid="peers-moments">
      <div className="section-head">
        <h4>{tr('Keyword overlap (Unverified, not shared moments)', `关键词重合（${UNVERIFIED_LABEL}，不是共同经历）`)}</h4>
        <button className="btn ghost small" disabled={p.loading} onClick={p.onRefresh}>
          {p.loading ? tr('Matching…', '匹配中…') : tr('Match again', '重新匹配')}
        </button>
      </div>
      <p className="muted tiny">
        {tr(
          'Uses only the topics on their card, compared against your own model (literal overlap by a fixed rule) and your own memory (local Runtime search). No LLM, no network. Every entry is “Unverified”: it only says the two texts are related, not that you really did the same thing. Likely keys, emails, phone numbers and paths are hidden. These entries never go into weekly letters; a real shared moment must be proposed by you above and signed by them.',
          '只用 TA 卡片上的话题，对照你自己的模型（固定规则的字面重合）和你自己的记忆（本机 Runtime 的 search 检索），不调用 LLM、不联网。 每条都是「未核实」：只说明两边的文字相关，不代表你们真的做过同一件事。已隐藏疑似密钥、邮箱、电话和路径。 这些条目不会写进每周信；真正的共同经历要由你在上面发起、对方签名确认。'
        )}
      </p>
      <p className="muted tiny" data-testid="moments-criteria">
        {momentsCriteria()}
      </p>
      {p.error ? <div className="banner bad compact">{p.error}</div> : null}
      {d?.modelError ? <div className="banner warn compact">{tr('Could not read your model; literal overlap may be incomplete: ', '读取你的模型失败，字面重合可能不全：')}{d.modelError}</div> : null}
      {d?.searchError ? <div className="banner warn compact">{tr('Local search failed; dated memory overlaps may be incomplete: ', '本地检索失败，共同经历可能不全：')}{d.searchError}</div> : null}
      {d && d.groups.length === 0 ? (
        <div className="muted" data-testid="moments-empty">
          {tr(`No keyword overlap found (searched ${d.searchedTopics} topic(s) on their card).`, `没有找到关键词重合（已检索 TA 卡片上的 ${d.searchedTopics} 个话题）。`)}
        </div>
      ) : null}
      {d?.droppedBelowGate ? (
        <div className="muted tiny" data-testid="moments-dropped">
          {tr(`${d.droppedBelowGate} more search result(s) were below the relevance threshold and are hidden.`, `另有 ${d.droppedBelowGate} 条检索结果没达到相关度门槛，已隐藏。`)}
        </div>
      ) : null}
      {d?.groups.length ? (
        <div className="muted tiny">
          {tr(
            `${SHARED_KIND_LABEL.topic} ${d.counts.topics} · ${SHARED_KIND_LABEL.experience} ${d.counts.experiences}`,
            `${SHARED_KIND_LABEL.topic} ${d.counts.topics} 条 · ${SHARED_KIND_LABEL.experience} ${d.counts.experiences} 条`
          )}
        </div>
      ) : null}
      {d?.groups.map((g) => (
        <section key={`${g.topic.source}:${g.topic.text}`} className="peers-moment-group">
          <div className="peers-moment-topic">
            <span className="chip subtle">{tr('Their card', 'TA 的卡片')} · {TOPIC_SOURCE_LABEL[g.topic.source]}</span> “{g.topic.text}”
          </div>
          <ul className="peers-moment-list">
            {g.entries.map((e, i) => (
              <li key={`${e.kind}:${e.evidenceRef ?? e.userSnippet}:${i}`} data-testid="moment-entry">
                <div>
                  <span className={`chip ${e.kind === 'experience' ? 'ok' : 'subtle'}`}>{SHARED_KIND_LABEL[e.kind]}</span>{' '}
                  <span className="chip warn" data-testid="moment-unverified">
                    {tr('Unverified', e.label)}
                  </span>{' '}
                  <span className="muted tiny">{matchText(e)}</span>
                </div>
                <div className="tiny">
                  {USER_SOURCE_LABEL[e.userSource]}
                  {e.userDate ? ` · ${formatLocal(e.userDate)}` : ''}
                  {e.userPath ? <span className="mono muted"> {e.userPath}</span> : null}
                  {tr(': ', '：')}“{e.userSnippet}”
                </div>
                <div className="tiny">
                  {e.evidenceRef ? (
                    <button className="btn ghost small" data-ref={e.evidenceRef} onClick={() => p.onEvidence(e.evidenceRef!)}>
                      {tr('View evidence', '查看证据')} <span className="mono">{e.evidenceRef}</span>
                    </button>
                  ) : (
                    <span className="muted">{tr('No receipt (model summary line, no separate evidence reference)', '无回执（模型摘要行，没有单独的证据引用）')}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

const peers = (): PeersApi['peers'] => (window.lens as unknown as PeersApi).peers

export function SharedMomentsSection({
  fingerprint,
  timezone,
  onEvidence
}: {
  fingerprint: string
  timezone: string
  onEvidence(reference: string): void
}) {
  const q = useQuery<SharedMoments>({
    queryKey: ['peers', 'moments', fingerprint, timezone],
    queryFn: () => unwrap(peers().sharedMoments(fingerprint, timezone)),
    staleTime: 60_000,
    retry: false
  })
  return (
    <SharedMomentsView
      data={q.data}
      loading={q.isFetching}
      error={q.isError ? (q.error instanceof Error ? q.error.message : String(q.error)) : null}
      onEvidence={onEvidence}
      onRefresh={() => void q.refetch()}
    />
  )
}
