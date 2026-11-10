import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { verifySignedCard } from '../../src/main/identity/card'
import { connectClient, fakeBackend, startBroker, textOf } from './broker-helpers'
import { createIssuedCard } from './card-helpers'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(backend = fakeBackend()) {
  const b = await startBroker(backend)
  cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }))
  cleanups.push(() => b.audit.close())
  cleanups.push(() => b.broker.stop())
  return b
}

function raw(port: number, opts: { path?: string; host?: string; origin?: string; token?: string; body?: unknown }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify(opts.body ?? { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: opts.host ?? `127.0.0.1:${port}`
    }
    if (opts.origin) headers.origin = opts.origin
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/mcp', method: 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('Broker transport and auth', () => {
  test('binds 127.0.0.1 only and is not reachable on a non-loopback interface', async () => {
    const b = await setup()
    expect(b.host).toBe('127.0.0.1')
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
    if (external) {
      await expect(
        new Promise((resolve, reject) => {
          const r = http.request({ host: external.address, port: b.port, path: '/mcp', method: 'POST', timeout: 1500 }, resolve)
          r.on('error', reject)
          r.on('timeout', () => r.destroy(new Error('timeout')))
          r.end()
        })
      ).rejects.toThrow()
    }
  })

  test('DNS-rebinding guard: foreign Host → 421, foreign Origin → 403, wrong path → 404', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    expect((await raw(b.port, { token, host: `evil.example:${b.port}` })).status).toBe(421)
    expect((await raw(b.port, { token, origin: 'https://evil.example' })).status).toBe(403)
    expect((await raw(b.port, { token, path: '/other' })).status).toBe(404)
    expect((await raw(b.port, { token, host: `localhost:${b.port}`, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } } })).status).toBe(200)
  })

  test('no / bad token → 401 + audited unauthorized; revoked → 403 + audited denied', async () => {
    const b = await setup()
    expect((await raw(b.port, {})).status).toBe(401)
    const { grant, token } = b.grants.create({ client: 'claude-code' })
    b.grants.revoke(grant.id)
    const r = await raw(b.port, { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'card_get', arguments: {} } } })
    expect(r.status).toBe(403)
    const rows = b.audit.list({ includeFailures: true })
    expect(rows.map((x) => [x.outcome, x.httpStatus, x.capability])).toEqual([
      ['denied', 403, 'card_get'],
      ['unauthorized', 401, 'rpc:tools/list']
    ])
    expect(rows[0].client).toBe('claude-code') // revoked grant is still attributed to its agent
    expect(rows[1].client).toBe('unknown') // no token → no grant to attribute
    expect(b.audit.list()).toEqual([]) // default view = successful reads only
  })
})

