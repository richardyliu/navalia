import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { IDENTITY_CHANNELS } from '../../src/main/identity/api'
import { registerIdentityIpc } from '../../src/main/identity/ipc'
import { createKeyManager } from '../../src/main/identity/keys'
import { RuntimeClient, RuntimeError } from '../../src/main/runtime/client'
import { storePaths } from '../../src/main/store/paths'
import { sampleGraph, shareFor } from './fixtures'
import { createTestBox, tempRoot } from './helpers'

/**
 * DEPLOY-05: Runtime schema 2026-11-05.3 REST owner-alias review (personal-model-og be0a0bc,
 * api/routes.py + api/models.py OwnerAliasDecisionBody), all behind the local Bearer token:
 *   GET  /owner-aliases?status=pending|active|rejected|all → {success, data: {status, aliases: [row]}}
 *   POST /owner-aliases/confirm {alias, note?}           → {success, data: {alias, status}}
 *   POST /owner-aliases/reject  {alias, note?}           → {success, data: {alias, status}} (note ignored)
 *   400 {"detail": "unusable_alias"} for an empty / generic alias; 422 on body validation.
 * The fake below mirrors those shapes. Temp roots only; the real Runtime is never called.
 */

const TOKEN = 'test-token-owner-aliases-0123456789'
const ROW = {
  alias: 'kevin-dev',
  alias_key: 'kevin-dev',
  status: 'pending',
  confidence: 0.9,
  evidence_count: 1,
  first_seen_at: '2026-11-01T09:00:00+00:00',
  last_seen_at: '2026-11-04T09:00:00+00:00',
  activated_at: null,
  decision_source: 'inferred',
  evidence: [{ session_id: 's1', source_kind: 'owned_account', quote: 'signed in as kevin-dev', confidence: 0.9, created_at: '2026-11-04T09:00:00+00:00' }]
}

