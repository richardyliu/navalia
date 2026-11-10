// Opt-in cloud HTTP client. The ONLY module in src/main/cloud that calls fetch (sse.ts only parses).
// Every method reads the config first and throws CloudError('disabled') before fetch when cloud
// is OFF or no server is set. No automatic retries; redirects are refused (the bearer must never
// follow a redirect to another origin); response bodies are size-bounded; errors map to a closed
// set with fixed messages (no token / signature / body text).
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { fingerprintOf } from '../identity/keys'
import { readCloudConfig, type CloudUrlPolicy } from './config'
import type { CloudErrorCode } from './api'
import { CloudError } from './errors'
import { DEFAULT_MAX_EVENT_BYTES, parseSse, type SseEvent } from './sse'
import { TOKEN_RE, type TokenStore } from './token'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface CloudClientDeps {
  configFile: string
  tokens: TokenStore
  /** Production: KeyManager.sign. The private key never leaves keys.ts. */
  sign: (message: Buffer) => Buffer
  /** Production: KeyManager.getPublicIdentity (only `public_key`, base64url raw 32 bytes, is used). */
  getPublicIdentity: () => { public_key: string } | null
  /** Default: global fetch (resolved per call, so tests can stub it). */
  fetch?: FetchLike
  timeoutMs?: number
  maxResponseBytes?: number
  streamTimeoutMs?: number
  maxEventBytes?: number
  now?: () => Date
  /** Loopback http only in unpackaged builds (see config.ts). Default false. */
  allowInsecureLoopback?: boolean
}

export interface CloudSession {
  accountId: string
  expiresAt: string
}

export interface CloudClient {
  /** Normalized origin when enabled; throws `disabled` otherwise. */
  origin(): string
  signIn(): Promise<CloudSession>
  session(): Promise<{ accountId: string; fingerprint: string; expiresAt: string }>
  /** Server logout + local forget (local forget happens even if the server call fails). */
  signOut(opts?: { timeoutMs?: number }): Promise<void>
  deleteAccount(): Promise<void>
  /** Authenticated JSON request for feature modules (Phase 1). Path must be `/v1/...`. */
  requestJson<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, schema: z.ZodType<T>, opts?: RequestOpts): Promise<T>
  /**
   * Authenticated PUT of a raw binary body (S1-FULL C13 meeting audio chunks) with a JSON response.
   * `contentType` must be an `audio/*` type; `headers` are limited to `x-*` names with printable
   * ASCII values. Same error mapping as `requestJson`.
   */
  putBytes<T>(path: string, bytes: Uint8Array, contentType: string, headers: Record<string, string>, schema: z.ZodType<T>, opts?: RequestOpts): Promise<T>
  /** Authenticated request whose success response has no body (e.g. `204`). S1-FULL C8 / C10. */
  requestEmpty(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<void>
  /** Authenticated POST returning an SSE stream (Chat, Phase 1). User abort ends iteration quietly. */
  stream(path: string, body: unknown, opts?: { signal?: AbortSignal }): AsyncGenerator<SseEvent, void, undefined>
}

/** Per-call overrides (S1-FULL C13: long transcripts / slow chunk uploads). */
export interface RequestOpts {
  timeoutMs?: number
  maxResponseBytes?: number
}

export const AUTH_CONTEXT = 'persome-cloud-auth-v1'
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
export const DEFAULT_STREAM_TIMEOUT_MS = 10 * 60_000

/**
 * Server error codes (from a JSON `{error:{code}}` body) that map to their own client code. Only
 * the code string is compared against this allowlist; no body text is ever surfaced.
 */
const SERVER_CODES = {
  quota_exceeded: 'quota_exceeded',
  llm_unavailable: 'llm_unavailable',
  upstream_error: 'upstream_error',
  upstream_timeout: 'upstream_timeout',
  // S1-FULL C12–C14 (meetings). `stt_unavailable` is a 503; the others are 4xx (MEETING_4XX).
  stt_unavailable: 'stt_unavailable',
  consent_required: 'consent_required',
  chunk_conflict: 'chunk_conflict',
  meeting_closed: 'meeting_closed',
  checksum_mismatch: 'checksum_mismatch',
  chunks_missing: 'chunks_missing',
  chunks_mismatch: 'chunks_mismatch',
  not_ready: 'not_ready'
} as const satisfies Record<string, CloudErrorCode>

