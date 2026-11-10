import { useMemo, useState } from 'react'
import '../components/het/het.css'
import { HET_DEFINITION, type HetPanelState, type HetSummary } from '../../../main/het/api'
import { assessorBanner, assessorLabel, reasonRows, retryControl, scopeLabels, totalCard } from '../components/het/labels'
import { AssessorPanel } from '../components/het/AssessorPanel'
import { TaskTable } from '../components/het/TaskTable'
import { countFilterFromParams } from '../components/het/countFilter'
import { FilteredTaskList } from '../components/het/FilteredTaskList'
import { intlLocale, tr } from '../lib/i18n'
import { useNav } from '../lib/nav'
import {
  formatHet,
  rangeBounds,
  useExportWeekly,
  useHetPeriod,
  useHetStatus,
  useHetSummary,
  useHetAssessorInfo,
  useRetryFailed,
  type HetRange
} from '../components/het/useHet'
import { StatCard } from '../components/StatCard'

const RANGES: Array<{ id: HetRange; readonly label: string }> = [
  {
    id: 'today',
    get label() {
      return tr('Today', '今日')
    }
  },
  {
    id: 'week',
    get label() {
      return tr('This week', '本周')
    }
  },
  {
    id: 'month',
    get label() {
      return tr('This month', '本月')
    }
  }
]

function stateBanner(state: HetPanelState, s: HetSummary): { tone: 'ok' | 'warn' | 'bad' | 'subtle'; text: string } {
  switch (state) {
    case 'notStarted':
      return { tone: 'subtle', text: tr(
          'No AI work detected yet. Navalia only reads Claude Code / Codex session logs; detected work shows up here automatically.',
          '还没有检测到 AI 工作。Navalia 只读 Claude Code / Codex 会话记录，检测到后会自动出现在这里。'
        )
      }
    case 'calculating':
      return { tone: 'subtle', text: tr(`${s.unsettled} sessions still running; assessed 30 minutes after they end.`, `${s.unsettled} 个会话仍在进行，结束 30 分钟后进入评估。`) }
    case 'onePending':
    case 'manyPending':
      return { tone: 'warn', text: tr(`${s.pending} tasks (all time) await assessment and count as 0 minutes until assessed.`, `全部时间共 ${s.pending} 个任务等待评估，评估完成前计 0 分钟。`) }
    case 'oneFailed':
    case 'manyFailed':
      return { tone: 'bad', text: tr(`${s.failed} tasks (all time) failed assessment and are not counted in the total.`, `全部时间共 ${s.failed} 个任务评估失败，不计入总数。`) }
    case 'updateFailed':
      return {
        tone: 'bad',
        text: tr(
          `Last update failed (${s.update?.error ?? 'update_failed'}). Below is the data from the last successful update; the next scheduled scan retries automatically, with no estimation.`,
          `上次更新失败（${s.update?.error ?? 'update_failed'}），下面是上一次成功更新的数据；下次定时扫描会自动重试，不做估算。`
        )
      }
    default:
      return { tone: 'ok', text: tr('All finished tasks have been assessed.', '所有已结束的任务都已评估。') }
  }
}

