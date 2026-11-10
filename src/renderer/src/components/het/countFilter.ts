// S1-R3-04 click-through: Home 「本周 AI 工作计数」 → HET page filtered task list. Pure helpers; the
// filter travels as nav params (App has no router). Counts only: never minutes, rates or a score.
import { commitSignalDefinition, HET_COUNT_FILTERS, type HetCountFilter, type HetWeekCounts } from '../../../../main/het/api'
import { tr } from '../../lib/i18n'
import type { NavParams } from '../../lib/nav'

export const COUNT_FILTER_LABEL: Record<HetCountFilter, string> = {
  get accepted() {
    return tr('Marked accepted', '标为 accepted（接受）')
  },
  get rejected() {
    return tr('Marked rejected', '标为 rejected（拒绝）')
  },
  get not_agent() {
    return tr('Marked not_agent (not an agent)', '标为 not_agent（不是 agent）')
  },
  get commit_signal() {
    return tr('With a commit signal', '有提交信号')
  }
}

const CORRECTION_TITLE = (a: string): string =>
  tr(
    `Tasks ending this week that you manually marked ${a} on the HET page (any assessment status). Only your corrections count; uncorrected tasks are not included.`,
    `本周结束的任务里，你在 HET 页手动标为 ${a} 的个数（不论评估状态）。只来自你的修正；没修正过的任务不计入。`
  )

/** Tooltip per count; the commit-signal one is the exact definition. */
export const COUNT_FILTER_TITLE: Record<HetCountFilter, string> = {
  get accepted() {
    return CORRECTION_TITLE('accepted')
  },
  get rejected() {
    return CORRECTION_TITLE('rejected')
  },
  get not_agent() {
    return CORRECTION_TITLE('not_agent')
  },
  get commit_signal() {
    return commitSignalDefinition()
  }
}

export interface CountFilterParams {
  filter: HetCountFilter
  /** ISO instants [start, end) exactly as returned by weekCounts. */
  start: string
  end: string
  week: string
  timezone?: string
}

export function countNavParams(c: HetWeekCounts, filter: HetCountFilter): NavParams {
  return { filter, start: c.start, end: c.end, week: c.iso_week, timezone: c.timezone }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

/** Valid count-filter params, or null (the HET page then shows its normal view). */
export function countFilterFromParams(p: NavParams): CountFilterParams | null {
  const filter = p.filter as HetCountFilter
  if (!HET_COUNT_FILTERS.includes(filter)) return null
  const { start, end } = p
  if (!start || !end || !ISO.test(start) || !ISO.test(end)) return null
  if (!(Date.parse(end) > Date.parse(start))) return null
  return { filter, start, end, week: p.week || tr(`From ${start.slice(0, 10)}`, `${start.slice(0, 10)} 起`), timezone: p.timezone || undefined }
}

/** `total` null while loading (no number is shown rather than a placeholder 0). */
export function filteredHeading(filter: HetCountFilter, week: string, total: number | null): string {
  const head = tr(`${week} · Tasks ${COUNT_FILTER_LABEL[filter].toLowerCase()}`, `${week} · ${COUNT_FILTER_LABEL[filter]}的任务`)
  return total === null ? head : tr(`${head}: ${total}`, `${head}：${total} 个`)
}
