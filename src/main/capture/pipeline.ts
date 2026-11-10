import fs from 'node:fs'
import path from 'node:path'
import type { Clock } from './clock'
import { CaptureCoordinator, TRIGGERS, type CaptureTrigger, type CoordinatorTuning, type Decision, type EventSource } from './coordinator'
import { buildFrame, type FrameLocal, type IngestFrame } from './frame'
import { IngestClient, type IngestOutcome } from './ingest-client'
import { loadNative, type LensNative } from './native'
import { matchesBuiltIn, type BuiltInExclusion } from './self-exclusion'
import type { ScreenshotReason } from './textHealth'

/**
 * Assembles the capture loop in the Electron main process:
 *
 *   native.observe ─► CaptureCoordinator ─► buildFrame (addon AX + pixels)
 *                 ─► IngestClient ─► POST /captures/ingest
 *
 * It refuses to start unless the Runtime's config says
 * `[capture] source = "ingest"`: with the daemon still capturing, Lens frames
 * would double every observation. Without Accessibility it starts degraded:
 * app-switch events (NSWorkspace) still produce frames, but they carry no AX
 * text (the Runtime records `ax_unavailable`).
 */

type Scalar = string | number | boolean

/** Scalar keys of `[capture]` in the Runtime config.toml (no TOML dependency). */
export function readRuntimeCaptureConfig(root: string): Record<string, Scalar> {
  let text: string
  try {
    text = fs.readFileSync(path.join(root, 'config.toml'), 'utf8')
  } catch {
    return {}
  }
  const out: Record<string, Scalar> = {}
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      section = trimmed.replace(/\s+/g, '')
      continue
    }
    if (section !== '[capture]') continue
    const m = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/)
    if (!m) continue
    const rawValue = m[2].trim()
    const quoted = rawValue.match(/^"([^"]*)"|^'([^']*)'/)
    if (quoted) {
      out[m[1]] = quoted[1] ?? quoted[2] ?? ''
      continue
    }
    const bare = rawValue.replace(/#.*$/, '').trim()
    if (bare === 'true' || bare === 'false') out[m[1]] = bare === 'true'
    else if (/^-?\d+(\.\d+)?$/.test(bare)) out[m[1]] = Number(bare)
  }
  return out
}

/** Read `[capture] source`; the Runtime default is "daemon". */
export function readCaptureSource(root: string): string {
  const source = readRuntimeCaptureConfig(root).source
  return typeof source === 'string' ? source : 'daemon'
}

export interface LockSource {
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): unknown
  removeListener(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): unknown
}

/** Metadata of one capture attempt that reached ingest. Never pixels or AX text. */
export interface FrameRecord {
  at: string
  trigger: string
  appName: string
  bundleId: string
  windowTitle: string
  url: string | null
  axAvailable: boolean
  screenshot: FrameLocal['screenshot']
  outcome: IngestOutcome['outcome']
  id: string | null
  /** P0-1 text health: AX element text chars (capped), OCR JPEG attached, pixel reason. */
  axTextChars: number
  ocr: boolean
  shotReason: ScreenshotReason
}

export interface StartCaptureOptions {
  appPath: string
  resourcesPath?: string
  root: string
  port: number
  getToken: () => string
  /** Electron's powerMonitor. */
  lockSource: LockSource
  includeScreenshot?: boolean
  isExcluded?: (bundleId: string, appName: string) => boolean
  /** Lens's own pid; its windows and events are never captured. */
  selfPid?: number
  /** Non-removable exclusion of Lens itself (other instances too). */
  builtIn?: BuiltInExclusion
  /** Initial user pause state (the caller keeps it current via coordinator.setPaused). */
  paused?: boolean
  onFrame?: (record: FrameRecord) => void
  /** P0-1: an attempt that produced no frame/pixels because of exclusion, pause or lock. */
  onShotIssue?: (reason: ScreenshotReason, at: number) => void
  tuning?: Partial<CoordinatorTuning>
  /** Test seams. */
  native?: LensNative
  clock?: Clock
  fetchImpl?: typeof fetch
}

export interface CaptureStatus {
  started: boolean
  reason: string | null
  /** Started, but without Accessibility: frames have no AX text. */
  degraded: string | null
  nativePath: string | null
  accessibilityObservers: boolean
  lastOutcomes: string[]
  decisions: Record<string, number>
}

