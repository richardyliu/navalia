// S1-R4-06 (DECISIONS-ROUND3 X2): opt-in periodic scan of the local subscription folder.
//
// The scheduler owns at most ONE pending timer. It is armed only while the subscription is
// enabled, a folder is chosen and `autoScan.enabled` is true in `subscription.json` (default off;
// corrupt config → off). Each tick calls the very same `subscription.refresh()` as the 「刷新」
// button (offline signature verification, sha256 ledger dedupe, top level only, no network), then
// re-reads the config and re-arms. `sync()` is called after every settings change; `stop()` on
// app quit. A tick that finds the subscription switched off arms nothing.
//
// Not a file watcher; one-shot timers re-armed after each scan (a slow scan never overlaps the next).
import { redactForDisplay } from '../import/redact'
import type { SubscriptionAutoScanRun, SubscriptionStatus } from './api'
import type { Subscription } from './subscription'

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms)
    // Never keep the process alive just for a scan.
    ;(h as { unref?: () => void }).unref?.()
    return h
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export interface SubscriptionScheduler {
  /** Re-read the config and arm / re-arm / clear the timer accordingly. */
  sync(): void
  /** Clear the timer for good (app quit). Further sync() calls do nothing. */
  stop(): void
  /** Status with this session's last automatic run and the next planned time. */
  decorate(status: SubscriptionStatus): SubscriptionStatus
  /** True while a timer is pending. */
  armed(): boolean
  /** Test hook: run one tick now (same code path as the timer). */
  tick(): Promise<void>
}

export function createSubscriptionScheduler(deps: { subscription: Subscription; timers?: Timers; now?: () => Date }): SubscriptionScheduler {
  const timers = deps.timers ?? realTimers
  const now = deps.now ?? (() => new Date())
  let handle: unknown = null
  let armedMs: number | null = null
  let nextAt: string | null = null
  let lastRun: SubscriptionAutoScanRun | null = null
  let stopped = false
  let running = false

  /** Interval in ms when a periodic scan is wanted right now, else null. */
  function plan(): number | null {
    let s: SubscriptionStatus
    try {
      s = deps.subscription.status()
    } catch {
      return null
    }
    if (!s.enabled || !s.folder || !s.autoScan.enabled) return null
    return s.autoScan.intervalMinutes * 60_000
  }

  function clear(): void {
    if (handle !== null) timers.clear(handle)
    handle = null
    armedMs = null
    nextAt = null
  }

  function sync(): void {
    if (stopped || running) return
    const ms = plan()
    if (ms === null) return clear()
    if (handle !== null && ms === armedMs) return
    clear()
    armedMs = ms
    nextAt = new Date(now().getTime() + ms).toISOString()
    handle = timers.set(() => void tick(), ms)
  }

  async function tick(): Promise<void> {
    handle = null
    armedMs = null
    nextAt = null
    if (stopped || running) return
    // Re-check at fire time: switched off since arming → no scan, no new timer.
    if (plan() === null) return
    running = true
    const at = now().toISOString()
    try {
      const r = await deps.subscription.refresh()
      lastRun = { at, ok: true, counts: r.counts, error: null }
    } catch (e) {
      lastRun = { at, ok: false, counts: null, error: redactForDisplay(e instanceof Error ? e.message : String(e)).slice(0, 300) }
    } finally {
      running = false
    }
    sync()
  }

  return {
    sync,
    stop() {
      stopped = true
      clear()
    },
    decorate(status) {
      return { ...status, autoScan: { ...status.autoScan, lastRun, nextAt } }
    },
    armed: () => handle !== null,
    tick
  }
}
