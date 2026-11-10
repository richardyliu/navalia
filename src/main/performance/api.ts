// S1-FULL C16 「表现」 (owner-only). Types + constants only: no node / electron imports, so the renderer
// typecheck can include it.
//
// What this is (brief "先做 B … 再做 C … 不做 A"):
// - B: per-day / per-week COUNTS of what Lens can actually see, each traceable to its rows:
//     accepted / rejected / not_agent  — the user's HET corrections (het.db, read-only),
//     transcript_commit                — `git commit` tool calls in Claude Code / Codex transcripts
//                                        that the HET adapters recorded (het_evidence rows),
//     git_commit                       — commits in repos the user explicitly added, authored by the
//                                        user's configured git email (read-only `git log`).
//   A source that is not available is `null` ("未知 / 未接入"), never 0. No rates, no grade, no
//   comparison with anyone, no time estimate (option A is not done).
// - C: projects the user writes (goal + milestones). Lens lists dated ACTIVITY matched by the
//   user's own keywords / paths / repos. It never computes how far a project is, never guesses an
//   end date, and only the user can tick a milestone.
// Owner-only: nothing here is served by the Broker, put in the Card, a letter, a .navaliaskill or the
// cloud (tests/performance/owner-only.test.ts).
import { tr } from '../../shared/i18n'
import type { LensResult } from '../../shared/types'

export const COUNT_KINDS = ['accepted', 'rejected', 'not_agent', 'transcript_commit', 'git_commit'] as const
export type CountKind = (typeof COUNT_KINDS)[number]

export const COUNT_LABEL: Record<CountKind, string> = {
  get accepted() {
    return tr('Accepted', '采纳')
  },
  get rejected() {
    return tr('Rejected', '不采纳')
  },
  get not_agent() {
    return tr('Not done by an Agent', '不是 Agent 做的')
  },
  get transcript_commit() {
    return tr('git commit in sessions', '会话里的 git commit')
  },
  get git_commit() {
    return tr('Repo commits', '仓库提交')
  }
}

/** Exact definition of each number, shown next to it. */
export const COUNT_DEFINITION: Record<CountKind, string> = {
  get accepted() {
    return tr(
      'HET tasks you manually marked "Accepted", attributed to the day of your latest mark.',
      'HET 任务中你手动标记为「采纳」的条数，按你最后一次标记的时间归到那一天。'
    )
  },
  get rejected() {
    return tr(
      'HET tasks you manually marked "Rejected", attributed to the day of your latest mark.',
      'HET 任务中你手动标记为「不采纳」的条数，按你最后一次标记的时间归到那一天。'
    )
  },
  get not_agent() {
    return tr(
      'HET tasks you marked "Not done by an Agent" (listed separately, not merged with accepted / rejected).',
      'HET 任务中你标记为「不是 Agent 做的」的条数（单独列出，不和采纳 / 不采纳合并）。'
    )
  },
  get transcript_commit() {
    return tr(
      'Events where a `git commit` command was called in Claude Code / Codex sessions (HET evidence rows). This means "was called", not that the commit succeeded; each task keeps a limited number of evidence rows, so this can be lower than the real count. Commit hashes are listed when the session showed them.',
      'Claude Code / Codex 会话里出现 `git commit` 命令调用的事件数（HET 证据行）。这是「调用过」，不保证提交成功；每个任务最多保留有限条证据，所以可能少于实际次数。会话里显示了提交哈希时一并列出。'
    )
  },
  get git_commit() {
    return tr(
      'Commits in the local repos you added on this page whose author email equals your git user.email (git log, read-only, offline, merge commits excluded).',
      '你在本页添加的本地仓库里，作者邮箱等于你的 git user.email 的提交数（git log，只读，不联网，不含合并提交）。'
    )
  }
}

export const ownerOnlyNote = (): string =>
  tr(
    'Shown only in your own Navalia. Never goes into your Personal Card, the Broker, weekly letters or the cloud.',
    '只在你自己的 Navalia 里显示。不进入个人卡片、Broker、周信或云端。'
  )
export const countsDisclaimer = (): string =>
  tr(
    'These are counts, not a performance grade: no rates, no rankings, and no estimate of time saved.',
    '这些是计数，不是绩效分；没有比率、排名，也不估算节省的时间。'
  )
export const activityOnlyNote = (): string =>
  tr(
    'Navalia only lists activity related to the project. It does not calculate how much is done or guess a finish date. Only you can tick off milestones.',
    'Navalia 只列出与项目相关的活动，不计算完成比例，也不预测完成日期。里程碑只能由你自己勾选。'
  )
export const unknownLabel = (): string => tr('Unknown / not connected', '未知 / 未接入')

export type SourceState = { state: 'ok'; detail: string | null } | { state: 'unknown'; reason: string }

export type PeriodRange = 'day' | 'week'

export type CountMap = Record<CountKind, number | null>

export interface DayBucket {
  /** Local YYYY-MM-DD. */
  day: string
  counts: CountMap
}

export interface RepoSourceState {
  id: string
  /** Display path (home shown as ~). */
  path: string
  authorEmail: string | null
  state: SourceState
}

