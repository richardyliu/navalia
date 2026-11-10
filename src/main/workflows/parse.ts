/**
 * Runtime behavioral memory → Workflow (S1-06). Pure: no fs, so it is unit-testable on strings.
 *
 * Runtime format (personal-model, read-only reference):
 * - files live at `<root>/memory/skills/skill-*.md` (legacy: `<root>/memory/skill-*.md`),
 *   see personal-model src/persome/store/files.py:86 (VALID_SUBDIRS) and :185 (memory_path)
 * - YAML frontmatter: description, tags, status, created, updated, entry_count, needs_compact
 *   (files.py:216 default_frontmatter)
 * - entries: `## [YYYY-MM-DDTHH:MM] {id: <id>} #tag ...` (files.py:132 ENTRY_HEADING_RE)
 * - entry body: `stage: observed` then `**Key**: value` lines
 *   (src/persome/prompts/pattern_detector.md "Entry format")
 * - behavior_patterns picks the latest non-superseded entry tagged `pattern` and
 *   (`observed` or body starting `stage: observed`) (src/persome/mcp/server.py:390-411)
 */
import { scrubText } from '../identity/redact'
import {
  emptyWorkflow,
  provenance,
  source,
  type EvidenceRef,
  type Workflow,
  type WorkflowProblem,
  type WorkflowStep
} from './schema'

export interface RuntimeEntry {
  id: string
  timestamp: string
  tags: string[]
  body: string
  supersededBy: string | null
}

export interface RuntimeSkillFile {
  /** Memory-relative path, e.g. `skills/skill-foo.md`. */
  path: string
  description: string
  tags: string[]
  status: string
  created: string
  updated: string
  entries: RuntimeEntry[]
}

const ENTRY_HEADING_RE = /^##\s*\[([^\]]+)\]\s*\{id:\s*([a-zA-Z0-9-]+)\}([^\n]*)$/gm
const RECEIPT_RE = /⟨[^⟩\s]{1,300}⟩/g

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"')
  }
  return t
}

/** Minimal YAML frontmatter reader for the flat keys the Runtime writes (scalars + string lists). */
export function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return { meta: {}, body: normalized }
  const head = normalized.slice(4, end)
  const after = normalized.slice(end + 4)
  const body = after.startsWith('\n') ? after.slice(1) : after
  const meta: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const line of head.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && listKey) {
      ;(meta[listKey] as string[]).push(unquote(item[1]))
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    if (value === '') {
      meta[key] = []
      listKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter(Boolean)
      listKey = null
    } else {
      meta[key] = unquote(value)
      listKey = null
    }
  }
  return { meta, body }
}

export function parseEntries(body: string): RuntimeEntry[] {
  const matches = [...body.matchAll(ENTRY_HEADING_RE)]
  return matches.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length
    const tags = (m[3] ?? '')
      .split(/\s+/)
      .filter((t) => t.startsWith('#'))
      .map((t) => t.slice(1))
    const sup = tags.find((t) => t.startsWith('superseded-by:'))
    return {
      id: m[2],
      timestamp: m[1].trim(),
      tags,
      body: body.slice(start, end).replace(/^\n+|\n+$/g, ''),
      supersededBy: sup ? sup.split(':', 2)[1] || null : null
    }
  })
}

export function parseSkillFile(path: string, text: string): RuntimeSkillFile {
  const { meta, body } = parseFrontmatter(text)
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '')
  const tags = Array.isArray(meta.tags) ? meta.tags : str('tags') ? [str('tags')] : []
  return {
    path,
    description: str('description'),
    tags,
    status: str('status') || 'active',
    created: str('created'),
    updated: str('updated'),
    entries: parseEntries(body)
  }
}

/** Same selection as Runtime behavior_patterns: tagged `pattern` and observed, not superseded. */
export function isObservedPatternEntry(e: RuntimeEntry): boolean {
  if (e.supersededBy) return false
  if (!e.tags.includes('pattern')) return false
  return e.tags.includes('observed') || e.body.trimStart().toLowerCase().startsWith('stage: observed')
}

type FieldKey = 'goal' | 'context' | 'steps' | 'inputs' | 'tools' | 'artifacts' | 'rules' | 'problems' | 'evidence' | 'confidence'

