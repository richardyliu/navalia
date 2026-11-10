/** Keyword search over Workflows (pure). Case-insensitive; whole query + whitespace terms. */
import type { ProvenanceKind, Workflow } from './schema'

export interface WorkflowSearchHit {
  id: string
  title: string
  goal: string
  version: number
  provenance: ProvenanceKind
  source_type: Workflow['source']['type']
  steps: number
  evidence: number
  score: number
}

function haystack(w: Workflow): string {
  return [
    w.id,
    w.title,
    w.goal,
    w.context,
    ...w.inputs,
    ...w.tools,
    ...w.steps.map((s) => s.text),
    ...w.artifacts,
    ...w.rules,
    ...w.problems.flatMap((p) => [p.problem, p.solution]),
    ...w.tags
  ]
    .join('\n')
    .toLowerCase()
}

export function searchWorkflows(list: Workflow[], query: string | undefined, opts: { limit?: number; provenance?: ProvenanceKind } = {}): WorkflowSearchHit[] {
  const q = (query ?? '').trim().toLowerCase()
  const terms = q ? [...new Set(q.split(/\s+/).filter(Boolean))] : []
  const hits: WorkflowSearchHit[] = []
  for (const w of list) {
    if (opts.provenance && w.provenance.kind !== opts.provenance) continue
    let score = 0
    if (q) {
      const h = haystack(w)
      if (h.includes(q)) score += terms.length + 1
      for (const t of terms) if (h.includes(t)) score += 1
      if (score === 0) continue
    }
    hits.push({
      id: w.id,
      title: w.title,
      goal: w.goal,
      version: w.version,
      provenance: w.provenance.kind,
      source_type: w.source.type,
      steps: w.steps.length,
      evidence: w.evidence.length,
      score
    })
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return hits.slice(0, Math.max(1, Math.min(opts.limit ?? 20, 50)))
}
