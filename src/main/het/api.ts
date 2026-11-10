/**
 * Renderer-facing API fragment for the Performance Plane (HET). Merged into
 * src/shared/api.ts via `extends`. Types only + constants: no node imports, so the
 * renderer typecheck can include it.
 */
import { tr } from '../../shared/i18n'
import type { LensResult } from '../../shared/types'
import type { AgentSignal, HetCorrection, HetLedgerStatus } from './types'

/** Reference §5.6 / HET-01, verbatim. */
export const HET_DEFINITION =
  'Human Equivalent Time estimates how long a competent professional might need to recreate the same AI output from scratch. It is not Agent runtime or proven time saved. Only detected AI work that finished assessment is included.'

export type HetAdoption = 'confirmed' | 'strong' | 'weak' | 'unknown' | 'rejected'

export interface HetEvidenceDto {
  event_id: string
  ts: string
  role: string
  tools: string[]
  files: string[]
  signals: string[]
  summary: string
  source: { file: string; line: number }
}

export interface HetTaskDto {
  id: string
  agent: string
  project: string | null
  title: string | null
  start: string
  end: string
  kind: string
  status: HetLedgerStatus
  /** Minutes only for counted (assessed, not rejected/not_agent) tasks; otherwise null. */
  minutes: number | null
  minutes_tenths: number | null
  adoption: HetAdoption | null
  correction: HetCorrection | null
  anchor_version: number | null
  counted: boolean
  signals: AgentSignal[]
  files_written: string[]
  stats: Record<string, number>
  last_error: string | null
  evidence?: HetEvidenceDto[]
  /** Local date (in the request's timezone) of the task end; set by period queries. */
  day?: string
}

/**
 * Reference §5.6 states. `updateFailed` = the last ledger update (tick: read transcripts →
 * segment → upsert) failed; numbers shown are from the last good update. Set by the service,
 * never by the ledger. The next scheduled tick (or `retry`) tries again; nothing is guessed.
 */
export type HetPanelState =
  | 'notStarted'
  | 'calculating'
  | 'onePending'
  | 'manyPending'
  | 'oneFailed'
  | 'manyFailed'
  | 'updateFailed'
  | 'ready'

/** Last ledger update outcome (service-level). `error` is a short, path-free code. */
export interface HetUpdateStatus {
  failed: boolean
  error: string | null
  last_tick_at: string | null
  /** Consecutive failed updates since the last good one. */
  consecutive_failures: number
}

export interface HetSummary {
  days: Array<{ date: string; minutes: number; minutes_tenths: number; tasks: number; pending: number }>
  total_minutes: number
  total_minutes_tenths: number
  pending: number
  failed: number
  unsettled: number
  state: HetPanelState
  /** IANA zone used for day buckets (null only for test-injected bucketing). */
  timezone: string | null
  /**
   * True iff at least one task in the window finished assessment. False ⇒ the zeros above
   * are NOT a measurement (「未测量」); the REST adapter reports null minutes in that case.
   */
  measured: boolean
  /** Service-level update status (absent when built directly from the ledger). */
  update?: HetUpdateStatus
  /** State computed from the ledger alone, kept when `state` is overridden by `updateFailed`. */
  ledger_state?: HetPanelState
}

export interface HetPeriod {
  start: string
  end: string
  tasks: HetTaskDto[]
  next_cursor: string | null
  /** Whole period (all pages); equals the sum of counted rows' minutes_tenths. */
  total_minutes_tenths: number
  total_minutes: number
  page_minutes_tenths: number
  /** Whole-period counts (not capped by page/limit). */
  counts: HetPeriodCounts
  /** IANA zone used for each task's `day`. */
  timezone: string
  /** True iff at least one task ending in the period finished assessment (see HetSummary.measured). */
  measured: boolean
}

/**
 * Activity — **Lens-defined shape**. The reference (§11.1) gives only the endpoint name
 * `GET /het/activity?start=&end=` (shape [X]); this structure is ours, not the product's.
 * Day = local date of the task END in `timezone` (same rule as summary/period).
 * Bounds: range ≤ 92 days; ≤ 500 markers (`markers_total` / `markers_truncated`).
 * Markers carry start/end for timeline display only; HET is `minutes`, never end − start.
 */