const FIELD_ALIASES: Record<string, FieldKey> = {
  pattern: 'goal',
  goal: 'goal',
  目标: 'goal',
  模式: 'goal',
  context: 'context',
  trigger: 'context',
  when: 'context',
  情境: 'context',
  场景: 'context',
  触发: 'context',
  steps: 'steps',
  sequence: 'steps',
  步骤: 'steps',
  流程: 'steps',
  inputs: 'inputs',
  input: 'inputs',
  输入: 'inputs',
  tools: 'tools',
  apps: 'tools',
  工具: 'tools',
  outputs: 'artifacts',
  output: 'artifacts',
  artifacts: 'artifacts',
  deliverables: 'artifacts',
  产出: 'artifacts',
  输出: 'artifacts',
  rules: 'rules',
  boundaries: 'rules',
  constraints: 'rules',
  规则: 'rules',
  边界: 'rules',
  problems: 'problems',
  pitfalls: 'problems',
  'problem→solution': 'problems',
  'problem -> solution': 'problems',
  问题: 'problems',
  evidence: 'evidence',
  证据: 'evidence',
  confidence: 'confidence',
  置信度: 'confidence'
}

const FIELD_LINE_RE = /^\s*(?:[-*]\s+)?\*\*([^*]{1,40})\*\*\s*[:：]\s?(.*)$/
/** S2-07: `### Steps` sub-heading inside an entry (level 3+; `##` is the entry heading). Value follows on later lines. */
const FIELD_HEADING_RE = /^\s*#{3,6}\s+([^#\n]{1,40}?)\s*[:：]?\s*$/
/** S2-07: plain `Steps: …` line. Only known aliases start a field, so ordinary prose is not misread. */
const FIELD_PLAIN_RE = /^([A-Za-z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff →>-]{0,30}?)\s*[:：]\s?(.*)$/

/** `**Key**: value` lines (value may continue on following lines until the next key). Unknown keys are ignored. */
export function parseFields(body: string): { stage: string | null; fields: Partial<Record<FieldKey, string>> } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  let stage: string | null = null
  const fields: Partial<Record<FieldKey, string>> = {}
  let current: FieldKey | null = null
  let skipping = false
  let currentPlain = false
  for (const line of lines) {
    const st = /^\s*stage:\s*(\S.*)$/i.exec(line)
    if (st && stage === null && current === null) {
      stage = st[1].trim()
      continue
    }
    const heading = FIELD_HEADING_RE.exec(line)
    const plain = heading ? null : FIELD_PLAIN_RE.exec(line)
    const plainKey = plain ? FIELD_ALIASES[plain[1].trim().toLowerCase()] : undefined
    // A field opened by a plain `Key:` line ends at the next plain `Other:` line (S2-07), so prose
    // like `Note: …` is not glued onto it. Bold / heading fields keep their old continuation rule.
    const m =
      FIELD_LINE_RE.exec(line) ??
      (heading ? [line, heading[1], ''] : plainKey ? [line, plain![1], plain![2]] : plain && currentPlain ? [line, plain[1], plain[2]] : null)
    if (m) {
      currentPlain = !FIELD_LINE_RE.test(line) && !heading
      const key = FIELD_ALIASES[m[1].trim().toLowerCase()]
      if (key) {
        current = key
        skipping = false
        fields[key] = fields[key] ? `${fields[key]}\n${m[2]}` : m[2]
      } else {
        current = null
        skipping = true
      }
      continue
    }
    if (current && !skipping) fields[current] = `${fields[current] ?? ''}\n${line}`
  }
  for (const k of Object.keys(fields) as FieldKey[]) {
    fields[k] = (fields[k] ?? '').replace(/^\s+|\s+$/g, '')
    if (!fields[k]) delete fields[k]
  }
  return { stage, fields }
}

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)、])\s+/

function cleanItem(s: string): string {
  return s.replace(BULLET_RE, '').replace(/\s+/g, ' ').trim().replace(/[.。;；]$/, '').trim()
}

/** Bullet / numbered lines; else inline `1. a 2. b`; else arrows; else the value as one item. */
export function splitSequence(value: string): string[] {
  const lines = value.split('\n').filter((l) => l.trim())
  if (lines.length > 1 && lines.every((l) => BULLET_RE.test(l))) return lines.map(cleanItem).filter(Boolean)
  const inline = value.split(/(?:^|\s)\d+[.)、]\s+/).map(cleanItem).filter(Boolean)
  if (/(?:^|\s)\d+[.)、]\s+[\s\S]*\s\d+[.)、]\s+/.test(value) && inline.length > 1) return inline
  if (/\s(?:→|->|=>)\s/.test(value)) return value.split(/\s(?:→|->|=>)\s/).map(cleanItem).filter(Boolean)
  if (lines.length > 1) return lines.map(cleanItem).filter(Boolean)
  const one = cleanItem(value)
  return one ? [one] : []
}

