import type { IncomingMessage, ServerResponse } from 'node:http'

/** An error that maps 1:1 to a contract error response. `message` must be safe to show. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>
  /** Extra fields merged into the `error` object (e.g. `missing` for chunks_missing). Must be safe to show. */
  readonly extra: Record<string, unknown>
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.headers = headers
    this.extra = extra
  }
}

const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text))
  })
  res.end(text)
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, BASE_HEADERS)
  res.end()
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, { error: { ...err.extra, code: err.code, message: err.message } }, err.headers)
}

function hasBody(req: IncomingMessage): boolean {
  const len = req.headers['content-length']
  if (len !== undefined) return len !== '0'
  return req.headers['transfer-encoding'] !== undefined
}

function isJsonType(req: IncomingMessage): boolean {
  const ct = req.headers['content-type']
  if (typeof ct !== 'string') return false
  const [type, ...params] = ct.split(';').map((s) => s.trim().toLowerCase())
  if (type !== 'application/json') return false
  for (const p of params) {
    if (p.startsWith('charset=') && p !== 'charset=utf-8' && p !== 'charset="utf-8"') return false
  }
  return true
}

/**
 * Reads the body as JSON. Enforces JSON content-type (415) and the byte cap (413).
 * `required`: a missing/empty body is 400 invalid_request; otherwise returns null.
 * Any body present must be application/json.
 */
export async function readJson(req: IncomingMessage, limit: number, required: boolean): Promise<Record<string, unknown> | null> {
  const present = hasBody(req)
  if (!present) {
    if (required) {
      if (!isJsonType(req)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json')
      throw new HttpError(400, 'invalid_request', 'Request body is required')
    }
    return null
  }
  if (!isJsonType(req)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json')
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpError(413, 'payload_too_large', 'Request body too large')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body too large')
    chunks.push(chunk)
  }
  if (size === 0) {
    if (required) throw new HttpError(400, 'invalid_request', 'Request body is required')
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not valid UTF-8 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_request', 'Body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(h.trim())
  return m ? m[1] : null
}

function mediaType(req: IncomingMessage): string {
  const ct = req.headers['content-type']
  return typeof ct === 'string' ? ct.split(';')[0].trim().toLowerCase() : ''
}

export function isFormType(req: IncomingMessage): boolean {
  return mediaType(req) === 'application/x-www-form-urlencoded'
}

export function isJsonRequest(req: IncomingMessage): boolean {
  return mediaType(req) === 'application/json'
}

/** Reads an application/x-www-form-urlencoded body (415 otherwise, 413 over `limit`). Empty body = empty params. */
export async function readForm(req: IncomingMessage, limit: number): Promise<URLSearchParams> {
  if (!hasBody(req)) return new URLSearchParams()
  if (!isFormType(req)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/x-www-form-urlencoded')
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpError(413, 'payload_too_large', 'Request body too large')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body too large')
    chunks.push(chunk)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new HttpError(400, 'invalid_request', 'Body is not valid UTF-8')
  }
  return new URLSearchParams(text)
}

/** Query parameters of the request URL (never logged). */
export function queryParams(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? '/'
  const qi = raw.indexOf('?')
  return new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1))
}

/**
 * Reads a raw (non-JSON) body up to `limit` bytes (413 above it, declared or streamed).
 * The caller checks the content-type first. Empty body = empty buffer.
 * `discardUpTo` (> limit): an oversized body up to this many bytes is read and thrown away before the 413,
 * so an ordinary HTTP client sees the 413 instead of a connection reset mid-upload.
 */
export async function readRaw(req: IncomingMessage, limit: number, discardUpTo = limit): Promise<Buffer> {
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > discardUpTo)) {
    throw new HttpError(413, 'payload_too_large', 'Request body too large')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > discardUpTo) throw new HttpError(413, 'payload_too_large', 'Request body too large')
    if (size <= limit) chunks.push(chunk)
  }
  if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body too large')
  return Buffer.concat(chunks, size)
}
