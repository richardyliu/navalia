// S1-R3-01: Settings → 身份别名. Static renders of the panel + the controller driven both by a pure
// mock bridge and by the real identity IPC handlers over a fake Runtime (temp roots only; the real
// Runtime / ~/.persome is never called). The real Runtime has 0 aliases (GAP-vs-S1-R3 §1), so
// every non-empty state here is mock data.
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { IDENTITY_CHANNELS } from '../../src/main/identity/api'
import { registerIdentityIpc } from '../../src/main/identity/ipc'
import { createKeyManager } from '../../src/main/identity/keys'
import { RuntimeClient } from '../../src/main/runtime/client'
import type { OwnerAliasList, OwnerAliasRow, OwnerAliasStatus } from '../../src/main/runtime/owner-aliases'
import { storePaths } from '../../src/main/store/paths'
import { OwnerAliasesPanel, type OwnerAliasesPanelProps } from '../../src/renderer/src/components/settings/OwnerAliasesSection'
import {
  genericAliasError,
  untrustedQuoteNote,
  aliasErrorText,
  aliasRows,
  decideAndRelist,
  emptyText,
  listAliases,
  safeQuote,
  type OwnerAliasBridge
} from '../../src/renderer/src/components/settings/ownerAliasesView'
import { sampleGraph, shareFor } from './fixtures'

// Heavily Chinese UI assertions: run in zh (an English check is at the end).
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))
import { createTestBox, tempRoot } from './helpers'
;(globalThis as { React?: typeof React }).React = React

const TOKEN = 'test-token-alias-ui-0123456789abcdef'

function row(alias: string, status: OwnerAliasStatus, over: Partial<OwnerAliasRow> = {}): OwnerAliasRow {
  return {
    alias,
    alias_key: alias.toLowerCase(),
    status,
    confidence: 0.82,
    evidence_count: 7,
    first_seen_at: '2026-11-01T09:00:00+00:00',
    last_seen_at: '2026-11-04T09:30:00+00:00',
    activated_at: null,
    decision_source: 'inferred',
    evidence: [{ session_id: 'sess-1', source_kind: 'owned_account', quote: 'signed in as kevin-dev', confidence: 0.9, created_at: '2026-11-04T09:00:00+00:00' }],
    ...over
  }
}

const panel = (over: Partial<OwnerAliasesPanelProps>) =>
  renderToStaticMarkup(
    createElement(OwnerAliasesPanel, {
      tab: 'pending',
      rows: [],
      loading: false,
      error: null,
      notice: null,
      busy: false,
      onTab: () => undefined,
      onDecide: () => undefined,
      onRefresh: () => undefined,
      ...over
    })
  )

/** In-memory bridge: records every call; confirm / reject consult `dialog` like main would. */
function mockBridge(initial: OwnerAliasRow[], dialog: () => boolean = () => true) {
  const rows = initial.map((r) => ({ ...r }))
  const calls: string[] = []
  const bridge: OwnerAliasBridge = {
    list: async (status = 'pending') => {
      calls.push(`list:${status}`)
      return { ok: true, data: { status, aliases: rows.filter((r) => status === 'all' || r.status === status) } as OwnerAliasList }
    },
    confirm: async (alias) => {
      calls.push(`confirm:${alias}`)
      if (!dialog()) return { ok: true, data: { decided: false, alias, status: null } }
      rows.find((r) => r.alias === alias)!.status = 'active'
      return { ok: true, data: { decided: true, alias, status: 'active' } }
    },
    reject: async (alias) => {
      calls.push(`reject:${alias}`)
      if (!dialog()) return { ok: true, data: { decided: false, alias, status: null } }
      rows.find((r) => r.alias === alias)!.status = 'rejected'
      return { ok: true, data: { decided: true, alias, status: 'rejected' } }
    }
  }
  return { bridge, calls, rows }
}

