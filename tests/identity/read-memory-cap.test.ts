import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { MAX_RESULT_CHARS, resultBudget, TOOL_RESULT_CHARS } from '../../src/main/broker/tools'
import { connectClient, fakeBackend, startBroker, textOf, type OssHandler } from './broker-helpers'

/**
 * MEM-10 (docs/upstream/MEM-10.md). Runtime schema 2026-11-05.3 (personal-model-og be0a0bc) pages
 * read_memory itself: `limit` (default 50, max 100) + opaque `cursor`, and each page is at most
 * 64 KiB of compact JSON with `has_more` / `next_cursor` AFTER `entries` (mcp/memory_paging.py).
 * The old Lens-only 50k cut would land inside a full page and drop `next_cursor`, breaking paging,
 * so read_memory now uses the global MAX_RESULT_CHARS. That still bounds an older runtime that
 * returns a whole file. Runtime is faked at the boundary (temp store only).
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** Pre-paging runtime (0.3.2 / b7a28ff): the whole file in one result, 1000 entries (> MAX_RESULT_CHARS). */
const bigMemory: OssHandler = () =>
  JSON.stringify({
    path: 'notes.md',
    entries: Array.from({ length: 1000 }, (_, i) => ({ id: `e-${i}`, content: `entry ${i} ${'lorem ipsum dolor sit amet '.repeat(9)}` }))
  })

/** A real-shaped read_memory cursor (memory_paging.py _encode_cursor; anchor = entries.make_id shape). */
const CURSOR = Buffer.from(JSON.stringify({ v: 1, q: '0123456789abcdef', a: '20261105-1514-4f6bdb', o: 100 })).toString('base64url')

/**
 * A full page as Runtime 2026-11-05.3 builds it (memory_paging.page): json.dumps default separators,
 * entries filled up to the 64 KiB byte budget minus the envelope reserve, then has_more/next_cursor.
 */
function upstreamPage(cursor: string | null): string {
  const MAX = 64 * 1024
  const RESERVE = 1024 + 512
  const payload: Record<string, unknown> = {
    path: 'notes.md', description: 'notes', tags: ['a', 'b'], status: 'active', updated: '2026-11-05', entry_count: 400,
    entries: [] as unknown[], matched: 400, returned: 0, limit: 100, max_result_bytes: MAX,
    has_more: false, next_cursor: null, truncated: false, truncated_reason: null
  }
  const pyDumps = (v: unknown) => JSON.stringify(v).replace(/","/g, '", "').replace(/":/g, '": ').replace(/,\{/g, ', {')
  const entries: unknown[] = []
  const base = cursor ? 100 : 0
  for (let i = 0; i < 100; i++) {
    const e = { id: `e-${base + i}`, timestamp: '2026-11-05T10:00', tags: ['t1', 't2', 't3'], body: `entry ${base + i} ${'lorem ipsum dolor sit amet '.repeat(22)}`, superseded_by: null, confidence: 0.9, conflicted: false, occurred_at: null }
    payload.entries = [...entries, e]
    if (Buffer.byteLength(pyDumps(payload)) > MAX - RESERVE) break
    entries.push(e)
  }
  Object.assign(payload, { entries, returned: entries.length, has_more: true, next_cursor: CURSOR, truncated: true, truncated_reason: 'byte_budget' })
  return pyDumps(payload)
}

async function client(oss: Record<string, OssHandler>) {
  const b = await startBroker(fakeBackend({ oss }))
  cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }), () => b.audit.close(), () => b.broker.stop())
  const { token } = b.grants.create({ client: 'claude-code' })
  const c = await connectClient(b.url, token)
  cleanups.push(() => c.close())
  return { b, c }
}

describe('MEM-10: bounded read_memory at the Broker passthrough', () => {
  test('budget: no Lens-only read_memory cut any more; every tool uses the global MAX_RESULT_CHARS', () => {
    expect(TOOL_RESULT_CHARS.read_memory).toBeUndefined()
    expect(resultBudget('read_memory')).toBe(MAX_RESULT_CHARS)
    expect(resultBudget('search')).toBe(MAX_RESULT_CHARS)
  })

  test('a full upstream page (64 KiB, has_more) passes intact: next_cursor survives; limit/cursor reach the runtime', async () => {
    const seen: Array<Record<string, unknown>> = []
    const { b, c } = await client({
      read_memory: (a) => {
        seen.push(a)
        return upstreamPage((a.cursor as string | undefined) ?? null)
      }
    })
    const page = upstreamPage(null)
    expect(Buffer.byteLength(page)).toBeGreaterThan(60_000) // a real full page, not a toy
    const text = textOf(await c.callTool({ name: 'read_memory', arguments: { path: 'notes.md', limit: 100 } }))
    expect(text).not.toContain('truncated by Navalia Broker')
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({ has_more: true, next_cursor: CURSOR, truncated_reason: 'byte_budget' })
    expect(parsed.entries.length).toBe(JSON.parse(page).entries.length)
    await c.callTool({ name: 'read_memory', arguments: { path: 'notes.md', limit: 100, cursor: parsed.next_cursor } })
    expect(seen).toEqual([
      { path: 'notes.md', limit: 100 },
      { path: 'notes.md', limit: 100, cursor: parsed.next_cursor }
    ])
    const rows = b.audit.list().filter((r) => r.capability === 'read_memory')
    expect(rows.map((r) => [r.errorCode, r.itemCount])).toEqual([
      [null, parsed.entries.length],
      [null, parsed.entries.length]
    ])
  })

  test('pre-paging runtime, 1000-entry file: cut at MAX_RESULT_CHARS with an explicit marker; Access log records it', async () => {
    const { b, c } = await client({ read_memory: bigMemory })
    const text = textOf(await c.callTool({ name: 'read_memory', arguments: { path: 'notes.md' } }))
    const m = new RegExp(`…\\[truncated by Navalia Broker: returned ${MAX_RESULT_CHARS} of (\\d+) chars; narrow the query or use limit/cursor\\]$`).exec(text)
    expect(m).not.toBeNull()
    const original = Number(m![1])
    expect(original).toBeGreaterThan(MAX_RESULT_CHARS)
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 200)
    const row = b.audit.list().find((r) => r.capability === 'read_memory')!
    expect(row).toMatchObject({ outcome: 'ok', errorCode: 'truncated', responseChars: text.length, itemCount: 1000 })
    expect(b.audit.preview(row.id)?.resultPreview).toContain(`[truncated: ${original} → ${MAX_RESULT_CHARS} chars]`)
  })

  test('small read_memory and other passthrough tools are untouched (no marker, errorCode null)', async () => {
    const { b, c } = await client({ read_memory: () => JSON.stringify({ path: 'a.md', entries: [{ id: 'e1', content: 'short' }] }) })
    const small = textOf(await c.callTool({ name: 'read_memory', arguments: { path: 'a.md' } }))
    expect(small).not.toContain('truncated by Navalia Broker')
    const s = textOf(await c.callTool({ name: 'search', arguments: { query: 'x' } }))
    expect(s).not.toContain('truncated')
    expect(b.audit.list().every((r) => r.errorCode === null)).toBe(true)
  })
})
