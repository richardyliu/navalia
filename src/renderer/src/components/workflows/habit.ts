/**
 * S1-05 habit rule alignment (pure).
 *
 * S1 article: a habit is stable only with evidence on ≥3 distinct dates.
 * Runtime 0.3.2 (b7a28ff) admitted at ≥2 observations with no date rule. Runtime schema 2026-11-05.3
 * (HABIT-3-DATES, commit 8f52b34) gates Face promotion on ≥3 distinct `observation_dates` and returns
 * them from behavior_patterns. Lens applies the same rule to everything it labels: under 3 distinct
 * dates → "观察中", and "日期未知" when no dates can be derived (e.g. an older Runtime's Faces).
 */
import { tr } from '../../lib/i18n'

export const STABLE_HABIT_MIN_DATES = 3

export type HabitStatus = 'stable' | 'observing' | 'unknown'
export type HabitBasis = 'evidence_timestamps' | 'declared_text' | 'none'

export interface HabitAssessment {
  status: HabitStatus
  /** Distinct dates used for the decision, null when not derivable. */
  distinctDates: number | null
  /** Distinct YYYY-MM-DD dates from evidence timestamps (sorted). */
  dates: string[]
  /** Day count the Runtime text itself declares ("across 4 days"), if any. */
  declaredDays: number | null
  basis: HabitBasis
  /** True when the count is not backed by evidence timestamps (text claim or unknown). */
  partial: boolean
  label: string
  detail: string
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/

export function dateOf(ts: string | null | undefined): string | null {
  if (!ts) return null
  const m = DATE_RE.exec(ts.trim())
  return m ? m[1] : null
}

export function distinctDates(timestamps: Array<string | null | undefined>): string[] {
  return [...new Set(timestamps.map(dateOf).filter((d): d is string => d !== null))].sort()
}

/** "across 4 days", "4 distinct days", "(3 consecutive days)", "4 个不同日期", "3 天". Largest claim wins. */
export function declaredDays(text: string | null | undefined): number | null {
  if (!text) return null
  const patterns = [/(\d{1,4})\s+(?:distinct\s+|different\s+|separate\s+|consecutive\s+)?(?:calendar\s+)?days?\b/gi, /(\d{1,4})\s*个?\s*(?:不同的?)?\s*(?:日期|天)/g]
  let best: number | null = null
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n
    }
  }
  return best
}

export function assessHabit(input: { timestamps?: Array<string | null | undefined>; text?: string | null }): HabitAssessment {
  const dates = distinctDates(input.timestamps ?? [])
  const declared = declaredDays(input.text)
  const fromEvidence = dates.length
  let basis: HabitBasis = 'none'
  let count: number | null = null
  if (fromEvidence > 0 && (declared === null || fromEvidence >= declared)) {
    basis = 'evidence_timestamps'
    count = fromEvidence
  } else if (declared !== null) {
    basis = 'declared_text'
    count = declared
  }
  if (count === null) {
    return {
      status: 'unknown',
      distinctDates: null,
      dates,
      declaredDays: declared,
      basis,
      partial: true,
      label: tr('Dates unknown', '日期未知'),
      detail: tr('No usable observation dates in the data, so it cannot tell whether there are 3 distinct dates', '数据里没有可用的观察日期，无法判断是否满 3 个不同日期')
    }
  }
  const status: HabitStatus = count >= STABLE_HABIT_MIN_DATES ? 'stable' : 'observing'
  const how = basis === 'evidence_timestamps' ? tr('From evidence timestamps', '来自证据时间戳') : tr('Declared in Runtime text, not checked item by item', 'Runtime 文本声明，未逐条核对')
  const label =
    status === 'stable'
      ? tr(`Stable habit · ${count} distinct dates`, `稳定习惯 · ${count} 个不同日期`)
      : tr(`Observing (fewer than 3 distinct dates) · ${count} dates`, `观察中（未满 3 个不同日期）· ${count} 个日期`)
  return { status, distinctDates: count, dates, declaredDays: declared, basis, partial: basis !== 'evidence_timestamps', label, detail: how }
}
