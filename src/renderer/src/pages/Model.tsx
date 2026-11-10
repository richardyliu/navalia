import { useMemo, useState } from 'react'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { ModelIssues } from '../components/ModelIssues'
import { errorMessage } from '../lib/api'
import { confidence, formatDateTime, formatNumber, tagList, truncate } from '../lib/format'
import { modelIssuesView } from '../lib/modelIssues'
import { useGraph, useStatus } from '../lib/queries'
import { tr } from '../lib/i18n'

export function Model() {
  const status = useStatus()
  const graph = useGraph(status.isSuccess)
  const [text, setText] = useState('')
  const [latestOnly, setLatestOnly] = useState(true)
  const [conflictedOnly, setConflictedOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const model = graph.data?.model
  const points = model?.points ?? []
  const issues = modelIssuesView(graph.data)

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase()
    return points
      .filter((point) => (latestOnly ? point.is_latest : true))
      .filter((point) => (conflictedOnly ? point.conflicted : true))
      .filter((point) => {
        if (!needle) return true
        return (
          (point.content ?? '').toLowerCase().includes(needle) ||
          (point.file_name ?? '').toLowerCase().includes(needle) ||
          tagList(point.tags).some((tag) => tag.toLowerCase().includes(needle))
        )
      })
      .sort((a, b) => {
        const left = a.occurred_at ?? a.created_at ?? ''
        const right = b.occurred_at ?? b.created_at ?? ''
        return right.localeCompare(left)
      })
  }, [points, text, latestOnly, conflictedOnly])

  const shown = filtered.slice(0, 300)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Model</div>
          <h2>{tr('Personal model', '个人模型')}</h2>
          <p className="muted">
            {tr(
              'Point → Line → Face → Volume → Root. Every conclusion traces back to the original text and receipt.',
              'Point → Line → Face → Volume → Root。每条结论都能回到原文与回执。'
            )}
          </p>
        </div>
        <div className="page-actions">
          {model ? (
            <span className="chip subtle">
              {formatNumber(model.stats.points)} Points · {formatNumber(model.stats.faces)} Faces
            </span>
          ) : null}
        </div>
      </header>

      {graph.isError ? <div className="banner bad compact">{errorMessage(graph.error)}</div> : null}

      {!graph.isError && !graph.isLoading && model && model.stats.points === 0 ? (
        <div className="banner warn">
          <div>
            <strong>{tr('The model is still empty', '模型还是空的')}</strong>
            <p>
              {tr('Let it capture for a while, then run ', '先让它采集一段时间，再在终端运行 ')}
              <code>persome model build</code>
              {tr(
                ' in a terminal. Building needs a configured LLM; without a key, capture continues but no Face/Volume/Root forms.',
                '。构建需要已配置的 LLM；没有 key 时，采集仍会继续，但不会形成 Face/Volume/Root。'
              )}
            </p>
          </div>
        </div>
      ) : null}

      {!graph.isError && !graph.isLoading && model ? (
        issues.codes.length > 0 || issues.stages.length > 0 || issues.showCliOnlyNote ? (
          <section className="card" data-testid="model-degraded-reasons">
            <div className="card-head">
              <h3>{tr('Degraded reasons', '降级原因')}</h3>
              <span className="chip warn">{model.build?.status ?? '—'}</span>
            </div>
            <ModelIssues view={issues} />
          </section>
        ) : null
      ) : null}

      <section className="grid model-top">
        <div className="card root-card">
          <div className="card-head">
            <h3>Root</h3>
            {model?.root ? <span className="chip ok">active</span> : <span className="chip warn">forming</span>}
          </div>
          {graph.isLoading ? (
            <p className="muted">{tr('Loading…', '正在读取…')}</p>
          ) : model?.root ? (
            <>
              <p className="root-text">{model.root.signature}</p>
              <div className="root-meta">
                <span>{tr(`Confidence ${confidence(model.root.confidence)}`, `置信度 ${confidence(model.root.confidence)}`)}</span>
                <span>{tr(`Observations ${formatNumber(model.root.observations)}`, `观察 ${formatNumber(model.root.observations)}`)}</span>
                <span>
                  {tr(
                    `${formatNumber(model.root.source_receipts?.length)} receipts`,
                    `${formatNumber(model.root.source_receipts?.length)} 条回执`
                  )}
                </span>
              </div>
            </>
          ) : (
            <p className="muted">
              {tr(
                'No Root yet. Root needs stable evidence across domains; keep using it, or run a build in the terminal.',
                '还没有 Root。Root 需要跨领域的稳定证据；继续使用，或在终端跑一次 build。'
              )}
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Faces / Volumes</h3>
            <span className="muted small">
              {formatNumber(model?.faces.length)} / {formatNumber(model?.volumes.length)}
            </span>
          </div>
          <div className="schema-list">
            {(model?.faces ?? []).slice(0, 6).map((face, index) => (
              <div key={`face-${index}`} className="schema-item">
                <div className="schema-title">{truncate(face.signature, 110)}</div>
                <div className="schema-meta">
                  <span>confidence {confidence(face.confidence)}</span>
                  <span>observations {formatNumber(face.observations)}</span>
                  <span className="chip subtle">{face.provenance ?? '—'}</span>
                </div>
              </div>
            ))}
            {(model?.volumes ?? []).slice(0, 3).map((volume, index) => (
              <div key={`volume-${index}`} className="schema-item volume">
                <div className="schema-title">{truncate(volume.signature, 110)}</div>
                <div className="schema-meta">
                  <span>Volume</span>
                  <span>confidence {confidence(volume.confidence)}</span>
                </div>
              </div>
            ))}
            {model && model.faces.length === 0 && model.volumes.length === 0 ? (
              <p className="muted small">{tr('No Face/Volume formed yet.', '还没有形成 Face/Volume。')}</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Points</h3>
          <div className="filters">
            <input
              className="input"
              placeholder={tr('Search content / file / tag', '搜索内容 / 文件 / 标签')}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <label className="check">
              <input type="checkbox" checked={latestOnly} onChange={(event) => setLatestOnly(event.target.checked)} />
              {tr('Latest only', '只看最新')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={conflictedOnly}
                onChange={(event) => setConflictedOnly(event.target.checked)}
              />
              {tr('Conflicts only', '只看冲突')}
            </label>
          </div>
        </div>

        {graph.isLoading ? (
          <p className="muted">{tr('Loading model…', '正在读取模型…')}</p>
        ) : shown.length === 0 ? (
          <p className="muted">{tr('No matching Points.', '没有匹配的 Point。')}</p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 96 }}>{tr('Time', '时间')}</th>
                  <th style={{ width: 180 }}>{tr('File', '文件')}</th>
                  <th>{tr('Content', '内容')}</th>
                  <th style={{ width: 72 }}>{tr('Confidence', '置信度')}</th>
                  <th style={{ width: 120 }}>{tr('Tags', '标签')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((point) => (
                  <tr
                    key={point.id}
                    className={point.conflicted ? 'row-conflicted' : ''}
                    onClick={() => setSelected(point.receipt || point.id)}
                  >
                    <td className="mono small">{formatDateTime(point.occurred_at ?? point.created_at)}</td>
                    <td className="mono small ellipsis">{point.file_name}</td>
                    <td>{truncate(point.content, 160)}</td>
                    <td>{confidence(point.confidence)}</td>
                    <td>
                      {tagList(point.tags).slice(0, 2).map((tag) => (
                        <span key={tag} className="chip subtle">
                          {tag}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="table-foot muted small">
              {tr(
                `Showing ${formatNumber(shown.length)} / ${formatNumber(filtered.length)}`,
                `显示 ${formatNumber(shown.length)} / ${formatNumber(filtered.length)} 条`
              )}
              {filtered.length > shown.length ? tr(' (rendering the first 300)', '（先渲染前 300 条）') : ''}
            </div>
          </>
        )}
      </section>

      {selected ? (
        <EvidenceDrawer reference={selected} onClose={() => setSelected(null)} onNavigate={setSelected} />
      ) : null}
    </div>
  )
}
