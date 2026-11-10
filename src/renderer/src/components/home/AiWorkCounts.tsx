// S1-R3-04 / S1-R4-04 「本周 AI 工作计数」 Home card body (X4 = B, owner-only). Reads het.db counts through the main HET service (IPC);
// no LLM, no network. Each number opens the HET page filtered to the tasks behind it.
import type { HetCountFilter, HetWeekCounts } from '../../../../main/het/api'
import { countNavParams } from '../het/countFilter'
import { useHetWeekCounts } from '../het/useHet'
import { useNav } from '../../lib/nav'
import { aiCountsDisclaimer, aiCountsView, type AiCountsView } from './aiCountsView'
import { tr } from '../../lib/i18n'

/** Presentational; intrinsic elements only (tests walk the tree and call onClick). */
export function AiWorkCountsBody({ view, onOpen }: { view: AiCountsView; onOpen: (filter: HetCountFilter) => void }) {
  if (view.kind === 'empty')
    return (
      <div className="ai-counts" data-state="empty">
        <p className="muted small">{view.text}</p>
        <p className="tiny muted">{view.weekLabel}</p>
        <p className="tiny ai-counts-disclaimer">{aiCountsDisclaimer()}</p>
      </div>
    )
  return (
    <div className="ai-counts" data-state="counts">
      <div className="ai-counts-grid">
        {view.items.map((i) => (
          <button
            key={i.filter}
            type="button"
            className="ai-count"
            data-filter={i.filter}
            title={i.title}
            onClick={() => onOpen(i.filter)}
          >
            <strong className="ai-count-n">{i.n}</strong>
            <span className="tiny">{i.label}</span>
          </button>
        ))}
      </div>
      <p className="tiny muted">
        {tr(
          `${view.tasks} tasks in the HET ledger this week · ${view.weekLabel}`,
          `本周 HET 账本共 ${view.tasks} 个任务 · ${view.weekLabel}`
        )}
      </p>
      <p className="tiny muted">{view.note}</p>
      <p className="tiny ai-counts-disclaimer">{aiCountsDisclaimer()}</p>
    </div>
  )
}

export type AiWorkCountsQueryState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string | null }
  | { kind: 'none' }
  | { kind: 'data'; data: HetWeekCounts }

/** Presentational for every query state (tested without React Query). An error never shows a number. */
export function AiWorkCountsStatus({ state, onOpen }: { state: AiWorkCountsQueryState; onOpen: (data: HetWeekCounts, filter: HetCountFilter) => void }) {
  if (state.kind === 'loading') return <p className="muted small">{tr('Loading…', '读取中…')}</p>
  if (state.kind === 'error')
    return (
      <div className="ai-counts" data-state="error">
        <div className="banner bad compact">
          {tr(
            `Failed to load: ${state.message ?? 'unknown error'} (counts not shown)`,
            `读取失败：${state.message ?? '未知错误'}（不显示计数）`
          )}
        </div>
        <p className="tiny ai-counts-disclaimer">{aiCountsDisclaimer()}</p>
      </div>
    )
  if (state.kind === 'none') return <p className="muted small">{tr('No data.', '没有数据。')}</p>
  const data = state.data
  return <AiWorkCountsBody view={aiCountsView(data)} onOpen={(f) => onOpen(data, f)} />
}

export function AiWorkCountsCard({ timezone }: { timezone?: string }) {
  const q = useHetWeekCounts(timezone)
  const { go } = useNav()
  const state: AiWorkCountsQueryState = q.isLoading
    ? { kind: 'loading' }
    : q.isError
      ? { kind: 'error', message: q.error?.message ?? null }
      : q.data
        ? { kind: 'data', data: q.data }
        : { kind: 'none' }
  return <AiWorkCountsStatus state={state} onOpen={(data, f) => go('het', countNavParams(data, f))} />
}
