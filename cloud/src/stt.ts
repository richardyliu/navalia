// Speech-to-text adapters for meetings (C13).
//
// - `mock`: no audio decoding, deterministic one segment per chunk. Tests / Lens E2E.
// - `soniox`: Soniox async REST API (docs.soniox.com, read 2026-11-05):
//     POST   {base}/v1/files                       multipart/form-data, field `file`        → 201 {id,...}
//     POST   {base}/v1/transcriptions              JSON {model, file_id, language_hints?,
//                                                  enable_speaker_diarization, enable_language_identification} → 201 {id,status}
//     GET    {base}/v1/transcriptions/{id}         → {status: queued|processing|completed|error, error_type, error_message}
//     GET    {base}/v1/transcriptions/{id}/transcript → {id, text, tokens:[{text,start_ms,end_ms,confidence,speaker?,language?}]}
//     DELETE {base}/v1/transcriptions/{id}         → 204 (409 while processing)
//     DELETE {base}/v1/files/{id}                  → 204
//   Auth: `Authorization: Bearer <key>`. After every chunk (success or failure) the transcription and the
//   uploaded file are deleted at Soniox (best effort). The key is only ever placed in that header; no
//   upstream body, URL or key reaches an error message or a log.

import type { SttConfig } from './config.ts'

export interface Segment {
  start_ms: number
  end_ms: number
  speaker: string | null
  text: string
}

export interface SttChunk {
  audio: Buffer
  /** Bare media type: audio/webm | audio/ogg | audio/wav */
  contentType: string
  durationMs: number
  seq: number
  languageHints: string[]
}

/** Segment times are relative to the chunk start. */
export interface SttResult {
  language: string | null
  segments: Segment[]
}

export type SttErrorCode = 'stt_rejected' | 'stt_auth' | 'stt_quota' | 'stt_failed' | 'stt_unavailable' | 'stt_timeout' | 'stt_bad_response' | 'aborted'

/** Safe-to-show failure. `permanent` = do not retry. `message` never contains upstream bodies, URLs or keys. */
export class SttError extends Error {
  readonly code: SttErrorCode
  readonly permanent: boolean
  constructor(code: SttErrorCode, permanent: boolean) {
    super(`speech-to-text failed: ${code}`)
    this.code = code
    this.permanent = permanent
  }
}

export interface SttAdapter {
  transcribe(chunk: SttChunk, signal: AbortSignal): Promise<SttResult>
}

export function createSttAdapter(cfg: SttConfig): SttAdapter | null {
  if (cfg.mode === 'mock') return mockStt()
  if (cfg.mode === 'soniox') return sonioxStt(cfg)
  return null
}

// ---------------------------------------------------------------- mock

export function mockSegmentText(seq: number, durationMs: number): string {
  return `（mock 转写）第 ${seq + 1} 段，${Math.round(durationMs / 1000)} 秒`
}

export function mockStt(): SttAdapter {
  return {
    async transcribe(c, signal) {
      if (signal.aborted) throw new SttError('aborted', false)
      return { language: null, segments: [{ start_ms: 0, end_ms: c.durationMs, speaker: 'S1', text: mockSegmentText(c.seq, c.durationMs) }] }
    }
  }
}

// ---------------------------------------------------------------- soniox

export interface SonioxToken {
  text?: unknown
  start_ms?: unknown
  end_ms?: unknown
  speaker?: unknown
  language?: unknown
  translation_status?: unknown
}

/** Max silence between tokens of one segment; a longer gap or a speaker change starts a new segment. */
const SEGMENT_GAP_MS = 2000

/** Groups Soniox tokens into segments (speaker change or long gap). Pure; exported for tests. */
export function tokensToResult(tokens: SonioxToken[], durationMs: number): SttResult {
  const segments: Segment[] = []
  const langCount = new Map<string, number>()
  let cur: (Segment & { last: number }) | null = null
  for (const t of tokens) {
    if (typeof t.text !== 'string' || typeof t.start_ms !== 'number' || typeof t.end_ms !== 'number') continue
    // Translation tokens (only present if translation is enabled, which we never do) are not transcript.
    if (t.translation_status === 'translation') continue
    const speaker = typeof t.speaker === 'string' && t.speaker !== '' ? `S${t.speaker}` : typeof t.speaker === 'number' ? `S${t.speaker}` : null
    if (typeof t.language === 'string' && /^[a-z]{2,3}$/.test(t.language)) langCount.set(t.language, (langCount.get(t.language) ?? 0) + 1)
    const start = Math.max(0, Math.min(durationMs, Math.round(t.start_ms)))
    const end = Math.max(start, Math.min(durationMs, Math.round(t.end_ms)))
    if (cur && cur.speaker === speaker && start - cur.last <= SEGMENT_GAP_MS) {
      cur.text += t.text
      cur.end_ms = Math.max(cur.end_ms, end)
      cur.last = end
    } else {
      if (cur) segments.push(cur)
      cur = { start_ms: start, end_ms: end, speaker, text: t.text, last: end }
    }
  }
  if (cur) segments.push(cur)
  const out = segments
    .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, speaker: s.speaker, text: s.text.trim() }))
    .filter((s) => s.text !== '')
  let language: string | null = null
  let best = 0
  for (const [l, n] of langCount) if (n > best) [language, best] = [l, n]
  return { language, segments: out }
}

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }

