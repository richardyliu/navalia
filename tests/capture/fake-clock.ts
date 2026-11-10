import type { Clock, TimerHandle } from '../../src/main/capture/clock'

/** Deterministic clock: timers only fire inside advance(). */
export class FakeClock implements Clock {
  private t = 0
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number)
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, ms))
  }

  get pendingTimers(): number {
    return this.timers.size
  }

  /** Advance virtual time, firing due timers in order and settling promises between them. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms
    for (;;) {
      await settle()
      let nextId = -1
      let next: { at: number; fn: () => void } | null = null
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue
        if (!next || timer.at < next.at || (timer.at === next.at && id < nextId)) {
          next = timer
          nextId = id
        }
      }
      if (!next) break
      this.timers.delete(nextId)
      this.t = next.at
      next.fn()
    }
    this.t = target
    await settle()
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
