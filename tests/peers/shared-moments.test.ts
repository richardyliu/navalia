// S1-R3-05: Peers detail 「共同话题 / 共同经历」 + weekly-letter citations.
// Entries come only from the friend's card topics vs. the user's own model (literal overlap) and the
// user's own memory via the Runtime `search` tool (semantic, local). No LLM, no network. Temp roots only.
import fs from 'node:fs'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { PEERS_CHANNELS, SHARED_KIND_LABEL, UNVERIFIED, type SharedMoments } from '../../src/main/peers/api'
import { registerPeersIpc } from '../../src/main/peers/ipc'
import { buildLetter } from '../../src/main/peers/letter'
import type { PeersDeps } from '../../src/main/peers/service'
import { buildSharedMoments, MAX_SEARCH_TOPICS, SEARCH_TOP_K } from '../../src/main/peers/shared'
import { cardTopics, userLines } from '../../src/main/peers/topics'
import type { RuntimeClient } from '../../src/main/runtime/client'
import type { LensResult, MemorySearchHit, ModelGraphResponse } from '../../src/shared/types'
import { SharedMomentsView } from '../../src/renderer/src/components/peers/SharedMoments'
import { friend, tempDir, text, userGraph } from './fixtures'
;(globalThis as { React?: typeof React }).React = React

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function alice() {
  const f = friend('moments')
  roots.push(f.root)
  return f
}

const hit = (id: string, content: string, timestamp?: string, path = 'project-x.md'): MemorySearchHit => ({ id, path, content, ...(timestamp ? { timestamp } : {}) })

describe('buildSharedMoments (pure)', () => {
  it('groups by the friend card topic; model lines → 共同话题, dated memory hits → 共同经历', () => {
    const topics = cardTopics(alice().card())
    const graphTopic = topics.findIndex((t) => t.text === '在做本地优先的知识图谱工具')
    const rustTopic = topics.findIndex((t) => t.text === 'Rust CLI and SQLite tooling')
    const m = buildSharedMoments({
      topics,
      lines: userLines(userGraph()),
      searches: [
        { topicIndex: graphTopic, hits: [{ ...hit('20261103-1010-aaaaaa', '和朋友讨论了图数据库的布局算法', '2026-11-03T10:10:00+08:00'), score: 0.8 }], error: null },
        { topicIndex: rustTopic, hits: [hit('20261102-0900-bbbbbb', 'Wrote a small Rust CLI for SQLite backups', '2026-11-02T09:00:00Z')], error: null }
      ]
    })
    expect(m.groups.map((g) => g.topic.text)).toEqual(['在做本地优先的知识图谱工具', 'Rust CLI and SQLite tooling'])
    const graph = m.groups[0]
    // literal model overlap
    const viz = graph.entries.find((e) => e.userSnippet.includes('知识图谱的可视化'))!
    expect(viz).toMatchObject({ kind: 'topic', match: 'literal', userSource: 'point', evidenceRef: '⟨pt-1:project-navalia.md⟩' })
    expect(viz.shared).toContain('知识图谱')
    expect(graph.entries.find((e) => e.userSource === 'root')).toMatchObject({ kind: 'topic', match: 'literal', evidenceRef: null })
    // semantic-only (no literal overlap with the card topic) dated memory hit
    expect(graph.entries.find((e) => e.userSource === 'memory')).toMatchObject({
      kind: 'experience',
      match: 'semantic',
      shared: [],
      evidenceRef: '20261103-1010-aaaaaa',
      userDate: '2026-11-03T10:10:00+08:00',
      rank: 1,
      gate: 'score',
      score: 0.8
    })
    // semantic + literal
    const rust = m.groups[1].entries.find((e) => e.userSource === 'memory')!
    expect(rust).toMatchObject({ kind: 'experience', match: 'both' })
    expect(rust.shared).toEqual(expect.arrayContaining(['rust', 'cli', 'sqlite']))
    expect(m.counts).toEqual({
      topics: m.groups.flatMap((g) => g.entries).filter((e) => e.kind === 'topic').length,
      experiences: 2
    })
    // ordering inside a group: 共同话题 before 共同经历
    for (const g of m.groups) {
      const kinds = g.entries.map((e) => e.kind)
      expect(kinds).toEqual([...kinds].sort((a, b) => (a === b ? 0 : a === 'topic' ? -1 : 1)))
    }
  })

  it('every entry is labelled 未核实; superseded points never appear', () => {
    const m = buildSharedMoments({
      topics: cardTopics(alice().card()),
      lines: userLines(userGraph()),
      searches: []
    })
    const all = m.groups.flatMap((g) => g.entries)
    expect(all.length).toBeGreaterThan(0)
    for (const e of all) expect(e.label).toBe(UNVERIFIED)
    expect(JSON.stringify(m)).not.toContain('知识图谱已经放弃')
  })

  it('a memory hit is listed once (first topic wins); undated hits count as 共同话题; empty / blank hits dropped', () => {
    const topics = [
      { source: 'highlight' as const, text: 'alpha topic' },
      { source: 'highlight' as const, text: 'beta topic' }
    ]
    // S1-R4-09: shares the word "topic" with both card topics, so it passes the overlap gate twice.
    const dup = hit('20261101-0000-cccccc', 'gardening topic notes')
    const m = buildSharedMoments({
      topics,
      lines: [],
      searches: [
        { topicIndex: 0, hits: [dup, hit('blank', '   ')], error: null },
        { topicIndex: 1, hits: [dup], error: null }
      ]
    })
    expect(m.groups).toHaveLength(1)
    expect(m.groups[0].entries).toHaveLength(1)
    expect(m.groups[0].entries[0]).toMatchObject({ kind: 'topic', userSource: 'memory', evidenceRef: '20261101-0000-cccccc', userDate: null })
  })

  it('empty: no overlap and no hits → no groups; search error surfaced, not invented', () => {
    const topics = [{ source: 'highlight' as const, text: '潜水与水下摄影' }]
    const m = buildSharedMoments({ topics, lines: userLines(userGraph()), searches: [{ topicIndex: 0, hits: null, error: 'Runtime 不可达' }] })
    expect(m.groups).toEqual([])
    expect(m.searchError).toBe('Runtime 不可达')
    expect(m.counts).toEqual({ topics: 0, experiences: 0 })
  })
})

