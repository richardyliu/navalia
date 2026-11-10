import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { PEERS_CHANNELS, SUBSCRIPTION_STATUS, type PeerImportResult, type PeerSuggestions, type LetterDraft, type PeerList } from '../../src/main/peers/api'
import { registerPeersIpc } from '../../src/main/peers/ipc'
import type { PeersDeps } from '../../src/main/peers/service'
import { cardTopics, suggestOverlap, userLines } from '../../src/main/peers/topics'
import type { RuntimeClient } from '../../src/main/runtime/client'
import type { LensResult, ModelGraphResponse } from '../../src/shared/types'
import { activityRows, importNotice, shortFingerprint, VERIFICATION_LABEL } from '../../src/renderer/src/components/peers/peersView'
import { friend, tempDir, text, userGraph } from './fixtures'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

type Handler = (event: unknown, raw: unknown) => Promise<LensResult<unknown>>
function harness(over: Partial<PeersDeps> = {}) {
  const storeRoot = tempDir('ipc')
  roots.push(storeRoot)
  const handlers = new Map<string, Handler>()
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let graph: ModelGraphResponse | Error = userGraph()
  const deps: PeersDeps = {
    storeRoot,
    now: () => new Date('2026-11-05T02:00:00Z'),
    runtime: () =>
      ({
        modelGraph: async () => {
          if (graph instanceof Error) throw graph
          return graph
        }
      }) as unknown as RuntimeClient,
    ossTool: async (name, args) => {
      calls.push({ name, args })
      if (name === 'recent_activity') {
        return JSON.stringify({ count: 1, entries: [{ id: 'e-1', path: 'project-navalia.md', timestamp: '2026-11-04T09:30:00+08:00', content: '给 Peers 页面写了验签测试' }] })
      }
      if (name === 'search') return JSON.stringify({ query: args.query, results: [] })
      throw new Error(`unexpected tool ${name}`)
    },
    saveDialog: async () => null,
    openDialog: async () => null,
    ...over
  }
  registerPeersIpc({ handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) } as never, deps)
  const call = async <T>(ch: string, raw?: unknown): Promise<LensResult<T>> => (await handlers.get(ch)!({}, raw)) as LensResult<T>
  return { storeRoot, handlers, call, calls, setGraph: (g: ModelGraphResponse | Error) => (graph = g) }
}

describe('peers IPC', () => {
  it('registers every channel', () => {
    const h = harness()
    expect([...h.handlers.keys()].sort()).toEqual(Object.values(PEERS_CHANNELS).sort())
  })

  it('validates payloads with zod', async () => {
    const h = harness()
    expect(await h.call(PEERS_CHANNELS.list, { x: 1 })).toMatchObject({ ok: false })
    expect(await h.call(PEERS_CHANNELS.get, { fingerprint: '../x' })).toMatchObject({ ok: false })
    expect(await h.call(PEERS_CHANNELS.remove, { fingerprint: 'A'.repeat(64) })).toMatchObject({ ok: false })
    expect(await h.call(PEERS_CHANNELS.letterDraft, { fingerprint: 'a'.repeat(64), timezone: 'Mars/Olympus' })).toMatchObject({ ok: false })
    expect(await h.call(PEERS_CHANNELS.importText, { text: '' })).toMatchObject({ ok: false })
    expect(await h.call(PEERS_CHANNELS.importText, { text: 'x', extra: 1 })).toMatchObject({ ok: false })
  })

  it('import → list → suggestions → letter → remove', async () => {
    const h = harness()
    const alice = friend('a')
    roots.push(alice.root)
    const imp = await h.call<PeerImportResult>(PEERS_CHANNELS.importText, { text: text(alice.card()) })
    expect(imp).toMatchObject({ ok: true, data: { ok: true, outcome: 'added' } })
    const list = await h.call<PeerList>(PEERS_CHANNELS.list)
    expect(list.ok && list.data.peers.map((p) => p.fingerprint)).toEqual([alice.fingerprint])

    const s = await h.call<PeerSuggestions>(PEERS_CHANNELS.suggestions, { fingerprint: alice.fingerprint })
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.data.modelError).toBeNull()
    expect(s.data.suggestions.length).toBeGreaterThan(0)
    for (const x of s.data.suggestions) expect(x.label).toBe('未核实')

    const l = await h.call<LetterDraft>(PEERS_CHANNELS.letterDraft, { fingerprint: alice.fingerprint, timezone: 'Asia/Shanghai' })
    expect(l.ok).toBe(true)
    if (!l.ok) return
    expect(l.data.range).toEqual({ start: '2026-10-30', end: '2026-11-05' })
    expect(l.data.markdown).toContain('“给 Peers 页面写了验签测试” ⟨e-1⟩（未核实）')
    // S1-FULL C11: the letter reads only recent_activity; no keyword / search overlap any more.
    expect(h.calls.map((c) => c.name)).toEqual(['recent_activity'])
    expect(h.calls[0].args).toEqual({ since: '2026-10-29', limit: 200 })
    expect(l.data.markdown).toContain('## 这周和你的共同经历')

    expect(await h.call(PEERS_CHANNELS.remove, { fingerprint: alice.fingerprint })).toEqual({ ok: true, data: { removed: true } })
    expect(await h.call(PEERS_CHANNELS.get, { fingerprint: alice.fingerprint })).toEqual({ ok: true, data: null })
  })

  it('tampered card is rejected over IPC and not listed', async () => {
    const h = harness()
    const f = friend('t')
    roots.push(f.root)
    const t = JSON.parse(text(f.card()))
    t.card.content.front.highlights[0].signature = 'forged'
    const r = await h.call<PeerImportResult>(PEERS_CHANNELS.importText, { text: JSON.stringify(t) })
    expect(r).toMatchObject({ ok: true, data: { ok: false, reason: 'tampered' } })
    expect(await h.call(PEERS_CHANNELS.list)).toEqual({ ok: true, data: { peers: [], unreadable: 0 } })
  })

  it('suggestions are empty with the error when the model is unreachable (never invented)', async () => {
    const h = harness()
    const f = friend('m')
    roots.push(f.root)
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    h.setGraph(new Error('runtime offline'))
    const s = await h.call<PeerSuggestions>(PEERS_CHANNELS.suggestions, { fingerprint: f.fingerprint })
    expect(s).toEqual({ ok: true, data: { suggestions: [], modelError: 'runtime offline' } })
  })

  it('import file goes through the open dialog; export writes only the chosen path', async () => {
    const out = tempDir('out')
    roots.push(out)
    const f = friend('d')
    roots.push(f.root)
    const cardFile = path.join(out, 'alice.navaliacard')
    fs.writeFileSync(cardFile, text(f.card()))
    const target = path.join(out, 'letter.md')
    const h = harness({ openDialog: async () => cardFile, saveDialog: async () => target })
    expect(await h.call(PEERS_CHANNELS.importFile)).toMatchObject({ ok: true, data: { ok: true, outcome: 'added' } })
    const r = await h.call<{ path: string | null }>(PEERS_CHANNELS.exportLetter, { fingerprint: f.fingerprint, markdown: '# 草稿' })
    expect(r).toMatchObject({ ok: true, data: { path: target } })
    expect(fs.readFileSync(target, 'utf8')).toBe('# 草稿\n')
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
  })
})