export interface HetActivity {
  start: string
  end: string
  timezone: string
  days: Array<{
    date: string
    minutes_tenths: number
    minutes: number
    /** counted (assessed, not rejected/not_agent) tasks */
    tasks: number
    pending: number
    unsettled: number
    by_agent: Record<string, { minutes_tenths: number; tasks: number }>
  }>
  total_minutes_tenths: number
  total_minutes: number
  markers: Array<{
    id: string
    agent: string
    start: string
    end: string
    status: HetLedgerStatus
    counted: boolean
    minutes_tenths: number | null
  }>
  markers_total: number
  markers_truncated: boolean
  /** True iff at least one task in range finished assessment. */
  measured: boolean
}

/**
 * Why a not-counted, not-excluded task is waiting. Keys: 'unsettled' | 'failed' | 'queued'
 * (never attempted) | the outcome prefix of last_error ('assessor_disabled', 'no_transport',
 * 'budget_unavailable', 'quota', 'offline', 'invalid', 'error'). The first two (and
 * 'budget_unavailable:<why>' from the gate) are S1-02 gate reasons: no transport call was made.
 */
export type HetWaitingKey =
  | 'unsettled'
  | 'failed'
  | 'queued'
  | 'assessor_disabled'
  | 'no_transport'
  | 'budget_unavailable'
  | 'quota'
  | 'offline'
  | 'invalid'
  | 'error'

export interface HetPeriodCounts {
  tasks: number
  counted: number
  needs_assessment: number
  unsettled: number
  failed: number
  excluded: number
  waiting_by_reason: Partial<Record<HetWaitingKey, number>>
}

/** Same mapping as the SQL in ledger.hetPeriod; used by the renderer per row. */
export function waitingKey(t: { status: HetLedgerStatus; last_error: string | null }): HetWaitingKey {
  if (t.status === 'unsettled') return 'unsettled'
  if (t.status === 'failed') return 'failed'
  if (!t.last_error) return 'queued'
  return t.last_error.split(':')[0] as HetWaitingKey
}

/**
 * S1-02 assessor gate, as the UI should explain it.
 *  - disabled: user switch off (default) → no call, 0 minutes
 *  - no_transport: switch on, but this build has no real assessor transport → no call, 0 minutes
 *  - budget_unavailable: switch on + transport, budget probe says no → no call, 0 minutes
 *  - ready: may call the transport (within per-tick / per-day caps)
 *  - fixture: unpackaged E2E fixture assessor (never an LLM)
 */
export interface HetAssessorStatus {
  enabled: boolean
  transport_present: boolean
  state: 'disabled' | 'no_transport' | 'budget_unavailable' | 'ready' | 'fixture'
  reason: string | null
}

/** X3: Runtime `[agent_funding]` daily budget as read by main (read-only; Lens never writes it). */
export interface HetAssessorBudget {
  enabled: boolean
  used: number
  limit: number
  remaining: number
  exhausted: boolean
  date: string
  reset_at: string
}

/**
 * X3 (R4-1) settings view for the assessor. No secrets, no prompt, no paths.
 * `sent_fields` lists exactly what leaves Lens per task with the current setting.
 */
export interface HetAssessorInfo extends HetAssessorStatus {
  /** Transport name: 'agent_funding' (Runtime CLI), 'disabled', or 'fixture' (E2E only). */
  transport: string
  /** True when the Runtime venv python exists (only meaningful for 'agent_funding'). */
  runtime_python_present: boolean
  client: string | null
  model: string | null
  budget: HetAssessorBudget | null
  send_summaries: boolean
  anchor_version: number | null
  per_tick_cap: number
  per_day_cap: number
  /** HET calls today that reached the transport (local day). */
  calls_today: number
  sent_fields: string[]
}

