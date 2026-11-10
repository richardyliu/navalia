// S1-R4-05: the single proactive scheduler. One interval timer, created only while the master switch
// is on (and settings are valid and permission was shown); cleared when it turns off and on quit.
// Ticks are at least PROACTIVE_TICK_MS apart, however often reconcile() is called.
import { PROACTIVE_TICK_MS } from './api'

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface SchedulerDeps {
  tick(): Promise<unknown>
  /** Whether a timer should exist right now. */
  shouldRun(): boolean
  now(): number
  timers: Timers
  intervalMs?: number
  onError?(error: unknown): void
}

export function createProactiveScheduler(deps: SchedulerDeps) {
  const intervalMs = Math.max(PROACTIVE_TICK_MS, deps.intervalMs ?? PROACTIVE_TICK_MS)
  let handle: unknown = null
  let lastRun: number | null = null
  let inFlight: Promise<void> | null = null

  function run(): Promise<void> {
    if (inFlight) return inFlight
    const now = deps.now()
    if (lastRun !== null && now - lastRun < intervalMs) return Promise.resolve()
    lastRun = now
    inFlight = deps
      .tick()
      .then(() => undefined, (e) => deps.onError?.(e))
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  function stop(): void {
    if (handle !== null) deps.timers.clearInterval(handle)
    handle = null
  }

  return {
    /** Start or stop the timer to match shouldRun(). Starting runs one tick right away (rate-limited). */
    reconcile(): Promise<void> {
      if (!deps.shouldRun()) {
        stop()
        return Promise.resolve()
      }
      if (handle === null) {
        handle = deps.timers.setInterval(() => void run(), intervalMs)
        return run()
      }
      return Promise.resolve()
    },
    stop,
    running: (): boolean => handle !== null,
    /** For tests / diagnostics. */
    lastRun: (): number | null => lastRun
  }
}