interface Seen {
  method: string
  url: string
  auth: string | undefined
  origin: string | undefined
  body: unknown
}
const seen: Seen[] = []
let mode: 'ok' | 'malformed' | 'unusable' | 'server-error' = 'ok'
let server: http.Server
let port = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, origin: req.headers.origin, body })
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (mode === 'server-error' && req.method === 'POST') return send(500, { detail: `boom ${String((body as { alias?: string })?.alias ?? '')} ${TOKEN}` })
      if (req.method === 'GET' && url.pathname === '/owner-aliases') {
        if (mode === 'malformed') return send(200, { success: true, data: { status: 'pending', aliases: [{ alias: 7 }] } })
        const status = url.searchParams.get('status') ?? 'pending'
        const all = [ROW, { ...ROW, alias: 'K. Dev', alias_key: 'k. dev', status: 'active', evidence: [] }, { ...ROW, alias: 'secret-handle-xyz', alias_key: 'secret-handle-xyz', evidence: [] }]
        return send(200, { success: true, data: { status, aliases: status === 'all' ? all : status === 'rejected' ? [] : [ROW] } })
      }
      if (req.method === 'POST' && (url.pathname === '/owner-aliases/confirm' || url.pathname === '/owner-aliases/reject')) {
        if (mode === 'unusable') return send(400, { detail: 'unusable_alias' })
        const alias = (body as { alias: string }).alias
        return send(200, { success: true, data: { alias, status: url.pathname.endsWith('confirm') ? 'active' : 'rejected' } })
      }
      return send(404, { detail: 'Not Found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const roots: string[] = []
afterEach(() => {
  seen.splice(0)
  mode = 'ok'
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

type Handler = (event: unknown, arg?: unknown) => unknown

function setup(answer: boolean | 'throw' = true) {
  const root = tempRoot('owner-aliases')
  roots.push(root)
  const paths = storePaths(root)
  const box = createTestBox({ available: true })
  const keys = createKeyManager(paths, box)
  const handlers = new Map<string, Handler>()
  const asked: Array<{ decision: string; alias: string; sender: unknown }> = []
  registerIdentityIpc({ handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) } as never, {
    paths,
    keys,
    box,
    getShareCard: async () => shareFor(sampleGraph()),
    getGraph: async () => sampleGraph(),
    confirmReset: async () => false,
    ownerAliases: {
      client: () => new RuntimeClient(port, TOKEN),
      confirmDecision: async (decision, alias, sender) => {
        asked.push({ decision, alias, sender })
        if (answer === 'throw') throw new Error('no window')
        return answer
      }
    }
  })
  const sender = { id: 42 }
  const call = (ch: string, arg?: unknown) => Promise.resolve(handlers.get(ch)!({ sender }, arg)) as Promise<any>
  return { handlers, call, asked, sender }
}

describe('RuntimeClient owner aliases (REST, Bearer)', () => {
  test('list → GET /owner-aliases?status=…, envelope unwrapped and validated', async () => {
    const c = new RuntimeClient(port, TOKEN)
    expect(await c.ownerAliases()).toEqual({ status: 'pending', aliases: [ROW] })
    expect(await c.ownerAliases('rejected')).toEqual({ status: 'rejected', aliases: [] })
    expect(seen.map((s) => [s.method, s.url, s.auth, s.origin])).toEqual([
      ['GET', '/owner-aliases?status=pending', `Bearer ${TOKEN}`, undefined],
      ['GET', '/owner-aliases?status=rejected', `Bearer ${TOKEN}`, undefined]
    ])
  })

  test('confirm / reject → POST JSON body; reject sends no note (Runtime ignores it)', async () => {
    const c = new RuntimeClient(port, TOKEN)
    expect(await c.confirmOwnerAlias('kevin-dev', 'my GitHub handle')).toEqual({ alias: 'kevin-dev', status: 'active' })
    expect(await c.rejectOwnerAlias('K. Dev')).toEqual({ alias: 'K. Dev', status: 'rejected' })
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', '/owner-aliases/confirm', { alias: 'kevin-dev', note: 'my GitHub handle' }],
      ['POST', '/owner-aliases/reject', { alias: 'K. Dev' }]
    ])
  })

  test('400 unusable_alias → RuntimeError with the Runtime code, message never echoes the alias', async () => {
    mode = 'unusable'
    const err = await new RuntimeClient(port, TOKEN).confirmOwnerAlias('me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RuntimeError)
    expect(err).toMatchObject({ code: 'server', status: 400, detail: 'unusable_alias' })
  })

  test('malformed Runtime payload → schema error', async () => {
    mode = 'malformed'
    await expect(new RuntimeClient(port, TOKEN).ownerAliases()).rejects.toMatchObject({ code: 'schema' })
  })
})

describe('identity IPC: owner aliases', () => {
  test('channels are part of the identity allowlist', () => {
    const { handlers } = setup()
    for (const ch of ['lens:owner-aliases:list', 'lens:owner-aliases:confirm', 'lens:owner-aliases:reject']) {
      expect(Object.values(IDENTITY_CHANNELS)).toContain(ch)
      expect(handlers.has(ch)).toBe(true)
    }
  })

  test('list: zod-validated status; reaches the Runtime', async () => {
    const { call } = setup()
    expect(await call(IDENTITY_CHANNELS.ownerAliasesList)).toEqual({ ok: true, data: { status: 'pending', aliases: [ROW] } })
    expect(await call(IDENTITY_CHANNELS.ownerAliasesList, { status: 'all' })).toMatchObject({ ok: true, data: { status: 'all' } })
    expect((await call(IDENTITY_CHANNELS.ownerAliasesList, { status: 'bogus' })).ok).toBe(false)
    expect((await call(IDENTITY_CHANNELS.ownerAliasesList, { status: 'all', extra: 1 })).ok).toBe(false)
    expect(seen.map((s) => s.url)).toEqual(['/owner-aliases?status=pending', '/owner-aliases?status=all'])
  })

  test('confirm is a user gesture: main-owned native dialog (with the sender) must say yes before any POST', async () => {
    const no = setup(false)
    expect(await no.call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias: 'kevin-dev' })).toEqual({ ok: true, data: { decided: false, alias: 'kevin-dev', status: null } })
    expect(no.asked).toEqual([{ decision: 'confirm', alias: 'kevin-dev', sender: no.sender }])
    expect(seen.map((s) => s.method)).toEqual(['GET'])
    seen.splice(0)

    const yes = setup(true)
    expect(await yes.call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias: 'kevin-dev' })).toEqual({ ok: true, data: { decided: true, alias: 'kevin-dev', status: 'active' } })
    expect(await yes.call(IDENTITY_CHANNELS.ownerAliasesReject, { alias: 'K. Dev' })).toEqual({ ok: true, data: { decided: true, alias: 'K. Dev', status: 'rejected' } })
    expect(yes.asked.map((a) => a.decision)).toEqual(['confirm', 'reject'])
    // F4: each decision re-reads the list first (alias must exist and not already be in the target state).
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['GET', '/owner-aliases?status=all', undefined],
      ['POST', '/owner-aliases/confirm', { alias: 'kevin-dev' }],
      ['GET', '/owner-aliases?status=all', undefined],
      ['POST', '/owner-aliases/reject', { alias: 'K. Dev' }]
    ])
  })

  test('dialog failure fails closed: nothing is posted', async () => {
    const { call } = setup('throw')
    expect((await call(IDENTITY_CHANNELS.ownerAliasesReject, { alias: 'kevin-dev' })).ok).toBe(false)
    expect(seen.filter((s) => s.method === 'POST')).toEqual([])
  })

  test('F4: unknown alias, or one already in the target state, never opens the dialog and posts nothing', async () => {
    const { call, asked } = setup(true)
    const unknown = await call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias: 'nobody-here' })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(JSON.stringify(unknown)).not.toContain('nobody-here')
    const already = await call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias: 'K. Dev' }) // already active
    expect(already.ok).toBe(false)
    expect(JSON.stringify(already)).not.toContain('K. Dev')
    expect(asked).toEqual([])
    expect(seen.filter((s) => s.method === 'POST')).toEqual([])
  })

  test('F4: bidi / zero-width / line-separator / C1 characters are rejected before anything else', async () => {
    const { call, asked } = setup(true)
    for (const alias of ['\u202Eecila', 'ali\u200Bce', 'a\u2028b', 'a\u2029b', 'a\u0085b', 'a\u009Fb', '\uFEFFalice', 'al\u2066ice']) {
      expect([alias, (await call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias })).ok]).toEqual([alias, false])
      expect([alias, (await call(IDENTITY_CHANNELS.ownerAliasesReject, { alias })).ok]).toEqual([alias, false])
    }
    expect(asked).toEqual([])
    expect(seen).toEqual([])
  })

  test('zod: alias 1–160 chars without control characters, no note (F4: not shown in the dialog, so not accepted), no extra keys', async () => {
    const { call, asked } = setup(true)
    for (const bad of [{}, { alias: '' }, { alias: 'x'.repeat(161) }, { alias: 'a\nb' }, { alias: 'kevin-dev', note: 'mine' }, { alias: 'a', status: 'active' }]) {
      expect([bad, (await call(IDENTITY_CHANNELS.ownerAliasesConfirm, bad)).ok]).toEqual([bad, false])
    }
    expect((await call(IDENTITY_CHANNELS.ownerAliasesReject, { alias: 'a', note: 'x' })).ok).toBe(false)
    expect(asked).toEqual([])
    expect(seen).toEqual([])
  })

  test('errors are redacted: fixed messages; no alias, note, token or Runtime body crosses IPC', async () => {
    const { call } = setup(true)
    mode = 'unusable'
    const r1 = await call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias: 'secret-handle-xyz' })
    expect(r1.ok).toBe(false)
    expect(r1.error.message).toContain('unusable_alias')
    mode = 'server-error'
    const r2 = await call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias: 'secret-handle-xyz' })
    mode = 'malformed'
    const r3 = await call(IDENTITY_CHANNELS.ownerAliasesList)
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(false)
      const text = JSON.stringify(r)
      for (const needle of ['secret-handle-xyz', 'private-note-abc', TOKEN, 'boom']) expect(text).not.toContain(needle)
    }
    expect(r2.error).toMatchObject({ code: 'server' })
  })

  test('no ownerAliases deps → channels still registered, fail closed', async () => {
    const root = tempRoot('owner-aliases-nodeps')
    roots.push(root)
    const paths = storePaths(root)
    const box = createTestBox({ available: true })
    const handlers = new Map<string, Handler>()
    registerIdentityIpc({ handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) } as never, {
      paths,
      keys: createKeyManager(paths, box),
      box,
      getShareCard: async () => shareFor(sampleGraph()),
      getGraph: async () => sampleGraph(),
      confirmReset: async () => false
    })
    const r = (await handlers.get(IDENTITY_CHANNELS.ownerAliasesList)!({}, undefined)) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(seen).toEqual([])
  })
})
