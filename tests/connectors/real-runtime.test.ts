import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postRuntime } from '../../src/main/connectors/ipc'
import { grantAll } from './consent-helper'
import { createConnectorService, type ConnectorService } from '../../src/main/connectors/service'
import { PersomeMcp } from '../../src/main/mcp/client'
import { HAVE_UPSTREAM, initRoot, isLoopback, recordConnects, sandboxedBin, startRest, tempRoot, type RestServer } from './upstream'

/**
 * S1-R3-07 acceptance against the REAL upstream Runtime (personal-model-og, schema 2026-11-05.3) on a
 * temp PERSOME_ROOT: calendar + health imports must show up in Runtime search, with no network.
 * Upstream processes run under a no-egress sandbox; this process records its own TCP connects.
 */
const FIX = path.join(__dirname, '..', 'fixtures', 'connectors')

type SearchHit = { id: string; path: string; content: string }
const hits = (raw: string): SearchHit[] => (JSON.parse(raw) as { results: SearchHit[] }).results

describe.skipIf(!HAVE_UPSTREAM)('connectors → real Runtime (temp root, no egress)', () => {
  let root: string
  let rest: RestServer
  let mcp: PersomeMcp
  let bin: string
  let conn: ReturnType<typeof recordConnects>
  const svc = (storeRoot: string): ConnectorService =>
    grantAll(createConnectorService({
      storeRoot,
      runtimeRoot: () => root,
      persomeBin: () => bin,
      ossTool: (n, a) => mcp.callTool(n, a),
      postRuntime: (r, b) => postRuntime(root, r, b)
    }))

  beforeAll(async () => {
    root = tempRoot('conn-rt')
    expect(initRoot(root)).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
    bin = sandboxedBin(tempRoot('bin'))
    // Record before the first fetch: undici keeps loopback connections alive and reuses them.
    conn = recordConnects()
    rest = await startRest(root)
    mcp = new PersomeMcp(bin, root)
  }, 180_000)

  afterAll(async () => {
    conn?.restore()
    mcp?.close()
    await rest?.close()
  })

  it('calendar (.ics → remember) appears in Runtime search; re-import adds nothing', { timeout: 120_000 }, async () => {
    const store = tempRoot('conn-store')
    const s = svc(store)
    const p = await s.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r = await s.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(r).toMatchObject({ written: 3, failed: 0 })
    expect(r.items.every((i) => typeof i.entryId === 'string')).toBe(true)

    for (const word of ['Zephyrquill', 'Brindlewhorl', 'Quorvantel']) {
      const h = hits(await mcp.callTool('search', { query: word, top_k: 10 })).filter((x) => x.content.includes(word))
      expect(h, word).toHaveLength(1)
      expect(h[0].content).toContain('日历事件：')
      expect(h[0].content).not.toContain('sk-ant-api03-FIXTURE')
      expect(h[0].content).not.toContain('@example.test')
    }

    const p2 = await s.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r2 = await s.commit(p2.previewId!, p2.items.map((i) => i.key), {})
    expect(r2).toMatchObject({ written: 0, unchanged: 3 })
    expect(hits(await mcp.callTool('search', { query: 'Zephyrquill', top_k: 10 })).filter((x) => x.content.includes('Zephyrquill'))).toHaveLength(1)
    console.log('[S1-R3-07] calendar entry ids', r.items.map((i) => i.entryId).join(','))
  })

  it('health (CSV + JSON → /health-events/import + daily remember) is queryable and searchable; idempotent', { timeout: 120_000 }, async () => {
    const store = tempRoot('conn-store-h')
    const s = svc(store)
    const pj = await s.previewFile('health', path.join(FIX, 'health.json'))
    const rj = await s.commit(pj.previewId!, pj.items.map((i) => i.key), {})
    expect(rj.failed).toBe(0)
    expect(rj.health).toEqual({ received: 3, inserted: 3, corrected: 0, duplicates: 0 })
    const pc = await s.previewFile('health', path.join(FIX, 'health.csv'))
    const rc = await s.commit(pc.previewId!, pc.items.map((i) => i.key), {})
    expect(rc.failed).toBe(0)
    expect(rc.health?.inserted).toBe(pc.totals.events)

    const q = JSON.parse(await mcp.callTool('query_health_metrics', { limit: 1000 })) as { count: number; events: Array<{ metric: string; provider: string; value: unknown }> }
    expect(q.count).toBe(3 + pc.totals.events)
    expect(q.events.find((e) => e.metric === 'steps')).toMatchObject({ provider: 'lens-file', value: 8532 })
    expect(JSON.stringify(q)).not.toContain('ghp_FIXTURE')

    const found = hits(await mcp.callTool('search', { query: 'resting_heart_rate steps', top_k: 10 })).filter((x) => x.content.includes('健康 / 训练记录'))
    expect(found.length).toBeGreaterThanOrEqual(1)
    expect(found.some((x) => x.content.includes('steps：8532 count'))).toBe(true)

    // Re-import both files: structured rows are duplicates upstream, no new summaries.
    const pj2 = await s.previewFile('health', path.join(FIX, 'health.json'))
    const rj2 = await s.commit(pj2.previewId!, pj2.items.map((i) => i.key), {})
    expect(rj2.health).toEqual({ received: 3, inserted: 0, corrected: 0, duplicates: 3 })
    expect(rj2).toMatchObject({ written: 0, unchanged: pj2.items.length })
    const q2 = JSON.parse(await mcp.callTool('query_health_metrics', { limit: 1000 })) as { count: number }
    expect(q2.count).toBe(q.count)
    console.log('[S1-R3-07] health receipts', JSON.stringify({ json: rj.health, csv: rc.health, rejson: rj2.health }))
  })

  it('calendar → timeline (import-data --no-build): stable source keys make a ledger-less re-run "unchanged"', { timeout: 120_000 }, async () => {
    const store = tempRoot('conn-store-t')
    const s = svc(store)
    const p = await s.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r = await s.commit(p.previewId!, p.items.map((i) => i.key), { target: 'timeline' })
    expect(r.cli?.exitCode).toBe(0)
    expect(r.cli?.counts).toEqual({ imported: 3, unchanged: 0, skipped: 0 })
    // Lose the Lens ledger: the Runtime itself must recognise the same documents.
    fs.rmSync(s.paths.ledgerPath)
    const s2 = svc(store)
    const p2 = await s2.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r2 = await s2.commit(p2.previewId!, p2.items.map((i) => i.key), { target: 'timeline' })
    expect(r2.cli?.counts).toEqual({ imported: 0, unchanged: 3, skipped: 0 })
  })

  it('C19 + R10 delete: health events deleted (deleted_events); markdown-authority memory erased via /memory/entries/delete', { timeout: 120_000 }, async () => {
    const store = tempRoot('conn-store-del')
    const s = svc(store)
    const count = async (): Promise<number> => (JSON.parse(await mcp.callTool('query_health_metrics', { limit: 1000 })) as { count: number }).count
    const before = await count()
    const pj = await s.previewFile('health', path.join(FIX, 'health.json'))
    await s.commit(pj.previewId!, pj.items.map((i) => i.key), {})
    expect(await count()).toBe(before) // same provider + ids as the earlier test: duplicates upstream
    fs.writeFileSync(path.join(store, 'del.csv'), 'date,title,body\n2026-11-03,Plumquartz review,C19 deletion probe\n')
    const pc = await s.previewFile('csv', path.join(store, 'del.csv'))
    const rc = await s.commit(pc.previewId!, pc.items.map((i) => i.key), {})
    expect(rc.written).toBe(1)
    const r = await s.deleteImported('health')
    expect(r.healthDeleted).toBe(3)
    expect(await count()).toBe(before - 3)
    // Default write authority is markdown: R10 erases remember entries (no /model/edit retire needed).
    expect(r).toMatchObject({ memoryRetired: 0, memoryErased: 1, remaining: [] })
    expect(hits(await mcp.callTool('search', { query: 'Plumquartz', top_k: 5 })).filter((x) => x.content.includes('Plumquartz'))).toHaveLength(1)
    const rcsv = await s.deleteImported('csv')
    expect(rcsv).toMatchObject({ memoryErased: 1, remaining: [] })
    expect(hits(await mcp.callTool('search', { query: 'Plumquartz', top_k: 5 })).filter((x) => x.content.includes('Plumquartz'))).toHaveLength(0)
    expect(s.ledger().connectors).toEqual([])
    console.log('[R10] erase on markdown authority', JSON.stringify({ health: r.healthDeleted, erased: (r.memoryErased ?? 0) + (rcsv.memoryErased ?? 0) }))
  })

  it('R10 timeline docs: deleteImported removes the import-data documents by Runtime source key', { timeout: 120_000 }, async () => {
    const store = tempRoot('conn-store-tdel')
    const s = svc(store)
    const p = await s.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r = await s.commit(p.previewId!, p.items.map((i) => i.key), { target: 'timeline' })
    expect(r.cli?.counts?.imported).toBe(3)
    const d = await s.deleteImported('calendar')
    expect(d).toMatchObject({ timelineDeleted: 3, remaining: [] })
    expect(s.ledger().connectors).toEqual([])
    // A fresh import of the same documents is new again (the Runtime source rows are gone).
    const s2 = svc(store)
    const p2 = await s2.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r2 = await s2.commit(p2.previewId!, p2.items.map((i) => i.key), { target: 'timeline' })
    expect(r2.cli?.counts).toEqual({ imported: 3, unchanged: 0, skipped: 0 })
  })

  it('this process only connected to loopback', () => {
    expect(conn.hosts.length).toBeGreaterThan(0)
    expect(conn.hosts.filter((h) => !isLoopback(h))).toEqual([])
    console.log('[S1-R3-07] connect targets', [...new Set(conn.hosts)].join(','))
  })
})

