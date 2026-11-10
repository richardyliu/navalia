// C19 deletion of imported data: ledger → Runtime deletion where it exists (memory: POST /model/edit
// retire; health: /health-events/import deleted_events), honest "remaining" otherwise. TEST DOUBLE
// Runtime below mirrors the upstream responses observed on the real Runtime (see C19 log §6).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerConnectorHandlers } from '../../src/main/connectors/ipc'
import { ConnectorError, createConnectorService } from '../../src/main/connectors/service'
import type { ExecFn } from '../../src/main/import/cli'
import { grantAll } from './consent-helper'
import { rmTmp, tmpDir } from './tmp-helper'
import { createHash } from 'node:crypto'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FIX = path.join(__dirname, '..', 'fixtures', 'connectors')

/**
 * Fake Runtime: remember ids; /model/edit retire (unknown ids → 400 unknown_point); health store with
 * deletion. Default = a Runtime before R10 (the R10 routes answer FastAPI's plain 404 "Not Found").
 * `r10: true` adds POST /memory/entries/delete and /imports/delete (R10 response shapes).
 */
function fakeRuntime(opts: { retireWorks?: boolean; down?: () => boolean; r10?: boolean; refuse?: (id: string) => string | null; sources?: Set<string> } = {}) {
  const memory = new Map<string, { content: string; retired: boolean }>()
  const health = new Map<string, unknown>()
  const calls: Array<{ route: string; body: any }> = []
  let n = 0
  const ossTool = async (_name: string, args: Record<string, unknown>): Promise<string> => {
    const id = `20261106-1014-${(++n).toString(16).padStart(6, '0')}`
    memory.set(id, { content: String(args.content), retired: false })
    return JSON.stringify({ entry_id: id, file: 'topic-agent-findings.md' })
  }
  const postRuntime = async (route: string, body: any): Promise<unknown> => {
    if (opts.down?.()) throw new ConnectorError('runtime_missing', '连不上 Runtime（127.0.0.1）：ECONNREFUSED。请先启动 Runtime。')
    if (!opts.r10 && (route === '/memory/entries/delete' || route === '/imports/delete')) throw new ConnectorError('unknown', 'Runtime 返回 404：Not Found')
    calls.push({ route, body })
    if (route === '/memory/entries/delete') {
      expect(body.schema_version).toBe(1)
      expect(body.entry_ids.length).toBeLessThanOrEqual(1000)
      const out = { kind: 'memory_entry', deleted: { entries: 0 }, deleted_ids: [] as string[], already_deleted: [] as string[], missing: [] as string[], refused: [] as Array<{ id: string; reason: string }> }
      for (const id of body.entry_ids as string[]) {
        const reason = opts.refuse?.(id) ?? null
        const m = memory.get(id)
        if (reason) out.refused.push({ id, reason })
        else if (m && !m.retired) {
          memory.delete(id)
          out.deleted_ids.push(id)
          out.deleted.entries++
        } else out.missing.push(id)
      }
      if (!out.deleted_ids.length && !out.refused.length) throw new ConnectorError('unknown', 'Runtime 返回 404：not_found')
      return { success: true, data: { schema_version: 1, ...out } }
    }
    if (route === '/imports/delete') {
      expect(body).toMatchObject({ schema_version: 1, by: 'source_key' })
      const deleted = (body.ids as string[]).filter((k) => opts.sources?.delete(k))
      const missing = (body.ids as string[]).filter((k) => !deleted.includes(k))
      if (!deleted.length) throw new ConnectorError('unknown', 'Runtime 返回 404：not_found')
      return { success: true, data: { schema_version: 1, kind: 'import', by: 'source_key', deleted: { sources: deleted.length }, deleted_ids: deleted, already_deleted: [], missing, refused: [], modeled_sessions: 0, derived_memory: 'none' } }
    }
    if (route === '/model/edit') {
      expect(body).toMatchObject({ schema_version: 1, kind: 'point', op: 'retire' })
      const m = memory.get(body.id)
      if (!m || opts.retireWorks === false) throw new ConnectorError('unknown', 'Runtime 返回 400：unknown_point')
      if (m.retired) throw new ConnectorError('unknown', 'Runtime 返回 400：point_already_retired')
      m.retired = true
      return { success: true, data: { applied: [`retired ${body.id}`] } }
    }
    if (route === '/health-events/import') {
      let inserted = 0
      let deleted = 0
      for (const e of body.events ?? []) {
        if (!health.has(`${e.source.provider}|${e.event_id}`)) inserted++
        health.set(`${e.source.provider}|${e.event_id}`, e)
      }
      for (const d of body.deleted_events ?? []) if (health.delete(`${d.provider}|${d.event_id}`)) deleted++
      expect((body.events?.length ?? 0) + (body.deleted_events?.length ?? 0)).toBeLessThanOrEqual(1000)
      return { success: true, data: { received: body.events?.length ?? 0, inserted, corrected: 0, duplicates: 0, deleted } }
    }
    throw new Error(`unexpected route ${route}`)
  }
  return { memory, health, calls, ossTool, postRuntime }
}