export interface HetSetSendSummariesResult {
  send_summaries: boolean
  /** False when turning ON was cancelled in the native confirm (setting unchanged). */
  confirmed: boolean
}

/** Field lists shown in the UI (kept next to buildAssessorPrompt; see assessor.ts P1). */
// Iterables (not arrays) so `tr()` runs when the list is spread, i.e. in the user's current locale.
export const HET_SENT_FIELDS_MINIMAL: Iterable<string> = {
  *[Symbol.iterator]() {
    yield tr('Task id', '任务 id')
    yield tr('Agent (claude-code / codex)', 'Agent（claude-code / codex）')
    yield tr('Duration (minutes)', '时长（分钟）')
    yield tr('Counts (messages / tool calls, etc.)', '计数（消息 / 工具调用等）')
    yield tr('Tool names', '工具名')
    yield tr('Signals (e.g. git_commit)', '信号（如 git_commit）')
    yield tr('Extensions of written files', '写入文件的扩展名')
  }
}
export const HET_SENT_FIELDS_SUMMARIES: Iterable<string> = {
  *[Symbol.iterator]() {
    yield tr('Project path', '项目路径')
    yield tr('Session title', '会话标题')
    yield tr('Written file paths (≤20)', '写入文件路径（≤20）')
    yield tr('Event summaries (redacted, ≤200 chars)', '事件摘要（已脱敏，≤200 字）')
  }
}

export interface HetTickStatus {
  lastTickAt: string | null
  running: boolean
  lastError: string | null
  transport: string
  assessor: HetAssessorStatus
}

export interface WeeklyReviewResult {
  /** Null when the user cancelled the save dialog. */
  markdownPath: string | null
  htmlPath: string | null
  total_minutes_tenths: number
  rows: number
}

/**
 * S1-R3-04 「本周 AI 工作计数」 (PERFORMANCE.md option B). Plain counts of ledger rows; never minutes,
 * rates or a score. `commit_signal` = the task's `signals` contain COMMIT_SIGNAL.
 */
export type HetCountFilter = 'accepted' | 'rejected' | 'not_agent' | 'commit_signal'
export const HET_COUNT_FILTERS: readonly HetCountFilter[] = ['accepted', 'rejected', 'not_agent', 'commit_signal']

/** The only signal that counts as a commit signal (pushes / PR links do not). */
export const COMMIT_SIGNAL: AgentSignal = 'git_commit'

/**
 * Exact definition (English; commitSignalDefinition() returns the current locale), shown verbatim in the UI tooltip. The regex is the one in
 * adapters/common.ts `shellSignals` (a test keeps them identical). Anchors (anchors.ts) never read
 * signals: they only weight the assessor's adoption level, so the commit signal is defined at the
 * adapter, which is the deterministic source the anchors' "adoption" evidence would point to.
 */
export const COMMIT_SIGNAL_DEFINITION =
  'Commit signal = the task\'s signals include git_commit: the text of a shell command the Agent ran in the task (Claude Code\'s Bash tool, Codex shell / function calls) matches /\\bgit\\s+(-C\\s+\\S+\\s+)?commit\\b/. Only the command text is checked, not its result: it does not mean the commit succeeded, was not reverted, or was merged; git push, gh pr create and PR links do not count. Independent of corrections (not_agent tasks count too).'
const COMMIT_SIGNAL_DEFINITION_ZH =
  '提交信号 = 该任务的 signals 含 git_commit：任务里 Agent 调用过的 shell 命令（Claude Code 的 Bash 工具、Codex 的 shell / function 调用）文本匹配 /\\bgit\\s+(-C\\s+\\S+\\s+)?commit\\b/。只看命令文本，不看结果：不代表提交成功、没被撤销或已合并；git push、gh pr create、PR 链接都不算。与修正状态无关（not_agent 的任务也照样计入）。'

/** COMMIT_SIGNAL_DEFINITION in the current UI locale (call at use time). */
export function commitSignalDefinition(): string {
  return tr(COMMIT_SIGNAL_DEFINITION, COMMIT_SIGNAL_DEFINITION_ZH)
}

