// S1-R3-SEC M3: peer-chosen topics drive searches over the user's memory. Snippets and topics are
// redacted before the UI; the search is bounded by the letter's `since` window. Since S1-FULL C11 the
// letter never cites keyword overlap (only signed shared moments). Temp roots only.
import fs from 'node:fs'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { PEERS_CHANNELS, UNVERIFIED, type LetterDraft, type SharedMoments } from '../../src/main/peers/api'
import { registerPeersIpc } from '../../src/main/peers/ipc'
import { addDays, buildLetter, letterWindow } from '../../src/main/peers/letter'
import type { PeersDeps } from '../../src/main/peers/service'
import { buildSharedMoments } from '../../src/main/peers/shared'
import { cardTopics, type UserLine } from '../../src/main/peers/topics'
import type { RuntimeClient } from '../../src/main/runtime/client'
import type { LensResult, MemorySearchHit } from '../../src/shared/types'
import { SharedMomentsView } from '../../src/renderer/src/components/peers/SharedMoments'
import { friend, tempDir, text, userGraph } from './fixtures'
;(globalThis as { React?: typeof React }).React = React

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const SECRET_HIT = 'Rust CLI 备份脚本 PGPASSWORD=hunter2secret 发给 bob@example.com 或 +1 (415) 555-0134'
const hit = (id: string, content: string, timestamp?: string): MemorySearchHit => ({ id, path: 'project-x.md', content, ...(timestamp ? { timestamp } : {}) })
const NOW = new Date('2026-11-05T02:00:00Z')

function alice() {
  const f = friend('moments-sec')
  roots.push(f.root)
  return f
}

function moments(): SharedMoments {
  const lines: UserLine[] = [{ source: 'point', text: 'Rust CLI and SQLite tooling, token=abcd1234efgh mail carol@example.com', ref: 'pt-9', weight: 1 }]
  return buildSharedMoments({
    topics: [
      { source: 'highlight', text: 'Rust CLI and SQLite tooling' },
      { source: 'highlight', text: 'ask me at dave@example.com about DB_PASS=topicsecret99' }
    ],
    lines,
    searches: [{ topicIndex: 0, hits: [hit('20261102-0900-bbbbbb', SECRET_HIT, '2026-11-02T09:00:00Z')], error: null }]
  })
}

describe('M3 redaction of shared moments (UI + letter)', () => {
  it('userSnippet and topic text are redacted (secrets, email, phone)', () => {
    const m = moments()
    const json = JSON.stringify(m)
    for (const s of ['hunter2secret', 'bob@example.com', '555-0134', 'abcd1234efgh', 'carol@example.com']) expect(json).not.toContain(s)
    const all = m.groups.flatMap((g) => g.entries)
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all.some((e) => e.userSnippet.includes('Rust CLI'))).toBe(true)
    // a topic that matched nothing is not grouped; when grouped, its text is redacted too
    const m2 = buildSharedMoments({
      topics: [{ source: 'highlight', text: 'ask me at dave@example.com about DB_PASS=topicsecret99' }],
      lines: [],
      // S1-R4-09: no literal overlap, so a score is needed for the topic to be grouped at all.
      searches: [{ topicIndex: 0, hits: [{ ...hit('x-1', 'something about it'), score: 0.9 }], error: null }]
    })
    expect(m2.groups).toHaveLength(1)
    expect(JSON.stringify(m2)).not.toContain('dave@example.com')
    expect(JSON.stringify(m2)).not.toContain('topicsecret99')
  })

  it('every entry has a stable content-derived id', () => {
    const a = moments().groups.flatMap((g) => g.entries.map((e) => e.id))
    const b = moments().groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(a).toEqual(b)
    for (const id of a) expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(new Set(a).size).toBe(a.length)
  })
})

// S1-FULL C11 / C18 (D31 change): keyword overlap is never cited in a letter any more, even when a
// caller passes the old `moments` / `cite` fields (they are ignored).
describe('C11: letter never cites keyword overlap', () => {
  it('legacy moments + cite inputs are ignored: no topic, snippet or memory ref appears', () => {
    const m = moments()
    const ids = m.groups.flatMap((g) => g.entries.map((e) => e.id))
    const md = buildLetter({
      now: NOW,
      timezone: 'UTC',
      peer: { fingerprint: 'f'.repeat(64), displayName: 'Alice', cardId: 'c1', cardIssuedAt: '2026-11-01T09:00:00.000Z' },
      recent: [],
      ...({ related: [], shared: [], moments: m, cite: ids } as object)
    }).markdown
    for (const x of ['Rust CLI and SQLite tooling', '备份脚本', '⟨20261102-0900-bbbbbb⟩', '⟨pt-9⟩', '我这边的记录是', '共同话题']) expect(md).not.toContain(x)
    expect(md).toContain('- 这 7 天没有双方签名确认、并且允许写进周信的共同经历。')
  })
})

