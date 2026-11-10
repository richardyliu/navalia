// S1-R3-02 acceptance: Broker tool catalog refresh (Runtime schema 2026-11-05.3).
// End-to-end style: a real MCP client (official SDK, streamable HTTP) with a scoped grant talks to a
// real Broker on 127.0.0.1; the Runtime is faked at the BrokerBackend boundary. Temp store only.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { OSS_TOOL_NAMES, TOOL_CATALOG } from '../../src/main/broker/catalog'
import { isMemoryCursor, TOOLS } from '../../src/main/broker/tools'
import { connectClient, fakeBackend, startBroker, textOf, type OssHandler } from './broker-helpers'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(oss: Record<string, OssHandler>) {
  const backend = fakeBackend({ oss })
  const b = await startBroker(backend)
  cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }), () => b.audit.close(), () => b.broker.stop())
  return { b, backend }
}

async function agent(b: Awaited<ReturnType<typeof setup>>['b'], scopes: string[] | null, client = 'codex') {
  const { token } = b.grants.create({ client, ...(scopes ? { scopes: scopes as never } : {}) })
  const c = await connectClient(b.url, token, client)
  cleanups.push(() => c.close())
  return c
}

// ---- Fake Runtime owner_aliases (store/owner_aliases.py review_list shape) ----
const aliasRow = (alias: string, status: string, quote: string) => ({
  alias,
  alias_key: alias.toLowerCase(),
  status,
  confidence: 0.8,
  evidence_count: 3,
  first_seen_at: '2026-11-01T09:00:00+00:00',
  last_seen_at: '2026-11-04T09:00:00+00:00',
  activated_at: status === 'active' ? '2026-11-04T10:00:00+00:00' : null,
  decision_source: status === 'pending' ? 'inferred' : 'user',
  evidence: [{ session_id: 's1', source_kind: 'owned_account', quote, confidence: 0.8, created_at: '2026-11-04T09:00:00+00:00' }]
})
const ALIASES = [
  aliasRow('kevin-dev', 'pending', 'QUOTE-1 signed in as kevin-dev'),
  aliasRow('kdev42', 'pending', 'QUOTE-2 @kdev42 pushed'),
  aliasRow('K. Dev', 'active', 'QUOTE-3'),
  aliasRow('other-person', 'rejected', 'QUOTE-4')
]
const ownerAliases: OssHandler = (a) => {
  const status = (a.status as string | undefined) ?? 'pending'
  return JSON.stringify({ status, aliases: ALIASES.filter((r) => status === 'all' || r.status === status) })
}

// ---- Fake Runtime read_memory paging (mcp/memory_paging.py shape) ----
const TOTAL = 230
const LIMIT = 100
const entryId = (i: number) => `20261105-${String(1000 + Math.floor(i / 60)).padStart(4, '0')}-${(0xa00000 + i).toString(16)}`
const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ v: 1, q: '0123456789abcdef', a: entryId(offset - 1), o: offset })).toString('base64url')
const decodeOffset = (cursor: string) => (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: number }).o

function readMemory(seen: Array<Record<string, unknown>>): OssHandler {
  return (a) => {
    seen.push(a)
    const start = typeof a.cursor === 'string' ? decodeOffset(a.cursor) : 0
    const end = Math.min(TOTAL, start + ((a.limit as number | undefined) ?? 50))
    const entries = Array.from({ length: end - start }, (_, k) => ({
      id: entryId(start + k),
      timestamp: '2026-11-05T10:00',
      // PII inside entries must still be scrubbed; only the cursor is exempt.
      body: `entry ${start + k} contact alice${start + k}@example.com`
    }))
    const hasMore = end < TOTAL
    return JSON.stringify({
      path: 'notes.md',
      entries,
      matched: TOTAL,
      returned: entries.length,
      limit: a.limit ?? 50,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(end) : null,
      truncated: hasMore,
      truncated_reason: hasMore ? 'limit' : null
    })
  }
}

