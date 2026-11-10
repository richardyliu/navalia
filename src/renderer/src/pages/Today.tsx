import { useMemo, useState } from 'react'
import '../components/library/library.css'
import { buildBrief, UNVERIFIED } from '../../../main/library/brief'
import { Skeleton } from '../components/Skeleton'
import { systemTimeZone, useBriefSources, useCopy, useExportBrief } from '../components/library/useLibrary'
import { tr } from '../lib/i18n'

export function Today() {
  const [timezone] = useState(systemTimeZone)
  const { recent, patterns, het } = useBriefSources(timezone)
  const copy = useCopy()
  const exporter = useExportBrief()
  const [notice, setNotice] = useState<string | null>(null)

  const loading = recent.isLoading || patterns.isLoading || het.isLoading
  // `now` = when the newest source was fetched, so the brief is stable between renders.
  const now = Math.max(recent.dataUpdatedAt, recent.errorUpdatedAt, patterns.dataUpdatedAt, het.dataUpdatedAt, 0) || Date.now()
  const brief = useMemo(
    () =>
      loading
        ? null
        : buildBrief({
            now,
            timezone,
            recent: recent.data ?? null,
            recentError: recent.isError ? recent.error.message : null,
            patterns: patterns.data ?? null,
            patternsError: patterns.isError ? patterns.error.message : null,
            het: het.data ?? null,
            hetError: het.isError ? het.error.message : null
          }),
    [loading, now, timezone, recent.data, recent.error, recent.isError, patterns.data, patterns.error, patterns.isError, het.data, het.error, het.isError]
  )

  function refresh(): void {
    setNotice(null)
    void recent.refetch()
    void patterns.refetch()
    void het.refetch()
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Today</div>
          <h2>
            {tr("Today's brief", '今日 brief')}
            {brief ? ` · ${brief.date}` : ''}
          </h2>
          <p className="muted">
            {tr(
              `Built from a fixed template over recent activity, behavior patterns and the HET summary, with no LLM. Lines marked "Unverified" were organized by Runtime or inferred by the template; check them yourself. Time zone ${timezone}.`,
              `按固定模板从最近活动、行为模式和 HET 汇总生成，不调用 LLM。标「${UNVERIFIED}」的行是 Runtime 整理或模板推断的，请自行核对。时区 ${timezone}。`
            )}
          </p>
        </div>
        <div className="page-actions brief-actions">
          <button className="btn small" disabled={loading} onClick={refresh}>
            {tr('Refresh', '刷新')}
          </button>
          <button
            className="btn small"
            disabled={!brief || copy.isPending}
            onClick={() =>
              brief &&
              copy.mutate(brief.markdown, { onSuccess: () => setNotice(tr('Copied to clipboard.', '已复制到剪贴板。')) })
            }
          >
            {tr('Copy', '复制')}
          </button>
          <button
            className="btn primary small"
            disabled={!brief || exporter.isPending}
            onClick={() =>
              brief &&
              exporter.mutate(
                { markdown: brief.markdown, date: brief.date },
                { onSuccess: (r) => setNotice(r.path ? tr(`Exported: ${r.path}`, `已导出：${r.path}`) : tr('Export cancelled.', '已取消导出。')) }
              )
            }
          >
            {tr('Export .md', '导出 .md')}
          </button>
        </div>
      </header>

      {copy.isError ? <div className="banner bad compact">{tr(`Copy failed: ${copy.error.message}`, `复制失败：${copy.error.message}`)}</div> : null}
      {exporter.isError ? <div className="banner bad compact">{tr(`Export failed: ${exporter.error.message}`, `导出失败：${exporter.error.message}`)}</div> : null}
      {notice ? <div className="banner ok compact">{notice}</div> : null}

      {loading ? (
        <section className="card">
          <Skeleton rows={4} />
        </section>
      ) : null}
      {brief ? (
        <section className="card">
          <div className="card-head">
            <h3>{tr('Next steps', '下一步')}</h3>
            <span className="tiny muted">
              {tr(
                'Only from items explicitly not done in the records (- [ ] / TODO: / 待办：) and learned habits; quoted as is, not scored',
                '只来自记录里明确未完成的事（- [ ] / TODO: / 待办：）和已学到的习惯；只列原文，不打分'
              )}
            </span>
          </div>
          {brief.nextSteps.length === 0 ? (
            <p className="muted small">
              {tr(
                "Today's and yesterday's records have no items marked not done and there are no learned habits, so this is empty.",
                '今天和昨天的记录里没有标为未完成的事项，也没有已学到的习惯，所以这里是空的。'
              )}
            </p>
          ) : (
            <ul className="lib-next">
              {brief.nextSteps.map((n) => (
                <li key={n.key}>
                  <span className="chip warn">{tr('Unverified', n.label)}</span> <span>“{n.text}”</span>
                  <div className="tiny muted">
                    {n.source.kind === 'record' ? (
                      <>
                        {tr('Source: ', '来源：')}
                        {n.day === 'today' ? tr('Today', '今天') : tr('Yesterday', '昨天')} {n.source.time ?? '--:--'} ·{' '}
                        <span className="mono">{n.source.path}</span> · <span className="mono">⟨{n.source.ref}⟩</span> ·{' '}
                        {tr('Original: ', '原文：')}
                        {n.source.line}
                      </>
                    ) : (
                      <>
                        {tr('Source: habit learned by behavior_patterns', '来源：behavior_patterns 已学到的习惯')}
                        {n.source.observations !== null
                          ? tr(` · observed ${n.source.observations} times`, ` · 观察 ${n.source.observations} 次`)
                          : ''}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {brief ? (
        <section className="card">
          <div className="card-head">
            <h3>Markdown</h3>
            <span className="tiny muted">
              {tr(
                `${brief.counts.recentToday} activities today · ${brief.counts.todo} not done · ${brief.counts.review} to review`,
                `今天 ${brief.counts.recentToday} 条活动 · ${brief.counts.todo} 条未完成 · ${brief.counts.review} 条待核对`
              )}
            </span>
          </div>
          <pre className="brief-md">{brief.markdown}</pre>
        </section>
      ) : null}
    </div>
  )
}