describe('S1-R3-01 panel render', () => {
  test('pending row: alias, evidence_count, source + quote shown as untrusted text, 确认 / 拒绝', () => {
    const rows = aliasRows({ status: 'pending', aliases: [row('kevin-dev', 'pending')] })
    const out = panel({ rows })
    expect(out).toContain('身份别名')
    expect(out).toContain('kevin-dev')
    expect(out).toContain('证据 7 条')
    expect(out).toContain('owned_account')
    expect(out).toContain('signed in as kevin-dev')
    expect(out).toContain(untrustedQuoteNote())
    expect(out).toContain('data-untrusted="true"')
    expect(out).toContain('显示最新 1 条，共 7 条')
    expect(out).toContain('data-testid="alias-confirm"')
    expect(out).toContain('data-testid="alias-reject"')
  })

  test('active rows offer only 拒绝, rejected rows only 确认', () => {
    const active = panel({ tab: 'active', rows: aliasRows({ status: 'active', aliases: [row('K. Dev', 'active')] }) })
    expect(active).not.toContain('data-testid="alias-confirm"')
    expect(active).toContain('data-testid="alias-reject"')
    const rejected = panel({ tab: 'rejected', rows: aliasRows({ status: 'rejected', aliases: [row('nope', 'rejected')] }) })
    expect(rejected).toContain('data-testid="alias-confirm"')
    expect(rejected).not.toContain('data-testid="alias-reject"')
  })

  test('hostile quote: markup escaped, bidi / zero-width removed, length capped', () => {
    const quote = `<img src=x onerror=alert(1)>‮evil​ ${'x'.repeat(600)}`
    const rows = aliasRows({ status: 'pending', aliases: [row('kevin-dev', 'pending', { evidence: [{ session_id: 's', source_kind: 'ocr', quote, confidence: 0.5, created_at: null }] })] })
    const out = panel({ rows })
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('‮')
    expect(out).not.toContain('​')
    expect(rows[0].evidence[0].quote.length).toBeLessThanOrEqual(281)
    expect(rows[0].evidence[0].when).toBe('时间未知')
    expect(safeQuote('a\nb\tc')).toBe('a b c')
  })

  test('empty state per tab (real Runtime currently has 0 aliases)', () => {
    for (const tab of ['pending', 'active', 'rejected'] as const) {
      const out = panel({ tab, rows: [] })
      expect(out).toContain('data-testid="alias-empty"')
      expect(out).toContain(emptyText(tab).replace(/“/g, '“'))
    }
    expect(panel({ rows: [], loading: true })).not.toContain('alias-empty')
    expect(panel({ rows: [], error: 'x' })).not.toContain('alias-empty')
  })

  test('error state renders the given (already redacted) text only', () => {
    const out = panel({ error: '连不上 Runtime（127.0.0.1），请先启动 persome' })
    expect(out).toContain('data-testid="alias-error"')
    expect(out).toContain('连不上 Runtime')
  })
})

