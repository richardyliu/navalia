import { systemClock, type Clock, type TimerHandle } from './clock'
import { pickApp, type AppBundleInfo, type OpenDialog } from './app-picker'
import type { CoordinatorTuning } from './coordinator'
import { loadNative, type LensNative } from './native'
import {
  readCaptureSource,
  readRuntimeCaptureConfig,
  startCapture,
  type CaptureHandle,
  type FrameRecord,
  type LockSource
} from './pipeline'
import { lensSelfExclusion, type BuiltInExclusion } from './self-exclusion'
import { CaptureSettingsStore, captureSettingsFile, type ExclusionKind, type PauseState } from './settings'
import type { CaptureStatusView, PerAppRow, RuntimeCaptureView } from './api'
import { TextHealthTracker } from './textHealth'

/**
 * Owns the capture lifecycle for the main process: settings (exclusion,
 * pause), the pipeline, permission requests, and the in-memory metadata the
 * Capture page shows. Frames are never stored here; only their metadata.
 */

export interface CaptureServiceDeps {
  appPath: string
  resourcesPath?: string
  storeRoot: string
  /** Resolved on every (re)start so PERSOME_ROOT / port changes apply. */
  locate: () => { root: string; port: number }
  getToken: (root: string) => string
  lockSource: LockSource
  selfPid?: number
  /** Honour NAVALIA_NATIVE (dev only: pass `!app.isPackaged`). */
  allowNativeEnvOverride?: boolean
  tuning?: Partial<CoordinatorTuning>
  /** Test seams. */
  native?: LensNative | null
  clock?: Clock
  fetchImpl?: typeof fetch
}

const RECENT_LIMIT = 50

/** OSS CaptureConfig defaults (personal-model src/persome/config.py) for keys the config omits. */
const RUNTIME_CAPTURE_DEFAULTS: Record<string, string | number | boolean> = {
  source: 'daemon',
  include_screenshot: true,
  encrypt_screenshots: true,
  buffer_retention_hours: 168,
  screenshot_retention_hours: 24,
  screenshot_max_width: 1920,
  enable_ocr_fallback: false,
  ocr_policy: 'auto',
  pause_on_lock: true,
  suppress_secure_input: true
}

export interface CaptureService {
  settings: CaptureSettingsStore
  status(): CaptureStatusView
  restart(): CaptureStatusView
  stop(): void
  pause(mode: 'now' | 'untilMidnight'): PauseState
  resume(): PauseState
  addExclusion(kind: ExclusionKind, value: string): void
  removeExclusion(kind: ExclusionKind, value: string): void
  pickAndExclude(dialog: OpenDialog): Promise<AppBundleInfo | null>
  requestAccessibility(): boolean
  requestScreenRecording(): Promise<{ granted: boolean }>
  /** For tests: the live pipeline handle. */
  handle(): CaptureHandle | null
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const clock = deps.clock ?? systemClock
  const settings = new CaptureSettingsStore(captureSettingsFile(deps.storeRoot), () => clock.now())
  let native: LensNative | null = deps.native === undefined ? null : deps.native
  let nativePath: string | null = null
  let nativeError: string | null = null
  if (deps.native === undefined) {
    const loaded = loadNative(deps.appPath, deps.resourcesPath, { allowEnvOverride: deps.allowNativeEnvOverride === true })
    native = loaded.native
    nativePath = loaded.path
    nativeError = loaded.error
  }

  let handle: CaptureHandle | null = null
  let lastReason: string | null = null
  let startedAt: string | null = null
  const recent: FrameRecord[] = []
  const perApp = new Map<string, PerAppRow>()
  const textHealth = new TextHealthTracker()
  let pauseTimer: TimerHandle | null = null

  settings.expireIfDue()

  let selfBundle: { bundleId: string | null; bundlePath: string | null } | null = null
  try {
    selfBundle = native && typeof native.selfBundle === 'function' ? native.selfBundle() : null
  } catch {
    selfBundle = null
  }
  const builtIn: BuiltInExclusion = lensSelfExclusion(selfBundle)

  function onFrame(r: FrameRecord): void {
    // Withdrawn frames never reached the Runtime: they are not "frames sent".
    if (r.outcome !== 'dropped') {
      const at = Date.parse(r.at)
      textHealth.record({
        at: Number.isFinite(at) ? at : clock.now(),
        axTextChars: r.axTextChars,
        axAvailable: r.axAvailable,
        screenshot: r.screenshot === 'attached',
        ocr: r.ocr,
        shotReason: r.shotReason
      })
    }
    recent.unshift(r)
    if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
    const key = r.bundleId || r.appName || '(unknown)'
    const row = perApp.get(key) ?? {
      key,
      appName: r.appName,
      bundleId: r.bundleId,
      written: 0,
      deduped: 0,
      skipped: 0,
      failed: 0,
      lastAt: r.at
    }
    if (r.outcome === 'written') row.written++
    else if (r.outcome === 'deduped') row.deduped++
    else if (r.outcome === 'skipped') row.skipped++
    else row.failed++
    row.lastAt = r.at
    row.appName = r.appName || row.appName
    perApp.set(key, row)
  }

