// S2-04 画像: Root / Top 3 Faces verbatim from the model graph, Runtime ordering, honest empty.
import { describe, expect, it } from 'vitest'
import { aggregateLibrary, compareFaces, portraitFromGraph } from '../../src/main/library/aggregate'
import { libraryAllEmpty, portraitCountsLine, portraitState } from '../../src/renderer/src/components/library/viewModel'
import { emptyGraph, graph } from './fixtures'

function withModel(extra: Record<string, unknown>) {
  const g = graph([])
  return { ...g, model: { ...g.model, ...extra } } as typeof g
}

const faces = [
  { id: 'f-b', signature: '上午先清理沟通，再进入深度工作。', observations: 6, confidence: 0.64, source_receipts: ['r1'] },
  { id: 'f-a', signature: '重视证据链：结论必须能回到原文和来源。', observations: 14, confidence: 0.86, source_receipts: ['r2', 'r3'] },
  { id: 'f-c', signature: '偏好本地优先工具。', observations: 9, confidence: 0.78 },
  { id: 'f-d', signature: '同样 9 次但置信更高。', observations: 9, confidence: 0.9 },
  { id: 'f-e', signature: '   ', observations: 99, confidence: 1 }
]

describe('library portrait (S2-04)', () => {
  it('Root verbatim, top 3 Faces in the Runtime HUMAN.md order (observations, confidence, id)', () => {
    const p = portraitFromGraph(
      withModel({
        root: { signature: '一个把证据链放在第一位的本地优先构建者。', observations: 20, confidence: 0.8, source_receipts: ['a', 'b'] },
        faces,
        stats: { points: 120, evolution_lines: 3, relation_lines: 7, faces: 5, volumes: 2, roots: 1, receipts: 40 }
      })
    )
    expect(p.root).toEqual({ id: null, signature: '一个把证据链放在第一位的本地优先构建者。', observations: 20, confidence: 0.8, receipts: 2 })
    expect(p.topFaces.map((f) => f.id)).toEqual(['f-a', 'f-d', 'f-c'])
    expect(p.topFaces[0].signature).toBe('重视证据链：结论必须能回到原文和来源。')
    expect(p.counts).toEqual({ points: 120, faces: 5, volumes: 2, relationLines: 7, receipts: 40 })
    expect(portraitCountsLine(p)).toBe('Points 120 · Faces 5 · Volumes 2 · Relations 7 · Receipts 40')
    expect(compareFaces({ id: 'a', signature: 'x', observations: 1, confidence: 0.5, receipts: 0 }, { id: 'b', signature: 'y', observations: 1, confidence: 0.5, receipts: 0 })).toBeLessThan(0)
  })

  it('empty model: no Root, no Faces → honest empty state; counts are what the Runtime said', () => {
    const o = aggregateLibrary({ graph: emptyGraph, catalog: null, patterns: null })
    expect(o.portrait).toEqual({ root: null, topFaces: [], counts: { points: 0, faces: 0, volumes: 0, relationLines: 0, receipts: 0 } })
    expect(portraitState(o).kind).toBe('empty')
    expect(libraryAllEmpty(o)).toBe(true)
  })

  it('missing stats are null, never computed or invented', () => {
    const p = portraitFromGraph({ generated_at: 'x', model: {} as never })
    expect(p).toEqual({ root: null, topFaces: [], counts: { points: null, faces: null, volumes: null, relationLines: null, receipts: null } })
    expect(portraitCountsLine(p)).toBe('Runtime reported no counts')
  })

  it('offline: graph error → portrait error state, not empty', () => {
    const o = aggregateLibrary({ graph: null, graphError: { code: 'unreachable', message: '连不上 Runtime' }, catalog: null, patterns: null })
    expect(portraitState(o)).toEqual({ kind: 'error', message: '连不上 Runtime' })
    expect(libraryAllEmpty(o)).toBe(false)
  })

  it('ok state with faces only', () => {
    const o = aggregateLibrary({ graph: withModel({ faces: faces.slice(0, 1) }), catalog: null, patterns: null })
    const s = portraitState(o)
    expect(s.kind).toBe('ok')
  })
})