/** List fields: bullet lines, else comma / 、 / ; separated. */
export function splitList(value: string, separators: RegExp = /[,，、;；]/): string[] {
  const lines = value.split('\n').filter((l) => l.trim())
  const parts = lines.length > 1 ? lines : value.split(separators)
  return parts.map(cleanItem).filter(Boolean)
}

export function splitProblems(value: string): WorkflowProblem[] {
  const items = value.split('\n').filter((l) => l.trim()).length > 1 ? value.split('\n') : value.split(/[;；]/)
  const out: WorkflowProblem[] = []
  for (const raw of items) {
    const item = cleanItem(raw)
    if (!item) continue
    const m = /^(.+?)\s*(?:→|->|=>)\s*(.*)$/.exec(item)
    out.push(m ? { problem: m[1].trim(), solution: m[2].trim() } : { problem: item, solution: '' })
  }
  return out
}

export function receiptsIn(text: string): string[] {
  return [...new Set(text.match(RECEIPT_RE) ?? [])]
}

/** Small pure string hash (FNV-1a 32-bit ×2 → 12 hex chars); not for security, only for stable ids. */
export function shortHash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12)
}

/**
 * True when the Broker's PII/secret scrubber leaves the id unchanged, so an agent can pass the
 * id it received back into get_workflow (e.g. `skill-weekly-report` matches the `sk…` key rule).
 */
export function isScrubStableId(id: string): boolean {
  return scrubText(id) === id
}

