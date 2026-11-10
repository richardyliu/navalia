/** Playbook / Workflow view-model (pure, unit-tested; the .tsx stays thin). */
import type { BehaviorPatterns } from '../../../../shared/types'
import type { CatalogSources, ImportReport, SkillExportResult, SkillImportReport, WorkflowCatalog } from '../../../../main/workflows/api'
import type { ContentKey, ExtractionMeta, ProvenanceKind, Workflow, WorkflowEdit } from '../../../../main/workflows/schema'
import { assessHabit, type HabitAssessment } from './habit'
import { tr } from '../../lib/i18n'

export const PROVENANCE_LABEL: Record<ProvenanceKind, string> = {
  get observed() {
    return tr('Observed', '观察到')
  },
  get imported() {
    return tr('Imported', '导入')
  },
  get user_edited() {
    return tr('Edited', '手动编辑')
  },
  get shared() {
    return tr('Shared by others', '别人分享')
  }
}

/** S1 provenance badge: 来自观察 / 导入 / 别人分享 (an edit keeps its origin badge). */
export const PROVENANCE_BADGE = {
  get observed() {
    return tr('Observed', '来自观察')
  },
  get imported() {
    return tr('Imported', '导入')
  },
  get shared() {
    return tr('Shared by others', '别人分享')
  },
  get extracted() {
    return tr('Externally extracted', '外部抽取')
  },
  get cloud() {
    return tr('Cloud extracted', '云端抽取')
  }
} as const
export type ProvenanceBadge = (typeof PROVENANCE_BADGE)[keyof typeof PROVENANCE_BADGE]
export type ProvenanceBadgeKey = keyof typeof PROVENANCE_BADGE

/** Badge label → its key (used for CSS classes; labels are localized). */
export function provenanceBadgeKey(label: string): ProvenanceBadgeKey | null {
  for (const k of Object.keys(PROVENANCE_BADGE) as ProvenanceBadgeKey[]) if (PROVENANCE_BADGE[k] === label) return k
  return null
}

export function provenanceBadge(w: Pick<Workflow, 'provenance'>): { label: ProvenanceBadge; edited: boolean } {
  const p = w.provenance
  // S2-07: drafted by an external agent and pasted back — never shown as "来自观察".
  // C15: drafted by the opt-in Lens cloud from a session the user picked; edited = any user change (preview or later).
  if (p.extraction?.source === 'cloud_extracted')
    return { label: PROVENANCE_BADGE.cloud, edited: (p.extraction.edited_fields?.length ?? 0) > 0 || (p.kind === 'user_edited' && p.based_on_version !== null) }
  if (p.extraction) return { label: PROVENANCE_BADGE.extracted, edited: p.kind === 'user_edited' && p.based_on_version !== null }
  const origin = p.kind === 'user_edited' ? (p.original_kind ?? 'observed') : p.kind
  const key = origin === 'user_edited' ? 'observed' : origin
  return { label: PROVENANCE_BADGE[key], edited: p.kind === 'user_edited' }
}

/** Fingerprint grouped for reading: `abcd efgh …` (full value, nothing hidden). */
export function formatFingerprint(fp: string): string {
  return fp.replace(/(.{4})(?=.)/g, '$1 ')
}

export function skillExportSummary(r: SkillExportResult): string {
  if (!r.path) return tr('Export cancelled', '已取消导出')
  const more = r.redacted.length > 5 ? '…' : ''
  const red = r.redacted.length
    ? tr(`; redacted ${r.redacted.length} (${r.redacted.slice(0, 5).join(', ')}${more})`, `；已脱敏 ${r.redacted.length} 处（${r.redacted.slice(0, 5).join('、')}${more}）`)
    : ''
  return tr(`Signed and exported to ${r.path} (signer fingerprint ${r.fingerprint.slice(0, 16)}…)${red}`, `已签名导出到 ${r.path}（签名指纹 ${r.fingerprint.slice(0, 16)}…）${red}`)
}

export function skillImportSummary(r: SkillImportReport | null): string {
  if (!r) return tr('Cancelled', '已取消')
  const head =
    r.item.outcome === 'duplicate'
      ? tr(`${r.file}: already exists (${r.item.detail ?? r.item.id}), not imported again`, `${r.file}：已存在（${r.item.detail ?? r.item.id}），未重复导入`)
      : tr(`${r.file}: imported "${r.item.title || r.item.id}", source: shared by others`, `${r.file}：已导入「${r.item.title || r.item.id}」，来源 别人分享`)
  return tr(`${head}. Signer fingerprint ${r.fingerprint.slice(0, 16)}… (${r.trustNote})`, `${head}。签名指纹 ${r.fingerprint.slice(0, 16)}…（${r.trustNote}）`)
}

