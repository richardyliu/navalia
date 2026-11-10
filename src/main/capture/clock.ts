/** Injectable time source so capture scheduling is deterministic under test. */
export type TimerHandle = unknown

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // Capture timers must never keep the process alive on quit.
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref()
    return t
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}
