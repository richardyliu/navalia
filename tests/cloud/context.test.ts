// S1-FULL C3 / C7: context assembler with fake Runtime deps — ranking, caps, truncation, redaction,
// no screenshot / path / token leakage, honest empty result when the Runtime is unreachable.
import { describe, expect, it, vi } from 'vitest'
import { fakeOss, SECRET } from './fake-runtime'
import {
  asksRecency,
  buildBundle,
  cleanSnippet,
  gatherContext,
  gatherWechat,
  keywords,
  redactForCloud,
  startOfWeek,
  wechatGroupOf,
  WECHAT_UNKNOWN_GROUP,
  type ContextCandidate
} from '../../src/main/cloud/context'

const NOW = new Date('2026-11-05T10:00:00+08:00') // Thursday

const allText = (items: Array<{ title: string; text: string; ref: string | null }>): string => items.map((i) => `${i.title}\n${i.text}\n${i.ref ?? ''}`).join('\n')

describe('C3 context: gather + bundle', () => {
  it('collects memory / model / workflow / recent, ranks memory first, assigns ctx ids', async () => {
    const { ossTool } = fakeOss()
    const g = await gatherContext('Lens 云端对话进展', { ossTool, now: () => NOW })
    expect(g.unreachable).toBe(false)
    expect(g.warnings).toEqual([])
    const b = buildBundle(g.candidates, { knownSecrets: [SECRET] })
    expect(b.items.map((i) => i.id)).toEqual(b.items.map((_, i) => `ctx-${i + 1}`))
    expect(b.items[0]).toMatchObject({ kind: 'memory', ref: 'mem-a' })
    expect(new Set(b.items.map((i) => i.kind))).toEqual(new Set(['memory', 'model', 'workflow', 'recent']))
    // The face that overlaps the question outranks the one that does not.
    const faces = b.items.filter((i) => i.title.startsWith('行为规律'))
    expect(faces[0].text).toContain('Lens 云端对话')
    expect(b.totalChars).toBe(b.items.reduce((n, i) => n + i.chars, 0))
    for (const i of b.items) expect(i.chars).toBe(i.title.length + i.text.length)
  })

  it('redacts secrets / PII and never leaks Runtime paths, screenshots, image data or the local token', async () => {
    const { ossTool } = fakeOss()
    const g = await gatherContext('Lens', { ossTool, now: () => NOW })
    const b = buildBundle(g.candidates, { knownSecrets: [SECRET] })
    const text = allText(b.items)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('alice@example.com')
    expect(text).not.toContain('13812345678')
    expect(text).not.toContain('.persome')
    expect(text).not.toContain('index.db')
    expect(text).not.toContain('.png')
    expect(text).not.toMatch(/base64|iVBOR/)
    expect(text).not.toContain('/Users/bob')
    // Memory titles carry the file label only.
    expect(b.items.find((i) => i.ref === 'mem-a')!.title).toBe('记忆 · project-lens · 2026-11-04 09:00')
  })

  it('recency questions ask recent_activity since Monday 00:00 local; others ask a small recent tail', async () => {
    const a = fakeOss()
    await gatherContext('我这周主要在忙什么', { ossTool: a.ossTool, now: () => NOW })
    const r1 = a.calls.find((c) => c.name === 'recent_activity')!.args
    expect(r1).toEqual({ since: startOfWeek(NOW).toISOString(), limit: 30 })
    expect(startOfWeek(NOW).getDay()).toBe(1)
    const b = fakeOss()
    await gatherContext('Lens 的架构', { ossTool: b.ossTool, now: () => NOW })
    expect(b.calls.find((c) => c.name === 'recent_activity')!.args).toEqual({ limit: 6 })
    expect(asksRecency('最近')).toBe(true)
    expect(asksRecency('架构是什么')).toBe(false)
  })

  it('entities named in the question → entity_graph via the model graph', async () => {
    const { ossTool, calls } = fakeOss({
      entity_graph: (args) => ({ resolved: args.name, layer: 'L2', edges: [{ src: 'Alice', dst: 'Lens', predicate: 'works_on', observations: 4 }], neighbors: [], chain_to_user: 'Alice → 同事 → 你' })
    })
    const graph = {
      generated_at: '',
      model: {
        points: [
          { id: 'p1', content: 'Alice 负责 Lens 的云端', layer: 'L1', status: 'active', is_latest: true, file_name: 'person-alice.md', tags: ['person'], confidence: 1, conflicted: false, receipt: 'rcpt-1' }
        ],
        lines: [],
        faces: [],
        volumes: [],
        root: null,
        receipts: [],
        stats: {}
      }
    }
    const g = await gatherContext('Alice 最近在做什么', { ossTool, runtime: () => ({ modelGraph: async () => graph as never }), now: () => NOW })
    expect(calls.some((c) => c.name === 'entity_graph' && c.args.name === 'alice')).toBe(true)
    const ent = g.candidates.find((c) => c.kind === 'entity')!
    expect(ent.text).toContain('Alice —works_on→ Lens')
    expect(ent.text).toContain('与你的关系')
    expect(g.candidates.some((c) => c.kind === 'model' && c.ref === 'rcpt-1')).toBe(true)
  })

  it('a failing source is reported, others still used', async () => {
    const { ossTool } = fakeOss({ behavior_patterns: () => new Error('boom /Users/bob/secret') })
    const g = await gatherContext('Lens', { ossTool, now: () => NOW })
    expect(g.unreachable).toBe(false)
    expect(g.warnings).toHaveLength(1)
    expect(g.warnings[0]).not.toContain('/Users')
    expect(g.candidates.some((c) => c.kind === 'memory')).toBe(true)
  })

  it('Runtime unreachable ⇒ empty preview with a warning, never fake items', async () => {
    const ossTool = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    const g = await gatherContext('这周怎么样', { ossTool, runtime: () => ({ modelGraph: async () => Promise.reject(new Error('down')) }), now: () => NOW })
    expect(g).toMatchObject({ candidates: [], unreachable: true })
    expect(g.warnings[0]).toContain('Cannot reach the local Persome Runtime')
    expect(buildBundle(g.candidates).items).toEqual([])
  })

  it('caps: ≤ maxItems, each ≤ 8000 with a truncation marker, total ≤ 60000, dedupe, env dumps dropped', () => {
    const big = 'x'.repeat(20_000)
    const cands: ContextCandidate[] = []
    for (let i = 0; i < 60; i++) cands.push({ kind: 'memory', title: `t${i}`, text: `${i} ${big}`, ref: `m${i}`, score: 100 - i })
    cands.push({ kind: 'memory', title: 'dup', text: 'dup', ref: 'm0', score: 1000 })
    cands.push({ kind: 'recent', title: 'env', text: 'PATH=/usr/bin\nHOME=/Users/x\nUSER=x\nAPI_KEY=abc', ref: null, score: 999 })
    const b = buildBundle(cands)
    expect(b.items.length).toBeLessThanOrEqual(40)
    expect(b.totalChars).toBeLessThanOrEqual(60_000)
    for (const i of b.items) {
      expect(i.text.length).toBeLessThanOrEqual(8000)
      if (i.title !== 'dup') expect(i.text).toMatch(/已截断，原文 200\d\d 字/)
    }
    expect(b.items[0].title).toBe('dup') // highest score wins the m0 slot
    expect(b.items.some((i) => i.title === 'env')).toBe(false)
    expect(b.warnings.join('\n')).toMatch(/truncated/)
    expect(b.warnings.join('\n')).toMatch(/exceeded the limit/)
    expect(b.warnings.join('\n')).toMatch(/credentials/)
    const small = buildBundle(cands.slice(0, 10), { maxItems: 3 })
    expect(small.items).toHaveLength(3)
  })

  it('keywords: latin words + CJK bigrams; redactForCloud counts', () => {
    expect(keywords('Lens 云端对话')).toEqual(expect.arrayContaining(['lens', '云端', '端对', '对话']))
    const r = redactForCloud('call 13812345678 or mail a@b.co with ~/.persome/index.db', [])
    expect(r.text).not.toMatch(/13812345678|a@b\.co|index\.db/)
    expect(r.redactions).toBeGreaterThanOrEqual(3)
  })
})

