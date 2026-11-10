/**
 * Renderer-facing API fragment for the Capture Plane (merged into
 * src/shared/api.ts via `extends`). Metadata only: no token, frame bytes,
 * screenshot pixels or AX text ever cross IPC.
 */
import type { LensResult } from '../../shared/types'
import type { ScreenshotReason, TextHealthView } from './textHealth'

export const CAPTURE_CHANNELS = {
  status: 'lens:capture:status',
  restart: 'lens:capture:restart',
  pause: 'lens:capture:pause',
  resume: 'lens:capture:resume',
  excludeAdd: 'lens:capture:exclude-add',
  excludeRemove: 'lens:capture:exclude-remove',
  pickApp: 'lens:capture:pick-app',
  requestAccessibility: 'lens:capture:request-accessibility',
  requestScreenRecording: 'lens:capture:request-screen-recording',
  openPrivacy: 'lens:capture:open-privacy',
  diagnostics: 'lens:capture:diagnostics'
} as const

export type ExclusionKind = 'bundleId' | 'appName'
export type PrivacyPane = 'accessibility' | 'screenRecording'

export interface PauseView {
  paused: boolean
  mode: 'none' | 'indefinite' | 'until'
  since: string | null
  until: string | null
}

export interface RecentFrameView {
  at: string
  trigger: string
  appName: string
  bundleId: string
  windowTitle: string
  url: string | null
  axAvailable: boolean
  screenshot: 'attached' | 'not_granted' | 'disabled' | 'unavailable' | 'secure_input'
  outcome: 'written' | 'deduped' | 'skipped' | 'parked' | 'rejected' | 'too_large' | 'dropped'
  id: string | null
  /** P0-1: AX element text chars (capped), OCR JPEG attached, pixel reason. */
  axTextChars?: number
  ocr?: boolean
  shotReason?: ScreenshotReason
}

export interface PerAppRow {
  key: string
  appName: string
  bundleId: string
  written: number
  deduped: number
  skipped: number
  failed: number
  lastAt: string
}

export interface RuntimeCaptureView {
  root: string
  port: number
  source: string
  /** Read-only view of Runtime `[capture]`; `fromConfig=false` means the OSS default applies. */
  settings: Array<{ key: string; value: string | number | boolean; fromConfig: boolean }>
}

export interface CaptureStatusView {
  started: boolean
  reason: string | null
  degraded: string | null
  startedAt: string | null
  nativeLoaded: boolean
  nativePath: string | null
  permissions: { accessibility: boolean; screenRecording: boolean }
  accessibilityObservers: boolean
  pause: PauseView
  excluded: {
    bundleIds: string[]
    appNames: string[]
    /** Always excluded, not removable: Lens itself (incl. other instances). */
    builtIn: Array<{ label: string; bundleIds: string[]; bundlePaths: string[] }>
  }
  settingsError: string | null
  ingest: {
    written: number
    deduped: number
    skipped: number
    rejected: number
    tooLarge: number
    retries: number
    parked: number
    /** Parked frames evicted at the hard cap (Runtime unreachable for long). */
    parkedEvicted?: number
    /** Withdrawn before delivery (R5): pause, screen lock, or app now excluded. */
    dropped: { paused: number; locked: number; excluded_app: number }
    queued: number
  }
  decisions: Record<string, number>
  recentFrames: RecentFrameView[]
  perApp: PerAppRow[]
  runtime: RuntimeCaptureView
  /** P0-1: frames / text frames / coverage over the last N minutes + no-text verdict. */
  textHealth?: TextHealthView
}

// --- S1-04 diagnostics (built in ./diagnostics.ts) ---

export type CaptureSource = 'ingest' | 'daemon' | 'unknown'

export type ConfigState = 'ok' | 'missing' | 'unreadable' | 'malformed'

export type ValueOrigin = 'config' | 'default' | 'unknown'

export interface OcrConfigView {
  enabled: boolean | null
  policy: string | null
  tier: string | null
  origin: { enabled: ValueOrigin; policy: ValueOrigin; tier: ValueOrigin }
}

export interface RuntimeConfigSummary {
  state: ConfigState
  /** Path of config.toml (home directory shown as ~ in the diagnostics text). */
  path: string
  /** Line-number-only parse error, or a short I/O reason. Never file content. */
  error: string | null
  source: CaptureSource
  sourceOrigin: ValueOrigin
  /** Set when `source` is present but not a value Runtime accepts (Runtime refuses to start). */
  sourceInvalid: boolean
  ocr: OcrConfigView
  /** Values Runtime would reject (it raises on load); listed by key only. */
  invalidKeys: string[]
}

/** Subset of Runtime `GET /health` (unauthenticated, non-personal) we display. */
export interface RuntimeOcrHealth {
  state: string | null
  enabled: boolean | null
  tier: string | null
  worker: string | null
}

export interface CaptureDiagnosticsView {
  generatedAt: string
  config: RuntimeConfigSummary
  runtimeOcr: RuntimeOcrHealth | null
  /** Whether Lens capture can be active given the Runtime source. */
  lensCaptureEffective: boolean
  /** Chinese one-paragraph explanation of what `source` means for Lens. */
  sourceExplanation: string
  ocrLabel: string
  frames: {
    lastAt: string | null
    lastApp: string | null
    lastOutcome: string | null
    accepted: number
    written: number
    recentCount: number
  }
  exclusions: { bundleIds: number; appNames: number; builtIn: number; summary: string }
  /** Copyable, redacted plaintext block. */
  text: string
}

export interface CaptureApi {
  capture: {
    status(): Promise<LensResult<CaptureStatusView>>
    restart(): Promise<LensResult<CaptureStatusView>>
    pause(mode: 'now' | 'untilMidnight'): Promise<LensResult<PauseView>>
    resume(): Promise<LensResult<PauseView>>
    excludeAdd(kind: ExclusionKind, value: string): Promise<LensResult<boolean>>
    excludeRemove(kind: ExclusionKind, value: string): Promise<LensResult<boolean>>
    pickApp(): Promise<LensResult<{ bundleId: string; name: string } | null>>
    requestAccessibility(): Promise<LensResult<boolean>>
    requestScreenRecording(): Promise<LensResult<{ granted: boolean }>>
    openPrivacy(pane: PrivacyPane): Promise<LensResult<boolean>>
    /** S1-04: Runtime source / OCR / permissions summary + redacted copyable text. */
    diagnostics(): Promise<LensResult<CaptureDiagnosticsView>>
  }
}