describe('S1-R3-01 controller (mock bridge)', () => {
  test('confirm → re-list: the alias leaves 待确认', async () => {
    const m = mockBridge([row('kevin-dev', 'pending'), row('other', 'pending')])
    const out = await decideAndRelist(m.bridge, 'confirm', 'kevin-dev', 'pending')
    expect(m.calls).toEqual(['confirm:kevin-dev', 'list:pending'])
    expect(out.tone).toBe('ok')
    expect(out.message).toContain('已确认“kevin-dev”')
    expect(out.list?.aliases.map((r) => r.alias)).toEqual(['other'])
  })

  test('reject → re-list', async () => {
    const m = mockBridge([row('kevin-dev', 'pending')])
    const out = await decideAndRelist(m.bridge, 'reject', 'kevin-dev', 'pending')
    expect(m.calls).toEqual(['reject:kevin-dev', 'list:pending'])
    expect(out.message).toContain('已拒绝')
    expect(out.list?.aliases).toEqual([])
    expect(m.rows[0].status).toBe('rejected')
  })

  test('dialog Cancel: nothing changes, still re-lists, warn notice', async () => {
    const m = mockBridge([row('kevin-dev', 'pending')], () => false)
    const out = await decideAndRelist(m.bridge, 'confirm', 'kevin-dev', 'pending')
    expect(out).toMatchObject({ tone: 'warn', message: '已取消，未做任何更改。' })
    expect(m.rows[0].status).toBe('pending')
    expect(out.list?.aliases).toHaveLength(1)
  })

  test('listing alone never confirms or rejects anything', async () => {
    const m = mockBridge([row('kevin-dev', 'pending')])
    await listAliases(m.bridge, 'pending')
    panel({ rows: aliasRows(await listAliases(m.bridge, 'pending')) })
    expect(m.calls).toEqual(['list:pending', 'list:pending'])
  })

  test('redacted errors: thrown IPC errors and unknown shapes become a fixed text', async () => {
    const secret = `boom kevin-dev ${TOKEN}`
    expect(aliasErrorText(new Error(secret))).toBe(genericAliasError())
    expect(aliasErrorText({ code: 'weird', message: secret })).toBe(genericAliasError())
    const bridge: OwnerAliasBridge = {
      list: async () => {
        throw new Error(secret)
      },
      confirm: async () => {
        throw new Error(secret)
      },
      reject: async () => ({ ok: false, error: { code: 'unreachable', message: '连不上 Runtime（127.0.0.1），请先启动 persome' } })
    }
    await expect(listAliases(bridge, 'pending')).rejects.toThrow(genericAliasError())
    const c = await decideAndRelist(bridge, 'confirm', 'kevin-dev', 'pending')
    expect(JSON.stringify(c)).not.toContain(TOKEN)
    expect(c).toMatchObject({ tone: 'bad', message: genericAliasError(), list: null, listError: genericAliasError() })
    const r = await decideAndRelist(bridge, 'reject', 'kevin-dev', 'pending')
    expect(r.message).toBe('连不上 Runtime（127.0.0.1），请先启动 persome')
  })
})

// ---- Through the real identity IPC handlers + a fake Runtime (no auto-activation end to end) ----

