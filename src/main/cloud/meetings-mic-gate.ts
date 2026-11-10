// S1-FULL C12 microphone permission gate (pure; no electron import). security.ts denies every web
// permission except sanitized clipboard write; the ONLY exception added for meetings is an
// audio-only `media` request from the app document while main has armed recording for a meeting
// (the user ticked the consent checkbox AND confirmed main's native dialog). Video, screen, mixed
// audio+video, other origins and an unarmed state are all denied.

export interface MicPermissionInput {
  /** Electron permission name (`media`, `clipboard-read`, …). */
  permission: string
  /** `details.mediaTypes` of the request (`['audio']`, `['video']`, `['audio','video']`, …). */
  mediaTypes: readonly unknown[] | undefined
  /** `details.requestingUrl`. */
  requestingUrl: string | undefined | null
  /** security.ts `isAppUrl` (app document only). */
  isAppUrl: (url: string | undefined | null) => boolean
  /** True only while main has armed recording for a consented meeting. */
  armed: boolean
}

/** Permission *request* handler decision. True only for media + audio-only + app URL + armed. */
export function micPermissionDecision(input: MicPermissionInput): boolean {
  if (input.permission !== 'media') return false
  const types = input.mediaTypes
  if (!Array.isArray(types) || types.length !== 1 || types[0] !== 'audio') return false
  if (!input.armed) return false
  try {
    return input.isAppUrl(input.requestingUrl) === true
  } catch {
    return false
  }
}

export interface MicCheckInput {
  permission: string
  /** `details.mediaType` of a permission *check* (`audio` | `video` | `unknown`). */
  mediaType: unknown
  /** `requestingOrigin` of the check. */
  requestingOrigin: string | undefined | null
  isAppUrl: (url: string | undefined | null) => boolean
  armed: boolean
}

/** Permission *check* handler decision (same rule; checks carry one `mediaType`). */
export function micCheckDecision(input: MicCheckInput): boolean {
  if (input.permission !== 'media' || input.mediaType !== 'audio' || !input.armed) return false
  try {
    return input.isAppUrl(input.requestingOrigin) === true
  } catch {
    return false
  }
}

/**
 * Arming state owned by the meetings service. One meeting at a time; arming expires so a crashed
 * renderer cannot leave the microphone grantable forever (the recorder re-arms nothing: a new
 * recording needs a new consent + confirm).
 */
export interface MicArm {
  arm(meetingId: string): void
  disarm(meetingId?: string): void
  armedFor(): string | null
  isArmed(): boolean
}

/** Default arming lifetime: the server's max meeting (240 × 35 s) plus slack. */
export const DEFAULT_ARM_TTL_MS = 3 * 3600_000

export function createMicArm(opts: { now?: () => number; ttlMs?: number } = {}): MicArm {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? DEFAULT_ARM_TTL_MS
  let current: { id: string; until: number } | null = null
  const live = (): { id: string; until: number } | null => {
    if (current && current.until <= now()) current = null
    return current
  }
  return {
    arm(meetingId) {
      current = { id: meetingId, until: now() + ttl }
    },
    disarm(meetingId) {
      if (meetingId === undefined || current?.id === meetingId) current = null
    },
    armedFor: () => live()?.id ?? null,
    isArmed: () => live() !== null
  }
}
