// Typed renderer API fragment for OG-09 Settings / Privacy (PRIV-02/03/06/07/10, VIS-10 updates).
// Types + constants only: no node imports, so the renderer typecheck can include it.
// Nothing crossing this boundary carries the Runtime bearer token, grant tokens, the screenshot
// key, or raw CLI command lines. Errors are reduced to a code + redacted message in main.
import type { LensResult } from '../../shared/types'

export const PRIVACY_CHANNELS = {
  retention: 'lens:privacy:retention',
  confirmIssue: 'lens:privacy:confirm-issue',
  deleteRun: 'lens:privacy:delete-run',
  withdrawRun: 'lens:privacy:withdraw-run',
  updateCheck: 'lens:privacy:update-check'
} as const

/** Runtime data deletion targets. Each maps to the Runtime's own `persome clean <target> --yes`. */
export const DELETE_TARGETS = ['captures', 'timeline', 'memory', 'all'] as const
export type DeleteTarget = (typeof DELETE_TARGETS)[number]

/** Every action that goes through the main-issued nonce + typed phrase gate. */
export const PRIVACY_ACTIONS = ['delete-captures', 'delete-timeline', 'delete-memory', 'delete-all', 'withdraw-all'] as const
export type PrivacyActionId = (typeof PRIVACY_ACTIONS)[number]

export function deleteAction(target: DeleteTarget): PrivacyActionId {
  return `delete-${target}` as PrivacyActionId
}

/** One Runtime retention key, read from `<runtime root>/config.toml` `[capture]` or the OSS default. */
export interface RetentionValue {
  key: 'buffer_retention_hours' | 'screenshot_retention_hours'
  label: string
  hours: number | null
  origin: 'config' | 'default' | 'invalid'
  /** Human summary, e.g. "168 小时（7 天）". */
  display: string
}

export interface RetentionView {
  /** Config path with the home directory shown as `~`. */
  configPath: string
  configState: 'ok' | 'missing' | 'unreadable'
  values: RetentionValue[]
  /** Always false: the Runtime exposes no REST/CLI setter, and Lens does not own config.toml. */
  editable: false
  /** Why it is read-only + the manual steps to change it. */
  howToChange: string[]
  /** Caveats from the Runtime's cleanup semantics (what "deleted after N hours" really means). */
  notes: string[]
}

export interface PrivacyChallenge {
  action: PrivacyActionId
  nonce: string
  /** The phrase the user must type exactly. */
  phrase: string
  expiresAt: string
  warning: string
}

export interface DeleteRunResult {
  target: DeleteTarget
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  /** OG4: output exceeded the cap; the middle was dropped (the clean itself ran to completion). */
  truncated: boolean
  /** Redacted, ANSI-stripped Runtime output. */
  output: string
  /** Backup written before deletion (directory name only), or null when not requested / cancelled. */
  backup: { name: string; files: number } | null
  runtimeRestarted: boolean
}

export interface WithdrawResult {
  /** Agents whose MCP config entry Lens removed (Claude Code / Codex / Desktop / Cursor). */
  agentsDisconnected: string[]
  /** Grants revoked in this run (all clients, including manual configs). */
  grantsRevoked: number
  /** Active grants left after the run (expected 0). */
  activeAfter: number
  /** The Access log is never touched by withdraw (PRIV-07 is a separate action). */
  accessLogTouched: false
  /** Per-agent problems (e.g. unreadable client config); the grants are revoked regardless. */
  warnings: string[]
}

export interface UpdateCheckResult {
  status: 'blocked'
  currentVersion: string | null
  /** Why the check cannot run. */
  reasons: string[]
  /** Always false: the update module makes no network request at all (OG-D4). */
  networkRequested: false
  decision: 'OG-D4'
}

export interface PrivacyApi {
  privacy: {
    retention(): Promise<LensResult<RetentionView>>
    confirmIssue(action: PrivacyActionId): Promise<LensResult<PrivacyChallenge>>
    deleteRun(target: DeleteTarget, nonce: string, phrase: string, backupFirst: boolean): Promise<LensResult<DeleteRunResult>>
    withdrawRun(nonce: string, phrase: string): Promise<LensResult<WithdrawResult>>
    updateCheck(): Promise<LensResult<UpdateCheckResult>>
  }
}