describe('M3 service: bounded search window + IPC opt-in', () => {
  function harness() {
    const storeRoot = tempDir('moments-sec')
    roots.push(storeRoot)
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<LensResult<unknown>>>()
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const deps: PeersDeps = {
      storeRoot,
      now: () => NOW,
      runtime: () => ({ modelGraph: async () => userGraph() }) as unknown as RuntimeClient,
      ossTool: async (name, args) => {
        calls.push({ name, args })
        if (name === 'recent_activity') return JSON.stringify({ count: 0, entries: [] })
        if (name === 'search')
          return JSON.stringify({ query: args.query, results: args.query === 'Rust CLI and SQLite tooling' ? [hit('20261102-0900-bbbbbb', SECRET_HIT, '2026-11-02T09:00:00Z')] : [] })
        throw new Error(`unexpected tool ${name}`)
      },
      saveDialog: async () => null,
      openDialog: async () => null
    }
    registerPeersIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, deps)
    const call = async <T>(ch: string, raw?: unknown) => (await handlers.get(ch)!({}, raw)) as LensResult<T>
    return { call, calls }
  }

  it('keyword-overlap searches are bounded by the letter window; the letter itself makes no search', async () => {
    const f = alice()
    const h = harness()
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    const tz = 'Asia/Shanghai'
    const since = addDays(letterWindow(NOW, tz).start, -1)
    await h.call(PEERS_CHANNELS.sharedMoments, { fingerprint: f.fingerprint, timezone: tz })
    const uiSearches = h.calls.filter((c) => c.name === 'search')
    expect(uiSearches.length).toBeGreaterThan(0)
    for (const c of uiSearches) expect(c.args.since).toBe(since)
    h.calls.length = 0
    await h.call(PEERS_CHANNELS.letterDraft, { fingerprint: f.fingerprint, timezone: tz })
    expect(h.calls.map((c) => c.name)).toEqual(['recent_activity'])
  })

  it('sharedMoments without a timezone is still bounded (UTC window)', async () => {
    const f = alice()
    const h = harness()
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    await h.call(PEERS_CHANNELS.sharedMoments, { fingerprint: f.fingerprint })
    for (const c of h.calls.filter((x) => x.name === 'search')) expect(c.args.since).toBe(addDays(letterWindow(NOW, 'UTC').start, -1))
  })

  it('letterDraft over IPC: no keyword snippet ever; the old `cite` argument is rejected (strictObject)', async () => {
    const f = alice()
    const h = harness()
    await h.call(PEERS_CHANNELS.importText, { text: text(f.card()) })
    const plain = (await h.call<LetterDraft>(PEERS_CHANNELS.letterDraft, { fingerprint: f.fingerprint, timezone: 'UTC' })) as { ok: true; data: LetterDraft }
    expect(plain.ok).toBe(true)
    expect(plain.data.markdown).not.toContain('⟨20261102-0900-bbbbbb⟩')
    expect(plain.data.markdown).not.toContain('备份脚本')
    const m = (await h.call<SharedMoments>(PEERS_CHANNELS.sharedMoments, { fingerprint: f.fingerprint, timezone: 'UTC' })) as { ok: true; data: SharedMoments }
    const id = m.data.groups.flatMap((g) => g.entries)[0].id
    expect((await h.call(PEERS_CHANNELS.letterDraft, { fingerprint: f.fingerprint, timezone: 'UTC', cite: [id] })).ok).toBe(false)
  })
})

describe('C18 Peers UI: keyword overlap is demoted', () => {
  it('no 写进每周信 checkbox; heading says 关键词重合 / 未核实 / 不是共同经历', () => {
    const html = renderToStaticMarkup(createElement(SharedMomentsView, { data: moments(), loading: false, error: null, onEvidence: () => undefined, onRefresh: () => undefined }))
    expect(html).not.toContain('moment-cite')
    expect(html).not.toContain('写进每周信（')
    expect(html).toContain('Keyword overlap (Unverified, not shared moments)')
  })

  it('Peers page asks for the letter without cite ids', () => {
    const src = fs.readFileSync(new URL('../../src/renderer/src/pages/Peers.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/letterDraft\(peer\.fingerprint, timezone\(\)\)/)
    expect(src).not.toMatch(/cited/)
  })
})
