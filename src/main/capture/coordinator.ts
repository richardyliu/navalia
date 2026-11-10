import { systemClock, type Clock, type TimerHandle } from './clock'

/**
 * Decides *when* to capture. With Runtime `capture.source = "ingest"` the
 * daemon's EventDispatcher, debounce and heartbeat are never constructed, so
 * every one of these guards is the shell's job. Getting them wrong is silent:
 * a frame per keystroke still returns HTTP 200 while it inflates disk, FTS and
 * timeline LLM calls.
 *
 * Semantics follow the OSS EventDispatcher (personal-model
 * src/persome/capture/event_dispatcher.py) with the Lens timing contract:
 *   - AXTitleChanged is ignored (too noisy, covered by focus/app events).
 *   - Event-family dedup (1 s): repeated events of one family on one surface
 *     collapse; Activation and FocusedWindowChanged share the
 *     "surface-transition" family; Focus after Activation replaces it,
 *     Activation after Focus is dropped, same-type transitions pass.
 *   - Trailing debounce: urgent events (startup, app activation, focused-window
 *     change, click) 500 ms; everything else (value change, text input) 3 s.
 *     The last trigger wins; a normal event never displaces or delays a pending
 *     urgent one. A pending trigger is flushed no later than maxPendingMs after
 *     the first event of the burst, so continuous typing still yields frames.
 *   - Minimum gap (2 s) and same-surface dedup (5 s) apply to non-focus-change
 *     triggers. Unlike the daemon (which drops), the trigger is deferred to the
 *     end of the window so the final state of a burst is still captured.
 *   - Heartbeat: a capture after 10 min without one.
 *   - Lock / pause: no events are accepted, pending work and the heartbeat are
 *     cancelled until unlocked / resumed.
 *   - Exclusion is checked on the event, before any capture call.
 *   - Only one capture is in flight; a rejected capture rolls back its
 *     reservation so it does not suppress the next one.
 */

export const TRIGGERS = {
  startup: 'startup',
  applicationActivated: 'AXApplicationActivated',
  focusedWindowChanged: 'AXFocusedWindowChanged',
  valueChanged: 'AXValueChanged',
  titleChanged: 'AXTitleChanged',
  mouseClick: 'UserMouseClick',
  textInput: 'UserTextInput',
  heartbeat: 'heartbeat'
} as const

const SKIP_EVENTS = new Set<string>([TRIGGERS.titleChanged])
const URGENT_EVENTS = new Set<string>([
  TRIGGERS.startup,
  TRIGGERS.applicationActivated,
  TRIGGERS.focusedWindowChanged,
  TRIGGERS.mouseClick
])
const FOCUS_TRANSITION_EVENTS = new Set<string>([
  TRIGGERS.startup,
  TRIGGERS.applicationActivated,
  TRIGGERS.focusedWindowChanged
])

export interface CoordinatorTuning {
  debounceMs: number
  urgentDebounceMs: number
  minGapMs: number
  dedupIntervalMs: number
  sameWindowDedupMs: number
  heartbeatMs: number
  maxPendingMs: number
}

/**
 * Lens spec values (DESIGN §3.2 / AGENT_PROMPT §3.1). These equal the OSS
 * daemon's CaptureConfig defaults.
 */
export const TUNING_SPEC: Readonly<CoordinatorTuning> = Object.freeze({
  debounceMs: 3_000,
  urgentDebounceMs: 500,
  minGapMs: 2_000,
  dedupIntervalMs: 1_000,
  sameWindowDedupMs: 5_000,
  heartbeatMs: 10 * 60_000,
  maxPendingMs: 30_000
})

/**
 * Alternate timing preset (DEVIATIONS D10). Only the numbers are mapped. Its 60 s
 * `dedupWindowMs` / 2 min `sameWindowDedupMs` gate on a content fingerprint,
 * which this coordinator does not implement: here sameWindowDedupMs bounds any
 * capture of the same surface, and the 1 s event-family window is kept.
 */
export const TUNING_PRODUCT: Readonly<CoordinatorTuning> = Object.freeze({
  debounceMs: 3_000,
  urgentDebounceMs: 500,
  minGapMs: 30_000,
  dedupIntervalMs: 1_000,
  sameWindowDedupMs: 2 * 60_000,
  heartbeatMs: 5 * 60_000,
  maxPendingMs: 30_000
})

/** The preset the app runs with. Switching presets is this one line. */
export const ACTIVE_TUNING: Readonly<CoordinatorTuning> = TUNING_SPEC

export interface CaptureEvent {
  eventType: string
  bundleId?: string
  appName?: string
  /** App bundle path, when the event source knows it (built-in self exclusion). */
  bundlePath?: string
  windowTitle?: string
  pid?: number
  details?: Record<string, unknown>
}

