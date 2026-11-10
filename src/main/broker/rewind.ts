import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv } from 'node:crypto'

/**
 * Rewind over the OSS runtime's capture buffer (`<root>/capture-buffer/<stem>.json`).
 * Screenshots are AES-256-GCM sealed by the runtime (capture/screenshot_crypto.py):
 *   "PSOMEGCM1:" + base64( iv(12) || ciphertext || tag(16) ), plaintext = the image's base64 text,
 *   key = PERSOME_SCREENSHOT_KEY (64 hex) from `<root>/env`.
 * Decryption happens here, in main only. The key is injected, never logged, never returned.
 */

export const MAGIC = 'PSOMEGCM1:'
export const STEM_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{1,9})?[pm]\d{2}-\d{2}$/
export const MAX_FRAMES = 100
export const MAX_TEXT_CHARS = 1500
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/**
 * Per-call scan budget: at most this many capture files are read + parsed per `frames()` call.
 * A filter that matches nothing (e.g. an unknown app_name) must not walk the whole buffer
 * (thousands of files, hundreds of MB) in one call; it returns `partial` with a cursor instead.
 */
export const SCAN_BUDGET = 300
export const MAX_CAPTURE_FILE_BYTES = 64 * 1024 * 1024

/** Error with a stable machine code (the Broker surfaces `code` as the Access-log error code). */
export class RewindReaderError extends Error {
  constructor(
    readonly code: 'plaintext_refused',
    message: string
  ) {
    super(message)
    this.name = 'RewindReaderError'
  }
}

