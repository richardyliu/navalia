import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { readdirSync } from 'node:fs'
import { STT_DISABLED, type CloudConfig, type SttConfig } from '../src/config.ts'
import type { ServerDeps } from '../src/server.ts'
import { bearer, login, newKey, postJson, startHarness, type Harness } from './helpers.ts'

export const MOCK_STT: SttConfig = { ...STT_DISABLED, mode: 'mock' }
export const SONIOX_KEY = 'SONIOXKEY-' + 's'.repeat(30)
export const TITLE = '机密董事会 TITLE-SECRET-42'

export interface MeetingHarness extends Harness {
  token: string
  accountId: string
}

export async function startMeetings(over: Partial<CloudConfig> = {}, extra: Partial<ServerDeps> = {}): Promise<MeetingHarness> {
  // Sessions outlive the 7-day retention tests.
  const h = await startHarness({ stt: MOCK_STT, tokenTtlS: 30 * 24 * 3600, ...over }, extra)
  const l = await login(h.base, newKey())
  return Object.assign(h, { token: l.token, accountId: l.account_id })
}

export const CONSENT = { version: 1, participants_informed: true }

export async function createMeeting(h: { base: string }, token: string, body: Record<string, unknown> = { title: TITLE, consent: CONSENT }): Promise<Response> {
  return postJson(h.base, '/v1/meetings', body, bearer(token))
}

export async function newMeeting(h: MeetingHarness, body?: Record<string, unknown>): Promise<string> {
  const r = await createMeeting(h, h.token, body)
  if (r.status !== 201) throw new Error(`create failed: ${r.status}`)
  return ((await r.json()) as { meeting_id: string }).meeting_id
}

/** Deterministic fake "audio" bytes (never real audio). */
export function fakeAudio(seq: number, size = 2048): Buffer {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seq * 7) & 0xff
  return b
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export interface ChunkOpts {
  contentType?: string
  sha?: string
  durationMs?: number | string
}

export async function putChunk(h: { base: string }, token: string, id: string, seq: number | string, body: Buffer, o: ChunkOpts = {}): Promise<Response> {
  return fetch(`${h.base}/v1/meetings/${id}/chunks/${seq}`, {
    method: 'PUT',
    headers: {
      ...bearer(token),
      'content-type': o.contentType ?? 'audio/webm;codecs=opus',
      'x-chunk-duration-ms': String(o.durationMs ?? 30_000),
      'x-chunk-sha256': o.sha ?? sha256(body)
    },
    body: new Uint8Array(body)
  })
}

export async function finish(h: { base: string }, token: string, id: string, chunks: number): Promise<Response> {
  return postJson(h.base, `/v1/meetings/${id}/finish`, { chunks }, bearer(token))
}

export async function getJson(h: { base: string }, token: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(h.base + path, { headers: bearer(token) })
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}

export function audioFiles(h: Harness): string[] {
  try {
    return readdirSync(h.app.config.audioDir)
  } catch {
    return []
  }
}

export function count(h: Harness, sql: string, ...args: Array<string | number>): number {
  return (h.app.db.prepare(sql).get(...args) as { n: number }).n
}