function setup(rt = fakeRuntime(), exec?: ExecFn) {
  const storeRoot = tmpDir('del')
  const svc = grantAll(
    createConnectorService({ storeRoot, runtimeRoot: () => storeRoot, persomeBin: () => '/opt/fake/persome', ossTool: rt.ossTool, postRuntime: rt.postRuntime, exec })
  )
  return { svc, storeRoot, rt }
}

const live = (rt: ReturnType<typeof fakeRuntime>) => [...rt.memory.values()].filter((m) => !m.retired).length

describe('ledger + delete imported data', () => {
  it('calendar (remember): every entry is retired through the Runtime; ledger emptied; re-import is "new" again', async () => {
    const { svc, storeRoot, rt } = setup()
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(svc.ledger().connectors).toEqual([{ kind: 'calendar', items: 3, memoryEntries: 3, memoryWithoutId: 0, healthEvents: 0, timelineDocs: 0, lastAt: expect.any(String) }])
    const r = await svc.deleteImported('calendar')
    expect(r).toMatchObject({ kind: 'calendar', memoryRetired: 3, remaining: [] })
    expect(live(rt)).toBe(0)
    expect(svc.ledger().connectors).toEqual([])
    expect((await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))).items.every((i) => i.state === 'new')).toBe(true)
    rmTmp(storeRoot)
  })

  it('an updated item has two entry ids — both are retired; a second run is a no-op; other connectors untouched', async () => {
    const { svc, storeRoot, rt } = setup()
    const dir = tmpDir('del-ics')
    const f = path.join(dir, 'c.ics')
    fs.copyFileSync(path.join(FIX, 'calendar.ics'), f)
    let p = await svc.previewFile('calendar', f)
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('团队外出日 Quorvantel', '团队外出日 Quorvantel（改期）'))
    p = await svc.previewFile('calendar', f)
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const e = await svc.previewFile('email', path.join(__dirname, 'fixtures', 'multipart.eml'))
    await svc.commit(e.previewId!, e.items.map((i) => i.key), {})
    expect(rt.memory.size).toBe(5)
    const r = await svc.deleteImported('calendar')
    expect(r.memoryRetired).toBe(4)
    expect(live(rt)).toBe(1)
    expect(svc.ledger().connectors.map((c) => c.kind)).toEqual(['email'])
    const again = await svc.deleteImported('calendar')
    expect(again).toMatchObject({ memoryRetired: 0, remaining: [] })
    rmTmp(storeRoot)
    rmTmp(dir)
  })

  it('health: structured events deleted by provider + id (batched ≤ 1000) and the daily summaries retired', async () => {
    const { svc, storeRoot, rt } = setup()
    const p = await svc.previewFile('health', path.join(FIX, 'health.csv'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const total = rt.health.size
    expect(svc.ledger().connectors).toEqual([expect.objectContaining({ kind: 'health', healthEvents: total, memoryEntries: 2 })])
    const r = await svc.deleteImported('health')
    expect(r).toMatchObject({ memoryRetired: 2, healthDeleted: total, remaining: [] })
    expect(rt.health.size).toBe(0)
    const del = rt.calls.filter((c) => c.route === '/health-events/import' && c.body.deleted_events)
    expect(del[0].body.deleted_events.every((d: { provider: string }) => d.provider === 'lens-file')).toBe(true)
    expect(svc.ledger().connectors).toEqual([])
    rmTmp(storeRoot)
  })

  it('Runtime without per-entry deletion (markdown authority → unknown_point): nothing faked, ids + manual steps listed, ledger kept', async () => {
    const rt = fakeRuntime({ retireWorks: false })
    const { svc, storeRoot } = setup(rt)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const r = await svc.deleteImported('calendar')
    expect(r.memoryRetired).toBe(0)
    expect(r.remaining).toHaveLength(1)
    expect(r.remaining[0]).toMatchObject({ what: 'memory', count: 3 })
    expect(r.remaining[0].reason).toMatch(/markdown/)
    expect(r.remaining[0].how.join()).toMatch(/topic-agent-findings\.md/)
    expect(r.remaining[0].ids).toEqual([...rt.memory.keys()])
    expect(live(rt)).toBe(3)
    expect(svc.ledger().connectors[0]).toMatchObject({ memoryEntries: 3 })
    rmTmp(storeRoot)
  })

  it('timeline documents cannot be deleted per source: listed as remaining with the clean-timeline note', async () => {
    const exec: ExecFn = async () => ({ code: 0, signal: null, stdout: '✓ Imported 3 new/changed document(s); 0 unchanged, 0 skipped.', stderr: '' })
    const { svc, storeRoot, rt } = setup(fakeRuntime(), exec)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), { target: 'timeline' })
    const r = await svc.deleteImported('calendar')
    expect(r.remaining).toEqual([expect.objectContaining({ what: 'timeline', count: 3 })])
    expect([...r.remaining[0].ids].sort()).toEqual(p.items.map((i) => `calendar/${i.key}.md`).sort())
    expect(r.remaining[0].how.join()).toMatch(/clean timeline/)
    expect(rt.calls).toHaveLength(0)
    expect(svc.ledger().connectors[0]).toMatchObject({ timelineDocs: 3 })
    rmTmp(storeRoot)
  })

  it('Runtime down: nothing is deleted or claimed; the ledger is unchanged; retry later works', async () => {
    let down = true
    const rt = fakeRuntime({ down: () => down })
    const { svc, storeRoot } = setup(rt)
    down = false
    const p = await svc.previewFile('health', path.join(FIX, 'health.json'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    down = true
    const r = await svc.deleteImported('health')
    expect(r).toMatchObject({ memoryRetired: 0, healthDeleted: 0 })
    expect(r.remaining.map((x) => x.what).sort()).toEqual(['health', 'memory'])
    expect(r.remaining.every((x) => /Runtime/.test(x.reason))).toBe(true)
    down = false
    const r2 = await svc.deleteImported('health')
    expect(r2).toMatchObject({ memoryRetired: 1, healthDeleted: 3, remaining: [] })
    rmTmp(storeRoot)
  })

  it('IPC: delete needs confirm:true and the main native confirm; unknown kind / nothing imported refused', async () => {
    const { svc, storeRoot, rt } = setup()
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    let answer = false
    const seen: unknown[] = []
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<any>>()
    registerConnectorHandlers({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, svc, async () => null, async () => true, {
      deletion: async (s) => {
        seen.push(s)
        return answer
      }
    })
    const call = (raw: unknown) => handlers.get('lens:connectors:delete-imported')!({ sender: null }, raw)
    expect((await call({ kind: 'calendar' })).ok).toBe(false)
    expect((await call({ kind: 'gmail', confirm: true })).ok).toBe(false)
    expect((await call({ kind: 'csv', confirm: true })).ok).toBe(false)
    expect(await call({ kind: 'calendar', confirm: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/已取消/) } })
    expect(live(rt)).toBe(3)
    answer = true
    expect(await call({ kind: 'calendar', confirm: true })).toMatchObject({ ok: true, data: { memoryRetired: 3 } })
    expect(seen[0]).toEqual({ kind: 'calendar', memoryEntries: 3, healthEvents: 0, timelineDocs: 0 })
    const l = await handlers.get('lens:connectors:ledger')!({})
    expect(l).toMatchObject({ ok: true, data: { connectors: [] } })
    rmTmp(storeRoot)
  })
})

