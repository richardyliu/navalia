import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { canonicalize } from '../identity/canonical'
import { GrantError, type GrantStore } from '../identity/grants'
import type { GrantView, Scope } from '../identity/grants-schema'
import type { AuditLog } from './audit'
import { deepScrub, scrubKeepingOpaque } from './scrub'
import { TOOLS, type BrokerBackend, type ToolDef } from './tools'

export const BROKER_HOST = '127.0.0.1'
export const BROKER_PORT = 8750
export const BROKER_PATH = '/mcp'
const MAX_BODY = 1024 * 1024

export interface BrokerOptions {
  grants: GrantStore
  audit: AuditLog
  backend: BrokerBackend
  /** 0 = ephemeral (tests). Host is always 127.0.0.1. */
  port?: number
  /**
   * Plain JSON REST routes on the same loopback server (OG-08: `/het/*`). Same Host/Origin
   * checks, same Bearer grant auth, same Access log as MCP tools. Matched by path prefix.
   */
  rest?: BrokerRestRouter[]
}

/**
 * One REST operation. `validate` runs before a grant use is consumed (invalid input never costs
 * a read); `run` receives only validated input and must return sanitized errors.
 */
export interface BrokerRestEndpoint<T = unknown> {
  /** Access-log capability name. */
  capability: string
  write: boolean
  /** Lens-extension scopes allowed for scoped grants; [] = full-access grants only. */
  scopes: Scope[]
  /** May spend LLM budget (e.g. triggers assessor work): refused when the agent budget is closed, like MCP `meta.llm`. */
  llm?: boolean
  /**
   * Keys whose string values are opaque Lens-generated tokens (ids, cursors) that the PII
   * scrubber would mangle (long base64url runs look like secrets). They pass unscrubbed only
   * if they match OPAQUE_RE (no '/', '@', ':', '.', spaces → cannot carry a path, email or URL).
   */
  opaqueKeys?: string[]
  validate(input: { query: URLSearchParams; body: unknown }): { ok: true; value: T } | { ok: false; result: BrokerRestResult }
  run(value: T): Promise<BrokerRestResult> | BrokerRestResult
}

export interface BrokerRestResult {
  status: number
  body: unknown
  itemIds?: string[]
  count?: number
  errorCode?: string
}

export interface BrokerRestRouter {
  /** Path prefix, e.g. '/het/'. */
  prefix: string
  resolve(method: string, pathname: string): BrokerRestEndpoint<unknown> | { status: 404 | 405; code: string }
}

export interface Broker {
  start(): Promise<{ host: string; port: number; url: string }>
  stop(): Promise<void>
  readonly url: string | null
}

const OPAQUE_RE = /^[A-Za-z0-9_-]{1,512}$/

/**
 * PII-scrub a REST response body exactly like MCP tool results (deepScrub), except values under
 * `opaqueKeys` that are provably opaque tokens (OPAQUE_RE). Keys are scrubbed too.
 */
export function scrubRestBody(value: unknown, opaqueKeys: ReadonlySet<string>, depth = 0): unknown {
  return scrubKeepingOpaque(value, opaqueKeys, OPAQUE_RE, depth)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function safeCanonical(v: unknown): string {
  try {
    return canonicalize(v ?? {})
  } catch {
    return JSON.stringify(v ?? {}) ?? '{}'
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function rpcError(status: number, message: string, id: unknown = null) {
  return { jsonrpc: '2.0', id, error: { code: status === 401 ? -32001 : -32003, message } }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 })
  }
}

/** The tool name of a JSON-RPC tools/call body (single or batch), for audit rows of denied requests. */
function capabilityOf(body: unknown): string {
  const msgs = Array.isArray(body) ? body : [body]
  for (const m of msgs) {
    const o = m as { method?: unknown; params?: { name?: unknown } }
    if (o?.method === 'tools/call' && typeof o.params?.name === 'string') return o.params.name.slice(0, 64)
  }
  const first = msgs[0] as { method?: unknown } | undefined
  return typeof first?.method === 'string' ? `rpc:${first.method.slice(0, 48)}` : 'http'
}

