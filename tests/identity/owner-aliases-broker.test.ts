import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { TOOL_CATALOG, toolMeta } from '../../src/main/broker/catalog'
import { TOOLS, itemsOf } from '../../src/main/broker/tools'
import { connectClient, fakeBackend, startBroker, textOf, type OssHandler } from './broker-helpers'

/**
 * DEPLOY-05: Runtime schema 2026-11-05.3 (personal-model-og be0a0bc) adds the read-only MCP tool
 * `owner_aliases(status = pending|active|rejected|all)` → `{"status", "aliases": [row…]}` where each
 * row carries `evidence: [{session_id, source_kind, quote, confidence, created_at}]`
 * (store/owner_aliases.py review_list). Runtime is faked at the boundary; temp store only.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const ROW = {
  alias: 'kevin-dev',
  alias_key: 'kevin-dev',
  status: 'pending',
  confidence: 0.9,
  evidence_count: 2,
  first_seen_at: '2026-11-01T09:00:00+00:00',
  last_seen_at: '2026-11-04T09:00:00+00:00',
  activated_at: null,
  decision_source: 'inferred',
  evidence: [
    { session_id: 's1', source_kind: 'owned_account', quote: 'ALIAS-QUOTE signed in as kevin-dev', confidence: 0.9, created_at: '2026-11-04T09:00:00+00:00' }
  ]
}

const aliasesHandler: OssHandler = (a) =>
  JSON.stringify({ status: a.status ?? 'pending', aliases: a.status === 'rejected' ? [] : [ROW, { ...ROW, alias: 'K. Dev', alias_key: 'k. dev', evidence: [] }] })

async function setup(oss: Record<string, OssHandler> = { owner_aliases: aliasesHandler }) {
  const backend = fakeBackend({ oss })
  const b = await startBroker(backend)
  cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }), () => b.audit.close(), () => b.broker.stop())
  return { b, backend }
}

async function client(b: Awaited<ReturnType<typeof setup>>['b'], scopes?: string[]) {
  const { token } = b.grants.create({ client: scopes ? 'codex' : 'claude-code', ...(scopes ? { scopes: scopes as never } : {}) })
  const c = await connectClient(b.url, token, scopes ? 'codex' : 'claude-code')
  cleanups.push(() => c.close())
  return c
}

describe('catalog: owner_aliases and full coverage', () => {
  test('owner_aliases is an OSS read tool (no write, no LLM, no image) scoped to model:search only (F1: identity:read is a public scope)', () => {
    expect(toolMeta('owner_aliases')).toEqual({ name: 'owner_aliases', origin: 'oss', write: false, llm: false, image: false, scopes: ['model:search'] })
    const def = TOOLS.find((t) => t.name === 'owner_aliases')!
    expect(def.inputSchema).toMatchObject({ properties: { status: { enum: ['pending', 'active', 'rejected', 'all'], default: 'pending' } } })
    expect(def.description).toContain('Read-only')
  })

  test('every catalog tool has at least one scope and a non-empty description', () => {
    for (const meta of TOOL_CATALOG) {
      expect([meta.name, meta.scopes.length > 0]).toEqual([meta.name, true])
      const def = TOOLS.find((t) => t.name === meta.name)!
      expect([meta.name, def.description.trim().length > 20]).toEqual([meta.name, true])
    }
  })

  test('audit coverage: one Access-log row per tool call, for every tool in the catalog', async () => {
    const { b } = await setup()
    const c = await client(b)
    const argsFor = (schema: Record<string, unknown>): Record<string, unknown> => {
      const props = (schema.properties ?? {}) as Record<string, { type?: string; minLength?: number }>
      const out: Record<string, unknown> = {}
      for (const k of (schema.required as string[] | undefined) ?? []) {
        const p = props[k] ?? {}
        out[k] = p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'array' ? [] : 'x'.repeat(Math.max(1, p.minLength ?? 1))
      }
      return out
    }
    for (const def of TOOLS) await c.callTool({ name: def.name, arguments: argsFor(def.inputSchema) })
    const rows = b.audit.list({ includeFailures: true })
    expect(rows.map((r) => r.capability).sort()).toEqual(TOOLS.map((t) => t.name).sort())
  })
})

describe('owner_aliases through the Broker', () => {
  test('audit: items and count come from `aliases`; an empty result is a logged read with count 0', async () => {
    const { b, backend } = await setup()
    const c = await client(b)
    const full = textOf(await c.callTool({ name: 'owner_aliases', arguments: { status: 'all' } }))
    expect(full).toContain('kevin-dev')
    const empty = await c.callTool({ name: 'owner_aliases', arguments: { status: 'rejected' } })
    expect(empty.isError ?? false).toBe(false)
    expect(backend.calls.map((x) => [x.name, x.args])).toEqual([
      ['owner_aliases', { status: 'all' }],
      ['owner_aliases', { status: 'rejected' }]
    ])
    const rows = b.audit.list()
    expect(rows.map((r) => [r.capability, r.outcome, r.itemCount])).toEqual([
      ['owner_aliases', 'ok', 0],
      ['owner_aliases', 'ok', 2]
    ])
    expect(rows[1].itemIds).toEqual(['kevin-dev', 'k. dev'])
    expect(itemsOf({ status: 'pending', aliases: [] })).toEqual({ ids: [], count: 0 })
  })

  test('status outside the runtime enum is rejected before the runtime sees it', async () => {
    const { b, backend } = await setup()
    const c = await client(b)
    const r = await c.callTool({ name: 'owner_aliases', arguments: { status: 'confirm' } })
    expect(r.isError).toBe(true)
    expect(backend.calls).toEqual([])
    expect(b.audit.list({ includeFailures: true })[0]).toMatchObject({ capability: 'owner_aliases', outcome: 'error', errorCode: 'invalid_args' })
  })

  test('extension: a scoped grant without evidence:read gets aliases but no evidence quotes', async () => {
    const { b } = await setup()
    const scoped = textOf(await (await client(b, ['model:search'])).callTool({ name: 'owner_aliases', arguments: {} }))
    expect(scoped).toContain('kevin-dev')
    expect(scoped).not.toContain('ALIAS-QUOTE')
    expect(scoped).toContain('evidence:read')
    const parsed = JSON.parse(scoped)
    expect(parsed.aliases[0]).toMatchObject({ alias: 'kevin-dev', evidence_count: 2, evidence: [] })

    const withEvidence = textOf(await (await client(b, ['model:search', 'evidence:read'])).callTool({ name: 'owner_aliases', arguments: {} }))
    expect(withEvidence).toContain('ALIAS-QUOTE')
    const full = textOf(await (await client(b)).callTool({ name: 'owner_aliases', arguments: {} }))
    expect(full).toContain('ALIAS-QUOTE')
    // The stored preview follows what the agent received.
    // Rows are newest first: the oldest codex row is the model:search-only call.
    const scopedRow = b.audit.list().filter((r) => r.client === 'codex' && r.capability === 'owner_aliases').at(-1)!
    expect(b.audit.preview(scopedRow.id)?.resultPreview).not.toContain('ALIAS-QUOTE')
  })

  test('F1: public-tier grants (identity:read, card:read) are refused; nothing reaches the runtime', async () => {
    const { b, backend } = await setup()
    for (const scopes of [['card:read'], ['identity:read'], ['card:read', 'identity:read', 'evidence:read']]) {
      const r = await (await client(b, scopes)).callTool({ name: 'owner_aliases', arguments: {} })
      expect([scopes, r.isError, textOf(r).startsWith('403 scope_denied')]).toEqual([scopes, true, true])
    }
    expect(backend.calls).toEqual([])
  })

  test('F5: without evidence:read only allowlisted row fields survive; unknown fields and non-JSON output are withheld', async () => {
    const { b } = await setup({
      owner_aliases: (a) =>
        a.status === 'active'
          ? 'plain text ALIAS-QUOTE not json'
          : JSON.stringify({ status: 'pending', aliases: [{ ...ROW, notes: 'EXTRA-FIELD-SECRET', evidence_summary: 'ALIAS-QUOTE x' }, 'stray ALIAS-QUOTE'], extra_top: 'TOP-SECRET' })
    })
    const c = await client(b, ['model:search'])
    const parsed = JSON.parse(textOf(await c.callTool({ name: 'owner_aliases', arguments: {} })))
    expect(Object.keys(parsed.aliases[0]).sort()).toEqual(['activated_at', 'alias', 'alias_key', 'confidence', 'decision_source', 'evidence', 'evidence_count', 'first_seen_at', 'last_seen_at', 'status'])
    expect(parsed.aliases).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toMatch(/ALIAS-QUOTE|EXTRA-FIELD-SECRET|TOP-SECRET/)
    const nonJson = textOf(await c.callTool({ name: 'owner_aliases', arguments: { status: 'active' } }))
    expect(nonJson).not.toContain('ALIAS-QUOTE')
    expect(JSON.parse(nonJson)).toMatchObject({ aliases: [], evidence_withheld: expect.any(String) })
  })
})

describe('F2/F3: runtime paging cursors pass only at known per-tool JSON paths with the exact upstream format', () => {
  // read_memory: urlsafe base64 (no '=') of {"v":1,"q":<16 hex>,"a":<entry id YYYYMMDD-HHMM-6hex>,"o":N} (memory_paging.py _encode_cursor).
  const memCursor = (anchor: Record<string, unknown>) => Buffer.from(JSON.stringify(anchor)).toString('base64url')
  const goodMem = memCursor({ v: 1, q: '0123456789abcdef', a: '20261105-1514-4f6bdb', o: 2 })
  // get_model_snapshot: page.next_cursor = urlsafe base64 of struct ">BBQ32s" (version 1, section 1..6, index, sha256) = 56 chars.
  const snap = (version: number, section: number) => {
    const b = Buffer.alloc(42, 7)
    b[0] = version
    b[1] = section
    return b.toString('base64url')
  }
  const goodSnap = snap(1, 1)

  test('read_memory $.next_cursor of the exact upstream shape passes; other paths, keys and shapes are scrubbed', async () => {
    expect(goodSnap).toHaveLength(56)
    const bad = [
      memCursor({ v: 1, q: '0123456789abcdef', a: 'A'.repeat(48), o: 2 }), // F3: anchor not a generated id
      memCursor({ v: 1, q: '0123456789abcdef', a: '20261105-1514-4f6bdb', o: 2, x: 'smuggled-secret-value' }),
      memCursor({ v: 2, q: '0123456789abcdef', a: '20261105-1514-4f6bdb', o: 2 }),
      memCursor({ v: 1, q: 'not-hex-not-hex!', a: '20261105-1514-4f6bdb', o: 2 }),
      memCursor({ v: 1, q: '0123456789abcdef', a: '20261105-1514-4f6bdb', o: -1 }),
      'A'.repeat(84)
    ]
    let n = 0
    const { b } = await setup({
      read_memory: () => JSON.stringify(n++ === 0
        ? { path: 'a.md', entries: [{ id: 'e1', body: 'x', next_cursor: goodMem }], has_more: true, next_cursor: goodMem, cursor: goodMem }
        : { path: 'a.md', entries: [], has_more: true, next_cursor: bad[n - 2] })
    })
    const c = await client(b)
    const first = JSON.parse(textOf(await c.callTool({ name: 'read_memory', arguments: { path: 'a.md' } })))
    expect(first.next_cursor).toBe(goodMem)
    expect(first.entries[0].next_cursor).toBe('[secret]') // nested: not the allowlisted path
    expect(first.cursor).toBe('[secret]') // top-level `cursor` is never emitted upstream
    for (const cur of bad) {
      const out = JSON.parse(textOf(await c.callTool({ name: 'read_memory', arguments: { path: 'a.md' } })))
      expect([cur, out.next_cursor === cur]).toEqual([cur, false])
    }
  })

  test('get_model_snapshot $.page.next_cursor (56 chars, version 1, section 1..6) passes; top-level / malformed are scrubbed', async () => {
    const shapes = [
      { page: { next_cursor: goodSnap }, keep: true },
      { cursor: goodSnap, page: { next_cursor: null }, keep: false },
      { page: { next_cursor: snap(2, 1) }, keep: false },
      { page: { next_cursor: snap(1, 7) }, keep: false },
      { page: { next_cursor: goodSnap + 'AAAA' }, keep: false }
    ]
    let i = 0
    const { b } = await setup({ get_model_snapshot: () => JSON.stringify({ section: 'points', items: [], ...shapes[i++] }) })
    const c = await client(b)
    for (const shape of shapes) {
      const out = JSON.parse(textOf(await c.callTool({ name: 'get_model_snapshot', arguments: { section: 'points' } })))
      const sent = (shape as { cursor?: string }).cursor ?? shape.page.next_cursor
      const got = (shape as { cursor?: string }).cursor ? out.cursor : out.page.next_cursor
      expect([sent, got === sent]).toEqual([sent, shape.keep])
    }
  })

  test('other tools get no exemption: query_health_metrics metadata.cursor / next_cursor are scrubbed', async () => {
    const { b } = await setup({
      query_health_metrics: () => JSON.stringify({ results: [{ id: 'm1', metadata: { cursor: goodSnap, next_cursor: goodMem } }], next_cursor: goodMem })
    })
    const c = await client(b)
    const text = textOf(await c.callTool({ name: 'query_health_metrics', arguments: {} }))
    expect(text).not.toContain(goodSnap)
    expect(text).not.toContain(goodMem)
  })
})