describe('overlap suggestions (deterministic)', () => {
  it('derives only literal overlap, skipping superseded points', () => {
    const f = friend('o')
    roots.push(f.root)
    const s = suggestOverlap(cardTopics(f.card()), userLines(userGraph()))
    expect(s.map((x) => x.shared)).toEqual([['cli', 'rust'], ['本地优先', '工具'], ['知识图谱']])
    expect(s.map((x) => x.userSource)).toEqual(['point', 'root', 'point'])
    expect(s.some((x) => x.userQuote.includes('放弃'))).toBe(false)
    expect(suggestOverlap(cardTopics(f.card()), userLines(userGraph()))).toEqual(s)
  })

  it('no overlap → empty', () => {
    const f = friend('n')
    roots.push(f.root)
    const card = f.card({ summary: '摄影爱好者', highlights: ['Landscape photography'] })
    expect(suggestOverlap(cardTopics(card), userLines(userGraph()))).toEqual([])
    expect(suggestOverlap(cardTopics(card), userLines(null))).toEqual([])
  })
})

describe('peers view-model', () => {
  it('labels verification, rejections, activity and subscription honestly', () => {
    expect(shortFingerprint('0123456789abcdef'.repeat(4))).toBe('01234567…cdef')
    expect(VERIFICATION_LABEL.old_key.text).toContain('Unverified')
    expect(importNotice({ ok: false, reason: 'tampered', detail: 'x' })).toEqual({ tone: 'bad', text: expect.stringContaining('modified') })
    expect(activityRows([{ at: '2026-11-05T02:00:00Z', kind: 'imported', cardId: 'card_x', cardIssuedAt: '2026-11-01T09:00:00Z' }])[0].text).toMatch(/^Imported the card on this Mac/)
    expect(SUBSCRIPTION_STATUS.state).toBe('local_folder')
    expect(SUBSCRIPTION_STATUS.reason).toContain('never goes online')
    expect(SUBSCRIPTION_STATUS.reason).toContain('Local first: folder subscription')
    expect(SUBSCRIPTION_STATUS.reason).toContain('X2')
    setLocale('zh')
    try {
      expect(VERIFICATION_LABEL.old_key.text).toContain('未核实')
      expect(importNotice({ ok: false, reason: 'tampered', detail: 'x' })).toEqual({ tone: 'bad', text: expect.stringContaining('改动') })
      expect(activityRows([{ at: '2026-11-05T02:00:00Z', kind: 'imported', cardId: 'card_x', cardIssuedAt: '2026-11-01T09:00:00Z' }])[0].text).toMatch(/^在本机导入了卡片/)
      expect(SUBSCRIPTION_STATUS.reason).toContain('不联网')
      expect(SUBSCRIPTION_STATUS.reason).toContain('本地优先：文件夹订阅')
      expect(SUBSCRIPTION_STATUS.reason).not.toContain('无云订阅')
    } finally {
      setLocale('en')
    }
  })
})