/** Shape the Runtime stores as `trigger` (event_dispatcher.py). */
export interface CaptureTrigger {
  event_type: string
  app_name: string
  bundle_id: string
  window_title: string
  details?: Record<string, unknown>
}

export type DecisionKind = 'captured' | 'rejected' | 'dropped' | 'deferred' | 'failed'

export interface Decision {
  kind: DecisionKind
  reason: string
  eventType: string
  at: number
}

export interface EventSource {
  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: (event: CaptureEvent) => void): () => void
}

export interface CoordinatorDeps {
  /** Performs one capture. Resolve false (or throw) when no frame was produced. */
  capture: (trigger: CaptureTrigger) => Promise<boolean>
  clock?: Clock
  isExcluded?: (bundleId: string, appName: string, bundlePath?: string) => boolean
  onDecision?: (decision: Decision) => void
  tuning?: Partial<CoordinatorTuning>
}

type SurfaceKey = string

function surfaceKey(bundleId: string, appName: string): SurfaceKey {
  if (bundleId) return `bundle\u0000${bundleId}`
  if (appName) return `app\u0000${appName}`
  return 'unknown\u0000'
}

interface Pending {
  trigger: CaptureTrigger
  urgent: boolean
  since: number
}

export class CaptureCoordinator {
  readonly tuning: CoordinatorTuning
  private readonly clock: Clock
  private readonly deps: CoordinatorDeps

  private running = false
  private locked = false
  private paused = false
  private inFlight = false

  private pending: Pending | null = null
  private pendingTimer: TimerHandle | null = null
  private heartbeatTimer: TimerHandle | null = null

