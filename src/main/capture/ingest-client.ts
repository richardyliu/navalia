import type { IngestFrame } from './frame'

/**
 * POST /captures/ingest. The endpoint answers HTTP 200 for three different
 * outcomes (written, deduped, skipped = paused/locked), so 200 is not
 * "stored". The daemon serializes ingest behind a global lock and 503s past 16
 * concurrent requests, so frames go strictly one at a time.
 */

export const MAX_BODY_BYTES = 12 * 1024 * 1024
export const RETRY_DELAYS_MS: readonly number[] = [250, 1000, 3000]

export type IngestOutcome =
  | { outcome: 'written'; id: string | null }
  | { outcome: 'deduped'; id: string | null }
  | { outcome: 'skipped'; id: null }
  | { outcome: 'parked'; reason: string }
  /**
   * Not retryable by waiting. `auth`: the token could not be read, or the
   * Runtime refused it twice (re-read in between). `http`: other 4xx.
   */
  | { outcome: 'rejected'; status: number; reason: 'auth' | 'http' }
  | { outcome: 'too_large'; bytes: number }
  /**
   * Withdrawn before delivery: capture was paused, or the frame's app became
   * excluded, while the frame was queued, parked or between retries.
   */
  | { outcome: 'dropped'; reason: DropReason }

export type DropReason = 'paused' | 'locked' | 'excluded_app'

export interface IngestStats {
  written: number
  deduped: number
  skipped: number
  rejected: number
  tooLarge: number
  retries: number
  parked: number
  /** Parked frames discarded at the hard cap (Runtime unreachable for a long time). */
  parkedEvicted: number
  dropped: Record<DropReason, number>
}

export interface IngestClientOptions {
  baseUrl: string
  /** Read lazily so a rotated token is picked up; never logged. */
  getToken: () => string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  retryDelaysMs?: readonly number[]
  attemptTimeoutMs?: number
  maxParked?: number
  /**
   * Checked immediately before every delivery attempt (first try and each
   * retry), and by revalidate(). Non-null means the frame must not reach the
   * Runtime any more.
   */
  gate?: (frame: IngestFrame) => DropReason | null
}

interface QueueItem {
  frame: IngestFrame
  resolve: (r: IngestOutcome) => void
}