/** "2026-11-05T01-03-12.916631p00-00" → Date. */
export function stemTime(stem: string): Date | null {
  const m = stem.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?([pm])(\d{2})-(\d{2})$/)
  if (!m) return null
  const frac = m[5] ? m[5].slice(0, 4) : ''
  const sign = m[6] === 'p' ? '+' : '-'
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${frac}${sign}${m[7]}:${m[8]}`)
  return Number.isNaN(d.getTime()) ? null : d
}

export function decryptEnvelope(envelope: string, key: Buffer): Buffer {
  if (!envelope.startsWith(MAGIC)) throw new Error('not a PSOMEGCM1 envelope')
  const blob = Buffer.from(envelope.slice(MAGIC.length), 'base64')
  if (blob.length < 12 + 16) throw new Error('screenshot envelope too short')
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(blob.length - 16)
  const body = blob.subarray(12, blob.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()])
}

function sniffMime(buf: Buffer, declared: unknown): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'image/webp'
  return typeof declared === 'string' && /^image\/[a-z]+$/.test(declared) ? declared : 'application/octet-stream'
}

export interface RewindFrame {
  file_stem: string
  timestamp: string
  app_name: string | null
  bundle_id: string | null
  window_title: string | null
  url: string | null
  text: string
  text_truncated: boolean
  has_screenshot: boolean
}

export interface RewindFramesResult {
  frames: RewindFrame[]
  /**
   * Continue from here (exclusive). Non-null whenever unexamined capture files remain in range:
   * either `limit` frames were returned, or the per-call scan budget ran out (`partial`).
   * The cursor is the stem of the last file examined (not necessarily the last frame returned).
   */
  next_cursor: string | null
  /** Capture files read and parsed by this call (≤ the scan budget). */
  scanned: number
  /** True when the scan budget stopped this call before `limit` matches or the end of the range. */
  partial: boolean
}

export interface RewindScreenshot {
  file_stem: string
  mime: string
  data: Buffer
  width: number | null
  height: number | null
  /** Always true: plaintext frames are refused by the reader (kept for callers that assert it). */
  encrypted: boolean
}

export interface RewindReader {
  /**
   * `order` defaults to 'asc' (oldest first); 'desc' is newest first (Lens Rewind page).
   * The cursor is `next_cursor` of the previous call (the last stem examined); continuation
   * starts strictly after it in the requested order, even if that file has since been deleted.
   */
  frames(q: { since?: string; until?: string; app_name?: string; limit?: number; cursor?: string; order?: 'asc' | 'desc' }): Promise<RewindFramesResult>
  /** Sealed (PSOMEGCM1) screenshots only; a plaintext legacy frame throws `plaintext_refused` (CAP-03). */
  screenshot(stem: string): Promise<RewindScreenshot>
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

export function createRewindReader(opts: { root: () => string; screenshotKey: () => Buffer | null; scanBudget?: number }): RewindReader {
  const dir = () => path.join(opts.root(), 'capture-buffer')
  const budget = Math.max(1, Math.floor(opts.scanBudget ?? SCAN_BUDGET))

  /** Async read + parse; yields to the event loop between files so a scan never monopolises main. */
  async function load(stem: string): Promise<Record<string, unknown>> {
    if (!STEM_RE.test(stem)) throw new Error('invalid file_stem')
    const file = path.join(dir(), `${stem}.json`)
    // Path is built from a validated stem only; stay inside capture-buffer.
    if (path.dirname(file) !== dir()) throw new Error('invalid file_stem')
    const st = await fs.promises.stat(file)
    if (st.size > MAX_CAPTURE_FILE_BYTES) throw new Error('capture file too large')
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>
  }

  return {
    async frames(q) {
      const limit = Math.max(1, Math.min(q.limit ?? 50, MAX_FRAMES))
      const since = q.since ? Date.parse(q.since) : -Infinity
      const until = q.until ? Date.parse(q.until) : Infinity
      if (Number.isNaN(since) || Number.isNaN(until)) throw new Error('since/until must be ISO-8601 timestamps')
      let after: { t: number; s: string } | null = null
      if (q.cursor) {
        const t = STEM_RE.test(q.cursor) ? stemTime(q.cursor)?.getTime() : undefined
        if (t === undefined || Number.isNaN(t)) throw new Error('invalid cursor')
        after = { t, s: q.cursor }
      }
      const desc = q.order === 'desc'
      let names: string[]
      try {
        names = (await fs.promises.readdir(dir())).filter((n) => n.endsWith('.json'))
      } catch {
        return { frames: [], next_cursor: null, scanned: 0, partial: false }
      }
      const cmp = (a: { t: number; s: string }, b: { t: number; s: string }) => a.t - b.t || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)
      const stems = names
        .map((n) => n.slice(0, -5))
        .filter((s) => STEM_RE.test(s))
        .map((s) => ({ s, t: stemTime(s)?.getTime() ?? NaN }))
        .filter((x) => !Number.isNaN(x.t) && x.t >= since && x.t <= until)
        // Strictly after the cursor in the requested order (position by value, not by index,
        // so a cursor whose file was deleted by retention still continues correctly).
        .filter((x) => !after || (desc ? cmp(x, after) < 0 : cmp(x, after) > 0))
        .sort(cmp)
      if (desc) stems.reverse()
      const frames: RewindFrame[] = []
      let i = 0
      let scanned = 0
      for (; i < stems.length && frames.length < limit && scanned < budget; i++) {
        scanned++
        let d: Record<string, unknown>
        try {
          d = await load(stems[i].s)
        } catch {
          continue
        }
        const wm = (d.window_meta ?? {}) as Record<string, unknown>
        const tr = (d.trigger ?? {}) as Record<string, unknown>
        if (q.app_name && (str(wm.app_name) ?? str(tr.app_name)) !== q.app_name) continue
        const text = typeof d.visible_text === 'string' ? d.visible_text : ''
        const shot = (d.screenshot ?? {}) as Record<string, unknown>
        frames.push({
          file_stem: stems[i].s,
          timestamp: str(d.timestamp) ?? new Date(stems[i].t).toISOString(),
          app_name: str(wm.app_name) ?? str(tr.app_name),
          bundle_id: str(wm.bundle_id) ?? str(tr.bundle_id),
          window_title: str(wm.title) ?? str(tr.window_title),
          url: str(d.url),
          text: Array.from(text).slice(0, MAX_TEXT_CHARS).join(''),
          text_truncated: Array.from(text).length > MAX_TEXT_CHARS,
          has_screenshot: typeof shot.image_base64 === 'string' && shot.image_base64.length > 0
        })
      }
      const more = i < stems.length
      return {
        frames,
        next_cursor: more && i > 0 ? stems[i - 1].s : null,
        scanned,
        partial: more && frames.length < limit
      }
    },

    async screenshot(stem) {
      const d = await load(stem)
      const shot = (d.screenshot ?? {}) as Record<string, unknown>
      const value = shot.image_base64
      if (typeof value !== 'string' || !value) throw new Error('this frame has no screenshot (stripped after retention or never captured)')
      // OG-D6b / CAP-03: screenshots are sealed at rest. A legacy plaintext frame is refused here,
      // for every consumer (Broker tool and Rewind page alike), before its bytes are decoded.
      if (!value.startsWith(MAGIC)) {
        throw new RewindReaderError('plaintext_refused', `screenshot is stored unencrypted (no ${MAGIC.slice(0, -1)} envelope); refused (CAP-03)`)
      }
      const key = opts.screenshotKey()
      if (!key) throw new Error('screenshot is encrypted and the runtime screenshot key is unavailable')
      let b64: string
      try {
        b64 = decryptEnvelope(value, key).toString('ascii')
      } catch {
        throw new Error('screenshot decrypt failed (wrong key or tampered)')
      }
      const data = Buffer.from(b64, 'base64')
      if (data.length === 0) throw new Error('screenshot payload is empty')
      if (data.length > MAX_IMAGE_BYTES) throw new Error('screenshot too large')
      return {
        file_stem: stem,
        mime: sniffMime(data, shot.mime_type),
        data,
        width: typeof shot.width === 'number' ? shot.width : null,
        height: typeof shot.height === 'number' ? shot.height : null,
        encrypted: true
      }
    }
  }
}