describe('C7 WeChat captures', () => {
  const captures = [
    { file_stem: 'f1', timestamp: '2026-11-03T10:00:00+08:00', app_name: 'WeChat', bundle_id: 'com.tencent.xinWeChat', window_title: '产品群', snippet: '周五 [发版]，Alice 负责', url: '' },
    { file_stem: 'f2', timestamp: '2026-11-04T11:00:00+08:00', app_name: 'WeChat', bundle_id: 'com.tencent.xinWeChat', window_title: '产品群', snippet: '回滚方案待定 13812345678' },
    { file_stem: 'f3', timestamp: '2026-11-04T12:00:00+08:00', app_name: '微信', bundle_id: 'com.tencent.xinWeChat', window_title: '家庭群 - 微信', snippet: '周末吃饭' },
    { file_stem: 'f4', timestamp: '2026-11-04T12:30:00+08:00', app_name: 'WeChat', bundle_id: 'com.tencent.xinWeChat', window_title: '微信', snippet: '主窗口内容' },
    { file_stem: 'f5', timestamp: '2026-11-04T13:00:00+08:00', app_name: 'Safari', bundle_id: 'com.apple.Safari', window_title: '微信公众号文章', snippet: '不是微信聊天' },
    { file_stem: 'f6', timestamp: '2026-10-20T13:00:00+08:00', app_name: 'WeChat', bundle_id: 'com.tencent.xinWeChat', window_title: '旧群', snippet: '上上周' }
  ]

  it('groups this week\'s WeChat hits by chat title; snippets only; other apps and older weeks excluded', async () => {
    const { ossTool, calls } = fakeOss({ search_captures: () => ({ query: '微信', results: captures }) })
    const g = await gatherWechat('发版', { ossTool, now: () => NOW })
    expect(calls.filter((c) => c.name === 'search_captures').every((c) => c.args.since === startOfWeek(NOW).toISOString())).toBe(true)
    expect(calls.some((c) => c.name === 'search_captures' && c.args.app_name === 'WeChat' && c.args.query === '发版')).toBe(true)
    expect(g.hits).toBe(4)
    const titles = g.candidates.map((c) => c.title)
    expect(titles).toEqual(expect.arrayContaining(['微信 · 产品群（2 次采集）', '微信 · 家庭群（1 次采集）', `微信 · ${WECHAT_UNKNOWN_GROUP}（1 次采集）`]))
    expect(titles.some((t) => t.includes('旧群') || t.includes('公众号'))).toBe(false)
    expect(g.candidates.every((c) => c.kind === 'capture')).toBe(true)
    const product = g.candidates.find((c) => c.title.startsWith('微信 · 产品群'))!
    expect(product.text).toContain('周五 发版，Alice 负责')
    expect(product.ref).toBe('capture:f1')
    // Named groups outrank the unidentified main window.
    expect(g.candidates.at(-1)!.title).toContain(WECHAT_UNKNOWN_GROUP)
    const b = buildBundle(g.candidates)
    expect(allText(b.items)).not.toContain('13812345678')
  })

  it('no captures ⇒ empty with an honest note (no fake groups); unreachable ⇒ warning', async () => {
    const empty = await gatherWechat(undefined, { ossTool: fakeOss({ search_captures: () => ({ results: [] }) }).ossTool, now: () => NOW })
    expect(empty.candidates).toEqual([])
    expect(empty.warnings.join()).toContain('No WeChat content was found')
    const down = await gatherWechat(undefined, {
      ossTool: vi.fn(async () => {
        throw new Error('down')
      }),
      now: () => NOW
    })
    expect(down).toMatchObject({ candidates: [], unreachable: true })
  })

  it('helpers', () => {
    expect(wechatGroupOf({ window_title: '' })).toBe(WECHAT_UNKNOWN_GROUP)
    expect(wechatGroupOf({ window_title: 'Team - WeChat' })).toBe('Team')
    expect(cleanSnippet('a [b] c\n d')).toBe('a b c d')
  })
})
