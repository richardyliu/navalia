// S1-FULL C16 「表现」 view helpers (pure, tested in tests/performance/view.test.ts).
// Copy rules: counts only; unknown is 「未知 / 未接入」 and never 0; no rate, no grade, no ranking,
// no time estimate; projects show activity, never how far along they are.
import {
  ACTIVITY_LABEL,
  COUNT_DEFINITION,
  COUNT_KINDS,
  COUNT_LABEL,
  unknownLabel,
  type ActivityItem,
  type CountKind,
  type CountMap,
  type EvidenceRef,
  type PerformanceApi,
  type PerformanceRow,
  type Project,
  type ProjectInput,
  type SourceState
} from '../../../main/performance/api'
import { tr } from '../lib/i18n'

/** The bridge, or null before the preload wiring lands (the page then says 未接入). */
export function performanceBridge(): PerformanceApi['performance'] | null {
  const lens = (globalThis as unknown as { lens?: Partial<PerformanceApi> }).lens
  return lens?.performance ?? null
}

export function formatCount(n: number | null): string {
  return n === null ? unknownLabel() : String(n)
}

export interface CountCell {
  kind: CountKind
  label: string
  value: string
  known: boolean
  definition: string
}

export function countCells(totals: CountMap): CountCell[] {
  return COUNT_KINDS.map((kind) => ({
    kind,
    label: COUNT_LABEL[kind],
    value: formatCount(totals[kind]),
    known: totals[kind] !== null,
    definition: COUNT_DEFINITION[kind]
  }))
}

export function sourceText(s: SourceState): string {
  return s.state === 'ok' ? (s.detail ?? tr('Connected', '已接入')) : s.reason
}

export function sourceTone(s: SourceState): 'ok' | 'warn' {
  return s.state === 'ok' ? 'ok' : 'warn'
}

export function evidenceText(e: EvidenceRef | null): string {
  return e ? `${e.file}:${e.line}` : '—'
}

const AT_SOURCE: Record<PerformanceRow['atSource'], string> = {
  get corrected_at() {
    return tr('Marked at', '标记时间')
  },
  get task_end() {
    return tr('Task end time (no mark recorded)', '任务结束时间（没有标记记录）')
  },
  get event_time() {
    return tr('Event time', '事件时间')
  },
  get author_date() {
    return tr('Author date', '作者时间')
  }
}

/** One line per fact of a row, in a fixed order. */
export function rowFacts(r: PerformanceRow): Array<[string, string]> {
  const facts: Array<[string, string]> = [[AT_SOURCE[r.atSource], r.at]]
  if (r.agent) facts.push(['Agent', r.agent])
  if (r.taskId) facts.push([tr('HET task', 'HET 任务'), r.taskId])
  if (r.sessionIds.length) facts.push([tr('Sessions', '会话'), r.sessionIds.join(', ')])
  if (r.project) facts.push([tr('Working directory', '工作目录'), r.project])
  if (r.evidence) facts.push([tr('Session log', '会话记录'), evidenceText(r.evidence)])
  if (r.commit) {
    facts.push([
      tr('Commit hash', '提交哈希'),
      r.commit.hash
        ? tr(
            `${r.commit.hash} (from ${r.commit.hashSource === 'git' ? 'git log' : 'session output'})`,
            `${r.commit.hash}（来自${r.commit.hashSource === 'git' ? ' git log' : '会话输出'}）`
          )
        : tr('No hash shown in the session', '会话里没有显示哈希')
    ])
    if (r.commit.repo) facts.push([tr('Repo', '仓库'), r.commit.repo])
    if (r.commit.subject) facts.push([tr('Message', '说明'), r.commit.subject])
  }
  return facts
}

export function rangeLabel(first: string, last: string): string {
  return first === last ? first : `${first} – ${last}`
}

/** Split a textarea into a trimmed, de-duplicated list (one per line or comma-separated). */
export function parseList(text: string, max = 10): string[] {
  return [...new Set(text.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean))].slice(0, max)
}

export function emptyProjectInput(): ProjectInput {
  return { title: '', goal: '', milestones: [], match: { keywords: [], paths: [], repoIds: [] } }
}

/** Editable copy of a stored project. Milestone `done` is deliberately not part of the input. */
export function toInput(p: Project): ProjectInput {
  return {
    id: p.id,
    title: p.title,
    goal: p.goal,
    milestones: p.milestones.map((m) => ({ id: m.id, title: m.title, targetDate: m.targetDate, note: m.note })),
    match: { keywords: [...p.match.keywords], paths: [...p.match.paths], repoIds: [...p.match.repoIds] }
  }
}

export function groupByDay(items: ActivityItem[]): Array<{ day: string; items: ActivityItem[] }> {
  const map = new Map<string, ActivityItem[]>()
  for (const it of items) map.set(it.day, [...(map.get(it.day) ?? []), it])
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, list]) => ({ day, items: list }))
}

export function matchedByText(m: string): string {
  const i = m.indexOf(':')
  const kind = i < 0 ? m : m.slice(0, i)
  const value = i < 0 ? '' : m.slice(i + 1)
  if (kind === 'keyword') return tr(`Keyword "${value}"`, `关键词「${value}」`)
  if (kind === 'path') return tr(`Path ${value}`, `路径 ${value}`)
  if (kind === 'repo') return tr('Selected repos', '所选仓库')
  return m
}

export function activityKindLabel(k: ActivityItem['kind']): string {
  return ACTIVITY_LABEL[k]
}

/** Milestone target text: the user's own date, or nothing. Lens never derives one. */
export function targetText(targetDate: string | null): string {
  return targetDate ? tr(`Target date ${targetDate} (set by you)`, `目标日期 ${targetDate}（你填写的）`) : tr('No target date', '没有目标日期')
}
