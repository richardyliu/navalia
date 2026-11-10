// S1-R4-09: Shared moments relevance gate + weekly letter cites only ticked items with a source.
// Runtime `search` returns no `score` (personal-model-og mcp/server.py `_search`: id, path, timestamp,
// age_days, content, rank, confidence, conflicted, occurred_at). `rank`/`confidence` are not relevance,
// so without a score a hit must overlap the card topic literally. Temp roots only, no network, no LLM.
import fs from 'node:fs'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { MIN_SEARCH_SCORE, PEERS_CHANNELS, type LetterDraft, type SharedMoments } from '../../src/main/peers/api'
import { registerPeersIpc } from '../../src/main/peers/ipc'
import type { PeersDeps } from '../../src/main/peers/service'
import { buildSharedMoments, searchGate } from '../../src/main/peers/shared'
import type { RuntimeClient } from '../../src/main/runtime/client'
import type { LensResult, MemorySearchHit } from '../../src/shared/types'
import { momentsCriteria, SharedMomentsView } from '../../src/renderer/src/components/peers/SharedMoments'
import { friend, tempDir, text } from './fixtures'
;(globalThis as { React?: typeof React }).React = React

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

/** Shaped like a real Runtime `_search` row (no `score`; `rank` 0.0 on the hybrid path). */
const runtimeHit = (id: string, content: string, extra: Record<string, unknown> = {}): MemorySearchHit =>
  ({ id, path: 'event-x.md', timestamp: '2026-11-03T10:00:00+08:00', age_days: 2, content, rank: 0.0, confidence: 0.99, conflicted: false, occurred_at: null, ...extra }) as unknown as MemorySearchHit

const TOPIC = { source: 'highlight' as const, text: 'Rust CLI and SQLite tooling' }

describe('searchGate', () => {
  it('threshold is a documented constant in 0..1', () => {
    expect(MIN_SEARCH_SCORE).toBe(0.5)
  })
  it('no score: literal overlap required; rank / confidence ignored', () => {
    expect(searchGate(runtimeHit('a', 'x'), [])).toEqual({ pass: false, score: null })
    expect(searchGate(runtimeHit('a', 'x', { rank: -12.5 }), [])).toEqual({ pass: false, score: null })
    expect(searchGate(runtimeHit('a', 'x'), ['rust'])).toEqual({ pass: true, via: 'overlap', score: null })
  })
  it('numeric score: decides on its own (≥ threshold passes, below drops even with overlap); non-finite ignored', () => {
    expect(searchGate({ score: 0.5 }, [])).toEqual({ pass: true, via: 'score', score: 0.5 })
    expect(searchGate({ score: 0.49 }, ['rust'])).toEqual({ pass: false, score: 0.49 })
    expect(searchGate({ score: Number.NaN }, ['rust'])).toEqual({ pass: true, via: 'overlap', score: null })
    expect(searchGate({ score: '0.9' as unknown as number }, [])).toEqual({ pass: false, score: null })
  })
})

