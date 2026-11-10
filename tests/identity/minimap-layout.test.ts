import { describe, expect, test } from 'vitest'
import { buildCardContent } from '../../src/main/identity/card-content'
import { groupFingerprint, layoutMiniMap, MAP_H, MAP_W } from '../../src/renderer/src/components/card/layout'
import { emptyGraph, sampleGraph, sources } from './fixtures'

describe('Mini Map layout', () => {
  test('deterministic, inside the viewBox, edges only from card data', () => {
    const map = buildCardContent(sources()).back.mini_map
    const a = layoutMiniMap(map)
    expect(layoutMiniMap(map)).toEqual(a)
    expect(a.nodes).toHaveLength(map.nodes.length)
    expect(a.edges).toHaveLength(map.edges.length)
    for (const n of a.nodes) {
      expect(n.x - n.r).toBeGreaterThanOrEqual(0)
      expect(n.x + n.r).toBeLessThanOrEqual(MAP_W)
      expect(n.y - n.r).toBeGreaterThanOrEqual(0)
      expect(n.y + n.r).toBeLessThanOrEqual(MAP_H)
    }
    const root = a.nodes.find((n) => n.level === 'root')!
    expect([root.x, root.y]).toEqual([MAP_W / 2, MAP_H / 2])
  })

  test('full 48-face map stays in bounds', () => {
    const g = sampleGraph()
    g.model.faces = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, signature: `face ${i}`, observations: i, confidence: 0.5 }))
    const { nodes } = layoutMiniMap(buildCardContent(sources(g)).back.mini_map)
    for (const n of nodes) {
      expect(n.x - n.r).toBeGreaterThanOrEqual(0)
      expect(n.y + n.r).toBeLessThanOrEqual(MAP_H)
    }
  })

  test('empty map → no nodes; fingerprint grouping', () => {
    expect(layoutMiniMap(buildCardContent(sources(emptyGraph())).back.mini_map)).toEqual({ nodes: [], edges: [] })
    expect(groupFingerprint('03b4119bdbabdfb5')).toBe('03b4 119b dbab dfb5')
  })
})