/** Allowlisted server codes that are surfaced as their own code even on a 4xx (meetings). */
const MEETING_4XX: ReadonlySet<CloudErrorCode> = new Set(['consent_required', 'chunk_conflict', 'meeting_closed', 'checksum_mismatch', 'chunks_missing', 'chunks_mismatch', 'not_ready'])

/** `chunks_missing` carries the missing chunk numbers (`error.missing` or top-level `missing`). */
function missingSeqs(buf: Buffer | undefined): number[] | undefined {
  if (!buf || buf.length === 0) return undefined
  try {
    const j = JSON.parse(buf.toString('utf8')) as { missing?: unknown; error?: { missing?: unknown } }
    const raw = Array.isArray(j?.error?.missing) ? j.error.missing : Array.isArray(j?.missing) ? j.missing : null
    if (!raw) return undefined
    const out = raw.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 100_000).slice(0, 10_000)
    return [...new Set(out)].sort((a, b) => a - b)
  } catch {
    return undefined
  }
}

function serverCode(buf: Buffer | undefined): CloudErrorCode | null {
  if (!buf || buf.length === 0) return null
  try {
    const code = (JSON.parse(buf.toString('utf8')) as { error?: { code?: unknown } })?.error?.code
    return typeof code === 'string' && Object.hasOwn(SERVER_CODES, code) ? SERVER_CODES[code as keyof typeof SERVER_CODES] : null
  } catch {
    return null
  }
}

/** The exact bytes signed for `/v1/auth/verify` (fixed server contract). */
export function authMessage(audience: string, challengeId: string, nonce: string, fingerprint: string): Buffer {
  return Buffer.from(`${AUTH_CONTEXT}\n${audience}\n${challengeId}\n${nonce}\n${fingerprint}`, 'utf8')
}

const Iso = z.string().min(1).max(64).refine((s) => Number.isFinite(Date.parse(s)))
const ChallengeSchema = z.object({
  challenge_id: z.string().min(1).max(256),
  nonce: z.string().min(1).max(1024),
  audience: z.string().min(1).max(2048),
  expires_at: Iso
})
const VerifySchema = z.object({
  token: z.string().regex(TOKEN_RE),
  token_type: z.literal('Bearer'),
  expires_at: Iso,
  account_id: z.string().min(1).max(256)
})
const SessionSchema = z.object({
  account_id: z.string().min(1).max(256),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  expires_at: Iso
})
const PATH_RE = /^\/v1\/[A-Za-z0-9/_.-]{1,256}$/

/** Retry-After: delta-seconds or HTTP-date; clamped to [0, 86400]. */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | undefined {
  if (!value) return undefined
  const v = value.trim()
  let s: number
  if (/^\d{1,10}$/.test(v)) s = Number(v)
  else {
    const t = Date.parse(v)
    if (!Number.isFinite(t)) return undefined
    s = Math.ceil((t - now.getTime()) / 1000)
  }
  return Math.min(86_400, Math.max(0, s))
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError'
}

/** Read at most `max` bytes of a body; cancel and fail `too_large` beyond that. */
async function readBounded(res: Response, max: number): Promise<Buffer> {
  const len = res.headers.get('content-length')
  if (len && /^\d+$/.test(len) && Number(len) > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new CloudError('too_large')
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const parts: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => undefined)
        throw new CloudError('too_large')
      }
      parts.push(Buffer.from(value))
    }
  } catch (e) {
    if (e instanceof CloudError) throw e
    throw new CloudError(isTimeout(e) ? 'timeout' : 'network')
  }
  return Buffer.concat(parts)
}

