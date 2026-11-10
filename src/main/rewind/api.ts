// Typed renderer API fragment for OG-05 Rewind (screenshot history).
// Types + constants only: no node imports, so the renderer typecheck can include it.
// Metadata crosses IPC; screenshot pixels cross only as ONE display-only data URL per `view`
// call. The screenshot key never leaves main.
import type { LensResult } from '../../shared/types'

export const REWIND_CHANNELS = {
  list: 'lens:rewind:list',
  view: 'lens:rewind:view'
} as const

/** Display cap for one decrypted screenshot (raw image bytes, before base64). */
export const REWIND_VIEW_MAX_BYTES = 8 * 1024 * 1024
export const REWIND_PAGE_MAX = 100

export interface RewindListQuery {
  /** ISO-8601, inclusive. */
  since?: string
  /** ISO-8601, inclusive. */
  until?: string
  /** Exact app name (as captured). */
  appName?: string
  limit?: number
  /** `nextCursor` from the previous page. */
  cursor?: string
}

export interface RewindFrameView {
  fileStem: string
  timestamp: string
  appName: string | null
  bundleId: string | null
  windowTitle: string | null
  url: string | null
  hasScreenshot: boolean
}

export interface RewindListResult {
  /** Newest first. */
  frames: RewindFrameView[]
  /** Continue with this cursor; non-null whenever unexamined frames remain (also when `partial`). */
  nextCursor: string | null
  /**
   * True when the per-call scan budget (Broker SCAN_BUDGET capture files) ran out before `limit`
   * matches were found: `frames` may be short or empty although older frames remain.
   */
  partial?: boolean
  /** Capture files examined by this call. */
  scanned?: number
  /** Whether a screenshot key is configured (boolean only; the key itself never crosses IPC). */
  keyAvailable: boolean
}

export type RewindViewResult =
  | {
      status: 'ok'
      fileStem: string
      mime: string
      /** `data:<mime>;base64,…` for an <img>; display only, never persisted. */
      dataUrl: string
      bytes: number
      width: number | null
      height: number | null
    }
  /** Not an error: a precondition the user must satisfy (e.g. missing key). */
  | { status: 'blocked'; reason: 'missing_key'; message: string }
  | { status: 'unavailable'; reason: 'no_screenshot' | 'plaintext_refused' | 'too_large' | 'unsupported_format'; message: string }

export interface RewindApi {
  rewind: {
    list(query?: RewindListQuery): Promise<LensResult<RewindListResult>>
    view(fileStem: string): Promise<LensResult<RewindViewResult>>
  }
}