/** Stable Lens id for a Runtime memory path: `rt-<stem without skill->`, or `rt-<hash>` if the scrubber would alter it. */
export function observedIdFor(memoryPath: string): string {
  const stem = memoryPath.split('/').pop()!.replace(/\.md$/i, '')
  const slug = stem
    .replace(/^skill-/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  const id = `rt-${slug || 'skill'}`
  return isScrubStableId(id) ? id : `rt-${shortHash(memoryPath)}`
}

// ─── S1-R3-03: Runtime R8 evidence-backed items ──────────────────────────────
//
// Runtime og/r8-workflow-structure writes Steps / Artifacts / Rules / Problems items that end with
// ` — evidence: `cap-id`, `⟨entry_id:path⟩``; behavior_patterns also serves them as structured
// arrays (personal-model src/persome/writer/workflow_structure.py). A bare pointer is a capture id;
// memory entries are always receipts.

const EVIDENCE_CLAUSE_RE = /\s*(?:[—–]+|-{1,2})?\s*[(\[]?\s*evidence\s*[:：=]\s*(.*?)\s*[)\]]?\s*$/i
const BARE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
const ARTIFACT_PREFIX_RE = /^(?:url|path|file|name)\s*[:：]\s*/i
const MAX_ITEM_REFS = 20

/** Split one item into visible text and its evidence pointers (receipts first, then bare capture ids). */
export function splitEvidence(item: string): { text: string; evidence: string[] } {
  const m = EVIDENCE_CLAUSE_RE.exec(item)
  if (!m) return { text: item.trim(), evidence: [] }
  const text = item.slice(0, m.index).trim().replace(/[—–-]+$/, '').trim()
  const raw = m[1]
  const refs: string[] = [...(raw.match(RECEIPT_RE) ?? [])]
  for (const tok of raw.replace(RECEIPT_RE, ' ').split(/[\s,;，；]+/)) {
    const t = tok.trim().replace(/^[`'"]+|[`'"]+$/g, '')
    if (t && BARE_REF_RE.test(t)) refs.push(t)
  }
  return { text, evidence: [...new Set(refs)].slice(0, MAX_ITEM_REFS) }
}

function refKind(ref: string): EvidenceRef['kind'] {
  return ref.startsWith('⟨') ? 'receipt' : 'capture'
}

interface PointedItem {
  text: string
  evidence: string[]
}

/**
 * R8 section: at least one line carries an evidence clause. Then, as in the Runtime, only bullet /
 * numbered lines with a pointer are items; pointer-less lines are dropped, never repaired.
 * Returns null for a legacy section so the old splitters keep their behaviour.
 */
function pointedItems(value: string): PointedItem[] | null {
  const lines = value.split('\n').filter((l) => l.trim())
  const split = lines.map((l) => splitEvidence(cleanItem(l)))
  if (!split.some((x) => x.evidence.length > 0)) return null
  return split.filter((x) => x.text && x.evidence.length > 0).map((x) => ({ text: cleanItem(x.text), evidence: x.evidence }))
}

function problemOf(text: string): WorkflowProblem {
  const m = /^(.+?)\s(?:→|->|=>)\s(.*)$/.exec(text)
  return m ? { problem: m[1].trim(), solution: m[2].trim() } : { problem: text, solution: '' }
}

function artifactText(text: string): string {
  return text.replace(ARTIFACT_PREFIX_RE, '').replace(/^`|`$/g, '').trim()
}

/** Item pointers collected while mapping, to be appended to `w.evidence`. */
type ItemRefs = string[]

function applyFields(w: Workflow, fields: Partial<Record<FieldKey, string>>): ItemRefs {
  const refs: ItemRefs = []
  const pointed = (v: string | undefined): PointedItem[] | null => {
    const items = v ? pointedItems(v) : null
    for (const it of items ?? []) refs.push(...it.evidence)
    return items
  }
  w.goal = fields.goal ?? ''
  w.context = fields.context ?? ''
  const steps = pointed(fields.steps)
  w.steps = steps
    ? steps.map<WorkflowStep>((it, i) => ({ order: i + 1, text: it.text, evidence: it.evidence }))
    : fields.steps
      ? splitSequence(fields.steps).map<WorkflowStep>((text, i) => ({ order: i + 1, text }))
      : []
  w.inputs = fields.inputs ? splitList(fields.inputs) : []
  w.tools = fields.tools ? splitList(fields.tools) : []
  const artifacts = pointed(fields.artifacts)
  w.artifacts = artifacts ? artifacts.map((it) => artifactText(it.text)).filter(Boolean) : fields.artifacts ? splitList(fields.artifacts) : []
  const rules = pointed(fields.rules)
  w.rules = rules ? rules.map((it) => it.text) : fields.rules ? splitList(fields.rules, /[;；]/) : []
  const problems = pointed(fields.problems)
  w.problems = problems ? problems.map((it) => problemOf(it.text)) : fields.problems ? splitProblems(fields.problems) : []
  w.evidence_note = fields.evidence ?? ''
  return refs
}

/** Append item pointers to the Workflow evidence list (deduped, typed capture / receipt). */
function addItemRefs(w: Workflow, refs: ItemRefs, timestamp: string | null): void {
  const seen = new Set(w.evidence.map((e) => e.ref))
  for (const ref of refs) {
    if (seen.has(ref) || w.evidence.length >= 500) continue
    seen.add(ref)
    w.evidence.push({ ref, kind: refKind(ref), timestamp, origin: 'local' })
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function structuredRefs(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter(isStr).map((r) => r.trim()).filter((r) => r.length <= 500))].slice(0, MAX_ITEM_REFS)
}

/** behavior_patterns R8 arrays → items; malformed or pointer-less items are skipped. */
function structuredItems<T>(v: unknown, map: (o: Record<string, unknown>) => T | null): Array<{ item: T; evidence: string[] }> {
  if (!Array.isArray(v)) return []
  const out: Array<{ item: T; evidence: string[] }> = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const o = raw as Record<string, unknown>
    const evidence = structuredRefs(o.evidence)
    const item = evidence.length ? map(o) : null
    if (item !== null) out.push({ item, evidence })
  }
  return out
}

/** Prefer behavior_patterns' structured arrays per field when non-empty; else keep the text mapping. */
function applyStructured(w: Workflow, skill: PatternSkill): ItemRefs {
  const refs: ItemRefs = []
  const steps = structuredItems(skill.steps, (o) => (isStr(o.text) ? o.text.trim().slice(0, 4000) : null))
  if (steps.length) w.steps = steps.map(({ item, evidence }, i) => ({ order: i + 1, text: item, evidence }))
  const artifacts = structuredItems(skill.artifacts, (o) => (isStr(o.value) ? o.value.trim().slice(0, 500) : null))
  if (artifacts.length) w.artifacts = artifacts.map((a) => a.item)
  const rules = structuredItems(skill.rules, (o) => (isStr(o.text) ? o.text.trim().slice(0, 4000) : null))
  if (rules.length) w.rules = rules.map((r) => r.item)
  const problems = structuredItems(skill.problems, (o) =>
    isStr(o.problem) ? { problem: o.problem.trim().slice(0, 4000), solution: typeof o.solution === 'string' ? o.solution.trim().slice(0, 4000) : '' } : null
  )
  if (problems.length) w.problems = problems.map((p) => p.item)
  for (const group of [steps, artifacts, rules, problems]) for (const g of group) refs.push(...g.evidence)
  return refs
}

function newestFirst(entries: RuntimeEntry[]): RuntimeEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.timestamp === b.e.timestamp ? b.i - a.i : a.e.timestamp < b.e.timestamp ? 1 : -1))
    .map((x) => x.e)
}

