import type { CaptureTrigger } from './coordinator'
import type { AXTreeOptions, LensNative } from './native'
import type { ScreenshotReason } from './textHealth'

/**
 * Body of POST /captures/ingest (personal-model api/models.py
 * CaptureIngestBody). Field names are the Runtime's, not ours.
 */
export interface IngestFrame {
  timestamp: string
  trigger: CaptureTrigger
  window_meta: { app_name: string; title: string; bundle_id: string }
  ax_tree?: Record<string, unknown>
  ax_metadata?: Record<string, unknown>
  screenshot?: { image_base64: string; mime_type: string; width: number; height: number }
  /**
   * Focused-window JPEG for the Runtime's OCR fallback (CaptureIngestBody
   * `ocr_jpeg_b64`). The ingest path OCRs only this field, never `screenshot`
   * (scheduler.py `_ingest_ocr_jpeg_provider`), so without it OCR never runs.
   */
  ocr_jpeg_b64?: string
}

/** CaptureIngestBody bound on any base64 image field (api/models.py MAX_CAPTURE_IMAGE_B64_CHARS). */
export const MAX_IMAGE_B64_CHARS = 8 * 1024 * 1024
/**
 * Below this many characters of element text in the frontmost app the window
 * counts as AX-poor and the OCR JPEG is attached. The Runtime makes the final
 * call (S1 `has_ax_content`); this only has to avoid withholding pixels the
 * Runtime would want, so it errs towards sending.
 */
export const AX_POOR_MAX_CHARS = 64

/** What the daemon passes to mac-ax-helper (ax_capture.py, capture.ax_depth=100). */
export const RECORDING_AX_OPTIONS: Readonly<AXTreeOptions> = Object.freeze({
  focusedWindowOnly: true,
  maxDepth: 100,
  timeout: 3
})

export interface BuildFrameOptions {
  includeScreenshot: boolean
  /** Lens's own pid: its windows are never captured. */
  selfPid?: number
  /** Bundle ids registered as http(s) handlers; only these are asked for a URL. */
  browserBundleIds?: ReadonlySet<string>
  screenshotMaxWidth?: number
  screenshotQuality?: number
  isExcluded?: (bundleId: string, appName: string, bundlePath?: string) => boolean
  /** Runtime `capture.enable_ocr_fallback`: attach `ocr_jpeg_b64` for AX-poor windows. */
  ocrFallback?: boolean
  /**
   * Runtime `capture.suppress_secure_input` (default true): while a secure text
   * field is focused no pixels are grabbed at all. The Runtime would drop them
   * (screen_state.is_secure_input_active); Lens does not take them in the first place.
   */
  suppressSecureInput?: boolean
  now?: () => number
}

/** Lens-local facts about a frame that are not part of the ingest body. */
export interface FrameLocal {
  /** Page URL from AXURL when the frontmost app is a browser (not sent: the Runtime derives URL from AX). */
  url: string | null
  screenshot: 'attached' | 'not_granted' | 'disabled' | 'unavailable' | 'secure_input'
  /** An OCR JPEG (`ocr_jpeg_b64`) went with the frame. */
  ocr: boolean
  /** P0-1 diagnostics: element text chars in the frontmost app (capped near AX_POOR_MAX_CHARS; 0 = no AX text). */
  axTextChars: number
  /** P0-1 diagnostics: why pixels did or did not go out (for stored screenshot and OCR alike). */
  shotReason: ScreenshotReason
}

export type BuildFrameResult =
  | { frame: IngestFrame; local: FrameLocal; skipped?: undefined }
  | { frame: null; local?: undefined; skipped: 'no_frontmost' | 'excluded_app' | 'self' }

function frontApp(tree: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const apps = Array.isArray(tree?.apps) ? (tree!.apps as Record<string, unknown>[]) : []
  return apps.find((a) => a?.is_frontmost === true) ?? apps[0]
}

function focusedWindowTitle(app: Record<string, unknown> | undefined): string {
  const windows = Array.isArray(app?.windows) ? (app!.windows as Record<string, unknown>[]) : []
  const w = windows.find((x) => x?.focused === true) ?? windows[0]
  return typeof w?.title === 'string' ? w.title : ''
}

/**
 * Same predicate as the Runtime's screen_state.is_secure_input_active: the
 * frontmost app's focused element is a secure text field.
 */
export function isSecureInputFocused(tree: Record<string, unknown> | undefined): boolean {
  const fe = frontApp(tree)?.focused_element as Record<string, unknown> | undefined
  if (!fe || typeof fe !== 'object') return false
  const subrole = typeof fe.subrole === 'string' ? fe.subrole.trim() : ''
  const role = typeof fe.role === 'string' ? fe.role.trim() : ''
  if (subrole === 'AXSecureTextField') return true
  return role === 'AXTextField' && fe.value === '[REDACTED]'
}