export interface HetWeekCounts {
  /** ISO 8601 week label, e.g. '2026-W45'. */
  iso_week: string
  /** Local Monday / Sunday labels (YYYY-MM-DD) in `timezone`, both inclusive (display). */
  week_start: string
  week_end: string
  /** Instants [start, end): local Monday 00:00 .. next Monday 00:00. Tasks are attributed by END. */
  start: string
  end: string
  timezone: string
  /** All ledger tasks ending in the week (any status). 0 ⇒ there is no data, not "zero work". */
  tasks: number
  counts: Record<HetCountFilter, number>
  commit_signal_definition: string
}

export interface HetFilteredTasks {
  start: string
  end: string
  filter: HetCountFilter
  timezone: string
  tasks: HetTaskDto[]
  next_cursor: string | null
  /** Whole-window count for this filter (equals HetWeekCounts.counts[filter] for the same window). */
  total: number
}

export interface HetApi {
  het: {
    /** `timezone`: IANA name; default = system zone. */
    summary(days?: number, timezone?: string): Promise<LensResult<HetSummary>>
    tasks(limit?: number, includeActivity?: boolean): Promise<LensResult<HetTaskDto[]>>
    period(
      start: string,
      end: string,
      cursor?: string | null,
      limit?: number,
      includeActivity?: boolean,
      timezone?: string
    ): Promise<LensResult<HetPeriod>>
    /** Lens-defined shape (see HetActivity). Range ≤ 92 days. */
    activity(start: string, end: string, timezone?: string): Promise<LensResult<HetActivity>>
    correct(taskId: string, action: HetCorrection): Promise<LensResult<{ minutes_tenths: number | null; changed: boolean }>>
    status(): Promise<LensResult<HetTickStatus>>
    /** S1-02: persist het-settings.json `assessorEnabled`. Does not create a transport. */
    setAssessorEnabled(enabled: boolean): Promise<LensResult<HetAssessorStatus>>
    /** X3: assessor settings view (state, client / model, Runtime budget, what is sent). */
    assessorInfo(): Promise<LensResult<HetAssessorInfo>>
    /** X3: `sendSummariesToAssessor`. Turning ON shows a main-owned native confirm; OFF does not. */
    setSendSummaries(enabled: boolean): Promise<LensResult<HetSetSendSummariesResult>>
    exportWeekly(weekStart: string): Promise<LensResult<WeeklyReviewResult>>
    /** OG-08: undo a correction (DEVIATIONS D17: corrections are reversible). */
    revertCorrection(taskId: string): Promise<LensResult<{ minutes_tenths: number | null; changed: boolean }>>
    /** OG-08 / HET-08: re-queue failed tasks and run one tick (same gate and caps). */
    retry(): Promise<LensResult<{ requeued: number }>>
    /** S1-R3-04: counts for the ISO week containing now (default system zone). No minutes. */
    weekCounts(timezone?: string): Promise<LensResult<HetWeekCounts>>
    /** S1-R3-04 click-through: tasks ending in [start, end) matching one count filter. */
    filteredTasks(
      start: string,
      end: string,
      filter: HetCountFilter,
      cursor?: string | null,
      limit?: number,
      timezone?: string
    ): Promise<LensResult<HetFilteredTasks>>
  }
}

export const HET_CHANNELS = {
  summary: 'lens:het:summary',
  tasks: 'lens:het:tasks',
  period: 'lens:het:period',
  correct: 'lens:het:correct',
  status: 'lens:het:status',
  exportWeekly: 'lens:het:export-weekly',
  activity: 'lens:het:activity',
  setAssessorEnabled: 'lens:het:set-assessor-enabled',
  revertCorrection: 'lens:het:revert-correction',
  retry: 'lens:het:retry',
  weekCounts: 'lens:het:week-counts',
  filteredTasks: 'lens:het:filtered-tasks',
  assessorInfo: 'lens:het:assessor-info',
  setSendSummaries: 'lens:het:set-send-summaries'
} as const

export type { HetCorrection, HetLedgerStatus }
