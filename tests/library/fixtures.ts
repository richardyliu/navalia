// Fixtures shaped after personal-model `model/snapshot.py` (relation Lines with
// source/target/source_entity_kind/target_entity_kind) and tests/mock-runtime.mjs (Points).
import type { BehaviorPatterns, ModelGraphResponse, Point } from '../../src/shared/types'

export function point(id: string, file_name: string, content: string, occurred_at: string | null, extra: Partial<Point> = {}): Point {
  return {
    id,
    content,
    layer: 'fact',
    status: 'active',
    is_latest: true,
    occurred_at,
    file_name,
    tags: [],
    confidence: 0.8,
    conflicted: false,
    receipt: `⟨${id}:${file_name}⟩`,
    ...extra
  }
}

export function graph(points: Point[], lines: Array<Record<string, unknown>> = []): ModelGraphResponse {
  return {
    generated_at: '2026-11-05T08:00:00Z',
    model: {
      schema_version: 1,
      generated_at: '2026-11-05T08:00:00Z',
      build: { status: 'complete' } as never,
      points,
      lines: lines as never,
      faces: [],
      volumes: [],
      root: null,
      receipts: [],
      stats: { points: points.length, evolution_lines: 0, relation_lines: lines.length, faces: 0, volumes: 0, roots: 0, receipts: 0 }
    }
  }
}

export const emptyGraph = graph([])

export const richGraph = graph(
  [
    point('pt-002', 'project-navalia.md', 'Navalia 的目标是只读、无登录的本地查看器。', '2026-11-04T10:12:00-08:00'),
    point('pt-005', 'project-navalia.md', '团队决定不在 v1 做 HET。', '2026-11-04T11:02:00-08:00'),
    point('pt-004', 'person-mira.md', 'Mira 是 Navalia 的设计负责人。', '2026-10-20T18:40:00-07:00'),
    point('pt-009', 'org-acme.md', 'Acme 是一家 AI 公司。', '2026-10-01T00:00:00Z'),
    point('pt-001', 'user-preferences.md', '用户偏好用 Rust 写 CLI。', '2026-10-12T14:03:00-07:00'),
    point('pt-old', 'person-bob.md', '旧版本', '2026-01-01T00:00:00Z', { is_latest: false })
  ],
  [
    { kind: 'evolution', source: 'pt-005', target: 'pt-002', predicate: 'supersedes' },
    // legacy mock shape: point-id endpoints, no entity kinds
    { kind: 'relation', src: 'pt-004', dst: 'pt-002', predicate: 'part_of' },
    {
      id: 'edge-1',
      kind: 'relation',
      source: 'Mira',
      target: 'Navalia',
      source_entity_kind: 'person',
      target_entity_kind: 'project',
      predicate: 'works_on',
      label: 'co-founder',
      quote: '“Mira 负责 Lens 的用户研究”',
      valid_from: '2026-11-01T00:00:00Z',
      source_evidence: { kind: 'occurrence', id: 'o1', receipt: '⟨occ:o1⟩' }
    },
    {
      id: 'edge-2',
      kind: 'relation',
      source: 'self',
      target: 'Dana',
      source_entity_kind: 'self',
      target_entity_kind: 'person',
      predicate: 'knows'
    },
    {
      id: 'edge-3',
      kind: 'relation',
      source: 'Dana',
      target: 'Launch Party',
      source_entity_kind: 'person',
      target_entity_kind: 'event',
      predicate: 'attended'
    },
    {
      id: 'edge-4',
      kind: 'relation',
      source: 'Dana',
      target: 'Mystery',
      source_entity_kind: 'person',
      predicate: 'mentions'
    }
  ]
)

export const patterns: BehaviorPatterns = {
  root: null,
  faces: [
    { signature: '上午先清理沟通，再进入深度工作。', observations: 6, confidence: 0.64 },
    { signature: '重视证据链：结论必须能回到原文和来源。', observations: 14, confidence: 0.86 },
    { signature: '偏好本地优先工具。', observations: 9, confidence: 0.78 }
  ],
  skills: [
    { path: 'skills/release.md', description: '发布前先跑 typecheck', updated: '2026-11-03', entry_id: 'ent-77', playbook: '1. typecheck\n2. test' }
  ],
  rendered: ''
}
