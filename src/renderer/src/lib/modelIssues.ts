// MOD-13: literal model-readiness reason codes (no_points / no_lines / no_faces / no_volumes / no_root,
// no_completed_build / build_in_progress) shown next to a Chinese explanation.
//
// Lens never derives these codes from counts. They are displayed only when the Runtime response carries
// them. Runtime schema 2026-11-05.3 (personal-model-og be0a0bc, commit e61fd6e) ships the MOD-13 fix:
// `GET /model/graph` -> `model_status: { ready, issues[] }`, computed by snapshot.py model_status() (the same
// list `persome model status` prints, including the two build-state codes). Older Runtimes (0.3.2 /
// b7a28ff) omit `model_status`; then `codes` is empty and the UI says the per-layer codes are CLI-only.
import type { ModelGraphResponse } from '../../../shared/types'
import { tr } from './i18n'

/** Chinese explanations for every code Runtime 2026-11-05.3 snapshot.py model_status() emits, in its order. */
export const ISSUE_EXPLANATIONS: Readonly<Record<string, string>> = {
  get no_points() {
    return tr('No Points yet (no usable memory entries)', '还没有任何 Point（没有可用的记忆条目）')
  },
  get no_lines() {
    return tr('No evolution / relation lines yet', '还没有演化线 / 关系线')
  },
  get no_faces() {
    return tr('No Faces (behavior patterns) formed yet', '还没有形成 Face（行为规律）')
  },
  get no_volumes() {
    return tr('No Volumes formed yet', '还没有形成 Volume')
  },
  get no_root() {
    return tr('No Root formed yet', '还没有形成 Root')
  },
  get no_completed_build() {
    return tr('No model build has completed yet', '还没有完成过一次模型构建')
  },
  get build_in_progress() {
    return tr('The model is building', '模型正在构建中')
  }
}

/**
 * Explanations for the literal `degraded_stages` values the Runtime puts on the build record.
 * model_contract: build.py adds it when the finished build has no Points, no Lines, no Faces, no Volumes or
 * no Root (any one of them). Every other value is the name of a build.py `_run_stage` stage that raised.
 */
export const STAGE_EXPLANATIONS: Readonly<Record<string, string>> = {
  get model_contract() {
    return tr(
      'The model was incomplete when the build finished: at least one of Point / Line / Face / Volume / Root is empty',
      '构建完成时模型不完整：Point / Line / Face / Volume / Root 至少有一层为空'
    )
  },
  get state_formation() {
    return tr(
      'The memory writer stage failed; new sessions this run may not have been written to memory',
      '记忆写入（writer）阶段出错，本次新会话可能没有写入记忆'
    )
  },
  get evomem_baseline() {
    return tr(
      'The memory evolution backfill (evomem backfill) stage failed; Points / evolution lines may not be updated',
      '记忆演化回填（evomem backfill）阶段出错，Point / 演化线可能没有更新'
    )
  },
  get entity_relation_enrichment() {
    return tr('The entity relation enrichment stage failed; relation lines may be incomplete', '实体关系补全阶段出错，关系线可能不完整')
  },
  get schema_miner() {
    return tr('The Face mining stage failed; behavior patterns may not be updated', 'Face 挖掘阶段出错，行为规律可能没有更新')
  },
  get cross_domain_sweeper() {
    return tr('The cross-domain merge stage failed; Volumes may not be updated', '跨领域归并阶段出错，Volume 可能没有更新')
  },
  get root_synthesis() {
    return tr('The Root synthesis stage failed; Root may not be updated', 'Root 合成阶段出错，Root 可能没有更新')
  },
  get vector_backfill() {
    return tr(
      'The vector backfill stage failed; semantic search may fall back to keyword search',
      '向量补齐阶段出错，语义检索可能退化为关键词检索'
    )
  }
}

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/

export interface IssueCode {
  code: string
  explanation: string
}

export interface ModelIssuesView {
  /** Literal codes from the Runtime response, in Runtime order. Empty when Runtime did not send any. */
  codes: IssueCode[]
  /** True when Runtime sent a `model_status.issues` array (even if empty). */
  runtimeProvidesCodes: boolean
  /** Literal degraded_stages from the build record with an explanation. */
  stages: IssueCode[]
  /** Model is degraded/empty but Runtime did not send per-layer codes → explain where they live. */
  showCliOnlyNote: boolean
}

function explain(code: string, table: Readonly<Record<string, string>>): string {
  return table[code] ?? tr('Reason code returned by Runtime (Navalia has no description for it)', 'Runtime 返回的原因码（Navalia 未收录中文说明）')
}

function literalCodes(raw: unknown, table: Readonly<Record<string, string>>): IssueCode[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: IssueCode[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !CODE_RE.test(value) || seen.has(value)) continue
    seen.add(value)
    out.push({ code: value, explanation: explain(value, table) })
  }
  return out
}

export function modelIssuesView(graph: ModelGraphResponse | undefined | null): ModelIssuesView {
  const empty: ModelIssuesView = { codes: [], runtimeProvidesCodes: false, stages: [], showCliOnlyNote: false }
  if (!graph || !graph.model) return empty
  const raw = (graph as { model_status?: { issues?: unknown } }).model_status?.issues
  const runtimeProvidesCodes = Array.isArray(raw)
  const codes = literalCodes(raw, ISSUE_EXPLANATIONS)
  const stages = literalCodes(graph.model.build?.degraded_stages, STAGE_EXPLANATIONS)
  const stats = graph.model.stats
  const looksIncomplete =
    stages.length > 0 ||
    graph.model.build?.status === 'degraded' ||
    graph.model.root == null ||
    (stats ? stats.points === 0 || stats.faces === 0 || stats.volumes === 0 : false)
  return { codes, runtimeProvidesCodes, stages, showCliOnlyNote: !runtimeProvidesCodes && looksIncomplete }
}