  private lastEvent = new Map<string, { at: number; eventType: string }>()
  private lastCaptureAt = Number.NEGATIVE_INFINITY
  private lastCaptureSurface: SurfaceKey | null = null
  private unsubscribe: (() => void) | null = null

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    this.tuning = { ...ACTIVE_TUNING, ...deps.tuning }
  }

  get state(): {
    running: boolean
    locked: boolean
    paused: boolean
    inFlight: boolean
    pending: string | null
  } {
    return {
      running: this.running,
      locked: this.locked,
      paused: this.paused,
      inFlight: this.inFlight,
      pending: this.pending?.trigger.event_type ?? null
    }
  }

  start(source?: EventSource, initial?: CaptureEvent): void {
    if (this.running) return
    this.running = true
    if (source) this.unsubscribe = source.subscribe((event) => this.onEvent(event))
    if (initial) this.onEvent(initial)
    this.armHeartbeat()
  }

  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.cancelPending()
    this.clearHeartbeat()
  }

  /** Screen lock / sleep. While locked nothing is captured. */
  setLocked(locked: boolean): void {
    if (this.locked === locked) return
    this.locked = locked
    this.applyGate()
  }

  /** User pause (E1.6 persists it; the coordinator only enforces it). */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    this.applyGate()
  }

  onEvent(event: CaptureEvent): void {
    const eventType = String(event.eventType ?? '')
    if (!this.running) return
    if (!eventType || SKIP_EVENTS.has(eventType)) return
    if (this.locked || this.paused) {
      this.note('dropped', this.locked ? 'locked' : 'paused', eventType)
      return
    }
    const bundleId = String(event.bundleId ?? '')
    const appName = String(event.appName ?? '')
    const now = this.clock.now()

    if (this.deps.isExcluded?.(bundleId, appName, event.bundlePath)) {
      // The foreground is now an excluded app: a pending capture would sample
      // it, so it is cancelled too.
      if (FOCUS_TRANSITION_EVENTS.has(eventType)) this.cancelPending()
      this.note('dropped', 'excluded_app', eventType)
      return
    }

    const surface = surfaceKey(bundleId, appName)
    const isTransition = FOCUS_TRANSITION_EVENTS.has(eventType)
    const family = isTransition ? 'surface-transition' : eventType
    const dedupKey = `${family}\u0001${surface}`
    const last = this.lastEvent.get(dedupKey)
    if (last && now - last.at < this.tuning.dedupIntervalMs) {
      // As in the daemon: a repeat of a non-transition family is redundant;
      // Activation right after Focus is redundant; Focus after Activation (the
      // more specific end of one transition) and same-type transitions (e.g.
      // switching between two windows of one app) pass.
      const activationAfterFocus =
        eventType === TRIGGERS.applicationActivated && last.eventType !== eventType
      if (!isTransition || activationAfterFocus) {
        this.note('dropped', 'event_dedup', eventType)
        return
      }
    }
    this.lastEvent.set(dedupKey, { at: now, eventType })
    if (this.lastEvent.size >= 256) this.pruneEvents(now)

    const trigger: CaptureTrigger = {
      event_type: eventType,
      app_name: appName,
      bundle_id: bundleId,
      window_title: String(event.windowTitle ?? '')
    }
    if (event.details && Object.keys(event.details).length > 0) trigger.details = event.details
    const urgent = URGENT_EVENTS.has(eventType)

    if (this.pending) {
      if (this.pending.urgent && !urgent) {
        // Keep the surface change and its short deadline.
        this.note('dropped', 'pending_urgent', eventType)
        return
      }
      this.pending = { trigger, urgent, since: this.pending.since }
    } else {
      this.pending = { trigger, urgent, since: now }
    }
    const debounce = urgent ? this.tuning.urgentDebounceMs : this.tuning.debounceMs
    const remaining = Math.max(0, this.tuning.maxPendingMs - (now - this.pending.since))
    this.schedule(Math.min(debounce, remaining))
  }

  private applyGate(): void {
    if (this.locked || this.paused) {
      this.cancelPending()
      this.clearHeartbeat()
    } else if (this.running) {
      this.armHeartbeat()
    }
  }

  private pruneEvents(now: number): void {
    for (const [key, value] of this.lastEvent) {
      if (now - value.at >= this.tuning.dedupIntervalMs) this.lastEvent.delete(key)
    }
  }

  private schedule(delayMs: number): void {
    if (this.pendingTimer !== null) this.clock.clearTimeout(this.pendingTimer)
    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = null
      void this.flush()
    }, Math.max(0, delayMs))
  }

  private cancelPending(): void {
    if (this.pendingTimer !== null) this.clock.clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    this.pending = null
  }

  private async flush(): Promise<void> {
    if (!this.running || this.locked || this.paused || !this.pending) return
    if (this.inFlight) return // re-scheduled when the in-flight capture settles

    const { trigger } = this.pending
    const now = this.clock.now()
    const isFocusChange = FOCUS_TRANSITION_EVENTS.has(trigger.event_type)
    const surface = surfaceKey(trigger.bundle_id, trigger.app_name)
    const isHeartbeat = trigger.event_type === TRIGGERS.heartbeat

    if (!isFocusChange && !isHeartbeat) {
      const sinceLast = now - this.lastCaptureAt
      let wait = 0
      let reason = ''
      if (sinceLast < this.tuning.minGapMs) {
        wait = this.tuning.minGapMs - sinceLast
        reason = 'min_gap'
      }
      if (surface === this.lastCaptureSurface && sinceLast < this.tuning.sameWindowDedupMs) {
        const sameWindowWait = this.tuning.sameWindowDedupMs - sinceLast
        if (sameWindowWait > wait) {
          wait = sameWindowWait
          reason = 'same_window'
        }
      }
      if (wait > 0) {
        this.note('deferred', reason, trigger.event_type)
        this.schedule(wait)
        return
      }
    }

    this.pending = null
    const previousAt = this.lastCaptureAt
    const previousSurface = this.lastCaptureSurface
    this.lastCaptureAt = now
    this.lastCaptureSurface = isHeartbeat ? previousSurface : surface
    this.inFlight = true
    let accepted = false
    try {
      accepted = (await this.deps.capture(trigger)) === true
      this.note(accepted ? 'captured' : 'rejected', accepted ? '' : 'no_frame', trigger.event_type)
    } catch {
      // Never surface frame contents or let a timer become an unhandled rejection.
      this.note('failed', 'capture_threw', trigger.event_type)
    } finally {
      this.inFlight = false
      if (!accepted && this.lastCaptureAt === now) {
        this.lastCaptureAt = previousAt
        this.lastCaptureSurface = previousSurface
      }
      if (this.running && !this.locked && !this.paused) {
        this.armHeartbeat()
        // An event may have arrived while the capture was in flight.
        const next = this.peekPending()
        if (next) {
          const elapsed = this.clock.now() - next.since
          const debounce = next.urgent ? this.tuning.urgentDebounceMs : this.tuning.debounceMs
          this.schedule(Math.min(debounce, Math.max(0, this.tuning.maxPendingMs - elapsed)))
        }
      }
    }
  }

  private peekPending(): Pending | null {
    return this.pending
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.clock.clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private armHeartbeat(): void {
    this.clearHeartbeat()
    if (!this.running || this.locked || this.paused) return
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeatTimer = null
      // A real event already waiting keeps its own trigger metadata.
      if (!this.pending) {
        this.pending = {
          trigger: { event_type: TRIGGERS.heartbeat, app_name: '', bundle_id: '', window_title: '' },
          urgent: true,
          since: this.clock.now()
        }
      }
      this.schedule(0)
    }, this.tuning.heartbeatMs)
  }

  private note(kind: DecisionKind, reason: string, eventType: string): void {
    try {
      this.deps.onDecision?.({ kind, reason, eventType, at: this.clock.now() })
    } catch {
      // Diagnostics never block capture.
    }
  }
}