/** Characters of element text (title/value/description) under the frontmost app's windows. */
export function axTextChars(tree: Record<string, unknown> | undefined): number {
  const app = frontApp(tree)
  if (!app) return 0
  let total = 0
  const stack: unknown[] = Array.isArray(app.windows)
    ? (app.windows as Record<string, unknown>[]).flatMap((w) => (Array.isArray(w?.elements) ? (w.elements as unknown[]) : []))
    : []
  let visited = 0
  while (stack.length > 0 && visited < 200_000) {
    visited++
    const node = stack.pop() as Record<string, unknown> | null
    if (!node || typeof node !== 'object') continue
    for (const key of ['title', 'value', 'description']) {
      const v = node[key]
      if (typeof v === 'string') total += v.trim().length
    }
    if (total >= AX_POOR_MAX_CHARS) return total
    if (Array.isArray(node.children)) stack.push(...(node.children as unknown[]))
  }
  return total
}

/**
 * Sample the frontmost surface. Exclusion is checked against the actual
 * frontmost app before any AX or pixel read, and again against the app the AX
 * snapshot actually describes (the foreground can move in between).
 * Screenshot bytes stay in memory; they are only base64-encoded into the frame.
 */
export async function buildFrame(
  native: LensNative,
  trigger: CaptureTrigger,
  options: BuildFrameOptions
): Promise<BuildFrameResult> {
  const isExcluded = options.isExcluded ?? (() => false)
  const now = options.now ?? Date.now
  const front = native.frontmost()
  if (!front) return { frame: null, skipped: 'no_frontmost' }
  if (options.selfPid !== undefined && front.pid === options.selfPid) return { frame: null, skipped: 'self' }
  const bundleId = front.bundleId ?? ''
  const appName = front.name ?? ''
  if (isExcluded(bundleId, appName, front.bundlePath ?? undefined)) return { frame: null, skipped: 'excluded_app' }

  const timestamp = new Date(now()).toISOString()
  let axTree: Record<string, unknown> | undefined
  try {
    axTree = JSON.parse(await native.axTree(RECORDING_AX_OPTIONS)) as Record<string, unknown>
  } catch {
    axTree = undefined // AX unavailable: Runtime records ax_unavailable
  }
  const axApp = frontApp(axTree)
  if (axApp && isExcluded(String(axApp.bundle_id ?? ''), String(axApp.name ?? ''))) {
    return { frame: null, skipped: 'excluded_app' }
  }

  const frame: IngestFrame = {
    timestamp,
    trigger,
    window_meta: {
      app_name: appName,
      title: front.windowTitle ?? focusedWindowTitle(axApp),
      bundle_id: bundleId
    }
  }
  if (axTree) {
    frame.ax_tree = axTree
    frame.ax_metadata = {
      mode: 'frontmost',
      depth: RECORDING_AX_OPTIONS.maxDepth,
      platform: 'macos',
      raw: false,
      producer: 'navalia-native'
    }
  }

  const textChars = axTextChars(axTree)
  const local: FrameLocal = {
    url: null,
    screenshot: 'disabled',
    ocr: false,
    axTextChars: textChars,
    shotReason: options.includeScreenshot ? 'disabled' : options.ocrFallback === true ? 'not_needed' : 'disabled'
  }
  if (bundleId && options.browserBundleIds?.has(bundleId)) {
    try {
      local.url = native.browserUrl(front.pid)
    } catch {
      local.url = null
    }
  }

  const secure = options.suppressSecureInput !== false && isSecureInputFocused(axTree)
  const wantOcr = options.ocrFallback === true && textChars < AX_POOR_MAX_CHARS
  if (secure) {
    // CAP-07: no pixels of a focused password field, for storage or for OCR.
    if (options.includeScreenshot || wantOcr) {
      local.screenshot = 'secure_input'
      local.shotReason = 'secure_input'
    }
  } else if (options.includeScreenshot || wantOcr) {
    if (!native.permissions().screenRecording) {
      local.screenshot = options.includeScreenshot ? 'not_granted' : 'disabled'
      local.shotReason = 'screen_recording_denied'
    } else {
      // Only the vetted app's frontmost window. If that grab fails the frame
      // goes out with AX text only; never fall back to a whole-display grab,
      // which would include windows of excluded apps behind it.
      const shot = await native
        .screenshot({
          scope: 'frontmostWindow',
          pid: front.pid,
          maxWidth: options.screenshotMaxWidth ?? 1920,
          quality: options.screenshotQuality ?? 80
        })
        .catch(() => null)
      if (shot) {
        const image = shot.data.toString('base64')
        if (options.includeScreenshot && image.length <= MAX_IMAGE_B64_CHARS) {
          frame.screenshot = {
            image_base64: image,
            mime_type: shot.mimeType,
            width: shot.width,
            height: shot.height
          }
          local.screenshot = 'attached'
        } else if (options.includeScreenshot) {
          local.screenshot = 'unavailable'
        }
        local.shotReason = image.length <= MAX_IMAGE_B64_CHARS ? 'attached' : 'too_large'
        // The OCR copy is the same JPEG; skip it when the body would approach the 12 MiB cap.
        if (wantOcr && image.length <= MAX_IMAGE_B64_CHARS && (frame.screenshot ? image.length * 2 : image.length) <= 10 * 1024 * 1024) {
          frame.ocr_jpeg_b64 = image
          local.ocr = true
        }
      } else {
        if (options.includeScreenshot) local.screenshot = 'unavailable'
        local.shotReason = 'sck_error'
      }
    }
  }
  return { frame, local }
}