describe('buildSharedMoments drops irrelevant search hits', () => {
  it('Runtime top-3 with no overlap and no score → not shown, counted as dropped', () => {
    const m = buildSharedMoments({
      topics: [TOPIC],
      lines: [],
      searches: [
        {
          topicIndex: 0,
          hits: [
            runtimeHit('20261103-0001-aaaaaa', '周末去爬山，天气很好'),
            runtimeHit('20261103-0002-bbbbbb', 'Wrote a small Rust CLI for SQLite backups'),
            runtimeHit('20261103-0003-cccccc', 'grocery list: eggs, milk')
          ],
          error: null
        }
      ]
    })
    const ids = m.groups.flatMap((g) => g.entries.map((e) => e.evidenceRef))
    expect(ids).toEqual(['20261103-0002-bbbbbb'])
    expect(m.groups[0].entries[0]).toMatchObject({ match: 'both', gate: 'overlap', score: null, rank: 2 })
    expect(m.droppedBelowGate).toBe(2)
  })

  it('score-bearing hits: below threshold dropped, at/above kept as semantic', () => {
    const m = buildSharedMoments({
      topics: [TOPIC],
      lines: [],
      searches: [
        {
          topicIndex: 0,
          hits: [runtimeHit('low', '周末去爬山', { score: 0.2 }), runtimeHit('high', '和朋友聊了命令行工具', { score: 0.75 })],
          error: null
        }
      ]
    })
    expect(m.groups[0].entries.map((e) => e.evidenceRef)).toEqual(['high'])
    expect(m.groups[0].entries[0]).toMatchObject({ match: 'semantic', gate: 'score', score: 0.75 })
    expect(m.droppedBelowGate).toBe(1)
  })

  it('empty state: everything irrelevant → no groups; UI shows empty state, criteria note and hidden count', () => {
    const m = buildSharedMoments({
      topics: [TOPIC],
      lines: [],
      searches: [{ topicIndex: 0, hits: [runtimeHit('a', '周末去爬山'), runtimeHit('b', 'grocery list')], error: null }]
    })
    expect(m.groups).toEqual([])
    expect(m.counts).toEqual({ topics: 0, experiences: 0 })
    const html = renderToStaticMarkup(createElement(SharedMomentsView, { data: m, loading: false, error: null, onEvidence: () => undefined, onRefresh: () => undefined }))
    expect(html).toContain('data-testid="moments-empty"')
    expect(html).not.toContain('data-testid="moment-entry"')
    expect(html).toContain('data-testid="moments-criteria"')
    expect(html).toContain('data-testid="moments-dropped"')
    expect(html).toContain('2 more search result(s) were below the relevance threshold')
    for (const s of ['literal overlap', 'Runtime search', 'relevance threshold']) expect(momentsCriteria()).toContain(s)
    setLocale('zh')
    try {
      for (const s of ['字面重合', 'Runtime search', '相关度门槛']) expect(momentsCriteria()).toContain(s)
    } finally {
      setLocale('en')
    }
    expect(html).not.toContain('周末去爬山')
  })
})

describe('service: real-shaped Runtime payload, irrelevant hits never reach UI or letter', () => {
  it('sharedMoments + letterDraft over IPC', async () => {
    const f = friend('gate')
    roots.push(f.root)
    const storeRoot = tempDir('gate')
    roots.push(storeRoot)
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<LensResult<unknown>>>()
    const deps: PeersDeps = {
      storeRoot,
      now: () => new Date('2026-11-05T02:00:00Z'),
      runtime: () => ({ modelGraph: async () => ({ model: null }) }) as unknown as RuntimeClient,
      ossTool: async (name, args) => {
        if (name === 'recent_activity') return JSON.stringify({ count: 0, entries: [] })
        if (name === 'search') return JSON.stringify({ query: args.query, results: [runtimeHit('20261103-0001-zzzzzz', '完全无关的一条：周末去爬山')] })
        throw new Error(`unexpected tool ${name}`)
      },
      saveDialog: async () => null,
      openDialog: async () => null
    }
    registerPeersIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, deps)
    const call = async <T>(ch: string, raw?: unknown) => (await handlers.get(ch)!({}, raw)) as LensResult<T>
    await call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    const m = (await call<SharedMoments>(PEERS_CHANNELS.sharedMoments, { fingerprint: f.fingerprint, timezone: 'UTC' })) as { ok: true; data: SharedMoments }
    expect(m.ok).toBe(true)
    expect(m.data.groups).toEqual([])
    expect(m.data.droppedBelowGate).toBeGreaterThan(0)
    const d = (await call<LetterDraft>(PEERS_CHANNELS.letterDraft, { fingerprint: f.fingerprint, timezone: 'UTC' })) as { ok: true; data: LetterDraft }
    expect(d.data.markdown).not.toContain('周末去爬山')
    // S1-FULL C11: the letter's shared section lists signed moments only (none here).
    expect(d.data.markdown).toContain('- 这 7 天没有双方签名确认、并且允许写进周信的共同经历。')
  })
})