describe('SharedMomentsView (render)', () => {
  const sample = (): SharedMoments =>
    buildSharedMoments({
      topics: cardTopics(alice().card()),
      lines: userLines(userGraph()),
      searches: [{ topicIndex: 1, hits: [{ ...hit('20261103-1010-aaaaaa', '和朋友讨论了图数据库的布局算法', '2026-11-03T10:10:00+08:00'), score: 0.8 }], error: null }]
    })

  it('readable items: their card topic + my snippet + 未核实 + evidence link per entry', () => {
    const m = sample()
    const html = renderToStaticMarkup(createElement(SharedMomentsView, { data: m, loading: false, error: null, onEvidence: () => undefined, onRefresh: () => undefined }))
    expect(html).toContain('Keyword overlap (Unverified, not shared moments)')
    expect(html).toContain(SHARED_KIND_LABEL.topic)
    expect(html).toContain(SHARED_KIND_LABEL.experience)
    const entries = m.groups.flatMap((g) => g.entries)
    expect(html.match(/data-testid="moment-entry"/g)?.length).toBe(entries.length)
    expect(html.match(/data-testid="moment-unverified"/g)?.length).toBe(entries.length)
    expect(html).toContain('Their card')
    expect(html).toContain('在做本地优先的知识图谱工具')
    expect(html).toContain('知识图谱的可视化')
    for (const e of entries) {
      if (e.evidenceRef) expect(html).toContain(`data-ref="${e.evidenceRef}"`)
    }
    expect(html).toContain('data-ref="20261103-1010-aaaaaa"')
    expect(html).toContain('No receipt')
  })

  it('empty state + errors', () => {
    const empty = buildSharedMoments({ topics: [{ source: 'highlight', text: '潜水' }], lines: [], searches: [] })
    const html = renderToStaticMarkup(createElement(SharedMomentsView, { data: empty, loading: false, error: null, onEvidence: () => undefined, onRefresh: () => undefined }))
    expect(html).toContain('data-testid="moments-empty"')
    const err = renderToStaticMarkup(
      createElement(SharedMomentsView, { data: { ...empty, modelError: '连不上 Runtime', searchError: '检索失败' }, loading: false, error: null, onEvidence: () => undefined, onRefresh: () => undefined })
    )
    expect(err).toContain('连不上 Runtime')
    expect(err).toContain('检索失败')
  })
})