  function armPauseExpiry(): void {
    if (pauseTimer !== null) clock.clearTimeout(pauseTimer)
    pauseTimer = null
    const state = settings.pauseState()
    if (state.paused && state.until) {
      const delay = Math.max(0, Date.parse(state.until) - clock.now())
      pauseTimer = clock.setTimeout(() => {
        pauseTimer = null
        settings.expireIfDue() // persists "none" and fires onChange
        applyPause()
      }, delay)
    }
  }

  function applyPause(): void {
    // Settings changed: pause state and/or exclusion lists.
    handle?.setPaused(settings.pauseState().paused)
    handle?.revalidate()
    armPauseExpiry()
  }

  settings.onChange(applyPause)

  function start(): void {
    handle?.stop()
    handle = null
    if (!native) {
      lastReason = nativeError ?? 'native addon unavailable'
      return
    }
    const loc = deps.locate()
    handle = startCapture({
      appPath: deps.appPath,
      resourcesPath: deps.resourcesPath,
      root: loc.root,
      port: loc.port,
      getToken: () => deps.getToken(loc.root),
      lockSource: deps.lockSource,
      isExcluded: (b, a) => settings.isExcluded(b, a),
      selfPid: deps.selfPid,
      builtIn,
      paused: settings.pauseState().paused,
      onFrame,
      onShotIssue: (reason, at) => textHealth.noteIssue(reason, at),
      tuning: deps.tuning,
      native,
      clock: deps.clock,
      fetchImpl: deps.fetchImpl
    })
    const s = handle.status()
    lastReason = s.reason
    startedAt = s.started ? new Date(clock.now()).toISOString() : null
    armPauseExpiry()
  }

  function runtimeView(): RuntimeCaptureView {
    const loc = deps.locate()
    const configured = readRuntimeCaptureConfig(loc.root)
    const keys = Object.keys(RUNTIME_CAPTURE_DEFAULTS)
    return {
      root: loc.root,
      port: loc.port,
      source: readCaptureSource(loc.root),
      settings: keys.map((key) => ({
        key,
        value: key in configured ? configured[key] : RUNTIME_CAPTURE_DEFAULTS[key],
        fromConfig: key in configured
      }))
    }
  }

  start()

  return {
    settings,
    handle: () => handle,
    status(): CaptureStatusView {
      const s = handle?.status()
      const client = handle?.client ?? null
      return {
        started: s?.started === true,
        reason: s?.started ? null : lastReason,
        degraded: s?.started ? s.degraded : null,
        startedAt,
        nativeLoaded: native !== null,
        nativePath,
        permissions: native ? native.permissions() : { accessibility: false, screenRecording: false },
        accessibilityObservers: s?.accessibilityObservers ?? false,
        pause: settings.pauseState(),
        excluded: { ...settings.get().excluded, builtIn: [builtIn] },
        settingsError: settings.loadError,
        ingest: client
          ? { ...client.stats, queued: client.queued }
          : {
              written: 0,
              deduped: 0,
              skipped: 0,
              rejected: 0,
              tooLarge: 0,
              retries: 0,
              parked: 0,
              dropped: { paused: 0, locked: 0, excluded_app: 0 },
              queued: 0
            },
        decisions: s?.decisions ?? {},
        recentFrames: recent.slice(),
        perApp: [...perApp.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
        runtime: runtimeView(),
        textHealth: textHealth.view(clock.now())
      }
    },
    restart() {
      start()
      return this.status()
    },
    stop() {
      handle?.stop()
      handle = null
      if (pauseTimer !== null) clock.clearTimeout(pauseTimer)
      pauseTimer = null
    },
    pause(mode) {
      return mode === 'now' ? settings.pauseNow() : settings.pauseUntilNextMidnight()
    },
    resume() {
      return settings.resume()
    },
    addExclusion(kind, value) {
      settings.addExclusion(kind, value)
    },
    removeExclusion(kind, value) {
      settings.removeExclusion(kind, value)
    },
    async pickAndExclude(dialog) {
      const info = await pickApp(dialog)
      if (info) settings.addExclusion('bundleId', info.bundleId)
      return info
    },
    requestAccessibility() {
      return native ? native.requestAccessibility() : false
    },
    async requestScreenRecording() {
      if (!native) return { granted: false }
      // Explicit user action only: this is the call that registers Lens in TCC.
      const granted = native.requestScreenRecording()
      return { granted }
    }
  }
}
