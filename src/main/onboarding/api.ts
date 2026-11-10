// Typed renderer API fragment for S2-01 onboarding (first run). Owned by the onboard-ask agent.
// Types + constants only: no node imports, so the renderer typecheck can include it.
import type { LensResult } from '../../shared/types'

export const ONBOARDING_CHANNELS = {
  status: 'lens:onboarding:status',
  finish: 'lens:onboarding:finish',
  reset: 'lens:onboarding:reset'
} as const

/** Overlay steps, in order. Shared by main (record validation) and the renderer state machine. */
export const ONBOARDING_STEPS = ['welcome', 'permissions', 'connections', 'import', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export type OnboardingOutcome = 'completed' | 'skipped'

/**
 * Why the overlay is / is not shown:
 * - `first_run`: no onboarding.json and the Lens Store has no user data → show.
 * - `reopened`: the user asked to see it again (`reset`) → show.
 * - `completed` / `skipped`: finished before → never show again.
 * - `legacy`: no onboarding.json but the Store already had user data (an existing user from
 *   before onboarding existed) → do not show; a `legacy` record is written so this is stable.
 * - `corrupt`: onboarding.json exists but is unreadable / invalid → do not show (safe default:
 *   the file only exists if onboarding ran before; never trap the user in a loop).
 */
export type OnboardingReason = 'first_run' | 'reopened' | 'completed' | 'skipped' | 'legacy' | 'corrupt'

export interface OnboardingStatus {
  show: boolean
  reason: OnboardingReason
  completedAt: string | null
  skippedAt: string | null
  /** Step the user was on when they completed / skipped (null if unknown). */
  lastStep: OnboardingStep | null
}

export interface OnboardingFinishInput {
  outcome: OnboardingOutcome
  lastStep: OnboardingStep
}

export interface OnboardingApi {
  onboarding: {
    status(): Promise<LensResult<OnboardingStatus>>
    finish(input: OnboardingFinishInput): Promise<LensResult<OnboardingStatus>>
    /** "重新打开引导": the overlay shows again on the next status() call. */
    reset(): Promise<LensResult<OnboardingStatus>>
  }
}
