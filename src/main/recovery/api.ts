// Typed renderer API fragment for OG-06 Recovery (data / runtime failure recovery).
// Types + constants only: no node imports, so the renderer typecheck can include it.
// Nothing crossing this boundary ever carries the bearer token, the screenshot key, or other
// values from `<runtime root>/env`; doctor output and diagnostics are redacted in main.
import type { LensResult } from '../../shared/types'

export const RECOVERY_CHANNELS = {
  health: 'lens:recovery:health',
  startRuntime: 'lens:recovery:runtime-start',
  restartRuntime: 'lens:recovery:runtime-restart',
  doctor: 'lens:recovery:doctor',
  diagnostics: 'lens:recovery:diagnostics',
  confirmIssue: 'lens:recovery:confirm-issue',
  confirmRun: 'lens:recovery:confirm-run'
} as const

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown'

export type CheckId =
  | 'runtime_bin'
  | 'runtime_root'
  | 'token'
  | 'runtime_reachable'
  | 'runtime_version'
  | 'index'
  | 'capture_pipeline'
  | 'capture_plane'
  | 'broker'
  | 'lens_store'
  | 'disk'

/** Actions main can execute (or the renderer can run with an existing helper). */
export type RecoveryActionId =
  | 'start-runtime'
  | 'restart-runtime'
  | 'run-doctor'
  | 'open-logs'
  | 'copy-diagnostics'
  | 'goto-capture'
  | 'goto-connections'
  | 'rebuild-captures-index'

/** Destructive actions that go through the two-step confirmation (typed phrase + nonce). */
export type DestructiveActionId = 'rebuild-captures-index'

export type NextStep =
  | { kind: 'action'; action: RecoveryActionId; label: string }
  | { kind: 'manual'; title: string; steps: string[]; command?: string }

export interface RecoveryCheck {
  id: CheckId
  label: string
  status: CheckStatus
  /** Short, redacted, human-readable detail (Chinese). */
  detail: string
  next: NextStep[]
}

export interface ManualProcedure {
  id: 'clear-capture-buffer' | 'reset-lens-store' | 'full-index-rebuild'
  title: string
  why: string
  steps: string[]
}

export interface RecoveryReport {
  generatedAt: string
  overall: CheckStatus
  runtime: { root: string; port: number; binFound: boolean; version: string | null }
  checks: RecoveryCheck[]
  /** Destructive operations Lens deliberately does not perform (no safe API exists). */
  manual: ManualProcedure[]
}

export interface DoctorLine {
  status: 'ok' | 'fail' | 'warn' | 'info'
  text: string
}

export interface DoctorResult {
  ran: boolean
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  durationMs: number
  /** Redacted, ANSI-stripped output. */
  output: string
  lines: DoctorLine[]
  summary: { ok: number; fail: number; warn: number }
}

export interface DiagnosticsResult {
  text: string
  copied: boolean
}

export interface ConfirmChallenge {
  action: DestructiveActionId
  nonce: string
  /** Phrase the user must type exactly. */
  phrase: string
  expiresAt: string
  warning: string
}

export interface DestructiveRunResult {
  action: DestructiveActionId
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  /** OG4: output exceeded the cap; the middle was dropped (the command itself ran to completion). */
  truncated: boolean
  output: string
  runtimeRestarted: boolean
}

export interface RecoveryApi {
  recovery: {
    health(): Promise<LensResult<RecoveryReport>>
    startRuntime(): Promise<LensResult<RecoveryReport>>
    restartRuntime(): Promise<LensResult<RecoveryReport>>
    doctor(): Promise<LensResult<DoctorResult>>
    diagnostics(copy: boolean): Promise<LensResult<DiagnosticsResult>>
    confirmIssue(action: DestructiveActionId): Promise<LensResult<ConfirmChallenge>>
    confirmRun(action: DestructiveActionId, nonce: string, phrase: string): Promise<LensResult<DestructiveRunResult>>
  }
}