let server: http.Server
let port = 0
let mode: 'ok' | 'leak' = 'ok'
const posts: Array<{ url: string; body: unknown }> = []
let store: OwnerAliasRow[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/owner-aliases') {
        const status = url.searchParams.get('status') ?? 'pending'
        return send(200, { success: true, data: { status, aliases: store.filter((r) => status === 'all' || r.status === status) } })
      }
      if (req.method === 'POST' && url.pathname.startsWith('/owner-aliases/')) {
        const body = JSON.parse(raw) as { alias: string }
        posts.push({ url: url.pathname, body })
        if (mode === 'leak') return send(500, { detail: `stack: ${body.alias} ${TOKEN}` })
        const target = url.pathname.endsWith('confirm') ? 'active' : 'rejected'
        store.find((r) => r.alias === body.alias)!.status = target
        return send(200, { success: true, data: { alias: body.alias, status: target } })
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
  posts.splice(0)
  mode = 'ok'
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function ipcBridge(answer: () => boolean): { bridge: OwnerAliasBridge; asked: string[] } {
  const root = tempRoot('alias-ui')
  roots.push(root)
  const paths = storePaths(root)
  const box = createTestBox({ available: true })
  const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>()
  const asked: string[] = []
  registerIdentityIpc({ handle: (ch: string, fn: (event: unknown, arg?: unknown) => unknown) => void handlers.set(ch, fn) } as never, {
    paths,
    keys: createKeyManager(paths, box),
    box,
    getShareCard: async () => shareFor(sampleGraph()),
    getGraph: async () => sampleGraph(),
    confirmReset: async () => false,
    ownerAliases: {
      client: () => new RuntimeClient(port, TOKEN),
      confirmDecision: async (decision, alias) => {
        asked.push(`${decision}:${alias}`)
        return answer()
      }
    }
  })
  const call = (ch: string, arg?: unknown) => Promise.resolve(handlers.get(ch)!({ sender: { id: 1 } }, arg)) as Promise<any>
  // Same shapes as src/preload/index.ts ownerAliases.
  const bridge: OwnerAliasBridge = {
    list: (status) => call(IDENTITY_CHANNELS.ownerAliasesList, status === undefined ? undefined : { status }),
    confirm: (alias) => call(IDENTITY_CHANNELS.ownerAliasesConfirm, { alias }),
    reject: (alias) => call(IDENTITY_CHANNELS.ownerAliasesReject, { alias })
  }
  return { bridge, asked }
}

describe('S1-R3-01 over the real IPC handlers (fake Runtime)', () => {
  test('no auto-activation: list + Cancel post nothing; only an explicit yes posts, then re-list reflects it', async () => {
    store = [row('kevin-dev', 'pending'), row('K. Dev', 'pending')]
    let yes = false
    const { bridge, asked } = ipcBridge(() => yes)
    const first = await listAliases(bridge, 'pending')
    expect(first.aliases).toHaveLength(2)
    expect(posts).toEqual([])

    const cancelled = await decideAndRelist(bridge, 'confirm', 'kevin-dev', 'pending')
    expect(cancelled.tone).toBe('warn')
    expect(asked).toEqual(['confirm:kevin-dev'])
    expect(posts).toEqual([])
    expect(store.every((r) => r.status === 'pending')).toBe(true)

    yes = true
    const confirmed = await decideAndRelist(bridge, 'confirm', 'kevin-dev', 'pending')
    expect(posts).toEqual([{ url: '/owner-aliases/confirm', body: { alias: 'kevin-dev' } }])
    expect(confirmed.list?.aliases.map((r) => r.alias)).toEqual(['K. Dev'])

    const rejected = await decideAndRelist(bridge, 'reject', 'K. Dev', 'pending')
    expect(posts[1]).toEqual({ url: '/owner-aliases/reject', body: { alias: 'K. Dev' } })
    expect(rejected.list?.aliases).toEqual([])
    expect((await listAliases(bridge, 'active')).aliases.map((r) => r.alias)).toEqual(['kevin-dev'])
    expect((await listAliases(bridge, 'rejected')).aliases.map((r) => r.alias)).toEqual(['K. Dev'])
    expect(asked).toEqual(['confirm:kevin-dev', 'confirm:kevin-dev', 'reject:K. Dev'])
  })

  test('Runtime 500 echoing alias + token: the UI notice is redacted', async () => {
    store = [row('kevin-dev', 'pending')]
    mode = 'leak'
    const { bridge } = ipcBridge(() => true)
    const out = await decideAndRelist(bridge, 'confirm', 'kevin-dev', 'pending')
    expect(out.tone).toBe('bad')
    expect(out.message).not.toContain(TOKEN)
    expect(out.message).not.toContain('stack')
    expect(out.message).not.toContain('kevin-dev')
    const html = panel({ notice: { tone: out.tone, message: out.message }, rows: aliasRows(out.list ?? undefined) })
    expect(html).not.toContain(TOKEN)
  })

  test('empty Runtime (0 aliases, as on the real data) → empty state', async () => {
    store = []
    const { bridge } = ipcBridge(() => true)
    const list = await listAliases(bridge, 'pending')
    expect(panel({ rows: aliasRows(list) })).toContain(emptyText('pending'))
  })
})

describe('S1-R3-01 panel in English (default locale)', () => {
  test('heading and actions read in English', () => {
    setLocale('en')
    const out = panel({ rows: aliasRows({ status: 'pending', aliases: [row('kevin-dev', 'pending')] }) })
    expect(out).toContain('Owner aliases')
    expect(out).toContain('kevin-dev')
    expect(out).toContain('data-testid="alias-confirm"')
  })
})