export function createBroker(options: BrokerOptions): Broker {
  const { grants, audit, backend } = options
  let server: http.Server | null = null
  let url: string | null = null
  let port = options.port ?? BROKER_PORT

  function allowedHost(host: string | undefined): boolean {
    return host === `${BROKER_HOST}:${port}` || host === `localhost:${port}`
  }

  function allowedOrigin(origin: string | undefined): boolean {
    // Non-browser MCP clients send no Origin. A browser page on any other origin is refused.
    return origin === undefined || origin === `http://${BROKER_HOST}:${port}` || origin === `http://localhost:${port}`
  }

  function auditDenied(grant: GrantView | null, capability: string, args: unknown, err: GrantError | { code: string; httpStatus: number }, t0: number) {
    const argsText = safeCanonical(args)
    audit.record({
      grantId: grant?.id ?? null,
      client: grant?.client ?? 'unknown',
      capability,
      argsSha256: sha256(argsText),
      argsPreview: JSON.stringify(deepScrub(args ?? {})),
      itemIds: [],
      itemCount: 0,
      responseChars: 0,
      resultPreview: '',
      outcome: err.httpStatus === 401 ? 'unauthorized' : 'denied',
      httpStatus: err.httpStatus,
      errorCode: err.code,
      durationMs: Date.now() - t0
    })
  }

  function buildServer(token: string, grant: GrantView): Server {
    const server = new Server({ name: 'navalia-broker', version: '0.2.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
        annotations: { readOnlyHint: !t.meta.write, destructiveHint: t.meta.write, openWorldHint: false }
      }))
    }))
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name
      const args = (req.params.arguments ?? {}) as Record<string, unknown>
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) {
        const t0 = Date.now()
        auditRow(grant, name.slice(0, 64), args, { outcome: 'error', httpStatus: 404, errorCode: 'unknown_tool' }, t0)
        return { isError: true, content: [{ type: 'text' as const, text: `unknown tool: ${name.slice(0, 64)}` }] }
      }
      return runTool(tool, token, grant, args)
    })
    return server
  }

  function auditRow(
    grant: GrantView | null,
    capability: string,
    args: unknown,
    r: { outcome: 'ok' | 'denied' | 'error' | 'unauthorized'; httpStatus: number; errorCode: string | null; itemIds?: string[]; count?: number; chars?: number; preview?: string },
    t0: number
  ) {
    const argsText = safeCanonical(args)
    audit.record({
      grantId: grant?.id ?? null,
      client: grant?.client ?? 'unknown',
      capability,
      argsSha256: sha256(argsText),
      argsPreview: JSON.stringify(deepScrub(args ?? {})),
      itemIds: r.itemIds ?? [],
      itemCount: r.count ?? 0,
      responseChars: r.chars ?? 0,
      resultPreview: r.preview ?? '',
      outcome: r.outcome,
      httpStatus: r.httpStatus,
      errorCode: r.errorCode,
      durationMs: Date.now() - t0
    })
  }

  async function runTool(tool: ToolDef, token: string, initial: GrantView, rawArgs: Record<string, unknown>) {
    const t0 = Date.now()
    let grant = initial
    try {
      // Re-check on every call so a revoke/expiry between requests and calls applies immediately.
      grant = grants.authorize(token)
      if (grant.access.mode === 'scoped' && !tool.meta.scopes.some((s) => (grant.access as { scopes: string[] }).scopes.includes(s))) {
        throw new GrantError('scope_denied', `grant lacks any of: ${tool.meta.scopes.join(', ')} (Navalia extension)`, grant)
      }
    } catch (error) {
      const e = error instanceof GrantError ? error : new GrantError('invalid_token', 'authorization failed')
      auditDenied(e.grant ?? grant, tool.name, rawArgs, e, t0)
      return { isError: true, content: [{ type: 'text' as const, text: `${e.httpStatus} ${e.code}: ${e.message}` }] }
    }

    const parsed = tool.validate.safeParse(rawArgs)
    if (!parsed.success) {
      auditRow(grant, tool.name, rawArgs, { outcome: 'error', httpStatus: 400, errorCode: 'invalid_args', preview: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, t0)
      return { isError: true, content: [{ type: 'text' as const, text: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` }] }
    }
    const args = parsed.data as Record<string, unknown>

    // Tools that may spend LLM budget fail closed before anything reaches the runtime.
    if (tool.meta.llm) {
      const b = backend.budget()
      if (!b.enabled || b.exhausted) {
        auditRow(grant, tool.name, args, { outcome: 'denied', httpStatus: 429, errorCode: 'budget_exhausted', preview: b.enabled ? 'agent budget exhausted' : 'agent budget disabled' }, t0)
        return { isError: true, content: [{ type: 'text' as const, text: `budget_exhausted: ${b.enabled ? 'the agent LLM budget is used up for today' : 'agent LLM budget is not enabled'}; nothing was run` }] }
      }
    }

    try {
      grant = grants.authorize(token, { consume: true })
      const out = await tool.run(args, grant, { backend, audit })
      // A truncated read is still a successful read (logged as ok); errorCode 'truncated' marks it in the Access log.
      auditRow(grant, tool.name, args, { outcome: 'ok', httpStatus: 200, errorCode: out.truncated ? 'truncated' : null, itemIds: out.itemIds, count: out.count, chars: out.responseChars, preview: out.preview }, t0)
      return { content: out.content }
    } catch (error) {
      if (error instanceof GrantError) {
        auditDenied(error.grant ?? grant, tool.name, args, error, t0)
        return { isError: true, content: [{ type: 'text' as const, text: `${error.httpStatus} ${error.code}: ${error.message}` }] }
      }
      const message = String(deepScrub(error instanceof Error ? error.message : String(error)))
      auditRow(grant, tool.name, args, { outcome: 'error', httpStatus: 502, errorCode: (error as { code?: string })?.code ?? 'backend_error', preview: message }, t0)
      return { isError: true, content: [{ type: 'text' as const, text: `upstream error: ${message}` }] }
    }
  }

  /**
   * REST: auth (headers only) → resolve → scope → read body → validate → LLM budget gate →
   * consume one grant use → run → PII scrub → Access log. Nothing is read from the body before
   * the Bearer grant is authorized; invalid input never consumes a use. Errors are fixed codes.
   */
  async function handleRest(router: BrokerRestRouter, req: http.IncomingMessage, res: http.ServerResponse, pathname: string, t0: number): Promise<void> {
    const restError = (code: string, message: string) => ({ error: { code, message } })
    res.setHeader('cache-control', 'no-store')
    const method = req.method ?? 'GET'
    const query = new URL(req.url ?? '/', `http://${BROKER_HOST}`).searchParams
    const target = router.resolve(method, pathname)
    const capability = 'capability' in target ? target.capability : `rest:${pathname.slice(0, 48)}`
    const argsOf = (body: unknown) => ({ query: Object.fromEntries(query), ...(body === undefined ? {} : { body }) })
    // Refusals before the body is read: don't keep a keep-alive socket around an unread body.
    const refuseEarly = (status: number, body: unknown) => {
      if (method === 'POST') res.setHeader('connection', 'close')
      return sendJson(res, status, body)
    }

    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    let grant: GrantView
    try {
      grant = grants.authorize(token)
    } catch (error) {
      const e = error instanceof GrantError ? error : new GrantError('invalid_token', 'authorization failed')
      auditDenied(e.grant, capability, argsOf(undefined), e, t0)
      if (e.httpStatus === 401) res.setHeader('www-authenticate', 'Bearer')
      return refuseEarly(e.httpStatus, restError(e.code, e.message))
    }

    if (!('capability' in target)) return refuseEarly(target.status, restError(target.code, target.code === 'not_found' ? 'not found' : 'method not allowed'))
    if (grant.access.mode === 'scoped' && !target.scopes.some((s) => (grant.access as { scopes: string[] }).scopes.includes(s))) {
      const e = new GrantError('scope_denied', target.scopes.length ? `grant lacks any of: ${target.scopes.join(', ')} (Navalia extension)` : 'requires a full-access grant', grant)
      auditDenied(grant, capability, argsOf(undefined), e, t0)
      return refuseEarly(e.httpStatus, restError(e.code, e.message))
    }

    let body: unknown
    try {
      body = method === 'POST' ? await readBody(req) : undefined
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400
      const code = status === 413 ? 'body_too_large' : 'invalid_json'
      // Audited as an error row; the offending body is never echoed or recorded.
      auditRow(grant, capability, argsOf(undefined), { outcome: 'error', httpStatus: status, errorCode: code }, t0)
      return refuseEarly(status, restError(code, status === 413 ? 'body too large' : 'invalid JSON'))
    }

    let valid: { ok: true; value: unknown } | { ok: false; result: BrokerRestResult }
    try {
      valid = target.validate({ query, body })
    } catch {
      valid = { ok: false, result: { status: 400, body: restError('invalid_request', 'invalid request'), errorCode: 'invalid_request' } }
    }
    if (!valid.ok) {
      const r = valid.result
      auditRow(grant, capability, argsOf(body), { outcome: 'error', httpStatus: r.status, errorCode: r.errorCode ?? 'invalid_request' }, t0)
      return sendJson(res, r.status, deepScrub(r.body))
    }

    // Same fail-closed gate as MCP tools with meta.llm: nothing runs, no grant use is consumed.
    if (target.llm) {
      const b = backend.budget()
      if (!b.enabled || b.exhausted) {
        const why = b.enabled ? 'agent budget exhausted' : 'agent budget disabled'
        auditRow(grant, capability, argsOf(body), { outcome: 'denied', httpStatus: 429, errorCode: 'budget_exhausted', preview: why }, t0)
        return sendJson(res, 429, restError('budget_exhausted', `${b.enabled ? 'the agent LLM budget is used up for today' : 'agent LLM budget is not enabled'}; nothing was run`))
      }
    }

    let out: BrokerRestResult
    try {
      grant = grants.authorize(token, { consume: true })
      out = await target.run(valid.value)
    } catch (error) {
      if (error instanceof GrantError) {
        auditDenied(error.grant ?? grant, capability, argsOf(body), error, t0)
        return sendJson(res, error.httpStatus, restError(error.code, error.message))
      }
      auditRow(grant, capability, argsOf(body), { outcome: 'error', httpStatus: 500, errorCode: 'internal_error' }, t0)
      return sendJson(res, 500, restError('internal_error', 'internal error'))
    }
    // F2: the response body is PII-scrubbed exactly like MCP results (not just the audit preview).
    const safe = scrubRestBody(out.body, new Set(target.opaqueKeys ?? []))
    const text = JSON.stringify(safe)
    const okStatus = out.status >= 200 && out.status < 300
    auditRow(
      grant,
      capability,
      argsOf(body),
      {
        outcome: okStatus ? 'ok' : 'error',
        httpStatus: out.status,
        errorCode: okStatus ? null : (out.errorCode ?? 'error'),
        itemIds: out.itemIds,
        count: out.count ?? 0,
        chars: okStatus ? text.length : 0,
        preview: text
      },
      t0
    )
    res.writeHead(out.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t0 = Date.now()
    if (!allowedHost(req.headers.host)) return sendJson(res, 421, rpcError(403, 'host not allowed'))
    if (!allowedOrigin(req.headers.origin)) return sendJson(res, 403, rpcError(403, 'origin not allowed'))
    const pathname = (req.url ?? '/').split('?')[0]
    const router = options.rest?.find((r) => pathname.startsWith(r.prefix))
    if (router) return handleRest(router, req, res, pathname, t0)
    if (pathname !== BROKER_PATH) return sendJson(res, 404, rpcError(404, 'not found'))

    let body: unknown
    try {
      body = await readBody(req)
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400
      return sendJson(res, status, rpcError(status, (error as Error).message))
    }

    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    let grant: GrantView
    try {
      grant = grants.authorize(token)
    } catch (error) {
      const e = error instanceof GrantError ? error : new GrantError('invalid_token', 'authorization failed')
      auditDenied(e.grant, capabilityOf(body), (body as { params?: { arguments?: unknown } })?.params?.arguments ?? {}, e, t0)
      if (e.httpStatus === 401) res.setHeader('www-authenticate', 'Bearer')
      return sendJson(res, e.httpStatus, rpcError(e.httpStatus, `${e.code}: ${e.message}`))
    }

    const mcp = buildServer(token, grant)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  return {
    get url() {
      return url
    },
    start() {
      return new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          handle(req, res).catch((error) => {
            if (!res.headersSent) sendJson(res, 500, rpcError(500, error instanceof Error ? error.message : 'internal error'))
            else res.end()
          })
        })
        s.once('error', reject)
        s.listen(port, BROKER_HOST, () => {
          const addr = s.address() as AddressInfo
          port = addr.port
          server = s
          url = `http://${BROKER_HOST}:${port}${BROKER_PATH}`
          resolve({ host: addr.address, port, url })
        })
      })
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve()
        server.closeAllConnections?.()
        server.close(() => resolve())
        server = null
        url = null
      })
    }
  }
}