export interface PerformanceCounts {
  range: PeriodRange
  /** 0 = current day / ISO week, -1 = previous, … */
  offset: number
  /** Local labels, inclusive. */
  first: string
  last: string
  start: string
  end: string
  timezone: string
  days: DayBucket[]
  totals: CountMap
  sources: {
    /** het.db corrections. */
    het: SourceState
    /** transcript commit events in het.db. */
    transcripts: SourceState
    /** git log over added repos (ok when ≥1 repo was read). */
    git: SourceState
    repos: RepoSourceState[]
  }
}

export interface EvidenceRef {
  /** Display path: relative to the home directory (`~/…`) when under it. */
  file: string
  line: number
}

export interface PerformanceRow {
  kind: CountKind
  /** Stable row id: task id, het evidence event id, or `repoId:hash`. */
  id: string
  /** ISO instant the row is counted at. */
  at: string
  day: string
  /** What `at` is. */
  atSource: 'corrected_at' | 'task_end' | 'event_time' | 'author_date'
  agent: string | null
  taskId: string | null
  sessionIds: string[]
  project: string | null
  evidence: EvidenceRef | null
  commit: { hash: string | null; hashSource: 'transcript' | 'git' | null; repo: string | null; subject: string | null } | null
}

export interface PerformanceRows {
  kind: CountKind
  first: string
  last: string
  /** Exactly the rows behind the count (same filter, same window). */
  rows: PerformanceRow[]
  /** null when the source is unknown. */
  total: number | null
  source: SourceState
}

export interface RepoEntry {
  id: string
  /** Absolute toplevel path (main only uses it; the renderer gets RepoView). */
  path: string
  /** Optional override; null ⇒ `git config user.email` of that repo. */
  authorEmail: string | null
  addedAt: string
}

export interface RepoView {
  id: string
  path: string
  authorEmail: string | null
  addedAt: string
}

// ── C: projects ────────────────────────────────────────────────────────────────

export interface Milestone {
  id: string
  title: string
  /** YYYY-MM-DD or null. A target the user wrote; Lens never derives one. */
  targetDate: string | null
  note: string
  /** Set only by the user's explicit tick (setMilestoneDone). */
  done: boolean
  doneAt: string | null
}

export interface ProjectMatch {
  /** Literal, case-insensitive keywords (memory text / path, HET task title). */
  keywords: string[]
  /** Path prefixes matched against HET task projects (agent working directories). */
  paths: string[]
  /** Ids of repos added on this page. */
  repoIds: string[]
}

export interface Project {
  id: string
  title: string
  goal: string
  milestones: Milestone[]
  match: ProjectMatch
  createdAt: string
  updatedAt: string
}

/** What the renderer sends to create / edit a project. Milestone `done` is NOT accepted here. */
export interface ProjectInput {
  id?: string
  title: string
  goal: string
  milestones: Array<{ id?: string; title: string; targetDate: string | null; note: string }>
  match: ProjectMatch
}

export type ActivityKind = 'memory' | 'het_task' | 'transcript_commit' | 'git_commit'

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  get memory() {
    return tr('Memory', '记忆')
  },
  get het_task() {
    return tr('Agent session', 'Agent 会话')
  },
  get transcript_commit() {
    return tr('git commit in sessions', '会话里的 git commit')
  },
  get git_commit() {
    return tr('Repo commits', '仓库提交')
  }
}

export interface ActivityItem {
  kind: ActivityKind
  id: string
  at: string
  day: string
  /** Why it matched: `keyword:<k>`, `path:<p>`, `repo:<id>`. */
  matchedBy: string
  title: string
  evidence: EvidenceRef | null
  /** Memory path / entry id, task id, commit hash. */
  ref: string
}

export interface ProjectActivity {
  projectId: string
  days: number
  first: string
  last: string
  items: ActivityItem[]
  sources: { memory: SourceState; het: SourceState; git: SourceState }
}

export const PERFORMANCE_CHANNELS = {
  counts: 'lens:performance:counts',
  rows: 'lens:performance:rows',
  repos: 'lens:performance:repos',
  addRepo: 'lens:performance:add-repo',
  updateRepo: 'lens:performance:update-repo',
  removeRepo: 'lens:performance:remove-repo',
  projects: 'lens:performance:projects',
  saveProject: 'lens:performance:save-project',
  deleteProject: 'lens:performance:delete-project',
  setMilestoneDone: 'lens:performance:set-milestone-done',
  activity: 'lens:performance:activity'
} as const

export const ACTIVITY_WINDOWS = [7, 30, 90] as const

export interface PerformanceApi {
  performance: {
    counts(range: PeriodRange, offset: number): Promise<LensResult<PerformanceCounts>>
    /** `day` (optional) narrows to one local day inside the window. */
    rows(range: PeriodRange, offset: number, kind: CountKind, day?: string): Promise<LensResult<PerformanceRows>>
    repos(): Promise<LensResult<RepoView[]>>
    /** Opens the native folder picker in main; the renderer never sends a path. */
    addRepo(): Promise<LensResult<RepoView[] | null>>
    updateRepo(id: string, authorEmail: string | null): Promise<LensResult<RepoView[]>>
    removeRepo(id: string): Promise<LensResult<RepoView[]>>
    projects(): Promise<LensResult<Project[]>>
    saveProject(input: ProjectInput): Promise<LensResult<Project[]>>
    deleteProject(id: string): Promise<LensResult<Project[]>>
    setMilestoneDone(projectId: string, milestoneId: string, done: boolean): Promise<LensResult<Project[]>>
    activity(projectId: string, days: number): Promise<LensResult<ProjectActivity>>
  }
}