export interface CaptureHandle {
  status(): CaptureStatus
  coordinator: CaptureCoordinator | null
  client: IngestClient | null
  /** User pause: stops new captures and withdraws every undelivered frame. */
  setPaused(paused: boolean): void
  /** Re-check undelivered frames after an exclusion change. */
  revalidate(): void
  stop(): void
}

function nativeEventSource(native: LensNative, onObservers: (ax: boolean) => void): EventSource {
  return {
    subscribe(listener) {
      const r = native.observe((e) =>
        listener({
          eventType: e.eventType,
          bundleId: e.bundleId,
          appName: e.appName,
          bundlePath: e.bundlePath,
          windowTitle: e.windowTitle,
          pid: e.pid
        })
      )
      onObservers(r.accessibilityObservers)
      return () => native.stopObserving()
    }
  }
}

export function startCapture(options: StartCaptureOptions): CaptureHandle {
  const status: CaptureStatus = {
    started: false,
    reason: null,
    degraded: null,
    nativePath: null,
    accessibilityObservers: false,
    lastOutcomes: [],
    decisions: {}
  }
  const inert: CaptureHandle = {
    status: () => ({ ...status }),
    coordinator: null,
    client: null,
    setPaused: () => {},
    revalidate: () => {},
    stop: () => {}
  }

  const runtimeCapture = readRuntimeCaptureConfig(options.root)
  const source = typeof runtimeCapture.source === 'string' ? runtimeCapture.source : 'daemon'
  if (source !== 'ingest') {
    status.reason = `Runtime capture.source is "${source}", not "ingest"`
    return inert
  }
  let native = options.native ?? null
  if (!native) {
    const loaded = loadNative(options.appPath, options.resourcesPath)
    native = loaded.native
    status.nativePath = loaded.path
    if (!native) {
      status.reason = loaded.error
      return inert
    }
  }
  if (!native.permissions().accessibility) {
    status.degraded = 'Accessibility is not granted to Navalia: frames carry no AX text'
  }

  const userExcludedOnly = options.isExcluded ?? (() => false)
  const builtIn = options.builtIn
  const userExcluded = (bundleId: string, appName: string, bundlePath?: string): boolean =>
    (builtIn !== undefined && matchesBuiltIn(builtIn, bundleId, bundlePath)) || userExcludedOnly(bundleId, appName)
  let browsers: ReadonlySet<string> = new Set()
  try {
    browsers = new Set(native.urlHandlers())
  } catch {
    browsers = new Set()
  }
  // The Runtime's [capture] privacy/OCR keys govern what Lens grabs, not just
  // what the Runtime keeps: include_screenshot=false means no pixels are taken.
  const flag = (key: string, fallback: boolean): boolean =>
    typeof runtimeCapture[key] === 'boolean' ? (runtimeCapture[key] as boolean) : fallback
  const posInt = (key: string): number | undefined => {
    const v = runtimeCapture[key]
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
  }
  const includeScreenshot = options.includeScreenshot ?? flag('include_screenshot', true)
  const ocrFallback = flag('enable_ocr_fallback', false)
  const suppressSecureInput = flag('suppress_secure_input', true)
  const screenshotMaxWidth = posInt('screenshot_max_width')
  const jpegQuality = posInt('screenshot_jpeg_quality')
  const screenshotQuality = jpegQuality !== undefined && jpegQuality <= 100 ? jpegQuality : undefined
  let paused = options.paused === true
  let locked = false
  const nowMs = (): number => (options.clock ? options.clock.now() : Date.now())
  const noteShotIssue = (reason: ScreenshotReason, at: number): void => {
    try {
      options.onShotIssue?.(reason, at)
    } catch {
      // Diagnostics never block capture.
    }
  }
  // R5: a frame built before a pause / lock / exclusion must not be delivered
  // after it, including by retries. Checked before every attempt.
  const client = new IngestClient({
    baseUrl: `http://127.0.0.1:${options.port}`,
    getToken: options.getToken,
    fetchImpl: options.fetchImpl,
    gate: (frame) =>
      paused
        ? 'paused'
        : locked
          ? 'locked'
          : userExcluded(frame.window_meta.bundle_id, frame.window_meta.app_name)
            ? 'excluded_app'
            : null
  })
  const coordinator = new CaptureCoordinator({
    clock: options.clock,
    tuning: options.tuning,
    isExcluded: userExcluded,
    onDecision: (d: Decision) => {
      const key = d.reason ? `${d.kind}:${d.reason}` : d.kind
      status.decisions[key] = (status.decisions[key] ?? 0) + 1
      if (d.kind === 'dropped') {
        const issue = DROP_TO_SHOT_REASON[d.reason]
        if (issue) noteShotIssue(issue, d.at)
      }
    },
    capture: async (trigger: CaptureTrigger) => {
      const built = await buildFrame(native!, trigger, {
        includeScreenshot,
        ocrFallback,
        suppressSecureInput,
        screenshotMaxWidth,
        screenshotQuality,
        isExcluded: userExcluded,
        selfPid: options.selfPid,
        browserBundleIds: browsers,
        now: options.clock ? () => options.clock!.now() : undefined
      })
      if (!built.frame) {
        if (built.skipped === 'excluded_app') noteShotIssue('excluded', nowMs())
        return false
      }
      const result = await client.push(built.frame)
      status.lastOutcomes = [...status.lastOutcomes.slice(-19), result.outcome]
      if (result.outcome === 'dropped') {
        const key = `dropped:${result.reason}`
        status.decisions[key] = (status.decisions[key] ?? 0) + 1
        const issue = DROP_TO_SHOT_REASON[result.reason]
        if (issue) noteShotIssue(issue, nowMs())
      }
      options.onFrame?.(record(built.frame, built.local, result))
      return result.outcome === 'written' || result.outcome === 'deduped'
    }
  })
  coordinator.setPaused(paused)

  const onLock = (): void => {
    locked = true
    coordinator.setLocked(true)
    client.revalidate()
  }
  const onUnlock = (): void => {
    locked = false
    coordinator.setLocked(false)
  }
  options.lockSource.on('lock-screen', onLock)
  options.lockSource.on('suspend', onLock)
  options.lockSource.on('unlock-screen', onUnlock)
  options.lockSource.on('resume', onUnlock)

  // Events from Lens itself never enter the coordinator.
  const events = nativeEventSource(native, (ax) => (status.accessibilityObservers = ax))
  const filtered: EventSource = {
    subscribe: (listener) =>
      events.subscribe((e) => {
        if (options.selfPid !== undefined && e.pid === options.selfPid) return
        listener(e)
      })
  }
  const front = native.frontmost()
  const initial =
    front?.bundleId &&
    front.pid !== options.selfPid &&
    !userExcluded(front.bundleId, front.name ?? '', front.bundlePath ?? undefined)
      ? { eventType: TRIGGERS.startup, bundleId: front.bundleId, appName: front.name ?? '' }
      : undefined
  coordinator.start(filtered, initial)
  status.started = true

  return {
    status: () => ({ ...status, decisions: { ...status.decisions } }),
    coordinator,
    client,
    setPaused: (next) => {
      paused = next
      coordinator.setPaused(next)
      if (next) client.revalidate()
    },
    revalidate: () => client.revalidate(),
    stop: () => {
      coordinator.stop()
      options.lockSource.removeListener('lock-screen', onLock)
      options.lockSource.removeListener('suspend', onLock)
      options.lockSource.removeListener('unlock-screen', onUnlock)
      options.lockSource.removeListener('resume', onUnlock)
      status.started = false
    }
  }
}

/** Coordinator / ingest-gate drop reasons that mean "no pixels were taken". */
const DROP_TO_SHOT_REASON: Record<string, ScreenshotReason | undefined> = {
  paused: 'paused',
  locked: 'locked',
  excluded_app: 'excluded'
}

function record(frame: IngestFrame, local: FrameLocal, result: IngestOutcome): FrameRecord {
  return {
    at: frame.timestamp,
    trigger: frame.trigger.event_type,
    appName: frame.window_meta.app_name,
    bundleId: frame.window_meta.bundle_id,
    windowTitle: frame.window_meta.title,
    url: local.url,
    axAvailable: frame.ax_tree !== undefined,
    screenshot: local.screenshot,
    outcome: result.outcome,
    id: 'id' in result ? result.id : null,
    axTextChars: local.axTextChars,
    ocr: local.ocr,
    shotReason: local.shotReason
  }
}
