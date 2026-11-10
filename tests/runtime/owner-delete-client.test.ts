// R10 per-item delete client methods against an in-process loopback HTTP double of the Runtime
// routes (POST /imports/delete, /memory/entries/delete, /timeline/delete). No temp dirs, no ~/.persome.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { RuntimeClient, RuntimeError } from '../../src/main/runtime/client'
import { isOwnerDeleteNotFound, parseOwnerDeleteResult, refusalText } from '../../src/main/runtime/owner-delete'

const TOKEN = 'test-token-owner-delete-0123456789abcdef'
let server: http.Server
let port = 0
let mode: 'r10' | 'pre-r10' | 'malformed' | 'frozen' = 'r10'
const seen: Array<{ url: string; auth: string | undefined; body: any }> = []
const existing = new Set(['e1', 'e2'])
const erased = new Set<string>()

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body })
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: 'unauthorized' })
      if (mode === 'pre-r10') return send(404, { detail: 'Not Found' })
      if (mode === 'malformed') return send(200, { success: true, data: { kind: 'import', deleted: 'x' } })
      if (mode === 'frozen') return send(423, { detail: 'memory_writes_frozen' })
      if (req.url === '/memory/entries/delete') {
        const ids: string[] = body.entry_ids
        const out = { kind: 'memory_entry', deleted: { entries: 0 }, deleted_ids: [] as string[], already_deleted: [] as string[], missing: [] as string[], refused: [] as Array<{ id: string; reason: string }> }
        for (const id of ids) {
          if (id === 'owned') out.refused.push({ id, reason: 'not_agent_written' })
          else if (existing.has(id)) {
            existing.delete(id)
            erased.add(id)
            out.deleted_ids.push(id)
            out.deleted.entries++
          } else if (erased.has(id)) out.already_deleted.push(id)
          else out.missing.push(id)
        }
        if (!out.deleted_ids.length && !out.already_deleted.length && !out.refused.length) return send(404, { detail: { error: 'not_found', kind: 'memory_entry', missing: out.missing } })
        return send(200, { success: true, data: { schema_version: 1, ...out } })
      }
      if (req.url === '/imports/delete' || req.url === '/timeline/delete') {
        if (body.ids.includes('known'))
          return send(200, {
            success: true,
            data: { schema_version: 1, kind: req.url === '/imports/delete' ? 'import' : 'timeline', by: body.by, deleted: { timeline_blocks: 1 }, deleted_ids: ['known'], already_deleted: [], missing: [], refused: [], modeled_sessions: 0, derived_memory: 'none' }
          })
        return send(404, { detail: { error: 'not_found', kind: 'import', missing: body.ids } })
      }
      return send(404, { detail: 'Not Found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  mode = 'r10'
  seen.length = 0
})

describe('RuntimeClient R10 per-item delete', () => {
  test('memory: bearer + schema_version body; erased → already_deleted on repeat; refusal surfaced', async () => {
    const c = new RuntimeClient(port, TOKEN)
    const first = await c.deleteMemoryEntries(['e1', 'owned'])
    expect(first).toMatchObject({ kind: 'memory_entry', deleted_ids: ['e1'], refused: [{ id: 'owned', reason: 'not_agent_written' }] })
    expect(seen[0]).toEqual({ url: '/memory/entries/delete', auth: `Bearer ${TOKEN}`, body: { schema_version: 1, entry_ids: ['e1', 'owned'] } })
    expect((await c.deleteMemoryEntries(['e1'])).already_deleted).toEqual(['e1'])
    expect(refusalText('not_agent_written')).toContain('source:agent-run')
    expect(refusalText('weird_code')).toContain('weird_code')
  })

  test('Runtime 404 not_found body ⇒ all-missing result (not an exception)', async () => {
    const r = await new RuntimeClient(port, TOKEN).deleteMemoryEntries(['nope'])
    expect(r).toEqual({ kind: 'memory_entry', deleted: {}, deleted_ids: [], already_deleted: [], missing: ['nope'], refused: [] })
  })

  test('imports / timeline: selector forwarded; known id deleted; unknown → missing', async () => {
    const c = new RuntimeClient(port, TOKEN)
    expect(await c.deleteImports('content_sha256', ['known'])).toMatchObject({ kind: 'import', deleted_ids: ['known'], modeled_sessions: 0 })
    expect(await c.deleteTimeline('block_id', ['tlb-x'])).toMatchObject({ missing: ['tlb-x'] })
    expect(seen.map((s) => [s.url, s.body])).toEqual([
      ['/imports/delete', { schema_version: 1, by: 'content_sha256', ids: ['known'] }],
      ['/timeline/delete', { schema_version: 1, by: 'block_id', ids: ['tlb-x'] }]
    ])
  })

  test('Runtime before R10 (plain 404) ⇒ RuntimeError endpoint_missing', async () => {
    mode = 'pre-r10'
    const err = await new RuntimeClient(port, TOKEN).deleteImports('source_key', ['a']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RuntimeError)
    expect(err).toMatchObject({ code: 'not_found', status: 404, detail: 'endpoint_missing' })
  })

  test('auth / server code / malformed payload / empty or oversize batch', async () => {
    await expect(new RuntimeClient(port, 'wrong-token-0123456789abcdef0123').deleteMemoryEntries(['e2'])).rejects.toMatchObject({ code: 'unauthorized' })
    mode = 'frozen'
    await expect(new RuntimeClient(port, TOKEN).deleteMemoryEntries(['e2'])).rejects.toMatchObject({ code: 'server', status: 423, detail: 'memory_writes_frozen' })
    mode = 'malformed'
    await expect(new RuntimeClient(port, TOKEN).deleteImports('source_key', ['a'])).rejects.toMatchObject({ code: 'schema' })
    const n = seen.length
    await expect(new RuntimeClient(port, TOKEN).deleteMemoryEntries([])).rejects.toBeInstanceOf(RuntimeError)
    await expect(new RuntimeClient(port, TOKEN).deleteMemoryEntries(Array.from({ length: 1001 }, (_, i) => `e${i}`))).rejects.toBeInstanceOf(RuntimeError)
    expect(seen.length).toBe(n)
  })

  test('unreachable Runtime ⇒ unreachable', async () => {
    const closed = http.createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const p = (closed.address() as AddressInfo).port
    await new Promise<void>((r) => closed.close(() => r()))
    await expect(new RuntimeClient(p, TOKEN).deleteMemoryEntries(['e2'])).rejects.toMatchObject({ code: 'unreachable' })
  })

  test('parse helpers', () => {
    expect(isOwnerDeleteNotFound({ detail: { error: 'not_found', missing: ['x'] } })).toBe(true)
    expect(isOwnerDeleteNotFound({ detail: 'Not Found' })).toBe(false)
    expect(parseOwnerDeleteResult({ success: true, data: { kind: 'timeline', deleted: { timeline_blocks: 2 }, deleted_ids: ['a'], already_deleted: [], missing: [], refused: [] } })).toMatchObject({ kind: 'timeline' })
    expect(parseOwnerDeleteResult({ data: { kind: 'other' } })).toBeNull()
  })
})