describe('S1-R3-02: an agent with a model:search grant reads pending aliases through the Broker MCP', () => {
  test('tools/list shows owner_aliases; default call returns only pending rows; audit row per call', async () => {
    const { b, backend } = await setup({ owner_aliases: ownerAliases })
    const c = await agent(b, ['model:search'])
    const listed = (await c.listTools()).tools.map((t) => t.name)
    expect(listed).toContain('owner_aliases')

    const pending = JSON.parse(textOf(await c.callTool({ name: 'owner_aliases', arguments: {} })))
    expect(pending.status).toBe('pending')
    expect(pending.aliases.map((r: { alias: string; status: string }) => [r.alias, r.status])).toEqual([
      ['kevin-dev', 'pending'],
      ['kdev42', 'pending']
    ])
    // Extension: no evidence:read → counts stay, quotes withheld.
    expect(pending.aliases[0]).toMatchObject({ evidence_count: 3, evidence: [] })
    expect(JSON.stringify(pending)).not.toContain('QUOTE-')

    const explicit = JSON.parse(textOf(await c.callTool({ name: 'owner_aliases', arguments: { status: 'pending' } })))
    expect(explicit.aliases).toHaveLength(2)
    expect(backend.calls.map((x) => [x.name, x.args])).toEqual([
      ['owner_aliases', {}],
      ['owner_aliases', { status: 'pending' }]
    ])
    const rows = b.audit.list().filter((r) => r.capability === 'owner_aliases')
    expect(rows.map((r) => [r.client, r.outcome, r.itemCount])).toEqual([
      ['codex', 'ok', 2],
      ['codex', 'ok', 2]
    ])
    expect(rows[0].itemIds).toEqual(['kevin-dev', 'kdev42'])
  })

  test('the Broker offers no way to activate an alias (no confirm/reject tool exists)', async () => {
    const { b } = await setup({ owner_aliases: ownerAliases })
    const c = await agent(b, null, 'claude-code')
    const names = (await c.listTools()).tools.map((t) => t.name)
    expect(names.filter((n) => /alias/.test(n))).toEqual(['owner_aliases'])
    const r = await c.callTool({ name: 'owner_aliases_confirm', arguments: { alias: 'kevin-dev' } }).catch((e: unknown) => ({ isError: true, e }))
    expect((r as { isError?: boolean }).isError).toBe(true)
  })
})

describe('S1-R3-02: read_memory pages across 3 pages via the Broker with the cursor intact', () => {
  test('model:search grant; cursor byte-identical round trip; pages disjoint and complete; entries still scrubbed', async () => {
    const seen: Array<Record<string, unknown>> = []
    const { b } = await setup({ read_memory: readMemory(seen) })
    const c = await agent(b, ['model:search'])

    const ids: string[] = []
    const cursors: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const args: Record<string, unknown> = { path: 'notes.md', limit: LIMIT, ...(cursor ? { cursor } : {}) }
      const text = textOf(await c.callTool({ name: 'read_memory', arguments: args }))
      const page = JSON.parse(text) as { entries: Array<{ id: string; body: string }>; has_more: boolean; next_cursor: string | null }
      expect(text).not.toContain('@example.com')
      ids.push(...page.entries.map((e) => e.id))
      cursor = page.next_cursor
      if (cursor) {
        expect(isMemoryCursor(cursor)).toBe(true)
        cursors.push(cursor)
      }
      pages++
      expect(pages).toBeLessThan(10)
    } while (cursor)

    expect(pages).toBe(3)
    expect(ids).toHaveLength(TOTAL)
    expect(new Set(ids).size).toBe(TOTAL)
    expect(ids).toEqual(Array.from({ length: TOTAL }, (_, i) => entryId(i)))
    // What reached the Runtime is exactly the cursor the Runtime issued.
    expect(cursors).toEqual([encodeCursor(100), encodeCursor(200)])
    expect(seen).toEqual([
      { path: 'notes.md', limit: LIMIT },
      { path: 'notes.md', limit: LIMIT, cursor: encodeCursor(100) },
      { path: 'notes.md', limit: LIMIT, cursor: encodeCursor(200) }
    ])
    const rows = b.audit.list().filter((r) => r.capability === 'read_memory')
    expect(rows.map((r) => [r.client, r.outcome, r.itemCount]).reverse()).toEqual([
      ['codex', 'ok', 100],
      ['codex', 'ok', 100],
      ['codex', 'ok', 30]
    ])
  })

  test('a forged next_cursor (not the upstream format) is NOT exempt from scrubbing', async () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, q: '0123456789abcdef', a: 'x', o: 1, secret: 'sk-live-0123456789abcdef' })).toString('base64url')
    expect(isMemoryCursor(forged)).toBe(false)
    const { b } = await setup({ read_memory: () => JSON.stringify({ path: 'n.md', entries: [], has_more: true, next_cursor: forged }) })
    const c = await agent(b, ['model:search'])
    const text = textOf(await c.callTool({ name: 'read_memory', arguments: { path: 'n.md' } }))
    expect(text).not.toContain(forged)
  })
})