describe.skipIf(!HAVE_UPSTREAM)('C19 delete → real Runtime with [evomem] write_authority = "evomem" (temp root, no egress)', () => {
  let root: string
  let rest: RestServer
  let mcp: PersomeMcp

  beforeAll(async () => {
    root = tempRoot('conn-evo')
    initRoot(root)
    const cfg = path.join(root, 'config.toml')
    const text = fs.readFileSync(cfg, 'utf8')
    expect(text).toMatch(/write_authority = "markdown"/)
    fs.writeFileSync(cfg, text.replace(/write_authority = "markdown"/, 'write_authority = "evomem"'))
    rest = await startRest(root)
    mcp = new PersomeMcp(sandboxedBin(tempRoot('bin-evo')), root)
  }, 180_000)

  afterAll(async () => {
    mcp?.close()
    await rest?.close()
  })

  it('remember entries written by a connector are retired through POST /model/edit and leave search', { timeout: 120_000 }, async () => {
    const store = tempRoot('conn-store-evo')
    const s = grantAll(createConnectorService({ storeRoot: store, runtimeRoot: () => root, persomeBin: () => null, ossTool: (n, a) => mcp.callTool(n, a), postRuntime: (r, b) => postRuntime(root, r, b) }))
    fs.writeFileSync(path.join(store, 'evo.csv'), 'date,title,body\n2026-11-03,Velloxite sync,first\n2026-11-04,Velloxite retro,second\n')
    const p = await s.previewFile('csv', path.join(store, 'evo.csv'))
    const r = await s.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(r.written).toBe(2)
    const found = () => mcp.callTool('search', { query: 'Velloxite', top_k: 10 }).then((x) => hits(x).filter((h) => h.content.includes('Velloxite')).length)
    expect(await found()).toBe(2)
    const d = await s.deleteImported('csv')
    expect(d).toMatchObject({ memoryRetired: 2, remaining: [] })
    expect(await found()).toBe(0)
    expect(s.ledger().connectors).toEqual([])
    console.log('[C19] retire on evomem authority', JSON.stringify(d))
  })
})