export function Het() {
  const [range, setRange] = useState<HetRange>('week')
  const summary = useHetSummary()
  const status = useHetStatus()
  const period = useHetPeriod(range)
  const exporter = useExportWeekly()
  const assessorInfo = useHetAssessorInfo()
  const retry = useRetryFailed()
  const nav = useNav()
  const countFilter = countFilterFromParams(nav.params)

  const pages = period.data?.pages ?? []
  const tasks = useMemo(() => pages.flatMap((p) => p.tasks), [pages])
  const totalTenths = pages[0]?.total_minutes_tenths ?? 0
  const counts = pages[0]?.counts
  const labels = scopeLabels(range, counts)
  const reasons = reasonRows(counts, status.data?.transport)
  const assessor = assessorLabel(status.data?.transport)
  const gate = status.data?.assessor
  const gateBanner = assessorBanner(gate, counts ? counts.needs_assessment : null)
  // While gated, the generic "N waiting" banner would repeat the gate banner; show only the gate.
  const banner = summary.data && !(gateBanner && summary.data.state !== 'notStarted') ? stateBanner(summary.data.state, summary.data) : null
  const total = totalCard(gate, totalTenths, counts?.counted ?? 0, formatHet(totalTenths), assessorInfo.data?.anchor_version)
  const retryCtl = retryControl(summary.data, gate)

  return (
    <div className="page het-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">{tr('HET · Human equivalent time (unmeasured)', 'HET · 等效人工时间（未测量）')}</div>
          <h2 title={HET_DEFINITION}>Human Equivalent Time</h2>
          <p className="het-definition">{HET_DEFINITION}</p>
        </div>
        <div className="page-actions">
          <div className="segmented">
            {RANGES.map((r) => (
              <button key={r.id} className={`seg-btn ${range === r.id ? 'active' : ''}`} onClick={() => setRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          <button
            className="btn ghost het-export"
            disabled={exporter.isPending}
            onClick={() => exporter.mutate(rangeBounds('week').start)}
            title={tr("Export this week's Weekly Review (Markdown + HTML, saved locally, never sent)", '导出本周 Weekly Review（Markdown + HTML，本地保存，不发送）')}
          >
            {exporter.isPending ? tr('Exporting…', '导出中…') : tr("Export this week's review", '导出本周周报')}
          </button>
        </div>
      </header>

      {gateBanner ? (
        <div className={`banner compact het-gate ${gateBanner.tone}`} data-gate={gate?.state}>
          {gateBanner.text}
        </div>
      ) : null}
      {banner ? <div className={`banner compact het-state ${banner.tone}`} data-state={summary.data?.state}>{banner.text}</div> : null}
      {retryCtl.show ? (
        <div className="banner compact het-retry">
          <button className="btn ghost het-retry-btn" disabled={retry.isPending} onClick={() => retry.mutate()} title={retryCtl.hint}>
            {retry.isPending ? tr('Retrying…', '重试中…') : retryCtl.text}
          </button>
          <span className="muted tiny"> {retryCtl.hint}</span>
          {retry.data ? <span className="tiny">{tr(` Requeued ${retry.data.requeued} tasks.`, ` 已放回队列 ${retry.data.requeued} 个任务。`)}</span> : null}
          {retry.isError ? <span className="tiny het-toggle-note"> {String(retry.error)}</span> : null}
        </div>
      ) : null}
      {summary.isError ? <div className="banner bad compact">{String(summary.error)}</div> : null}
      {period.isError ? <div className="banner bad compact">{String(period.error)}</div> : null}
      {exporter.data ? (
        <div className="banner ok compact">
          {exporter.data.markdownPath
            ? tr(
                `Exported: ${exporter.data.markdownPath} and .html (total ${formatHet(exporter.data.total_minutes_tenths)}, ${exporter.data.rows} rows)`,
                `已导出：${exporter.data.markdownPath} 与 .html（总计 ${formatHet(exporter.data.total_minutes_tenths)}，${exporter.data.rows} 条）`
              )
            : tr('Export cancelled', '已取消导出')}
        </div>
      ) : null}
      {exporter.isError ? <div className="banner bad compact">{String(exporter.error)}</div> : null}

      {countFilter ? (
        <FilteredTaskList params={countFilter} transport={status.data?.transport} onClear={() => nav.go('het')} />
      ) : null}

      <div className="grid stats">
        <StatCard
          label={tr(`HET · ${RANGES.find((r) => r.id === range)!.label} · Estimate`, `HET · ${RANGES.find((r) => r.id === range)!.label} · 估计`)}
          value={<span title={HET_DEFINITION}>{total.value}</span>}
          detail={total.detail}
          tone={total.tone}
        />
        <StatCard
          label={labels.pendingCardLabel}
          value={labels.pendingCardValue ?? '—'}
          detail={labels.pendingCardDetail}
          tone={labels.pendingCardValue ? 'warn' : 'muted'}
        />
        <StatCard
          label={labels.failedCardLabel}
          value={counts?.failed ?? '—'}
          detail={tr('Not counted in the total', '不计入总数')}
          tone={counts?.failed ? 'bad' : 'muted'}
        />
        <StatCard
          label={tr('Assessor', '评估器')}
          value={assessor.value}
          detail={
            status.data?.lastTickAt
              ? tr(
                  `Last scan ${new Date(status.data.lastTickAt).toLocaleTimeString(intlLocale())}`,
                  `上次扫描 ${new Date(status.data.lastTickAt).toLocaleTimeString(intlLocale())}`
                )
              : tr('Not scanned yet', '尚未扫描')
          }
          tone={assessor.tone}
        />
      </div>

      <AssessorPanel gate={gate} />

      {reasons.length ? (
        <section className="card het-pending">
          <div className="section-head">
            <h3>{labels.queueTitle}</h3>
            <span className="muted tiny">
              {tr(
                'Counted over the whole period (not affected by paging); these tasks count as 0 minutes until assessed',
                '按整个时间段统计（不受分页影响）；这些任务计 0 分钟，直到评估完成'
              )}
            </span>
          </div>
          <ul className="het-pending-list">
            {reasons.map((r) => (
              <li key={r.key} data-reason={r.key}>
                <span className="chip warn">{r.n}</span> {r.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <div className="section-head">
          <h3>{tr('Tasks', '任务')}</h3>
          <span className="muted tiny">{tr('Click a row to expand evidence; corrections: accepted / rejected / not_agent', '点一行展开证据；修正动作：accepted / rejected / not_agent')}</span>
        </div>
        {period.isLoading ? <p className="muted">{tr('Loading…', '读取中…')}</p> : <TaskTable tasks={tasks} transport={status.data?.transport} />}
        {counts && tasks.length < counts.tasks ? (
          <p className="muted tiny">{tr(`Showing ${tasks.length} / ${counts.tasks}`, `已显示 ${tasks.length} / ${counts.tasks} 条`)}</p>
        ) : null}
        {period.hasNextPage ? (
          <button className="btn ghost" onClick={() => void period.fetchNextPage()} disabled={period.isFetchingNextPage}>
            {period.isFetchingNextPage ? tr('Loading…', '加载中…') : tr('Load more', '加载更多')}
          </button>
        ) : null}
      </section>
    </div>
  )
}
