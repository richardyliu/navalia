import { describe, expect, test } from 'vitest'
import { buildCardContent, CardContentSchema, MAX_MAP_FACES } from '../../src/main/identity/card-content'
import { scrubText } from '../../src/main/identity/redact'
import { emptyGraph, sampleGraph, shareFor, sources } from './fixtures'

describe('Card content from /model/share-card + /model/graph structure', () => {
  test('front = Root summary + top highlights + as-of; back = Mini Map + stats', () => {
    const c = buildCardContent(sources(), { displayName: 'Ryl' })
    expect(c.front.display_name).toBe('Ryl')
    expect(c.front.summary).toBe('软件工程师，专注于 AI 原生产品。重视证据与可追溯性。')
    expect(c.front.summary_observations).toBe(23)
    expect(c.front.as_of).toBe('2026-11-04T17:04:12.123Z')
    expect(c.front.model_status).toBe('complete')
    expect(c.front.degraded).toBe(false)
    expect(c.front.highlights.map((h) => [h.level, h.observations])).toEqual([
      ['face', 14],
      ['volume', 11],
      ['face', 9],
      ['face', 6]
    ])
    expect(c.back.stats).toEqual({ points: 1, evolution_lines: 0, relation_lines: 0, faces: 3, volumes: 1, roots: 1 })
  })

  test('Mini Map edges come only from runtime members/parent_id, keyed by card-local keys', () => {
    const c = buildCardContent(sources())
    expect(c.back.mini_map.nodes.map((n) => [n.key, n.level, n.member_count])).toEqual([
      ['r0', 'root', 1],
      ['v0', 'volume', 2],
      ['f0', 'face', 2],
      ['f1', 'face', 1],
      ['f2', 'face', 0]
    ])
    expect(c.back.mini_map.edges).toEqual([
      { from: 'r0', to: 'v0' },
      { from: 'v0', to: 'f0' },
      { from: 'v0', to: 'f1' }
    ])
  })

  test('no points, quotes, receipts, runtime ids, or paths leak into the card', () => {
    const json = JSON.stringify(buildCardContent(sources()))
    for (const needle of ['SECRET-POINT-CONTENT', 'SECRET-QUOTE', '⟨', 'pt-00', 'face-a', 'vol-1', 'root-1', 'bld_demo', '/Users/', 'someone@example.com']) {
      expect(json).not.toContain(needle)
    }
  })

  test('items without a signature after scrubbing are dropped', () => {
    const g = sampleGraph()
    ;(g.model.faces[2] as { signature: string }).signature = '   '
    const c = buildCardContent(sources(g))
    expect(c.back.mini_map.nodes.filter((n) => n.level === 'face')).toHaveLength(2)
  })

  test('empty / unbuilt model yields an empty-state card, not fabricated content', () => {
    const c = buildCardContent(sources(emptyGraph()))
    expect(c.front.summary).toBeNull()
    expect(c.front.summary_confidence).toBeNull()
    expect(c.front.highlights).toEqual([])
    expect(c.front.model_status).toBe('not_built')
    expect(c.back.mini_map).toEqual({ nodes: [], edges: [] })
  })

  test('degraded build or index_health marks the card degraded', () => {
    const g = sampleGraph()
    g.index_health = { status: 'degraded' }
    expect(buildCardContent(sources(g)).front.degraded).toBe(true)
  })

  test('caps map size and truncates long labels by code point (no lone surrogates)', () => {
    const g = sampleGraph()
    g.model.faces = Array.from({ length: 80 }, (_, i) => ({ id: `f${i}`, signature: '😀'.repeat(400), observations: i, confidence: 0.5 }))
    const c = buildCardContent(sources(g))
    expect(c.back.mini_map.nodes.filter((n) => n.level === 'face')).toHaveLength(MAX_MAP_FACES)
    const label = c.back.mini_map.nodes[2].label
    expect(Array.from(label)).toHaveLength(280)
    expect(label.endsWith('…')).toBe(true)
    expect(() => CardContentSchema.parse(c)).not.toThrow()
  })

  test('invalid as-of is an error, not a fabricated timestamp', () => {
    const g = sampleGraph()
    g.generated_at = 'nope'
    g.model.generated_at = 'nope'
    expect(() => buildCardContent(sources(g))).toThrow(/generated_at/)
  })

  test('text comes from share-card, never from graph: graph-only text does not appear', () => {
    const g = sampleGraph()
    const share = shareFor(g)
    ;(g.model.root as { signature: string }).signature = 'GRAPH-ONLY-ROOT-TEXT'
    ;(g.model.faces[0] as { signature: string }).signature = 'GRAPH-ONLY-FACE-TEXT'
    const json = JSON.stringify(buildCardContent({ share, graph: g }))
    expect(json).not.toContain('GRAPH-ONLY')
    expect(json).toContain('软件工程师')
    // runtime scrub (<email>) and Lens scrub both applied; raw email never present
    expect(json).toContain('<email>')
    expect(json).not.toContain('someone@example.com')
  })

  test('share-card is required; a missing or malformed response fails closed', () => {
    expect(() => buildCardContent({ share: null, graph: sampleGraph() })).toThrow()
    expect(() => buildCardContent({ share: { generated_at: 'x' }, graph: sampleGraph() })).toThrow()
  })

  test('graph unavailable: text still built, no edges, member_count 0, status unknown', () => {
    const c = buildCardContent({ share: shareFor(sampleGraph()), graph: null })
    expect(c.front.summary).toContain('软件工程师')
    expect(c.back.mini_map.edges).toEqual([])
    expect(c.back.mini_map.nodes.every((n) => n.member_count === 0)).toBe(true)
    expect(c.front.model_status).toBe('unknown')
  })

  test('misaligned lists (runtime dropped an item) attach no structure for that level', () => {
    const g = sampleGraph()
    const share = shareFor(g)
    share.model.faces.pop()
    const c = buildCardContent({ share, graph: g })
    expect(c.back.mini_map.nodes.filter((n) => n.level === 'face').every((n) => n.member_count === 0)).toBe(true)
    expect(c.back.mini_map.edges).toEqual([{ from: 'r0', to: 'v0' }])
  })

  test('real runtime share-card shape (2026-11-04, empty model) parses', () => {
    const real = {
      generated_at: '2026-11-04T20:32:44.675780-08:00',
      model: { root: null, faces: [], volumes: [], stats: { points: 14, evolution_lines: 1, relation_lines: 9, faces: 0, volumes: 0, roots: 0 } }
    }
    const c = buildCardContent({ share: real, graph: null })
    expect(c.front.summary).toBeNull()
    expect(c.back.stats.points).toBe(14)
    expect(c.front.as_of).toBe('2026-11-05T04:32:44.675Z')
  })
})