function statusError(status: number): SttError {
  if (status === 401 || status === 403) return new SttError('stt_auth', true)
  if (status === 402) return new SttError('stt_quota', true)
  if (status === 429 || status >= 500) return new SttError('stt_unavailable', false)
  return new SttError('stt_rejected', true)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SttError('aborted', false))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new SttError('aborted', false))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function sonioxStt(cfg: SttConfig): SttAdapter {
  const base = cfg.sonioxBaseUrl.replace(/\/+$/, '')
  const auth = { authorization: `Bearer ${cfg.sonioxApiKey}` }

  /** fetch that maps every failure to SttError without leaking anything. */
  async function call(method: string, path: string, signal: AbortSignal, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    let r: Response
    try {
      r = await fetch(base + path, { method, headers: { ...auth, ...headers }, body, signal, redirect: 'error' })
    } catch {
      throw signal.aborted ? new SttError(signal.reason === 'timeout' ? 'stt_timeout' : 'aborted', false) : new SttError('stt_unavailable', false)
    }
    return r
  }

  async function json(r: Response): Promise<Record<string, unknown>> {
    try {
      const j = (await r.json()) as unknown
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>
    } catch {
      /* fallthrough */
    }
    throw new SttError('stt_bad_response', false)
  }

  async function discard(r: Response): Promise<void> {
    try {
      await r.body?.cancel()
    } catch {
      /* ignore */
    }
  }

  async function cleanup(fileId: string | null, transcriptionId: string | null): Promise<void> {
    // Separate short budget so cleanup also runs after a timeout / abort.
    const signal = AbortSignal.timeout(10_000)
    for (const path of [transcriptionId ? `/v1/transcriptions/${encodeURIComponent(transcriptionId)}` : null, fileId ? `/v1/files/${encodeURIComponent(fileId)}` : null]) {
      if (!path) continue
      try {
        const r = await call('DELETE', path, signal)
        await discard(r)
      } catch {
        /* best effort; Soniox keeps nothing we need */
      }
    }
  }

  return {
    async transcribe(c, outer) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort('timeout'), cfg.timeoutMs)
      const onOuter = (): void => ac.abort('aborted')
      outer.addEventListener('abort', onOuter, { once: true })
      if (outer.aborted) ac.abort('aborted')
      const signal = ac.signal
      let fileId: string | null = null
      let trId: string | null = null
      try {
        // 1. upload
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(c.audio)], { type: c.contentType }), `chunk.${EXT[c.contentType] ?? 'bin'}`)
        const up = await call('POST', '/v1/files', signal, form)
        if (!up.ok) {
          await discard(up)
          throw statusError(up.status)
        }
        const f = await json(up)
        if (typeof f.id !== 'string' || f.id === '') throw new SttError('stt_bad_response', false)
        fileId = f.id

        // 2. create transcription
        const req: Record<string, unknown> = {
          model: cfg.sonioxModel,
          file_id: fileId,
          enable_speaker_diarization: true,
          enable_language_identification: true
        }
        if (c.languageHints.length > 0) req.language_hints = c.languageHints
        const cr = await call('POST', '/v1/transcriptions', signal, JSON.stringify(req), { 'content-type': 'application/json' })
        if (!cr.ok) {
          await discard(cr)
          throw statusError(cr.status)
        }
        const t = await json(cr)
        if (typeof t.id !== 'string' || t.id === '') throw new SttError('stt_bad_response', false)
        trId = t.id

        // 3. poll
        let status = typeof t.status === 'string' ? t.status : 'queued'
        while (status !== 'completed') {
          if (status === 'error') throw new SttError('stt_failed', true)
          if (status !== 'queued' && status !== 'processing') throw new SttError('stt_bad_response', false)
          await sleep(cfg.pollIntervalMs, signal).catch((e: unknown) => {
            throw signal.reason === 'timeout' ? new SttError('stt_timeout', false) : e
          })
          const g = await call('GET', `/v1/transcriptions/${encodeURIComponent(trId)}`, signal)
          if (!g.ok) {
            await discard(g)
            throw statusError(g.status)
          }
          const gj = await json(g)
          status = typeof gj.status === 'string' ? gj.status : ''
        }

        // 4. transcript
        const tr = await call('GET', `/v1/transcriptions/${encodeURIComponent(trId)}/transcript`, signal)
        if (!tr.ok) {
          await discard(tr)
          throw statusError(tr.status)
        }
        const body = await json(tr)
        if (!Array.isArray(body.tokens)) throw new SttError('stt_bad_response', false)
        return tokensToResult(body.tokens as SonioxToken[], c.durationMs)
      } catch (err) {
        if (err instanceof SttError) throw err
        throw new SttError(signal.reason === 'timeout' ? 'stt_timeout' : 'stt_unavailable', false)
      } finally {
        clearTimeout(timer)
        outer.removeEventListener('abort', onOuter)
        await cleanup(fileId, trId)
      }
    }
  }
}