describe('R10 Runtime: per-item erase + timeline delete by source', () => {
  it('memory entries are erased (not retired) in one batch; ledger emptied; second run is a no-op', async () => {
    const rt = fakeRuntime({ r10: true })
    const { svc, storeRoot } = setup(rt)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const r = await svc.deleteImported('calendar')
    expect(r).toMatchObject({ memoryErased: 3, memoryRetired: 0, remaining: [] })
    expect(rt.memory.size).toBe(0)
    expect(rt.calls.filter((c) => c.route === '/memory/entries/delete')).toHaveLength(1)
    expect(rt.calls.some((c) => c.route === '/model/edit')).toBe(false)
    expect(r.notes.join()).toMatch(/删除了 3 条/)
    expect(svc.ledger().connectors).toEqual([])
    expect(await svc.deleteImported('calendar')).toMatchObject({ memoryErased: 0, remaining: [] })
    rmTmp(storeRoot)
  })

  it('ids the Runtime no longer has count as gone (noted); refused ids stay with the Runtime reason', async () => {
    const rt = fakeRuntime({ r10: true, refuse: (id) => (id.endsWith('2') ? 'not_agent_written' : null) })
    const { svc, storeRoot } = setup(rt)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const ids = [...rt.memory.keys()]
    rt.memory.delete(ids[0]) // e.g. the owner cleared memory meanwhile
    const r = await svc.deleteImported('calendar')
    expect(r.memoryErased).toBe(1)
    expect(r.notes.join()).toMatch(/1 条在 Runtime 里已经不存在/)
    expect(r.remaining).toEqual([expect.objectContaining({ what: 'memory', count: 1, ids: [ids[1]], reason: expect.stringMatching(/source:agent-run/) })])
    expect(svc.ledger().connectors[0]).toMatchObject({ memoryEntries: 1 })
    rmTmp(storeRoot)
  })

  it('timeline docs: /imports/delete by the Runtime source key sha256("folder\\0<source dir>\\0<kind>/<key>.md")', async () => {
    const exec: ExecFn = async () => ({ code: 0, signal: null, stdout: '✓ Imported 3 new/changed document(s); 0 unchanged, 0 skipped.', stderr: '' })
    const sources = new Set<string>()
    const rt = fakeRuntime({ r10: true, sources })
    const { svc, storeRoot } = setup(rt, exec)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), { target: 'timeline' })
    const srcDir = path.join(fs.realpathSync(path.join(storeRoot, 'connectors')), 'source')
    const keyOf = (doc: string) => createHash('sha256').update(`folder\u0000${srcDir}\u0000${doc}`).digest('hex')
    // The Runtime knows two of the three documents (the third was cleared earlier).
    const docs = p.items.map((i) => `calendar/${i.key}.md`)
    sources.add(keyOf(docs[0]))
    sources.add(keyOf(docs[1]))
    const r = await svc.deleteImported('calendar')
    expect(r.timelineDeleted).toBe(2)
    expect(r.remaining).toEqual([expect.objectContaining({ what: 'timeline', count: 1, ids: [docs[2]], reason: expect.stringMatching(/没有找到/) })])
    expect(svc.ledger().connectors[0]).toMatchObject({ timelineDocs: 1 })
    const call = rt.calls.find((c) => c.route === '/imports/delete')!
    expect([...call.body.ids].sort()).toEqual(docs.map(keyOf).sort())
    rmTmp(storeRoot)
  })

  it('a Runtime before R10 still gets /model/edit retire (fallback) and the old timeline note', async () => {
    const rt = fakeRuntime()
    const { svc, storeRoot } = setup(rt)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const r = await svc.deleteImported('calendar')
    expect(r).toMatchObject({ memoryRetired: 3, memoryErased: 0, remaining: [] })
    expect(rt.calls.every((c) => c.route === '/model/edit')).toBe(true)
    rmTmp(storeRoot)
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('delete notes default to English', async () => {
    const rt = fakeRuntime({ r10: true })
    const { svc, storeRoot } = setup(rt)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const r = await svc.deleteImported('calendar')
    expect(r.notes.join()).toMatch(/Runtime deleted 3 entries/)
    rmTmp(storeRoot)
  })
})