/**
 * One Runtime skill file → observed Workflow. Structured fields come from the newest observed
 * entry; evidence lists every observed, non-superseded entry plus every receipt they carry.
 * Returns null when the file is not active or has no observed pattern entry.
 */
export function workflowFromSkillFile(file: RuntimeSkillFile): Workflow | null {
  if (file.status !== 'active') return null
  const observed = newestFirst(file.entries.filter(isObservedPatternEntry))
  if (observed.length === 0) return null
  const latest = observed[0]
  const { stage, fields } = parseFields(latest.body)
  const w = emptyWorkflow(
    observedIdFor(file.path),
    provenance('observed', { observed_at: latest.timestamp }),
    source('runtime_skill_file', {
      path: file.path,
      entry_ids: observed.map((e) => e.id).slice(0, 200),
      stage,
      confidence: fields.confidence ?? null
    })
  )
  w.title = (file.description || file.path.split('/').pop()!.replace(/\.md$/, '')).slice(0, 500)
  const itemRefs = applyFields(w, fields)
  const evidence: EvidenceRef[] = []
  const seen = new Set<string>()
  for (const e of observed) {
    if (!seen.has(e.id)) {
      seen.add(e.id)
      evidence.push({ ref: e.id, kind: 'entry', timestamp: e.timestamp, origin: 'local' })
    }
    for (const r of receiptsIn(e.body)) {
      if (seen.has(r)) continue
      seen.add(r)
      evidence.push({ ref: r, kind: 'receipt', timestamp: e.timestamp, origin: 'local' })
    }
  }
  w.evidence = evidence.slice(0, 500)
  addItemRefs(w, itemRefs, latest.timestamp)
  w.tags = file.tags.filter((t) => typeof t === 'string').slice(0, 50)
  w.created_at = file.created || null
  w.updated_at = file.updated || latest.timestamp
  return w
}

/** behavior_patterns `skills[]` item (Runtime MCP). */
export interface PatternSkill {
  path: string
  description?: string
  updated?: string
  entry_id?: string
  observed_at?: string
  playbook: string
  /** Runtime R8 (og/r8-workflow-structure), optional: evidence-backed structure parsed from the playbook. */
  steps?: Array<{ order?: number; text: string; evidence: string[] }>
  artifacts?: Array<{ kind?: string; value: string; evidence: string[] }>
  rules?: Array<{ text: string; evidence: string[] }>
  problems?: Array<{ problem: string; solution?: string; evidence: string[] }>
  structure_dropped?: number
}

/** One behavior_patterns playbook → observed Workflow (only the newest entry is available here). */
export function workflowFromPatternSkill(skill: PatternSkill): Workflow {
  const { stage, fields } = parseFields(skill.playbook ?? '')
  const w = emptyWorkflow(
    observedIdFor(skill.path),
    provenance('observed', { observed_at: skill.observed_at ?? null }),
    source('runtime_behavior_patterns', {
      path: skill.path,
      entry_ids: skill.entry_id ? [skill.entry_id] : [],
      stage,
      confidence: fields.confidence ?? null
    })
  )
  w.title = (skill.description || skill.path.split('/').pop()!.replace(/\.md$/, '')).slice(0, 500)
  const textRefs = applyFields(w, fields)
  const structuredRefsFound = applyStructured(w, skill)
  const ts = skill.observed_at ?? null
  if (skill.entry_id) w.evidence.push({ ref: skill.entry_id, kind: 'entry', timestamp: ts, origin: 'local' })
  for (const r of receiptsIn(skill.playbook ?? '')) w.evidence.push({ ref: r, kind: 'receipt', timestamp: ts, origin: 'local' })
  addItemRefs(w, [...structuredRefsFound, ...textRefs], ts)
  w.updated_at = skill.updated || ts
  return w
}