/** Captures process.stdout/stderr writes while `fn` runs. */
export async function captureStd<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  const cap =
    (orig: typeof process.stdout.write) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest)
    }
  process.stdout.write = cap(origOut) as typeof process.stdout.write
  process.stderr.write = cap(origErr) as typeof process.stderr.write
  try {
    return { result: await fn(), out }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

// ---------------------------------------------------------------- fake Soniox (modelled on docs.soniox.com, 2026-11-05)

export interface FakeSonioxReq {
  method: string
  path: string
  authorization: string | undefined
  contentType: string | undefined
  body: Buffer
}

export interface FakeSonioxOpts {
  /** HTTP status for POST /v1/files (default 201). */
  uploadStatus?: number
  /** HTTP status for POST /v1/transcriptions (default 201). */
  createStatus?: number
  /** Status GETs return 'processing' this many times before the final status (default 2). */
  pollsBeforeDone?: number
  finalStatus?: 'completed' | 'error'
  tokens?: unknown[]
}

export interface FakeSoniox {
  base: string
  reqs: FakeSonioxReq[]
  opts: FakeSonioxOpts
  close(): Promise<void>
}

export const SONIOX_TOKENS = [
  { text: '大家', start_ms: 100, end_ms: 400, confidence: 0.97, speaker: '1', language: 'zh' },
  { text: '好', start_ms: 400, end_ms: 600, confidence: 0.95, speaker: '1', language: 'zh' },
  { text: 'Hello', start_ms: 1000, end_ms: 1400, confidence: 0.9, speaker: '2', language: 'en' },
  { text: ' team', start_ms: 1400, end_ms: 1800, confidence: 0.9, speaker: '2', language: 'en' },
  { text: '开始', start_ms: 5000, end_ms: 5600, confidence: 0.9, speaker: '1', language: 'zh' }
]

export async function startFakeSoniox(opts: FakeSonioxOpts = {}): Promise<FakeSoniox> {
  const reqs: FakeSonioxReq[] = []
  const polls = new Map<string, number>()
  let n = 0
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = req.url ?? '/'
      const method = req.method ?? ''
      reqs.push({ method, path, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks) })
      const send = (status: number, body?: unknown): void => {
        if (body === undefined) {
          res.writeHead(status)
          res.end()
          return
        }
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.headers.authorization !== `Bearer ${SONIOX_KEY}`) return send(401, { error_type: 'unauthenticated', message: 'bad key' })
      let m: RegExpExecArray | null
      if (method === 'POST' && path === '/v1/files') {
        const st = opts.uploadStatus ?? 201
        // A hostile upstream echoing the key must not make it leak anywhere.
        if (st !== 201) return send(st, { error_type: 'x', message: `echo ${req.headers.authorization}` })
        return send(201, { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, filename: 'chunk.webm', size: 1, created_at: new Date().toISOString() })
      }
      if (method === 'POST' && path === '/v1/transcriptions') {
        const st = opts.createStatus ?? 201
        if (st !== 201) return send(st, { error_type: 'x', message: 'nope' })
        const id = `11111111-0000-4000-8000-${String(++n).padStart(12, '0')}`
        polls.set(id, 0)
        return send(201, { id, status: 'queued', model: 'stt-async-v6', created_at: new Date().toISOString(), filename: 'chunk.webm' })
      }
      if (method === 'GET' && (m = /^\/v1\/transcriptions\/([0-9a-f-]+)$/.exec(path))) {
        const p = (polls.get(m[1]) ?? 0) + 1
        polls.set(m[1], p)
        const done = p > (opts.pollsBeforeDone ?? 2)
        const status = done ? (opts.finalStatus ?? 'completed') : 'processing'
        return send(200, { id: m[1], status, error_type: status === 'error' ? 'audio_decode_error' : null, error_message: status === 'error' ? `decode failed ${SONIOX_KEY}` : null })
      }
      if (method === 'GET' && (m = /^\/v1\/transcriptions\/([0-9a-f-]+)\/transcript$/.exec(path))) {
        return send(200, { id: m[1], text: 'x', tokens: opts.tokens ?? SONIOX_TOKENS })
      }
      if (method === 'DELETE' && /^\/v1\/(files|transcriptions)\/[0-9a-f-]+$/.test(path)) return send(204)
      send(404, { error_type: 'not_found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    reqs,
    opts,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
  }
}

export function sonioxConfig(base: string): SttConfig {
  return { ...STT_DISABLED, mode: 'soniox', sonioxApiKey: SONIOX_KEY, sonioxBaseUrl: base, pollIntervalMs: 5, timeoutMs: 5000 }
}
