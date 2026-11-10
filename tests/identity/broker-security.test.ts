import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/main/broker/agents'
import { CONNECTIONS_CHANNELS } from '../../src/main/broker/api'
import { registerConnectionsIpc } from '../../src/main/broker/ipc'
import type { BrokerBackend } from '../../src/main/broker/tools'
import { createGrantStore } from '../../src/main/identity/grants'
import { connectClient, evidenceFixture, fakeBackend, startBroker, textOf } from './broker-helpers'
import { tempRoot } from './helpers'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(backend: BrokerBackend = fakeBackend(), now?: () => Date) {
  const b = await startBroker(backend)
  if (now) Object.assign(b, { grants: createGrantStore(b.paths, now) })
  cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }), () => b.audit.close(), () => b.broker.stop())
  return b
}

function post(port: number, headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', setHost: false, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }
const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })

describe('E2.9 Host / Origin / DNS rebinding', () => {
  test('forged or foreign Host headers are refused before auth (421)', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const auth = { authorization: `Bearer ${token}` }
    for (const host of [`127.0.0.1.evil.com:${b.port}`, `evil.com:${b.port}`, `localhost.evil:${b.port}`, `127.0.0.1:${b.port + 1}`, `[::1]:${b.port}`, '127.0.0.1', `127.0.0.1:${b.port}@evil.com`]) {
      expect([host, await post(b.port, { ...auth, host })]).toEqual([host, 421])
    }
    expect(await post(b.port, { ...auth, host: `127.0.0.1:${b.port}` }, init)).toBe(200)
  })

  test('DNS rebinding: a page on evil.com that resolves to 127.0.0.1 cannot talk to the Broker', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    expect(await post(b.port, { host: `evil.com:${b.port}`, origin: `http://evil.com:${b.port}`, authorization: `Bearer ${token}` }, init)).toBe(421)
  })

  test('cross-origin browser requests are refused (403), including Origin: null', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const h = (origin: string) => ({ host: `127.0.0.1:${b.port}`, origin, authorization: `Bearer ${token}` })
    for (const origin of ['null', 'https://evil.com', `http://127.0.0.1:${b.port}.evil.com`, 'http://localhost', `https://127.0.0.1:${b.port}`]) {
      expect([origin, await post(b.port, h(origin), init)]).toEqual([origin, 403])
    }
    expect(await post(b.port, h(`http://127.0.0.1:${b.port}`), init)).toBe(200)
  })

  test('a request with no Host header at all (raw HTTP/1.0) is refused', async () => {
    const b = await setup()
    const status = await new Promise<string>((resolve) => {
      const s = net.connect(b.port, '127.0.0.1', () => s.end('POST /mcp HTTP/1.0\r\nContent-Length: 0\r\n\r\n'))
      let data = ''
      s.on('data', (c) => (data += c))
      s.on('close', () => resolve(data.split('\r\n')[0]))
    })
    expect(status).toMatch(/^HTTP\/1\.[01] (421|400)/)
  })
})