describe('S1-R3-02: catalog coverage (scope, description, audit)', () => {
  test('OSS names match the captured Runtime tool list (22), every tool has scope + description', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/main/broker/oss-tools.json'), 'utf8')) as { tools: Array<{ name: string }> }
    expect([...OSS_TOOL_NAMES].sort()).toEqual(captured.tools.map((t) => t.name).sort())
    expect(OSS_TOOL_NAMES).toHaveLength(22)
    expect(TOOLS.map((t) => t.name).sort()).toEqual(TOOL_CATALOG.map((t) => t.name).sort())
    for (const meta of TOOL_CATALOG) {
      const def = TOOLS.find((t) => t.name === meta.name)!
      expect([meta.name, meta.scopes.length > 0, def.description.trim().length > 20]).toEqual([meta.name, true, true])
    }
  })

  test('every catalog tool is audited on success AND on scope denial (Access log)', async () => {
    const { b } = await setup({ owner_aliases: ownerAliases })
    const full = await agent(b, null, 'claude-code')
    // A scope no catalog tool requires → every call is a 403 that must still be logged.
    const denied = await agent(b, ['reports:read'], 'codex')
    const argsFor = (schema: Record<string, unknown>): Record<string, unknown> => {
      const props = (schema.properties ?? {}) as Record<string, { type?: string; minLength?: number }>
      const out: Record<string, unknown> = {}
      for (const k of (schema.required as string[] | undefined) ?? []) {
        const p = props[k] ?? {}
        out[k] = p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'array' ? [] : 'x'.repeat(Math.max(1, p.minLength ?? 1))
      }
      return out
    }
    for (const def of TOOLS) {
      await full.callTool({ name: def.name, arguments: argsFor(def.inputSchema) })
      if (!TOOL_CATALOG.find((m) => m.name === def.name)!.scopes.includes('reports:read' as never)) {
        const r = await denied.callTool({ name: def.name, arguments: argsFor(def.inputSchema) })
        expect([def.name, r.isError]).toEqual([def.name, true])
      }
    }
    const rows = b.audit.list({ includeFailures: true })
    const fullRows = rows.filter((r) => r.client === 'claude-code').map((r) => r.capability)
    expect(fullRows.sort()).toEqual(TOOLS.map((t) => t.name).sort())
    const deniedRows = rows.filter((r) => r.client === 'codex')
    expect(deniedRows.length).toBe(TOOL_CATALOG.filter((m) => !m.scopes.includes('reports:read' as never)).length)
    expect(new Set(deniedRows.map((r) => r.errorCode))).toEqual(new Set(['scope_denied']))
  })
})
