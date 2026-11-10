/**
 * S1 skills headline: "N skill files. M weeks of judgment." (pure, unit-tested).
 *
 * N = number of Workflows. M = number of distinct ISO weeks that contain at least one evidence
 * date. Only real dates count: an evidence ref without a parseable `YYYY-MM-DD` timestamp is
 * skipped, never guessed. When no evidence has a date, M is null and renders as "—".
 */
import type { Workflow } from '../../../../main/workflows/schema'
import { tr } from '../../lib/i18n'

export interface SkillsHeadline {
  n: number
  m: number | null
  text: string
}

/** ISO-8601 week key `YYYY-Www` for a calendar date, or null if the date is not real. */
export function isoWeekKey(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(timestamp.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  // Thursday of this week decides the ISO year.
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const isoYear = date.getUTCFullYear()
  const week = Math.ceil(((date.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

export function skillsHeadline(workflows: ReadonlyArray<Pick<Workflow, 'evidence'>>): SkillsHeadline {
  const weeks = new Set<string>()
  for (const w of workflows) {
    for (const e of w.evidence) {
      const k = isoWeekKey(e.timestamp)
      if (k) weeks.add(k)
    }
  }
  const n = workflows.length
  const m = weeks.size ? weeks.size : null
  return { n, m, text: tr(`${n} skill files. ${m ?? '—'} weeks of judgment.`, `${n} 个技能文件，${m ?? '—'} 周的判断。`) }
}