describe('Broker tools via the official MCP client', () => {
  test('lists the full product set: 22 OSS (incl. owner_aliases) + 3 Rewind + 4 extensions (incl. S1-06 get_workflow, search_workflows)', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toHaveLength(29)
    for (const n of ['search', 'owner_aliases', 'remember', 'correct_memory', 'process_pending_model_work', 'search_rewind', 'rewind_frames', 'view_rewind_screenshot', 'card_get', 'usage_report']) expect(tools).toContain(n)
    for (const old of ['memory_search', 'context_get', 'evidence_resolve']) expect(tools).not.toContain(old)
  })

  test('card_get returns a card that verifies offline; audit row has client/capability/items/count/chars', async () => {
    const issued = createIssuedCard()
    cleanups.push(issued.cleanup)
    const b = await setup(fakeBackend({ card: () => issued.signed }))
    const { token } = b.grants.create({ client: 'claude-code' })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    const text = textOf(await client.callTool({ name: 'card_get', arguments: {} }))
    expect(verifySignedCard(JSON.parse(text)).valid).toBe(true)
    const [row] = b.audit.list()
    expect(row).toMatchObject({ client: 'claude-code', capability: 'card_get', itemIds: [issued.signed.card.card_id], itemCount: 1, responseChars: text.length, outcome: 'ok' })
  })

  test('empty-result search is logged as a successful read with count 0', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    await client.callTool({ name: 'search', arguments: { query: 'zzz-nothing' } })
    const [row] = b.audit.list()
    expect(row).toMatchObject({ capability: 'search', itemCount: 0, outcome: 'ok' })
    expect(row.responseChars).toBeGreaterThan(0)
    expect(b.audit.preview(row.id)?.argumentsPreview).toContain('zzz-nothing')
  })

  test('PII scrubbing on outputs and previews', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    const s = textOf(await client.callTool({ name: 'search', arguments: { query: 'contact' } }))
    expect(s).not.toContain('x@y.io')
    expect(s).toContain('[email]')
    const c = textOf(await client.callTool({ name: 'current_context', arguments: {} }))
    expect(c).not.toContain('/Users/alice')
    expect(JSON.stringify(b.audit.list())).not.toContain('x@y.io')
  })

  test('resolve_evidence: full access returns it (scrubbed); scoped without evidence:read is refused, nothing reaches the runtime', async () => {
    const backend = fakeBackend()
    const b = await setup(backend)
    const full = b.grants.create({ client: 'claude-code' })
    const c1 = await connectClient(b.url, full.token)
    cleanups.push(() => c1.close())
    const t1 = textOf(await c1.callTool({ name: 'resolve_evidence', arguments: { reference: '⟨pt-001:user-preferences.md⟩' } }))
    expect(t1).toContain('QUOTE-SUMMARY')
    expect(t1).not.toContain('a@b.co')

    const scoped = b.grants.create({ client: 'codex', scopes: ['model:search'] })
    const c2 = await connectClient(b.url, scoped.token)
    cleanups.push(() => c2.close())
    const before = backend.calls.length
    const r2 = await c2.callTool({ name: 'resolve_evidence', arguments: { reference: '⟨pt-001:user-preferences.md⟩' } })
    expect(r2.isError).toBe(true)
    expect(textOf(r2)).toMatch(/^403 scope_denied/)
    expect(textOf(r2)).not.toContain('QUOTE')
    expect(backend.calls.length).toBe(before)

    const withEvidence = b.grants.create({ client: 'cursor', scopes: ['evidence:read'] })
    const c3 = await connectClient(b.url, withEvidence.token)
    cleanups.push(() => c3.close())
    expect(textOf(await c3.callTool({ name: 'resolve_evidence', arguments: { reference: 'x' } }))).toContain('QUOTE-SUMMARY')
  })

  test('scoped grant (extension) without a tool scope → tool error 403 scope_denied, audited', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'codex', scopes: ['card:read'] })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    const r = await client.callTool({ name: 'current_context', arguments: {} })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('403 scope_denied')
    expect(b.audit.list({ includeFailures: true })[0]).toMatchObject({ outcome: 'denied', errorCode: 'scope_denied', capability: 'current_context' })
  })

  test('revoke takes effect on the very next call of an open session', async () => {
    const b = await setup()
    const { grant, token } = b.grants.create({ client: 'claude-code' })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    expect((await client.callTool({ name: 'card_get', arguments: {} })).isError).toBeFalsy()
    b.grants.revoke(grant.id)
    const t0 = Date.now()
    await expect(client.callTool({ name: 'card_get', arguments: {} })).rejects.toThrow(/403|revoked/)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(b.audit.list({ includeFailures: true })[0]).toMatchObject({ outcome: 'denied', httpStatus: 403, errorCode: 'revoked' })
  })

  test('max reads counts tool calls only and exhausts with 403', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code', maxReads: 2 })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    await client.listTools()
    await client.callTool({ name: 'card_get', arguments: {} })
    await client.callTool({ name: 'card_get', arguments: {} })
    await expect(client.callTool({ name: 'card_get', arguments: {} })).rejects.toThrow(/403|exhausted/)
  })

  test('backend failure is audited as error and returned as a tool error', async () => {
    const b = await setup(fakeBackend({ oss: { search: () => { throw new Error('runtime down at /Users/alice/x') } } }))
    const { token } = b.grants.create({ client: 'claude-code' })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    const r = await client.callTool({ name: 'search', arguments: { query: 'q' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).not.toContain('/Users/alice')
    expect(b.audit.list({ includeFailures: true })[0]).toMatchObject({ outcome: 'error' })
  })

  test('usage_report: reads and chars for this client, typing-time wording', async () => {
    const b = await setup()
    const { token } = b.grants.create({ client: 'claude-code' })
    const client = await connectClient(b.url, token)
    cleanups.push(() => client.close())
    await client.callTool({ name: 'search', arguments: { query: 'zzz-nothing' } })
    const rep = JSON.parse(textOf(await client.callTool({ name: 'usage_report', arguments: {} })))
    expect(rep).toMatchObject({ client: 'claude-code', reads: 1, by_capability: { search: 1 } })
    expect(rep.note).toContain('do not measure time saved')
  })
})
