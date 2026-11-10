import type { ModelGraphResponse } from '../../src/shared/types'

/** Shape mirrors personal-model `build_live_snapshot` (schema items carry id/level/parent_id/members). */
export function sampleGraph(): ModelGraphResponse {
  const generated = '2026-11-04T09:04:12.123456-08:00'
  return {
    generated_at: generated,
    model: {
      schema_version: 1,
      generated_at: generated,
      build: {
        build_id: 'bld_demo_7f3a91',
        core_commit: 'b7a28ff',
        models: {},
        prompt_hashes: {},
        config_hash: null,
        input_window: null,
        mode: 'live',
        trigger: 'scheduled',
        started_at: null,
        completed_at: null,
        duration_ms: null,
        degraded_stages: [],
        status: 'complete'
      },
      points: [
        {
          id: 'pt-001',
          content: 'SECRET-POINT-CONTENT lives at /Users/alice/private/notes.md',
          layer: 'L1',
          status: 'active',
          is_latest: true,
          file_name: 'user-preferences.md',
          tags: [],
          confidence: 0.9,
          conflicted: false,
          receipt: '⟨pt-001:user-preferences.md⟩'
        }
      ],
      lines: [],
      faces: [
        { id: 'face-a', level: 1, parent_id: 'vol-1', members: ['pt-001', 'pt-002'], signature: '重视证据链：结论必须能回到原文和来源。', observations: 14, confidence: 0.86, provenance: 'both', source_receipts: ['⟨pt-006:user-preferences.md⟩'] },
        { id: 'face-b', level: 1, parent_id: 'vol-1', members: ['pt-003'], signature: 'Prefers local-first tools; mail me at someone@example.com', observations: 9, confidence: 0.78, source_receipts: [] },
        { id: 'face-c', level: 1, parent_id: null, members: [], signature: '上午先清理沟通，再进入深度工作。', observations: 6, confidence: 0.64, source_receipts: [] }
      ],
      volumes: [
        { id: 'vol-1', level: 2, parent_id: 'root-1', members: ['face-a', 'face-b'], signature: '在工具选择上，可靠性与可审计性优先于功能数量。', observations: 11, confidence: 0.74, source_receipts: [] }
      ],
      root: {
        id: 'root-1',
        level: 3,
        members: ['vol-1'],
        signature: '软件工程师，专注于 AI 原生产品。重视证据与可追溯性。',
        observations: 23,
        confidence: 0.81,
        source_receipts: ['⟨pt-001:user-preferences.md⟩']
      },
      receipts: [{ receipt: '⟨pt-001:user-preferences.md⟩', quote: 'SECRET-QUOTE' }],
      stats: { points: 1, evolution_lines: 0, relation_lines: 0, faces: 3, volumes: 1, roots: 1, receipts: 1 }
    }
  }
}

export function emptyGraph(): ModelGraphResponse {
  const g = sampleGraph()
  g.model.points = []
  g.model.faces = []
  g.model.volumes = []
  g.model.root = null
  g.model.receipts = []
  g.model.build.status = 'not_built'
  g.model.stats = { points: 0, evolution_lines: 0, relation_lines: 0, faces: 0, volumes: 0, roots: 0, receipts: 0 }
  return g
}

/** What `/model/share-card` returns for sampleGraph(): scrubbed summaries only (routes.py projection). */
export function shareFor(graph: ModelGraphResponse, scrub: (s: string) => string = (s) => s.replace(/\S+@\S+/g, '<email>')) {
  const summary = (item: { signature?: unknown; observations?: unknown; confidence?: unknown } | null) => {
    if (!item) return null
    const signature = scrub(String(item.signature ?? '')).trim()
    if (!signature) return null
    return { signature, observations: Number(item.observations ?? 0), confidence: Number(item.confidence ?? 0) }
  }
  const s = graph.model.stats
  return {
    generated_at: graph.generated_at,
    model: {
      root: summary(graph.model.root),
      faces: graph.model.faces.map(summary).filter((x) => x !== null),
      volumes: graph.model.volumes.map(summary).filter((x) => x !== null),
      stats: { points: s.points, evolution_lines: s.evolution_lines, relation_lines: s.relation_lines, faces: s.faces, volumes: s.volumes, roots: s.roots }
    }
  }
}

export function sources(graph: ModelGraphResponse = sampleGraph()) {
  return { share: shareFor(graph), graph }
}