export const SOURCE_LABEL: Record<Workflow['source']['type'], string> = {
  get runtime_skill_file() {
    return tr('Runtime skill file', 'Runtime 技能文件')
  },
  runtime_behavior_patterns: 'Runtime behavior_patterns',
  get import_file() {
    return tr('Imported file', '导入文件')
  },
  lens_store: 'Navalia Store',
  get share() {
    return tr('Shared', '分享')
  }
}

export function habitOfWorkflow(w: Workflow): HabitAssessment {
  return assessHabit({ timestamps: w.evidence.filter((e) => e.origin === 'local').map((e) => e.timestamp), text: w.evidence_note })
}

export interface WorkflowListItem {
  id: string
  title: string
  goal: string
  version: number
  provenance: ProvenanceKind
  provenanceLabel: string
  /** S1 badge: 来自观察 / 导入 / 别人分享. */
  badge: ProvenanceBadge
  badgeEdited: boolean
  /** Shared: signer key fingerprint. */
  signerFingerprint: string | null
  sourceLabel: string
  steps: number
  evidence: number
  /** How many of the structured fields are filled (goal..problems), out of 7. */
  filled: number
  habit: HabitAssessment | null
}

/** Imported or shared: evidence is the sender's, not local proof of a habit. */
function isForeign(w: Workflow): boolean {
  const k = w.provenance.kind === 'user_edited' ? w.provenance.original_kind : w.provenance.kind
  return k === 'imported' || k === 'shared' || !!w.provenance.extraction
}

export function filledFields(w: Workflow): number {
  return [w.goal, w.inputs, w.tools, w.steps, w.artifacts, w.rules, w.problems].filter((v) => (typeof v === 'string' ? v.trim() !== '' : v.length > 0)).length
}

export function workflowListItems(catalog: WorkflowCatalog | undefined, filter = ''): WorkflowListItem[] {
  const q = filter.trim().toLowerCase()
  return (catalog?.workflows ?? [])
    .filter((w) => !q || `${w.id}\n${w.title}\n${w.goal}\n${w.tags.join(' ')}`.toLowerCase().includes(q))
    .map((w) => ({
      id: w.id,
      title: w.title || w.id,
      goal: w.goal,
      version: w.version,
      provenance: w.provenance.kind,
      provenanceLabel: PROVENANCE_LABEL[w.provenance.kind],
      badge: provenanceBadge(w).label,
      badgeEdited: provenanceBadge(w).edited,
      signerFingerprint: w.provenance.signer_fingerprint,
      sourceLabel: SOURCE_LABEL[w.source.type],
      steps: w.steps.length,
      evidence: w.evidence.length,
      filled: filledFields(w),
      // Habit rule applies to observed behaviour only; imported evidence is not local proof.
      habit: isForeign(w) ? null : habitOfWorkflow(w)
    }))
}

export function sourceWarnings(sources: CatalogSources | undefined): string[] {
  if (!sources) return []
  const out: string[] = []
  if (sources.runtimeFiles !== 'ok' && sources.runtimeFiles !== 'missing') out.push(tr(`Failed to read Runtime skill files: ${sources.runtimeFiles}`, `读取 Runtime 技能文件失败：${sources.runtimeFiles}`))
  if (sources.behaviorPatterns !== 'ok' && sources.behaviorPatterns !== 'skipped') out.push(tr(`behavior_patterns unavailable: ${sources.behaviorPatterns}`, `behavior_patterns 不可用：${sources.behaviorPatterns}`))
  return out
}

// ── Edit draft: plain text fields, one item per line ─────────────────────────