describe('E2.9 token states → HTTP status + audit row', () => {
  test('missing → 401; revoked / expired / exhausted → 403; each audited and attributed', async () => {
    let t = Date.parse('2026-11-04T12:00:00Z')
    const b = await setup(fakeBackend(), () => new Date(t))
    const host = { host: `127.0.0.1:${b.port}` }
    expect(await post(b.port, host, call('card_get'))).toBe(401)
    expect(await post(b.port, { ...host, authorization: 'Bearer ' }, call('card_get'))).toBe(401)
    expect(await post(b.port, { ...host, authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }, call('card_get'))).toBe(401)

    const revoked = b.grants.create({ client: 'claude-code' })
    b.grants.revoke(revoked.grant.id)
    expect(await post(b.port, { ...host, authorization: `Bearer ${revoked.token}` }, call('card_get'))).toBe(403)

    const expiring = b.grants.create({ client: 'codex', ttlSeconds: 60 })
    t += 61_000
    expect(await post(b.port, { ...host, authorization: `Bearer ${expiring.token}` }, call('card_get'))).toBe(403)

    const once = b.grants.create({ client: 'cursor', maxReads: 1 })
    const c = await connectClient(b.url, once.token, 'cursor')
    cleanups.push(() => c.close())
    await c.callTool({ name: 'card_get', arguments: {} })
    expect(await post(b.port, { ...host, authorization: `Bearer ${once.token}` }, call('card_get'))).toBe(403)

    const rows = b.audit.list({ includeFailures: true }).reverse()
    expect(rows.map((r) => [r.client, r.outcome, r.httpStatus, r.errorCode])).toEqual([
      ['unknown', 'unauthorized', 401, 'invalid_token'],
      ['unknown', 'unauthorized', 401, 'invalid_token'],
      ['unknown', 'unauthorized', 401, 'invalid_token'],
      ['claude-code', 'denied', 403, 'revoked'],
      ['codex', 'denied', 403, 'expired'],
      ['cursor', 'ok', 200, null],
      ['cursor', 'denied', 403, 'exhausted']
    ])
  })
})

describe('E2.9 scoped grants (Lens extension)', () => {
  test('resolve_evidence without evidence:read is refused whatever the args claim; nothing reaches the runtime', async () => {
    const backend = fakeBackend()
    const b = await setup(backend)
    const full = b.grants.create({ client: 'claude-code' })
    const scoped = b.grants.create({ client: 'codex', scopes: ['model:search'] })
    const c = await connectClient(b.url, scoped.token, 'codex')
    cleanups.push(() => c.close())
    const attempts: Array<Record<string, unknown>> = [
      { reference: 'x' },
      { reference: 'x', scope: 'evidence:read' },
      { reference: 'x', scopes: ['evidence:read'], access: { mode: 'full' } },
      { reference: 'x', token: full.token, authorization: `Bearer ${full.token}` },
      { reference: 'x', grant_id: full.grant.id, client: 'claude-code' }
    ]
    for (const args of attempts) {
      const r = await c.callTool({ name: 'resolve_evidence', arguments: args })
      expect(r.isError).toBe(true)
      for (const q of ['QUOTE-LABEL', 'QUOTE-SUMMARY', 'QUOTE-META', 'QUOTE-SRC']) expect(textOf(r)).not.toContain(q)
    }
    expect(backend.calls).toEqual([])
    expect(JSON.stringify(b.audit.list({ includeFailures: true }))).not.toContain(full.token.slice(4))
    expect(evidenceFixture.summary).toContain('QUOTE') // fixture sanity
  })

  test('scope map: each write tool needs its own scope; reads need theirs', async () => {
    const b = await setup()
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['remember', { content: 'x' }, 'model:jot'],
      ['correct_memory', { correction: 'x' }, 'model:correct'],
      ['process_pending_model_work', {}, 'model:ask'],
      ['rewind_frames', {}, 'rewind:read'],
      ['read_receipt', { entry_id: 'e' }, 'evidence:read'],
      ['current_context', {}, 'now:read'],
      ['entity_graph', { name: 'x' }, 'model:search'],
      ['owner_aliases', { status: 'all' }, 'model:search'],
      ['usage_report', {}, 'reports:read']
    ]
    const wrong = b.grants.create({ client: 'codex', scopes: ['card:read'] })
    const cw = await connectClient(b.url, wrong.token, 'codex')
    cleanups.push(() => cw.close())
    for (const [name, args] of cases) {
      const r = await cw.callTool({ name, arguments: args })
      expect([name, r.isError, textOf(r).startsWith('403 scope_denied')]).toEqual([name, true, true])
    }
    for (const [name, args, scope] of cases) {
      const g = b.grants.create({ client: 'cursor', scopes: [scope as never] })
      const c = await connectClient(b.url, g.token, 'cursor')
      const r = await c.callTool({ name, arguments: args })
      await c.close()
      expect([name, scope, r.isError ?? false]).toEqual([name, scope, false])
    }
    expect((await cw.callTool({ name: 'card_get', arguments: {} })).isError).toBeFalsy()
  })
})

