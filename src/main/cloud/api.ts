// Typed renderer API fragment for the opt-in cloud client (S1-FULL C2) and Lens Chat (C3–C7,
// `chat` namespace, see chat-api.ts). Types + constants only (renderer-safe). Cloud is OFF by
// default; while off, main makes zero network calls.
import type { ChatApiFragment } from './chat-api'
import type { MeetingsApiFragment } from './meetings-api'
import type { SubsApiFragment } from './subs-api'

export const CLOUD_CHANNELS = {
  status: 'lens:cloud:status',
  configure: 'lens:cloud:configure',
  signIn: 'lens:cloud:sign-in',
  signOut: 'lens:cloud:sign-out',
  deleteAccount: 'lens:cloud:delete-account'
} as const

/**
 * Closed error set. `disabled`…`server` plus `quota_exceeded` / `llm_unavailable` /
 * `upstream_error` / `upstream_timeout` come from an HTTP exchange (the last four only when the
 * server's JSON `error.code` is exactly that string, or from an SSE `error` event); the rest are
 * local. Messages are fixed strings per code: they never contain the token, a signature, or
 * response body text.
 */
export type CloudErrorCode =
  | 'disabled'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'too_large'
  | 'bad_response'
  | 'server'
  | 'invalid_args'
  | 'cancelled'
  | 'no_identity'
  | 'storage'
  | 'unknown'
  // S1-FULL C3–C7 (chat)
  | 'quota_exceeded'
  | 'llm_unavailable'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'not_found'
  | 'runtime'
  | 'busy'
  // S1-FULL C8 / C10 (cloud cards + subscriptions). The server codes are mapped by HTTP status in
  // cards.ts / subs.ts (the client only knows the status); the rest are local offline checks.
  | 'card_not_owner'
  | 'card_invalid'
  | 'letter_not_owner'
  | 'letter_invalid'
  | 'duplicate_issue'
  | 'signature_invalid'
  | 'wrong_signer'
  | 'self_card'
  | 'no_card'
  // S1-FULL C12–C14 (meetings). Server codes (allowlisted in client.ts) plus local `mic_denied`.
  | 'consent_required'
  | 'stt_unavailable'
  | 'chunk_conflict'
  | 'meeting_closed'
  | 'checksum_mismatch'
  | 'chunks_missing'
  | 'chunks_mismatch'
  | 'not_ready'
  | 'mic_denied'
  // S1-FULL C18 (shared moments). Server codes mapped by HTTP status in moments.ts; `not_friend` /
  // `unknown_signer` are local checks against the Peers list.
  | 'moment_not_owner'
  | 'moment_invalid'
  | 'acceptance_invalid'
  | 'not_participant'
  | 'moment_conflict'
  | 'not_friend'
  | 'unknown_signer'

export interface CloudIpcError {
  code: CloudErrorCode
  message: string
  /** Only for `rate_limited` / `quota_exceeded`, when the server sent a usable Retry-After. */
  retryAfterS?: number
}

/** Same shape as `LensResult<T>`, with the cloud error-code set (see C2 log, wiring request). */
export type CloudResult<T> = { ok: true; data: T } | { ok: false; error: CloudIpcError }

export interface CloudStatus {
  enabled: boolean
  /** Normalized origin (`https://host[:port]`), or null when never configured. */
  baseUrl: string | null
  /** True only when enabled, a non-expired token exists, and it was issued for `baseUrl`. */
  signedIn: boolean
  accountId: string | null
  /** ISO time the session expires; null when signed out. */
  expiresAt: string | null
}

export interface CloudConfigureArgs {
  enabled: boolean
  baseUrl: string | null
  /** Required (`true`) to turn cloud ON or to change the server while ON; main also asks natively. */
  confirm?: true
}

export interface CloudApi extends ChatApiFragment, SubsApiFragment, MeetingsApiFragment {
  cloud: {
    status(): Promise<CloudResult<CloudStatus>>
    /**
     * Turning OFF (or switching server) first revokes the session server-side best-effort (short
     * timeout), then always forgets the local token; `remoteRevoked` says whether the server
     * confirmed. No request is made when there is no stored session.
     */
    configure(args: CloudConfigureArgs): Promise<CloudResult<CloudStatus & { remoteRevoked: boolean }>>
    signIn(): Promise<CloudResult<CloudStatus>>
    /** Best-effort server logout when ON, then always forgets the local token. */
    signOut(): Promise<CloudResult<CloudStatus & { remoteRevoked: boolean }>>
    /** Deletes the cloud account (server side). Requires `confirm: true` + a native confirm in main. */
    deleteAccount(args: { confirm: true }): Promise<CloudResult<CloudStatus>>
  }
}