export function parseIngestResponse(payload: unknown): IngestOutcome | null {
  if (typeof payload !== 'object' || payload === null) return null
  const data = (payload as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const d = data as { id?: unknown; deduped?: unknown; skipped?: unknown }
  const id = typeof d.id === 'string' && d.id.length > 0 ? d.id : null
  if (d.skipped === true) return { outcome: 'skipped', id: null }
  if (d.deduped === true) return { outcome: 'deduped', id }
  if (d.skipped === false && d.deduped === false) return { outcome: 'written', id }
  return null
}

export class IngestClient {
  readonly stats: IngestStats = {
    written: 0,
    deduped: 0,
    skipped: 0,
    rejected: 0,
    tooLarge: 0,
    retries: 0,
    parked: 0,
    parkedEvicted: 0,
    dropped: { paused: 0, locked: 0, excluded_app: 0 }
  }
  /** Frames whose retries were exhausted. Held in memory only (they may carry pixels). */
  readonly parkedFrames: IngestFrame[] = []
  private readonly queue: QueueItem[] = []
  private draining = false
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly retryDelays: readonly number[]
  private readonly attemptTimeoutMs: number
  private readonly maxParked: number
  private readonly gate: (frame: IngestFrame) => DropReason | null
  /** Parked after an unreadable 200: the Runtime already processed them, so never resent automatically. */
  private readonly noAutoRetry = new WeakSet<IngestFrame>()
  private inFlight: { frame: IngestFrame; controller: AbortController } | null = null

  constructor(private readonly options: IngestClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 10_000
    this.maxParked = options.maxParked ?? 64
    this.gate = options.gate ?? (() => null)
  }

  /**
   * Re-apply the gate now (call on pause and on exclusion changes): queued and
   * parked frames that fail it are dropped, and an attempt already on the wire
   * for such a frame is aborted. A request whose body the Runtime has already
   * read cannot be recalled; abort narrows that window to the request in
   * progress at the pause instant.
   */
  revalidate(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const reason = this.gate(this.queue[i].frame)
      if (reason) {
        const [item] = this.queue.splice(i, 1)
        item.resolve(this.drop(reason))
      }
    }
    for (let i = this.parkedFrames.length - 1; i >= 0; i--) {
      const reason = this.gate(this.parkedFrames[i])
      if (reason) {
        this.parkedFrames.splice(i, 1)
        this.drop(reason)
      }
    }
    this.stats.parked = this.parkedFrames.length
    if (this.inFlight && this.gate(this.inFlight.frame)) this.inFlight.controller.abort()
  }

  private drop(reason: DropReason): IngestOutcome {
    this.stats.dropped[reason]++
    return { outcome: 'dropped', reason }
  }

  get queued(): number {
    return this.queue.length
  }

  push(frame: IngestFrame): Promise<IngestOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ frame, resolve })
      void this.drain()
    })
  }

  /** Re-queue parked frames (e.g. after the Runtime is reachable again). */
  retryParked(): Promise<IngestOutcome[]> {
    this.revalidate()
    const frames = this.parkedFrames.splice(0)
    this.stats.parked -= frames.length
    return Promise.all(frames.map((f) => this.push(f)))
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!
        let result: IngestOutcome
        try {
          result = await this.send(item.frame)
        } catch {
          result = this.park(item.frame, 'internal_error')
        }
        item.resolve(result)
        if ((result.outcome === 'written' || result.outcome === 'deduped') && this.parkedFrames.length > 0) {
          // The Runtime is reachable again: re-queue parked frames behind the
          // current queue (gate re-checked on send). Without this they would
          // sit in memory until quit, i.e. be lost.
          this.requeueParked()
        }
      }
    } finally {
      this.draining = false
    }
  }

  private requeueParked(): void {
    for (let i = 0; i < this.parkedFrames.length; ) {
      const frame = this.parkedFrames[i]
      if (this.noAutoRetry.has(frame)) {
        i++
        continue
      }
      this.parkedFrames.splice(i, 1)
      this.queue.push({ frame, resolve: () => {} })
    }
    this.stats.parked = this.parkedFrames.length
  }

  private park(frame: IngestFrame, reason: string): IngestOutcome {
    if (this.parkedFrames.length >= this.maxParked) {
      // Bounded memory: shed the pixels (and OCR copy) of the oldest parked
      // frame that still has them; its text payload is kept.
      const oldest = this.parkedFrames.find((f) => f.screenshot || f.ocr_jpeg_b64)
      if (oldest) {
        delete oldest.screenshot
        delete oldest.ocr_jpeg_b64
      }
      // Text-only frames are still unbounded in count (an AX tree can be MBs):
      // past a hard cap the oldest is evicted and counted, never silently.
      while (this.parkedFrames.length >= this.maxParked * 4) {
        this.parkedFrames.shift()
        this.stats.parkedEvicted++
      }
    }
    if (reason === 'bad_response') this.noAutoRetry.add(frame)
    this.parkedFrames.push(frame)
    this.stats.parked = this.parkedFrames.length
    return { outcome: 'parked', reason }
  }

  private async send(frame: IngestFrame): Promise<IngestOutcome> {
    const body = JSON.stringify(frame)
    const bytes = Buffer.byteLength(body)
    if (bytes > MAX_BODY_BYTES) {
      this.stats.tooLarge++
      return { outcome: 'too_large', bytes }
    }
    let lastReason = 'unknown'
    let authRetried = false
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      let blocked = this.gate(frame)
      if (blocked) return this.drop(blocked)
      if (attempt > 0) {
        this.stats.retries++
        await this.sleep(this.retryDelays[attempt - 1])
        blocked = this.gate(frame)
        if (blocked) return this.drop(blocked)
      }
      let token: string
      try {
        token = this.options.getToken()
      } catch {
        // Missing / unreadable / over-permissive env file: not a transport fault.
        this.stats.rejected++
        return { outcome: 'rejected', status: 0, reason: 'auth' }
      }
      const controller = new AbortController()
      this.inFlight = { frame, controller }
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.attemptTimeoutMs)
      let status = 0
      let payload: unknown = null
      try {
        const response = await this.fetchImpl(`${this.options.baseUrl}/captures/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body,
          signal: controller.signal
        })
        status = response.status
        if (status === 200) payload = await response.json().catch(() => null)
        else await response.arrayBuffer().catch(() => null)
      } catch (error) {
        if ((error as Error)?.name === 'AbortError' && !timedOut) {
          // Aborted by revalidate(): the gate decides on the next pass.
          blocked = this.gate(frame)
          if (blocked) return this.drop(blocked)
        }
        lastReason = (error as Error)?.name === 'AbortError' ? 'timeout' : 'unreachable'
        continue
      } finally {
        clearTimeout(timer)
        this.inFlight = null
      }
      if (status === 200) {
        const parsed = parseIngestResponse(payload)
        if (!parsed) {
          // A 200 means the Runtime accepted and processed the request; only
          // the receipt is unreadable (contract/version mismatch). Resending
          // could store the frame twice and cannot fix the contract, so park
          // once without retrying.
          return this.park(frame, 'bad_response')
        }
        this.stats[parsed.outcome as 'written' | 'deduped' | 'skipped']++
        return parsed
      }
      if (status >= 500) {
        lastReason = `http_${status}`
        continue
      }
      if ((status === 401 || status === 403) && !authRetried) {
        // The Runtime may have rotated its token: re-read it once, immediately.
        authRetried = true
        attempt--
        continue
      }
      // 4xx: the request itself is wrong (auth, schema, size). Retrying cannot help.
      this.stats.rejected++
      return { outcome: 'rejected', status, reason: status === 401 || status === 403 ? 'auth' : 'http' }
    }
    return this.park(frame, lastReason)
  }
}