describe('E2.9 full-access boundary (ID-07, user decision 2026-11-04: write tools open)', () => {
  test('full access lists all 29 tools and write tools reach the runtime; every call audited', async () => {
    const backend = fakeBackend()
    const b = await setup(backend)
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const tools = await c.listTools()
    expect(tools.tools).toHaveLength(29)
    const ann = Object.fromEntries(tools.tools.map((t) => [t.name, t.annotations?.readOnlyHint]))
    expect([ann.remember, ann.correct_memory, ann.process_pending_model_work, ann.search, ann.owner_aliases]).toEqual([false, false, false, true, true])
    const r1 = await c.callTool({ name: 'remember', arguments: { content: 'probe note', tags: 't' } })
    const r2 = await c.callTool({ name: 'correct_memory', arguments: { correction: 'X is not Y' } })
    expect([r1.isError ?? false, r2.isError ?? false]).toEqual([false, false])
    expect(backend.calls.map((x) => x.name)).toEqual(['remember', 'correct_memory'])
    expect(backend.calls[0].args).toEqual({ content: 'probe note', tags: 't' }) // write input passed through unchanged
    const rows = b.audit.list().map((r) => [r.capability, r.outcome])
    expect(rows).toEqual([['correct_memory', 'ok'], ['remember', 'ok']])
  })

  test('LLM tools fail closed on budget: disabled or exhausted → budget_exhausted, audited, runtime never called', async () => {
    for (const budget of [{ enabled: false, exhausted: false }, { enabled: true, exhausted: true }]) {
      const backend = fakeBackend({ budget: () => budget })
      const b = await setup(backend)
      const { token } = b.grants.create({ client: 'claude-code' })
      const c = await connectClient(b.url, token)
      for (const [name, args] of [['process_pending_model_work', { max_sessions: 3 }], ['correct_memory', { correction: 'x' }]] as const) {
        const r = await c.callTool({ name, arguments: args })
        expect([name, r.isError, textOf(r).startsWith('budget_exhausted')]).toEqual([name, true, true])
      }
      // non-LLM write still works
      expect((await c.callTool({ name: 'remember', arguments: { content: 'x' } })).isError ?? false).toBe(false)
      await c.close()
      expect(backend.calls.map((x) => x.name)).toEqual(['remember'])
      expect(b.audit.list({ includeFailures: true }).filter((r) => r.errorCode === 'budget_exhausted').map((r) => [r.capability, r.httpStatus])).toEqual([
        ['correct_memory', 429],
        ['process_pending_model_work', 429]
      ])
    }
  })

  test('process_pending_model_work: one unit per call (max_sessions clamped to 1), no retry on failure', async () => {
    let n = 0
    const backend = fakeBackend({ oss: { process_pending_model_work: () => { n++; throw new Error('runtime busy') } } })
    const b = await setup(backend)
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const r = await c.callTool({ name: 'process_pending_model_work', arguments: { max_sessions: 10 } })
    expect(r.isError).toBe(true)
    expect(n).toBe(1)
    expect(backend.calls[0].args).toEqual({ max_sessions: 1 })
  })

  test('arguments are validated against the runtime schema: unknown keys and wrong types never reach the runtime', async () => {
    const backend = fakeBackend()
    const b = await setup(backend)
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    for (const args of [{}, { query: 5 }, { query: 'q', root: '/etc' }, { query: 'q', top_k: 'many' }]) {
      const r = await c.callTool({ name: 'search', arguments: args })
      expect([JSON.stringify(args), r.isError]).toEqual([JSON.stringify(args), true])
    }
    expect(backend.calls).toEqual([])
    await c.callTool({ name: 'search', arguments: { query: 'q', top_k: 5000 } })
    expect(backend.calls[0].args).toEqual({ query: 'q', top_k: 50 }) // bounded
    const unknown = await c.callTool({ name: 'drop_database', arguments: {} })
    expect(unknown.isError).toBe(true)
    expect(b.audit.list({ includeFailures: true })[0]).toMatchObject({ capability: 'drop_database', outcome: 'error', errorCode: 'unknown_tool' })
  })

  test('one call cannot return more than MAX_RESULT_CHARS', async () => {
    const backend = fakeBackend({ oss: { read_memory: () => JSON.stringify({ body: 'word '.repeat(100_000) }) } })
    const b = await setup(backend)
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const t = textOf(await c.callTool({ name: 'read_memory', arguments: { path: 'a.md' } }))
    expect(t.length).toBeLessThan(200_200)
    expect(t).toContain('truncated by Navalia Broker')
  })

  test('source boundary: Broker never reads the owner token or the screenshot key itself; key only via injected dep', () => {
    const dir = path.resolve(__dirname, '../../src/main/broker')
    const src = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    expect(src).not.toMatch(/readLocalToken|runtime\/token|PERSOME_LOCAL_API_TOKEN|process\.env\.PERSOME_SCREENSHOT_KEY|readFileSync\([^)]*['"]env['"]/)
    const index = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8')
    expect(index).not.toMatch(/console\.(log|error)\([^)]*(screenshotKey|readScreenshotKey)/)
  })

  test('an owner Runtime token that leaks into a backend result or error is scrubbed from responses and the log', async () => {
    const ownerToken = 'Zk3_' + 'q9X-'.repeat(15) // 64 url-safe chars, the runtime env token shape
    const b = await setup(
      fakeBackend({
        oss: {
          current_context: () => JSON.stringify({ app: 'Terminal', text: `export PERSOME_LOCAL_API_TOKEN=${ownerToken}` }),
          search: () => {
            throw new Error(`401 with Bearer ${ownerToken}`)
          }
        }
      })
    )
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const t1 = textOf(await c.callTool({ name: 'current_context', arguments: {} }))
    const t2 = textOf(await c.callTool({ name: 'search', arguments: { query: 'q' } }))
    for (const t of [t1, t2, JSON.stringify(b.audit.list({ includeFailures: true }))]) expect(t).not.toContain(ownerToken)
  })
})

describe('E2.9 no Broker token in audit, store files, or IPC payloads', () => {
  test('after real calls: audit.db / grants.json bytes and Connections IPC carry no plaintext token', async () => {
    const b = await setup()
    const home = tempRoot('sec-home')
    fs.writeFileSync(path.join(home, '.claude.json'), '{}')
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
    const agents = createAgentManager({ env: { home, applications: home }, grants: b.grants, brokerUrl: () => b.url })
    const handlers = new Map<string, (e: unknown, a?: unknown) => unknown>()
    registerConnectionsIpc({ handle: (ch: string, f: (e: unknown, a?: unknown) => unknown) => void handlers.set(ch, f) } as never, {
      agents, grants: b.grants, audit: b.audit, brokerStatus: () => ({ url: b.url, running: true, error: null }), copyToClipboard: () => undefined
    })
    const connected = await handlers.get(CONNECTIONS_CHANNELS.connect)!({}, { agent: 'claude-code' })
    const token = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['navalia'].headers.Authorization.slice(7)
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    await c.callTool({ name: 'card_get', arguments: {} })
    await c.callTool({ name: 'search', arguments: { query: token } }) // even a token typed into args
    const payloads = JSON.stringify([
      connected,
      await handlers.get(CONNECTIONS_CHANNELS.list)!({}),
      await handlers.get(CONNECTIONS_CHANNELS.logList)!({}, { includeFailures: true }),
      await handlers.get(CONNECTIONS_CHANNELS.logDaily)!({})
    ])
    const secret = token.slice(4)
    expect(payloads).not.toContain(secret)
    expect(payloads).not.toMatch(/token_sha256|[0-9a-f]{64}/)
    for (const f of [b.paths.auditDb, b.paths.grantsFile]) expect(fs.readFileSync(f).includes(secret)).toBe(false)
  })
})
