/** Library page view-model (S2-04, pure, unit-tested; Library.tsx stays thin). */
import type { LibraryOverview, LibraryPortrait, LibrarySkill, LibrarySkillCounts, LibrarySkillOrigin } from '../../../../main/library/api'
import type { EvidenceRef } from '../../../../main/workflows/schema'
import { skillsHeadline, type SkillsHeadline } from '../workflows/headline'
import { PROVENANCE_BADGE } from '../workflows/viewModel'
import { tr } from '../../lib/i18n'

export function editedBadge(): string {
  return tr('Edited', '手动编辑')
}

/** Origin badge labels, identical to Playbook's (来自观察 / 导入 / 别人分享 / 外部抽取). */
export const SKILL_ORIGIN_BADGE: Record<LibrarySkillOrigin, string> = PROVENANCE_BADGE

export function skillBadges(s: Pick<LibrarySkill, 'origin' | 'edited'>): string[] {
  return s.edited ? [SKILL_ORIGIN_BADGE[s.origin], editedBadge()] : [SKILL_ORIGIN_BADGE[s.origin]]
}

/**
 * “N 个技能文件，M 周的判断。” — the exact Playbook function (`skillsHeadline`) applied to the
 * same evidence (timestamp + its real origin) each catalog Workflow carries, so both pages say the
 * same N / M. Origins are carried through, never relabelled `local` (S2-SEC M2).
 */
export function librarySkillsHeadline(skills: ReadonlyArray<Pick<LibrarySkill, 'evidenceDates' | 'evidenceOrigins'>>): SkillsHeadline {
  return skillsHeadline(
    skills.map((s) => ({
      evidence: s.evidenceDates.map((timestamp, i): EvidenceRef => ({ ref: '-', kind: 'entry', timestamp, origin: s.evidenceOrigins[i] ?? 'imported' }))
    }))
  )
}

/** Per-source counts in a fixed order; zero sources are still shown (honest empty). */
export function skillCountChips(c: LibrarySkillCounts): Array<{ label: string; count: number }> {
  const chips = [
    { label: SKILL_ORIGIN_BADGE.observed, count: c.observed },
    { label: SKILL_ORIGIN_BADGE.imported, count: c.imported },
    { label: SKILL_ORIGIN_BADGE.shared, count: c.shared }
  ]
  if (c.extracted > 0) chips.push({ label: SKILL_ORIGIN_BADGE.extracted, count: c.extracted })
  if (c.edited > 0) chips.push({ label: editedBadge(), count: c.edited })
  return chips
}

export type PortraitState =
  | { kind: 'error'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'ok'; portrait: LibraryPortrait }

export function portraitState(o: Pick<LibraryOverview, 'portrait' | 'graphError'>): PortraitState {
  if (o.graphError || !o.portrait) return { kind: 'error', message: o.graphError?.message ?? tr('Could not read the model', '没有读到模型') }
  const p = o.portrait
  if (!p.root && p.topFaces.length === 0) {
    return { kind: 'empty', message: tr(
        'Runtime has not formed a Root / Faces yet (it needs repeated evidence across sessions and a run of persome model build).',
        'Runtime 还没有形成 Root / Faces（需要跨会话重复证据并跑过 persome model build）。'
      ) }
  }
  return { kind: 'ok', portrait: p }
}

/** `points 120 · faces 7 · …` — only the counts the Runtime reported; absent ones are omitted. */
export function portraitCountsLine(p: LibraryPortrait): string {
  const parts: Array<[string, number | null]> = [
    ['Points', p.counts.points],
    ['Faces', p.counts.faces],
    ['Volumes', p.counts.volumes],
    [tr('Relations', '关系'), p.counts.relationLines],
    [tr('Receipts', '回执'), p.counts.receipts]
  ]
  const shown = parts.filter(([, n]) => n !== null).map(([k, n]) => `${k} ${n}`)
  return shown.length ? shown.join(' · ') : tr('Runtime reported no counts', 'Runtime 没有给出计数')
}

/** Overall empty banner: only when no section errored and every section is empty. */
export function libraryAllEmpty(o: LibraryOverview): boolean {
  if (o.graphError || o.skillsError || o.workflowError) return false
  const portraitEmpty = !o.portrait || (!o.portrait.root && o.portrait.topFaces.length === 0)
  return portraitEmpty && o.counts.people + o.counts.projects + o.counts.unclassified + o.counts.skills === 0
}