describe('service + IPC', () => {
  function harness(opts: { graph?: ModelGraphResponse | Error; search?: (args: Record<string, unknown>) => string } = {}) {
    const storeRoot = tempDir('moments')
    roots.push(storeRoot)
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<LensResult<unknown>>>()
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const deps: PeersDeps = {
      storeRoot,
      now: () => new Date('2026-11-05T02:00:00Z'),
      runtime: () =>
        ({
          modelGraph: async () => {
            const g = opts.graph ?? userGraph()
            if (g instanceof Error) throw g
            return g
          }
        }) as unknown as RuntimeClient,
      ossTool: async (name, args) => {
        calls.push({ name, args })
        if (name === 'recent_activity') return JSON.stringify({ count: 0, entries: [] })
        if (name === 'search') return opts.search ? opts.search(args) : JSON.stringify({ query: args.query, results: [] })
        throw new Error(`unexpected tool ${name}`)
      },
      saveDialog: async () => null,
      openDialog: async () => null
    }
    registerPeersIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, deps)
    const call = async <T>(ch: string, raw?: unknown) => (await handlers.get(ch)!({}, raw)) as LensResult<T>
    return { call, calls }
  }

  it('channel validates the fingerprint; only local `search` per topic (bounded), args = topic text + top_k', async () => {
    const f = alice()
    const h = harness({
      search: (a) =>
        JSON.stringify({ query: a.query, results: a.query === 'Rust CLI and SQLite tooling' ? [hit('20261102-0900-bbbbbb', 'Rust CLI for backups', '2026-11-02T09:00:00Z')] : [] })
    })
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    expect((await h.call(PEERS_CHANNELS.sharedMoments, { fingerprint: 'nope' })).ok).toBe(false)
    const r = (await h.call<SharedMoments>(PEERS_CHANNELS.sharedMoments, { fingerprint: f.fingerprint })) as { ok: true; data: SharedMoments }
    expect(r.ok).toBe(true)
    const topics = cardTopics(f.card())
    expect(h.calls.every((c) => c.name === 'search')).toBe(true)
    // S1-R3-SEC M3: bounded by the letter window (UTC when no timezone is given): 2026-10-30 − 1 day.
    expect(h.calls.map((c) => c.args)).toEqual(topics.slice(0, MAX_SEARCH_TOPICS).map((t) => ({ query: t.text, since: '2026-10-29', top_k: SEARCH_TOP_K })))
    expect(r.data.searchedTopics).toBe(Math.min(MAX_SEARCH_TOPICS, topics.length))
    const rust = r.data.groups.find((g) => g.topic.text === 'Rust CLI and SQLite tooling')!
    expect(rust.entries.some((e) => e.evidenceRef === '20261102-0900-bbbbbb' && e.kind === 'experience')).toBe(true)
  })

  it('search unreachable: stops after the first failure, still returns literal model overlap + the error', async () => {
    const f = alice()
    const h = harness({
      search: () => {
        throw new Error('stdio MCP 不可用')
      }
    })
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    const r = (await h.call<SharedMoments>(PEERS_CHANNELS.sharedMoments, { fingerprint: f.fingerprint })) as { ok: true; data: SharedMoments }
    expect(h.calls).toHaveLength(1)
    expect(r.data.searchError).toContain('stdio MCP 不可用')
    expect(r.data.groups.length).toBeGreaterThan(0)
  })

  it('model unreachable + no hits → empty with modelError', async () => {
    const f = alice()
    const h = harness({ graph: new Error('连不上 Runtime') })
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    const r = (await h.call<SharedMoments>(PEERS_CHANNELS.sharedMoments, { fingerprint: f.fingerprint })) as { ok: true; data: SharedMoments }
    expect(r.data).toMatchObject({ groups: [], modelError: '连不上 Runtime' })
  })

  it('C11: the letter draft does NOT cite keyword overlap (signed moments only)', async () => {
    const f = alice()
    const h = harness({
      search: (a) =>
        JSON.stringify({ query: a.query, results: a.query === 'Rust CLI and SQLite tooling' ? [hit('20261102-0900-bbbbbb', 'Rust CLI for backups', '2026-11-02T09:00:00Z')] : [] })
    })
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    const r = (await h.call<{ markdown: string; counts: { experiences: number } }>(PEERS_CHANNELS.letterDraft, { fingerprint: f.fingerprint, timezone: 'UTC' })) as {
      ok: true
      data: { markdown: string; counts: { experiences: number } }
    }
    expect(r.ok).toBe(true)
    expect(r.data.markdown).toContain('## 这周和你的共同经历')
    expect(r.data.markdown).not.toContain('⟨20261102-0900-bbbbbb⟩')
    expect(r.data.counts.experiences).toBe(0)
    expect(h.calls.map((c) => c.name)).toEqual(['recent_activity'])
  })
})
