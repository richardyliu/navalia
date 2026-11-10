// S1-R3-04 / S1-R4-04 「本周 AI 工作计数」 (X4 = option B, approved 2026-11-05, owner-only:
// never exposed through the Broker, the Card or the weekly letter). Pure view-model over
// HetWeekCounts from main (het.db via IPC). Counts only: no minutes, no percentages, no score.
import { HET_COUNT_FILTERS, type HetCountFilter, type HetWeekCounts } from '../../../../main/het/api'
import { COUNT_FILTER_LABEL, COUNT_FILTER_TITLE } from '../het/countFilter'
import { tr } from '../../lib/i18n'

export function aiCountsTitle(): string {
  return tr('AI work counts this week', '本周 AI 工作计数')
}

/** Shown literally, in every state. */
export function aiCountsDisclaimer(): string {
  return tr('These are counts, not a rating of your work, and do not represent time saved', '这是计数，不是绩效分，不代表节省时间')
}

export interface AiCountItem {
  filter: HetCountFilter
  label: string
  n: number
  title: string
}

export type AiCountsView =
  | { kind: 'empty'; weekLabel: string; text: string }
  | { kind: 'counts'; weekLabel: string; tasks: number; items: AiCountItem[]; note: string }

export function aiCountsView(c: HetWeekCounts): AiCountsView {
  const weekLabel = tr(
    `${c.iso_week} · ${c.week_start} – ${c.week_end} (${c.timezone}, by task end time)`,
    `${c.iso_week} · ${c.week_start} – ${c.week_end}（${c.timezone}，按任务结束时间）`
  )
  // No task ended this week ⇒ nothing was counted. Showing four zeros would read as a measurement.
  if (c.tasks === 0)
    return {
      kind: 'empty',
      weekLabel,
      text: tr(
        `The HET ledger has no tasks this week (${c.iso_week}), so there are no counts. Navalia only reads Claude Code / Codex session logs; numbers appear here once tasks are detected.`,
        `本周（${c.iso_week}）HET 账本里没有任务，所以没有计数。Navalia 只读 Claude Code / Codex 会话记录，检测到任务后这里才会有数。`
      )
    }
  return {
    kind: 'counts',
    weekLabel,
    tasks: c.tasks,
    items: HET_COUNT_FILTERS.map((f) => ({ filter: f, label: COUNT_FILTER_LABEL[f], n: c.counts[f], title: COUNT_FILTER_TITLE[f] })),
    note: tr(
      'accepted / rejected / not_agent come only from your manual corrections on the HET page; the commit signal only looks at git commit commands the Agent ran. Click a number to see its tasks.',
      'accepted / rejected / not_agent 只来自你在 HET 页的手动修正；提交信号只看 Agent 发出的 git commit 命令。点数字看对应任务。'
    )
  }
}
