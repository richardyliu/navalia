/**
 * P0-1 capture text health. Counts, over a recent time window, the frames Lens
 * actually pushed to ingest and how many of them can yield text in the
 * Runtime (AX text, or an OCR JPEG the Runtime OCRs). When frames flow but
 * none carry text, the usual cause is lost TCC grants (e.g. after an ad-hoc
 * re-sign changed the app's cdhash), and the Capture page shows a red banner.
 *
 * Pure except for the small in-memory tracker. Never holds pixels, AX text,
 * titles or URLs: only per-frame booleans, a char count and a reason enum.
 */

import { tr } from '../../shared/i18n'

/**
 * Why a frame went out without pixels (or that it had them). Frame-level
 * reasons come from buildFrame; `excluded` / `paused` / `locked` come from
 * the coordinator or ingest gate (no frame was built or delivered at all).
 */
export type ScreenshotReason =
  | 'attached'
  /** include_screenshot=false and the OCR fallback is off. */
  | 'disabled'
  /** OCR fallback on, include_screenshot=false, and the window had enough AX text. */
  | 'not_needed'
  /** CGPreflightScreenCaptureAccess is false: no Screen Recording grant. */
  | 'screen_recording_denied'
  /** Granted, but ScreenCaptureKit and the CGWindowList fallback both returned nothing (or threw). */
  | 'sck_error'
  /** JPEG exceeded the ingest image bound. */
  | 'too_large'
  /** A secure text field was focused: pixels are never grabbed. */
  | 'secure_input'
  | 'excluded'
  | 'paused'
  | 'locked'

export const SCREENSHOT_REASON_LABEL: Record<ScreenshotReason, string> = {
  get attached() { return tr('Screenshot attached', '已附带截图') },
  get disabled() { return tr('Screenshots and OCR fallback are both off', '截图与 OCR 兜底都已关闭') },
  get not_needed() { return tr('Enough AX text; no OCR screenshot needed', 'AX 文本充足，不需要 OCR 截图') },
  get screen_recording_denied() { return tr('No Screen Recording permission', '没有屏幕录制权限') },
  get sck_error() { return tr('ScreenCaptureKit / CGWindowList screenshot failed', 'ScreenCaptureKit / CGWindowList 截图失败') },
  get too_large() { return tr('Screenshot exceeds the ingest size limit', '截图超过 ingest 大小上限') },
  get secure_input() { return tr('Password field focused; no screenshot', '密码框聚焦，不截图') },
  get excluded() { return tr('App excluded', '应用已排除') },
  get paused() { return tr('Capture paused', '采集已暂停') },
  get locked() { return tr('Screen locked', '屏幕已锁定') }
}

/** One pushed frame, reduced to what text health needs. */
export interface TextSample {
  /** Epoch ms. */
  at: number
  /** Element text characters in the frontmost app's AX tree (0 when AX unavailable). */
  axTextChars: number
  axAvailable: boolean
  /** A stored screenshot went with the frame. */
  screenshot: boolean
  /** An OCR JPEG (`ocr_jpeg_b64`) went with the frame. */
  ocr: boolean
  shotReason: ScreenshotReason
}

export type TextHealthVerdict = 'idle' | 'no_text' | 'partial' | 'ok'

export interface TextHealthView {
  windowMinutes: number
  frames: number
  /** Frames the Runtime can get text from: AX text or an OCR JPEG. */
  textFrames: number
  axTextFrames: number
  ocrFrames: number
  /** Frames carrying any pixels (stored screenshot or OCR JPEG). */
  screenshotFrames: number
  /** textFrames / frames, 0..1; null when there were no frames. */
  coverage: number | null
  verdict: TextHealthVerdict
  /** Red banner copy (only for `no_text`). */
  banner: string | null
  /** Most recent reason a frame/attempt went without pixels, if any. */
  lastShotIssue: { reason: ScreenshotReason; label: string; at: string } | null
}

export function noTextBanner(): string {
  return tr(
    'Capture is sending frames but no text. TCC may have broken after a repackage: re-grant Accessibility / Screen Recording, then restart Navalia.',
    '采集在发帧，但没有文本。TCC 可能在重新打包后失效——请重新授权 Accessibility / Screen Recording，然后重启 Navalia。'
  )
}

/** Below this coverage (with some text) the verdict is `partial`. */
export const PARTIAL_COVERAGE_BELOW = 0.5
export const DEFAULT_WINDOW_MINUTES = 30

export function computeTextHealth(
  samples: readonly TextSample[],
  now: number,
  windowMinutes: number = DEFAULT_WINDOW_MINUTES,
  lastShotIssue: { reason: ScreenshotReason; at: number } | null = null
): TextHealthView {
  const since = now - windowMinutes * 60_000
  let frames = 0
  let textFrames = 0
  let axTextFrames = 0
  let ocrFrames = 0
  let screenshotFrames = 0
  for (const s of samples) {
    if (s.at < since || s.at > now) continue
    frames++
    const ax = s.axAvailable && s.axTextChars > 0
    if (ax) axTextFrames++
    if (s.ocr) ocrFrames++
    if (ax || s.ocr) textFrames++
    if (s.screenshot || s.ocr) screenshotFrames++
  }
  const coverage = frames === 0 ? null : textFrames / frames
  const verdict: TextHealthVerdict =
    frames === 0 ? 'idle' : textFrames === 0 ? 'no_text' : coverage! < PARTIAL_COVERAGE_BELOW ? 'partial' : 'ok'
  return {
    windowMinutes,
    frames,
    textFrames,
    axTextFrames,
    ocrFrames,
    screenshotFrames,
    coverage,
    verdict,
    banner: verdict === 'no_text' ? noTextBanner() : null,
    lastShotIssue: lastShotIssue
      ? {
          reason: lastShotIssue.reason,
          label: SCREENSHOT_REASON_LABEL[lastShotIssue.reason],
          at: new Date(lastShotIssue.at).toISOString()
        }
      : null
  }
}

/** Reasons that are worth surfacing as "why no pixels" (everything but a successful/irrelevant case). */
export function isShotIssue(reason: ScreenshotReason): boolean {
  return reason !== 'attached' && reason !== 'not_needed'
}

const MAX_SAMPLES = 5000

/** In-memory, bounded store of text samples + the latest screenshot issue. */
export class TextHealthTracker {
  private samples: TextSample[] = []
  private issue: { reason: ScreenshotReason; at: number } | null = null

  record(sample: TextSample): void {
    this.samples.push(sample)
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES)
    if (isShotIssue(sample.shotReason)) this.issue = { reason: sample.shotReason, at: sample.at }
  }

  /** An attempt that never became a frame (exclusion / pause / lock). */
  noteIssue(reason: ScreenshotReason, at: number): void {
    if (isShotIssue(reason)) this.issue = { reason, at }
  }

  view(now: number, windowMinutes: number = DEFAULT_WINDOW_MINUTES): TextHealthView {
    return computeTextHealth(this.samples, now, windowMinutes, this.issue)
  }
}
