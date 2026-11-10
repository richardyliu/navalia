/**
 * HET (Human Equivalent Time) core types.
 *
 * Scope of this file (E3.1–E3.2): the normalized transcript event produced by the
 * read-only agent log adapters, the attended-window input from the Runtime timeline,
 * and the `HetTask` candidate produced by the segmenter. Assessment / anchors / ledger
 * fields are declared for the schema draft but are not produced yet.
 */

export type AgentId = 'claude-code' | 'codex'

/**
 * `user`       a human-authored prompt (injected context / tool results are NOT user).
 * `assistant`  model output: text and/or tool calls.
 * `tool_result` result of a tool call fed back to the model.
 * `system`     harness-injected content (environment context, compaction, hooks).
 */
export type AgentRole = 'user' | 'assistant' | 'tool_result' | 'system'

/** Coarse, content-free signals that later feed adoption evidence. */
export type AgentSignal = 'git_commit' | 'git_push' | 'pr_create' | 'pr_link' | 'tool_error'

export interface AgentEvent {
  agent: AgentId
  sessionId: string
  /** Epoch milliseconds (UTC). Events without a parseable timestamp are dropped + counted. */
  ts: number
  cwd: string | null
  /** Project key derived from cwd (see `projectKeyFromCwd`). */
  project: string | null
  role: AgentRole
  toolNames: string[]
  /** Paths the agent wrote/edited (Edit/Write/apply_patch...). */
  filesWritten: string[]
  /** Paths the agent read without writing. */
  filesRead: string[]
  signals: AgentSignal[]
  /** Whitespace-collapsed, secret-redacted, truncated to SUMMARY_MAX chars. */
  summary: string
  /** True for subagent / sidechain traffic inside a parent session. */
  sidechain: boolean
  /** Provenance: absolute transcript path + 1-based line number. Never content. */
  source: { file: string; line: number }
}

export const SUMMARY_MAX = 200

/** Schema-drift counters. Key = stable warning code, value = occurrences. */
export type WarningCounts = Record<string, number>

export interface AdapterResult {
  agent: AgentId
  files: number
  lines: number
  events: AgentEvent[]
  /** Per-session short title (Claude `ai-title`/`custom-title`), truncated. */
  sessionTitles: Record<string, string>
  warnings: WarningCounts
}

/**
 * A window in which the human was observably attending the screen, derived from the
 * Runtime timeline (OSS: MCP `attention_trajectory().trajectory[]`, or
 * `timeline_blocks.start_time/end_time`). There is no REST timeline endpoint in the OSS
 * runtime; main fetches it via MCP and maps it with `attendedFromTrajectory`.
 */
export interface AttendedWindow {
  start: number
  end: number
  /** Attended surface label (window / pane / page). Optional; never required for segmenting. */
  surface?: string
}

/** Segmenter output status. Later lifecycle states live in the ledger, not here. */
export type HetSegmentStatus = 'unsettled' | 'settled'

/** Placeholder until the assessor classifies the task (E3.3). */
export type HetKind = 'unassessed' | 'research' | 'writing' | 'coding' | 'review' | 'ops' | 'meeting'

export interface HetTask {
  /** Deterministic: derived from agent + earliest (sessionId, start). Stable across ticks. */
  id: string
  agent: AgentId
  project: string | null
  title: string | null
  start: number
  end: number
  kind: HetKind
  status: HetSegmentStatus
  sessionIds: string[]
  stats: {
    events: number
    userTurns: number
    assistantTurns: number
    toolCalls: number
    filesWritten: number
    filesRead: number
    sidechainEvents: number
  }
  /** Distinct written paths (capped) for evidence; no file content. */
  filesWritten: string[]
  signals: AgentSignal[]
  /** Overlap with attended windows. `null` when no timeline was supplied. */
  attendedMs: number | null
}

/**
 * Ledger lifecycle. `needs_assessment` = settled but not (yet) assessed: waiting, or the
 * last attempt hit budget/quota/offline/invalid. `failed` = maxAttempts invalid/error.
 */
export type HetLedgerStatus = 'unsettled' | 'needs_assessment' | 'assessed' | 'failed'

/** User corrections — exactly these three (reference §10.3). */
export type HetCorrection = 'accepted' | 'rejected' | 'not_agent'
