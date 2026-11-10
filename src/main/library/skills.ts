// S2-04 Library “技能” column: the Lens Workflow catalog (observed + edited + imported + shared,
// via `createWorkflowService(...).catalog()`) plus any behavior_patterns skill the catalog does
// not already hold. Pure: no I/O, no clock.
//
// Dedupe rules (tests/library/skills.test.ts):
// 1. behavior_patterns skill → `observedIdFor(path)` (`rt-<stem>`, DEVIATIONS D25). Same id as a
//    catalog row ⇒ dropped (the catalog already merged it, store version wins).
// 2. Otherwise its normalized content (NFKC, whitespace fold, casefold over the content fields)
//    equal to a catalog row ⇒ dropped.
// 3. Catalog rows are never removed: an imported / shared copy whose normalized content equals an
//    observed row only gets `sameContentAs`, so N stays equal to the Playbook headline.
import type { BehaviorPatterns } from '../../shared/types'
import type { WorkflowCatalog } from '../workflows/api'
import { observedIdFor, workflowFromPatternSkill } from '../workflows/parse'
import type { Workflow } from '../workflows/schema'
import type { LibrarySkill, LibrarySkillCounts, LibrarySkillOrigin } from './api'

function fold(text: string): string {
  return String(text ?? '').normalize('NFKC').trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase()
}

/**
 * Normalized content key, or null when the Workflow carries too little content to compare
 * (no goal, context and steps: two bare titles are not evidence of the same skill).
 */
export function normalizedContentKey(w: Pick<Workflow, 'title' | 'goal' | 'context' | 'steps' | 'rules' | 'inputs' | 'tools' | 'artifacts' | 'problems'>): string | null {
  const goal = fold(w.goal)
  const context = fold(w.context)
  const steps = w.steps.map((s) => fold(s.text)).filter(Boolean)
  if (!goal && !context && steps.length === 0) return null
  return JSON.stringify([
    fold(w.title),
    goal,
    context,
    steps,
    w.rules.map(fold),
    w.inputs.map(fold),
    w.tools.map(fold),
    w.artifacts.map(fold),
    w.problems.map((p) => [fold(p.problem), fold(p.solution)])
  ])
}

/**
 * Origin badge: an edit keeps its origin; an external-agent extraction is `extracted` whatever
 * kind the user saved it as (same rule as Playbook `provenanceBadge`, 外部抽取).
 */
export function originOf(w: Pick<Workflow, 'provenance'>): LibrarySkillOrigin {
  const p = w.provenance
  if (p.extraction) return 'extracted'
  const k = p.kind === 'user_edited' ? (p.original_kind ?? 'observed') : p.kind
  return k === 'imported' || k === 'shared' ? k : 'observed'
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function skillRow(w: Workflow): LibrarySkill {
  return {
    id: w.id,
    title: w.title || w.id,
    summary: w.goal || w.context || w.evidence_note || '',
    origin: originOf(w),
    // Same as Playbook `provenanceBadge`: an extraction saved as user_edited is only 手动编辑 after a real edit.
    edited: w.provenance.kind === 'user_edited' && (!w.provenance.extraction || w.provenance.based_on_version !== null),
    path: w.source.path,
    updated: w.updated_at,
    evidenceRef: w.evidence[0]?.ref ?? null,
    evidenceCount: w.evidence.length,
    evidenceDates: w.evidence.map((e) => e.timestamp),
    evidenceOrigins: w.evidence.map((e) => e.origin),
    sameContentAs: null
  }
}

export interface SkillsAggregate {
  skills: LibrarySkill[]
  skillCounts: LibrarySkillCounts
}

export function aggregateSkills(catalog: WorkflowCatalog | null, patterns: BehaviorPatterns | null): SkillsAggregate {
  const base: Workflow[] = Array.isArray(catalog?.workflows) ? [...catalog.workflows] : []
  const ids = new Set(base.map((w) => w.id))
  const keys = new Set(base.map(normalizedContentKey).filter((k): k is string => k !== null))
  let dedupedPatterns = 0
  const extra: Workflow[] = []
  for (const s of Array.isArray(patterns?.skills) ? patterns.skills : []) {
    if (!s || typeof s.path !== 'string' || typeof s.playbook !== 'string') continue
    const id = observedIdFor(s.path)
    if (ids.has(id)) {
      dedupedPatterns++
      continue
    }
    const w = workflowFromPatternSkill({
      path: s.path,
      playbook: s.playbook,
      description: str(s.description) ?? undefined,
      updated: str(s.updated) ?? undefined,
      entry_id: str(s.entry_id) ?? undefined,
      observed_at: str(s.observed_at) ?? undefined
    })
    const key = normalizedContentKey(w)
    if (key && keys.has(key)) {
      dedupedPatterns++
      continue
    }
    ids.add(w.id)
    if (key) keys.add(key)
    extra.push(w)
  }

  const all = [...base, ...extra]
  const rows = all.map(skillRow)
  // Content twins: point foreign copies (imported / shared) at the observed row they equal.
  const observedByKey = new Map<string, string>()
  all.forEach((w, i) => {
    const k = normalizedContentKey(w)
    if (k && rows[i].origin === 'observed' && !observedByKey.has(k)) observedByKey.set(k, w.id)
  })
  all.forEach((w, i) => {
    const k = normalizedContentKey(w)
    if (k && rows[i].origin !== 'observed') rows[i].sameContentAs = observedByKey.get(k) ?? null
  })

  const skillCounts: LibrarySkillCounts = {
    observed: rows.filter((r) => r.origin === 'observed').length,
    imported: rows.filter((r) => r.origin === 'imported').length,
    shared: rows.filter((r) => r.origin === 'shared').length,
    extracted: rows.filter((r) => r.origin === 'extracted').length,
    edited: rows.filter((r) => r.edited).length,
    dedupedPatterns
  }
  return { skills: rows, skillCounts }
}