export function createCloudClient(deps: CloudClientDeps): CloudClient {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const now = deps.now ?? (() => new Date())
  const policy: CloudUrlPolicy = { allowInsecureLoopback: deps.allowInsecureLoopback === true }

  function origin(): string {
    const cfg = readCloudConfig(deps.configFile, policy)
    if (!cfg.enabled || !cfg.baseUrl) throw new CloudError('disabled')
    return cfg.baseUrl
  }

  function bearerFor(base: string): string {
    const t = deps.tokens.bearer(base)
    if (!t) throw new CloudError('unauthorized')
    return t
  }

  async function send(
    base: string,
    method: string,
    path: string,
    body: unknown,
    bearer: string | null,
    signal: AbortSignal,
    accept: string,
    raw?: { bytes: Uint8Array; contentType: string; headers: Record<string, string> }
  ): Promise<Response> {
    if (!PATH_RE.test(path) || path.includes('..')) throw new CloudError('invalid_args')
    const headers: Record<string, string> = raw ? { ...raw.headers, accept } : { accept }
    if (raw) headers['content-type'] = raw.contentType
    else if (body !== undefined) headers['content-type'] = 'application/json'
    if (bearer) headers.authorization = `Bearer ${bearer}`
    const f = deps.fetch ?? globalThis.fetch
    try {
      return await f(`${base}${path}`, {
        method,
        headers,
        body: raw ? (raw.bytes as Uint8Array<ArrayBuffer>) : body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })
    } catch (e) {
      throw new CloudError(isTimeout(e) ? 'timeout' : 'network')
    }
  }

  /** Map a non-2xx response; drops the stored token on 401. Never includes body text. */
  async function fail(res: Response, sentBearer: boolean): Promise<never> {
    // Drain (bounded). Only an allowlisted `error.code` string is read; no text is surfaced.
    const body = await readBounded(res, 64 * 1024).catch(() => undefined)
    const status = res.status
    const known = serverCode(body)
    if (known === 'quota_exceeded') {
      const retryAfterS = parseRetryAfter(res.headers.get('retry-after'), now())
      throw new CloudError('quota_exceeded', retryAfterS === undefined ? { status } : { status, retryAfterS })
    }
    if (known && status >= 500) throw new CloudError(known, { status })
    if (known && status >= 400 && MEETING_4XX.has(known)) {
      const missing = known === 'chunks_missing' ? missingSeqs(body) : undefined
      throw new CloudError(known, missing === undefined ? { status } : { status, missing })
    }
    if (status === 401) {
      if (sentBearer) deps.tokens.clear()
      throw new CloudError('unauthorized', { status })
    }
    if (status === 403) throw new CloudError('forbidden', { status })
    if (status === 429) {
      const retryAfterS = parseRetryAfter(res.headers.get('retry-after'), now())
      throw new CloudError('rate_limited', retryAfterS === undefined ? { status } : { status, retryAfterS })
    }
    if (status === 413) throw new CloudError('too_large', { status })
    if (status >= 500) throw new CloudError('server', { status })
    throw new CloudError('bad_response', { status })
  }

  async function call(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
    expect: 'json' | 'empty',
    ms: number = timeoutMs,
    raw?: { bytes: Uint8Array; contentType: string; headers: Record<string, string> },
    max: number = maxBytes
  ): Promise<unknown> {
    const base = origin()
    const bearer = auth ? bearerFor(base) : null
    const signal = AbortSignal.timeout(ms)
    const res = await send(base, method, path, body, bearer, signal, 'application/json', raw)
    if (!res.ok) return fail(res, bearer !== null)
    if (expect === 'empty') {
      await readBounded(res, maxBytes)
      return undefined
    }
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel().catch(() => undefined)
      throw new CloudError('bad_response', { status: res.status })
    }
    const buf = await readBounded(res, max)
    try {
      return JSON.parse(buf.toString('utf8')) as unknown
    } catch {
      throw new CloudError('bad_response', { status: res.status })
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const r = schema.safeParse(value)
    if (!r.success) throw new CloudError('bad_response')
    return r.data
  }

  return {
    origin,

    async signIn() {
      const base = origin()
      const identity = deps.getPublicIdentity()
      if (!identity) throw new CloudError('no_identity')
      const raw = Buffer.from(identity.public_key, 'base64url')
      if (raw.length !== 32 || raw.toString('base64url') !== identity.public_key) throw new CloudError('no_identity')
      const publicKey = raw.toString('base64url')
      const ch = parse(ChallengeSchema, await call('POST', '/v1/auth/challenge', { public_key: publicKey }, false, 'json'))
      // Bind the signature to this server: a challenge minted for another audience is never signed.
      if (ch.audience !== base) throw new CloudError('forbidden', { detail: tr('Server identity does not match the configuration; nothing was signed', '服务器身份与配置不一致，未签名') })
      if (Date.parse(ch.expires_at) <= now().getTime()) throw new CloudError('bad_response')
      let signature: Buffer
      try {
        signature = deps.sign(authMessage(ch.audience, ch.challenge_id, ch.nonce, fingerprintOf(raw)))
      } catch {
        throw new CloudError('no_identity')
      }
      const v = parse(
        VerifySchema,
        await call('POST', '/v1/auth/verify', { challenge_id: ch.challenge_id, public_key: publicKey, signature: signature.toString('base64url') }, false, 'json')
      )
      if (Date.parse(v.expires_at) <= now().getTime()) throw new CloudError('bad_response')
      // Re-check: cloud may have been turned off / re-pointed while the exchange was in flight.
      if (origin() !== base) throw new CloudError('disabled')
      // Bind the token to the identity that signed in (identity reset ⇒ signed out; token.ts).
      deps.tokens.save(v.token, { accountId: v.account_id, expiresAt: v.expires_at, origin: base, fingerprint: fingerprintOf(raw) })
      return { accountId: v.account_id, expiresAt: v.expires_at }
    },

    async session() {
      const s = parse(SessionSchema, await call('GET', '/v1/auth/session', undefined, true, 'json'))
      return { accountId: s.account_id, fingerprint: s.fingerprint, expiresAt: s.expires_at }
    },

    async signOut(opts = {}) {
      origin()
      try {
        await call('POST', '/v1/auth/logout', undefined, true, 'empty', opts.timeoutMs ?? timeoutMs)
      } finally {
        deps.tokens.clear()
      }
    },

    async deleteAccount() {
      await call('DELETE', '/v1/account', undefined, true, 'empty')
      deps.tokens.clear()
    },

    async requestJson(method, path, body, schema, opts = {}) {
      return parse(schema, await call(method, path, body, true, 'json', opts.timeoutMs ?? timeoutMs, undefined, opts.maxResponseBytes ?? maxBytes))
    },

    async putBytes(path, bytes, contentType, headers, schema, opts = {}) {
      if (!/^audio\/[a-z0-9.+-]{1,32}(?:;\s?codecs=[a-z0-9.,-]{1,32})?$/i.test(contentType)) throw new CloudError('invalid_args')
      if (!(bytes instanceof Uint8Array)) throw new CloudError('invalid_args')
      const extra: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers)) {
        if (!/^x-[a-z0-9-]{1,48}$/i.test(k) || !/^[\x20-\x7e]{0,256}$/.test(v)) throw new CloudError('invalid_args')
        extra[k.toLowerCase()] = v
      }
      const raw = { bytes, contentType, headers: extra }
      return parse(schema, await call('PUT', path, undefined, true, 'json', opts.timeoutMs ?? timeoutMs, raw, opts.maxResponseBytes ?? maxBytes))
    },

    async requestEmpty(method, path, body) {
      await call(method, path, body, true, 'empty')
    },

    async *stream(path, body, opts = {}) {
      const base = origin()
      const bearer = bearerFor(base)
      const timeout = AbortSignal.timeout(deps.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS)
      const user = opts.signal
      const signal = user ? AbortSignal.any([timeout, user]) : timeout
      let res: Response
      try {
        res = await send(base, 'POST', path, body, bearer, signal, 'text/event-stream')
      } catch (e) {
        if (user?.aborted) return
        throw e
      }
      if (!res.ok) return void (await fail(res, true))
      if (!/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '') || !res.body) {
        await res.body?.cancel().catch(() => undefined)
        throw new CloudError('bad_response', { status: res.status })
      }
      try {
        yield* parseSse(res.body, { signal, maxEventBytes: deps.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES })
      } catch (e) {
        if (e instanceof CloudError) throw e
        if (user?.aborted && !timeout.aborted) return
        throw new CloudError(timeout.aborted || isTimeout(e) ? 'timeout' : 'network')
      }
    }
  }
}
