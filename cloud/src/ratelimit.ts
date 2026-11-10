// In-memory fixed-window rate limiter. Single-process only: a multi-instance
// deployment needs a shared store (documented in README / S1-FULL-ARCH).

export interface RateDecision {
  ok: boolean
  /** Seconds until the current window resets (>= 1 when !ok). */
  retryAfterS: number
}

interface Bucket {
  windowStart: number
  count: number
}

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly windowMs: number
  private readonly max: number
  private readonly maxKeys: number

  constructor(windowS: number, max: number, maxKeys = 100_000) {
    this.windowMs = windowS * 1000
    this.max = max
    this.maxKeys = maxKeys
  }

  hit(key: string, now: number): RateDecision {
    const windowStart = now - (now % this.windowMs)
    let b = this.buckets.get(key)
    if (!b || b.windowStart !== windowStart) {
      if (!b && this.buckets.size >= this.maxKeys) this.sweep(windowStart)
      b = { windowStart, count: 0 }
      this.buckets.set(key, b)
    }
    b.count++
    const retryAfterS = Math.max(1, Math.ceil((windowStart + this.windowMs - now) / 1000))
    return { ok: b.count <= this.max, retryAfterS }
  }

  /** Drops buckets from past windows; if still full, drops everything (fail-open on memory pressure, not on limits). */
  sweep(currentWindowStart: number): void {
    for (const [k, b] of this.buckets) if (b.windowStart !== currentWindowStart) this.buckets.delete(k)
    if (this.buckets.size >= this.maxKeys) this.buckets.clear()
  }

  get size(): number {
    return this.buckets.size
  }
}