export interface WorkflowDraft {
  title: string
  goal: string
  context: string
  inputs: string
  tools: string
  steps: string
  artifacts: string
  rules: string
  /** One per line: `problem → solution` */
  problems: string
  tags: string
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

export function draftFromWorkflow(w: Workflow): WorkflowDraft {
  return {
    title: w.title,
    goal: w.goal,
    context: w.context,
    inputs: w.inputs.join('\n'),
    tools: w.tools.join('\n'),
    steps: w.steps.map((s) => s.text).join('\n'),
    artifacts: w.artifacts.join('\n'),
    rules: w.rules.join('\n'),
    problems: w.problems.map((p) => (p.solution ? `${p.problem} → ${p.solution}` : p.problem)).join('\n'),
    tags: w.tags.join('\n')
  }
}

export function editFromDraft(d: WorkflowDraft): WorkflowEdit {
  return {
    title: d.title.trim(),
    goal: d.goal.trim(),
    context: d.context.trim(),
    inputs: lines(d.inputs),
    tools: lines(d.tools),
    steps: lines(d.steps).map((text, i) => ({ order: i + 1, text })),
    artifacts: lines(d.artifacts),
    rules: lines(d.rules),
    problems: lines(d.problems).map((l) => {
      const m = /^(.+?)\s*(?:→|->|=>)\s*(.*)$/.exec(l)
      return m ? { problem: m[1].trim(), solution: m[2].trim() } : { problem: l, solution: '' }
    }),
    tags: lines(d.tags)
  }
}

export function draftDirty(d: WorkflowDraft, w: Workflow): boolean {
  return JSON.stringify(editFromDraft(d)) !== JSON.stringify(editFromDraft(draftFromWorkflow(w)))
}

export function importSummary(r: ImportReport | null): string {
  if (!r) return tr('Cancelled', '已取消')
  // Imports always get a fresh imp-<hash> id (original id in detail); `~` marks a hash collision.
  const renamed = r.items.filter((i) => i.outcome === 'imported' && i.id.includes('~')).length
  const parts = [tr(`imported ${r.imported}`, `导入 ${r.imported} 个`)]
  if (r.duplicates) parts.push(tr(`skipped ${r.duplicates} duplicates`, `跳过重复 ${r.duplicates} 个`))
  if (renamed) parts.push(tr(`${renamed} renamed (id conflict)`, `${renamed} 个与现有 id 冲突，已改名`))
  return tr(`${r.file}: ${parts.join(', ')}`, `${r.file}：${parts.join('，')}`)
}

export function provenanceLine(w: Workflow): string {
  const p = w.provenance
  const bits = [`${PROVENANCE_LABEL[p.kind]} · v${w.version}`]
  if (p.kind === 'user_edited' && p.based_on_version) bits.push(tr(`based on v${p.based_on_version}`, `基于 v${p.based_on_version}`))
  if (p.original_kind && p.kind === 'user_edited') bits.push(tr(`originally: ${PROVENANCE_LABEL[p.original_kind]}`, `最初：${PROVENANCE_LABEL[p.original_kind]}`))
  if (p.extraction?.source === 'cloud_extracted') bits.push(cloudExtractionLine(p.extraction))
  else if (p.extraction) bits.push(tr(`Extracted by external agent: ${p.extraction.agent} (${p.extraction.extracted_at.slice(0, 10)})`, `外部 agent 抽取：${p.extraction.agent}（${p.extraction.extracted_at.slice(0, 10)}）`))
  else if (p.from) bits.push(tr(`from ${p.from}`, `来自 ${p.from}`))
  return bits.join(' · ')
}

// ── Behavior patterns (v2.1 display) + S1-05 habit labels ───────────────────

export type PatternSkill = BehaviorPatterns['skills'][number]

/** A behavior_patterns playbook: prefer all entry dates from the matching skill-file Workflow. */
export function habitOfPatternSkill(skill: PatternSkill, catalog: WorkflowCatalog | undefined): HabitAssessment {
  const match = catalog?.workflows.find((w) => w.source.path === skill.path && w.source.type === 'runtime_skill_file')
  if (match) return habitOfWorkflow(match)
  const h = assessHabit({ timestamps: [skill.observed_at], text: skill.playbook })
  // behavior_patterns returns only the newest entry: one timestamp is a lower bound, not a count.
  if (h.basis === 'evidence_timestamps' && h.status !== 'stable') {
    return { ...h, partial: true, detail: tr('behavior_patterns returns only the newest entry, so the date count is a lower bound', 'behavior_patterns 只返回最新一条记录，日期数是下限') }
  }
  return h
}

export type PatternFace = BehaviorPatterns['faces'][number]

/**
 * Runtime schema 2026-11-05.3 (HABIT-3-DATES fixed upstream, commit 8f52b34) returns each Face's distinct
 * `observation_dates` from behavior_patterns, and promotes a Face only with ≥ 3 of them. Older Runtimes send
 * no dates → 日期未知. Non-string entries are ignored.
 */
export function habitOfFace(face?: PatternFace): HabitAssessment {
  const dates = Array.isArray(face?.observation_dates) ? face.observation_dates.filter((d): d is string => typeof d === 'string') : []
  return assessHabit({ timestamps: dates })
}

export function habitChipClass(h: HabitAssessment): string {
  return h.status === 'stable' ? 'chip ok' : h.status === 'observing' ? 'chip warn' : 'chip subtle'
}

// ── S1-R3-03: per-item evidence links (Runtime R8 Steps / Artifacts / Rules / Problems) ──

/** One clickable pointer: `ref` goes to the EvidenceDrawer (resolve_evidence) unchanged. */
export interface EvidenceLink {
  ref: string
  label: string
}

const RECEIPT_PATH_RE = /^⟨.*:([^:⟩]+)⟩$/

function linkOf(ref: string): EvidenceLink {
  const m = RECEIPT_PATH_RE.exec(ref)
  return m ? { ref, label: tr(`Memory ${m[1]}`, `记忆 ${m[1]}`) } : { ref, label: tr(`Screenshot ${ref}`, `截屏 ${ref}`) }
}

function refsOf(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim()))].slice(0, 20) : []
}