describe('scrubText', () => {
  test.each([
    ['mail a.b@example.co', 'mail [email]'],
    ['see https://example.com/x?y=1 now', 'see [url] now'],
    ['file /Users/alice/secret.txt here', 'file [path] here'],
    ['key sk-abcdefghijklmnopqrstuv', 'key [secret]'],
    ['ip 192.168.1.20', 'ip [ip]'],
    ['call +1 (415) 555-0100', 'call [phone]'],
    ['重视证据链：结论必须能回到原文和来源。', '重视证据链：结论必须能回到原文和来源。'],
    // security review #3 additions
    ['aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok', 'aws [secret] ok'],
    ['id AKIAIOSFODNN7EXAMPLE', 'id [secret]'],
    ['maps AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW', 'maps [secret]'],
    ['stripe rk_live_51HxYzAbCdEfGh12345', 'stripe [secret]'],
    ['{"token": "abc.def.ghi", "name": "x"}', '{"token": "[secret]", "name": "x"}'],
    ['{"password":"hunter2"}', '{"password":"[secret]"}'],
    ['{"access_token":"ya29.a0Af"}', '{"access_token":"[secret]"}'],
    ['curl -H "Authorization: Bearer eyJhbGciOi.J9x1"', 'curl -H "Authorization: Bearer [secret]"'],
    ['export OPENAI_API_KEY=sk-proj-abc', 'export OPENAI_API_KEY=[secret]'],
    ['DB_PASSWORD="p@ss word"', 'DB_PASSWORD=[secret]'],
    ['my password is hunter2 lol', 'my password is [secret] lol'],
    ['wifi 密码：abc12345', 'wifi 密码：[secret]'],
    ['-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----', '[secret]'],
    ['Token budget exceeded today', 'Token budget exceeded today'],
    ['Bearer of bad news', 'Bearer of bad news'],
    ['version 2.0.0 released on 2025-09-01', 'version 2.0.0 released on 2025-09-01'],
    ['call 415-555-0100 now', 'call [phone] now'],
    ['at 2026-11-04T09:04:12 build 192', 'at 2026-11-04T09:04:12 build 192']
  ])('%s', (input, expected) => {
    expect(scrubText(input)).toBe(expected)
  })
})
