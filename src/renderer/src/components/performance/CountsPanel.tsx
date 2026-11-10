// S1-FULL C16 「表现」 B: owner-only counts per day / ISO week. Every number opens its exact rows.
import { useEffect, useState } from 'react'
import { countsDisclaimer, type CountKind, type PerformanceCounts, type PerformanceRows, type PeriodRange } from '../../../../main/performance/api'
import { tr } from '../../lib/i18n'
import { countCells, formatCount, performanceBridge, rangeLabel, rowFacts, sourceText, sourceTone } from '../../pages/performanceView'

export function CountsPanel() {
  const api = performanceBridge()
  const [range, setRange] = useState<PeriodRange>('week')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<PerformanceCounts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<{ kind: CountKind; day?: string } | null>(null)
  const [rows, setRows] = useState<PerformanceRows | null>(null)
  const [rowsError, setRowsError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    let live = true
    setLoading(true)
    setError(null)
    setOpen(null)
    void api.counts(range, offset).then((r) => {
      if (!live) return
      setLoading(false)
      if (r.ok) setData(r.data)
      else setError(r.error.message)
    })
    return () => {
      live = false
    }
  }, [api, range, offset])

  useEffect(() => {
    if (!api || !open) return
    let live = true
    setRows(null)
    setRowsError(null)
    void api.rows(range, offset, open.kind, open.day).then((r) => {
      if (!live) return
      if (r.ok) setRows(r.data)
      else setRowsError(r.error.message)
    })
    return () => {
      live = false
    }
  }, [api, range, offset, open])

  if (!api) return <div className="banner warn compact">{tr('Performance is not wired to the main process yet (not connected).', '「表现」还没有接入主进程（未接入）。')}</div>

  return (
    <section className="card perf-counts" data-testid="perf-counts">
      <div className="card-head">
        <h3>
          {tr(
            `Counts (${data ? rangeLabel(data.first, data.last) : 'loading…'})`,
            `计数（${data ? rangeLabel(data.first, data.last) : '读取中…'}）`
          )}
        </h3>
        <div className="perf-row">
          <div className="segmented">
            {(['day', 'week'] as const).map((r) => (
              <button key={r} className={`seg-btn ${range === r ? 'active' : ''}`} onClick={() => (setRange(r), setOffset(0))}>
                {r === 'day' ? tr('By day', '按天') : tr('By week', '按周')}
              </button>
            ))}
          </div>
          <button className="btn ghost small" onClick={() => setOffset(offset - 1)} disabled={loading}>
            {range === 'day' ? tr('← Previous day', '← 上一天') : tr('← Previous week', '← 上一周')}
          </button>
          <button className="btn ghost small" onClick={() => setOffset(Math.min(0, offset + 1))} disabled={loading || offset === 0}>
            {range === 'day' ? tr('Next day →', '下一天 →') : tr('Next week →', '下一周 →')}
          </button>
        </div>
      </div>
      <p className="muted small">
        {countsDisclaimer()} {tr('Click any number to see every row behind it.', '点任一数字查看它背后的每一行。')}
      </p>
      {error ? <div className="banner bad compact">{error}</div> : null}
      {data ? (
        <>
          <div className="perf-cells">
            {countCells(data.totals).map((c) => (
              <button
                key={c.kind}
                className={`perf-cell ${open?.kind === c.kind && !open.day ? 'active' : ''}`}
                data-kind={c.kind}
                disabled={!c.known}
                title={c.definition}
                onClick={() => setOpen({ kind: c.kind })}
              >
                <strong className={c.known ? '' : 'muted'}>{c.value}</strong>
                <span className="small">{c.label}</span>
              </button>
            ))}
          </div>
          {data.range === 'week' ? (
            <table className="perf-days small">
              <thead>
                <tr>
                  <th>{tr('Date', '日期')}</th>
                  {countCells(data.totals).map((c) => (
                    <th key={c.kind}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.day}>
                    <td className="mono">{d.day}</td>
                    {countCells(d.counts).map((c) => (
                      <td key={c.kind}>
                        {c.known ? (
                          <button className="link-btn mono" onClick={() => setOpen({ kind: c.kind, day: d.day })}>
                            {formatCount(d.counts[c.kind])}
                          </button>
                        ) : (
                          <span className="muted tiny">{c.value}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <ul className="perf-sources tiny">
            <li>
              <span className={`chip ${sourceTone(data.sources.het)}`}>{tr('HET marks / sessions', 'HET 标记 / 会话')}</span> {sourceText(data.sources.het)}
            </li>
            <li>
              <span className={`chip ${sourceTone(data.sources.git)}`}>{tr('Local repos', '本地仓库')}</span> {sourceText(data.sources.git)}
              {data.sources.repos
                .filter((r) => r.state.state !== 'ok')
                .map((r) => (
                  <div key={r.id} className="muted">
                    {r.path}
                    {tr(': ', '：')}
                    {sourceText(r.state)}
                  </div>
                ))}
            </li>
          </ul>
          {open ? (
            <div className="perf-rows" data-testid="perf-rows">
              <div className="card-head">
                <h3 className="small">
                  {tr('Details: ', '明细：')}
                  {countCells(data.totals).find((c) => c.kind === open.kind)?.label}
                  {open.day ? ` · ${open.day}` : ''}
                  {rows ? tr(` (${formatCount(rows.total)} rows)`, `（${formatCount(rows.total)} 行）`) : ''}
                </h3>
                <button className="btn ghost small" onClick={() => setOpen(null)}>
                  {tr('Collapse', '收起')}
                </button>
              </div>
              {rowsError ? <div className="banner bad compact">{rowsError}</div> : null}
              {!rows && !rowsError ? <p className="muted small">{tr('Loading…', '读取中…')}</p> : null}
              {rows && rows.total === null ? <p className="muted small">{sourceText(rows.source)}</p> : null}
              {rows && rows.total === 0 ? <p className="muted small">{tr('No records in this period.', '这个时间段没有记录。')}</p> : null}
              {rows && rows.rows.length > 0 ? (
                <ol className="perf-row-list">
                  {rows.rows.map((r) => (
                    <li key={r.id}>
                      <dl className="kv tiny">
                        {rowFacts(r).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd className="mono">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
