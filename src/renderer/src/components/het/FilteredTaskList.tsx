// S1-R3-04 click-through target on the HET page: tasks behind one 「本周 AI 工作计数」 number.
import { useMemo } from 'react'
import { tr } from '../../lib/i18n'
import { COUNT_FILTER_TITLE, filteredHeading, type CountFilterParams } from './countFilter'
import { TaskTable } from './TaskTable'
import { useHetFilteredTasks } from './useHet'
import { aiCountsDisclaimer } from '../home/aiCountsView'

export function FilteredTaskList({ params, transport, onClear }: { params: CountFilterParams; transport?: string; onClear: () => void }) {
  const q = useHetFilteredTasks(params)
  const pages = q.data?.pages ?? []
  const tasks = useMemo(() => pages.flatMap((p) => p.tasks), [pages])
  const total = pages[0]?.total
  return (
    <section className="card het-filtered" data-filter={params.filter}>
      <div className="section-head">
        <h3 title={COUNT_FILTER_TITLE[params.filter]}>
          {filteredHeading(params.filter, params.week, total ?? null)}
        </h3>
        <button className="btn ghost small" onClick={onClear}>
          {tr('Clear filter', '清除筛选')}
        </button>
      </div>
      <p className="muted tiny">{COUNT_FILTER_TITLE[params.filter]} {aiCountsDisclaimer()}{tr('.', '。')}</p>
      {q.isError ? <div className="banner bad compact">{String(q.error)}</div> : null}
      {q.isLoading ? <p className="muted">{tr('Loading…', '读取中…')}</p> : <TaskTable tasks={tasks} transport={transport} />}
      {q.hasNextPage ? (
        <button className="btn ghost" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? tr('Loading…', '加载中…') : tr('Load more', '加载更多')}
        </button>
      ) : null}
    </section>
  )
}