/** Links for one Workflow step; legacy / edited steps have none. */
export function stepEvidenceLinks(step: Workflow['steps'][number]): EvidenceLink[] {
  return refsOf(step.evidence).map(linkOf)
}

export interface PlaybookStructure {
  steps: Array<{ order: number; text: string; links: EvidenceLink[] }>
  artifacts: Array<{ kind: string; value: string; links: EvidenceLink[] }>
  rules: Array<{ text: string; links: EvidenceLink[] }>
  problems: Array<{ problem: string; solution: string; links: EvidenceLink[] }>
  /** Items the Runtime dropped for lacking a pointer (0 / absent on older Runtimes). */
  dropped: number
  empty: boolean
}

function objects(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)) : []
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** behavior_patterns skill → structured Playbook view. Items without text or pointer are skipped, never filled in. */
export function playbookStructure(skill: PatternSkill): PlaybookStructure {
  const steps = objects(skill.steps)
    .map((o) => ({ text: str(o.text), links: refsOf(o.evidence).map(linkOf) }))
    .filter((s) => s.text && s.links.length)
    .map((s, i) => ({ order: i + 1, ...s }))
  const artifacts = objects(skill.artifacts)
    .map((o) => ({ kind: str(o.kind) || 'name', value: str(o.value), links: refsOf(o.evidence).map(linkOf) }))
    .filter((a) => a.value && a.links.length)
  const rules = objects(skill.rules)
    .map((o) => ({ text: str(o.text), links: refsOf(o.evidence).map(linkOf) }))
    .filter((r) => r.text && r.links.length)
  const problems = objects(skill.problems)
    .map((o) => ({ problem: str(o.problem), solution: str(o.solution), links: refsOf(o.evidence).map(linkOf) }))
    .filter((p) => p.problem && p.links.length)
  const dropped = typeof skill.structure_dropped === 'number' && skill.structure_dropped > 0 ? skill.structure_dropped : 0
  return { steps, artifacts, rules, problems, dropped, empty: !steps.length && !artifacts.length && !rules.length && !problems.length }
}

// ── C15: cloud_extracted provenance ─────────────────────────────────────────

export const CONTENT_KEY_LABEL: Record<ContentKey, string> = {
  get title() {
    return tr('Title', '标题')
  },
  get goal() {
    return tr('Goal', '目标')
  },
  get context() {
    return tr('Context', '情境')
  },
  get inputs() {
    return tr('Inputs', '输入')
  },
  get tools() {
    return tr('Tools', '工具')
  },
  get steps() {
    return tr('Steps', '步骤')
  },
  get artifacts() {
    return tr('Artifacts', '产出')
  },
  get rules() {
    return tr('Rules', '规则')
  },
  get problems() {
    return tr('Problems', '问题')
  },
  get tags() {
    return tr('Tags', '标签')
  }
}

/** `云端抽取（模型 x，日期）· 会话「…」· 用户改过：步骤、规则` */
export function cloudExtractionLine(e: ExtractionMeta): string {
  const day = e.extracted_at.slice(0, 10)
  const bits = [tr(`Cloud extracted (${e.model ? `model ${e.model}, ` : ''}${day})`, `云端抽取（${e.model ? `模型 ${e.model}，` : ''}${day}）`)]
  const agent = e.session?.agent === 'codex' ? 'Codex' : 'Claude Code'
  if (e.session) bits.push(tr(`${agent} session "${e.session.title}"`, `${agent} 会话「${e.session.title}」`))
  if (e.cited_items) bits.push(tr(`${e.cited_items.length} cited`, `引用 ${e.cited_items.length} 条`))
  if (e.edited_fields?.length)
    bits.push(tr(`edited by user: ${e.edited_fields.map((k) => CONTENT_KEY_LABEL[k]).join(', ')}`, `用户改过：${e.edited_fields.map((k) => CONTENT_KEY_LABEL[k]).join('、')}`))
  return bits.join(' · ')
}

/** True when a field of a cloud-extracted Workflow carries the 「用户已编辑」 marker. */
export function fieldEdited(w: Pick<Workflow, 'provenance'>, key: ContentKey): boolean {
  const e = w.provenance.extraction
  return e?.source === 'cloud_extracted' && !!e.edited_fields?.includes(key)
}
