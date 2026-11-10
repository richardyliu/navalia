/**
 * S1-FULL C15 — cloud Workflow extraction: the reply contract, its parser, and the mapping from a
 * reviewed draft to Workflow content. zod only, no Node imports: the renderer view-model reuses it.
 *
 * Server contract (`POST /v1/chat/completions`, `task: "workflow_extract"`): the streamed text is ONLY
 * a ```json fenced block of
 *   {"title","steps":[{"title","detail","cites":["ctx-N"]}],"artifacts":[{"name","kind","cites"}],
 *    "rules":[{"text","cites"}],"problems":[{"text","resolution","cites"}]}
 * Anything unparseable / schema-invalid is rejected as a whole (no partial draft). Items whose cites
 * do not point at a sent item are dropped; nothing is invented to fill gaps.
 */
import { tr } from '../../shared/i18n'
import { z } from 'zod'
import { CONTENT_KEYS, CtxIdSchema, type ContentKey, type ItemCites, type WorkflowEdit } from './schema'

const Cites = z.array(z.string().max(32)).max(50).default([])

/** The reply as the server returns it (unknown keys ignored, bounds enforced). */
export const CloudReplySchema = z.object({
  title: z.string().max(500).default(''),
  steps: z
    .array(z.object({ title: z.string().trim().min(1).max(500), detail: z.string().max(3500).default(''), cites: Cites }))
    .max(200)
    .default([]),
  artifacts: z
    .array(z.object({ name: z.string().trim().min(1).max(400), kind: z.string().max(50).default(''), cites: Cites }))
    .max(100)
    .default([]),
  rules: z.array(z.object({ text: z.string().trim().min(1).max(4000), cites: Cites })).max(100).default([]),
  problems: z
    .array(z.object({ text: z.string().trim().min(1).max(4000), resolution: z.string().max(4000).default(''), cites: Cites }))
    .max(100)
    .default([])
})

const DraftCites = z.array(CtxIdSchema).max(20)

/** The draft the user reviews / edits and finally saves (renderer → main). User-added items may have no cites. */
export const CloudDraftSchema = z.strictObject({
  title: z.string().max(500),
  steps: z.array(z.strictObject({ title: z.string().trim().min(1).max(500), detail: z.string().max(3500), cites: DraftCites })).max(200),
  artifacts: z.array(z.strictObject({ name: z.string().trim().min(1).max(400), kind: z.string().max(50), cites: DraftCites })).max(100),
  rules: z.array(z.strictObject({ text: z.string().trim().min(1).max(4000), cites: DraftCites })).max(100),
  problems: z.array(z.strictObject({ text: z.string().trim().min(1).max(4000), resolution: z.string().max(4000), cites: DraftCites })).max(100)
})
export type CloudDraft = z.infer<typeof CloudDraftSchema>

export type CloudParseResult =
  | { ok: true; draft: CloudDraft; droppedItems: number; strippedCites: number }
  | { ok: false; error: string }

const FENCE_RE = /```json[ \t]*\r?\n([\s\S]*?)```/i

/** The JSON text inside the first ```json fence; a bare JSON object (whole reply) is tolerated. */
export function jsonBlock(text: string): string | null {
  const m = FENCE_RE.exec(text)
  if (m) return m[1]
  const t = text.trim()
  return t.startsWith('{') && t.endsWith('}') ? t : null
}

/**
 * Parse + validate the cloud reply against the ids that were actually sent. A cite outside `sentIds`
 * is stripped; an item left with no valid cite is dropped. Zero surviving steps ⇒ rejected.
 */
export function parseCloudReply(text: string, sentIds: readonly string[]): CloudParseResult {
  const block = jsonBlock(text)
  if (block === null) return { ok: false, error: tr('The cloud reply has no ```json code block; no draft was generated', '云端回复里没有 ```json 代码块，未生成草稿') }
  let json: unknown
  try {
    json = JSON.parse(block)
  } catch {
    return { ok: false, error: tr('Could not parse the JSON in the cloud reply; no draft was generated', '云端回复的 JSON 无法解析，未生成草稿') }
  }
  const r = CloudReplySchema.safeParse(json)
  if (!r.success) {
    const issues = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
    return { ok: false, error: tr(`The cloud reply does not match the extraction format (${issues.join('; ')}); no draft was generated`, `云端回复不符合抽取格式（${issues.join('; ')}），未生成草稿`) }
  }
  const sent = new Set(sentIds)
  let droppedItems = 0
  let strippedCites = 0
  function keep<T extends { cites: string[] }>(list: T[]): Array<T & { cites: string[] }> {
    const out: Array<T & { cites: string[] }> = []
    for (const item of list) {
      const valid = [...new Set(item.cites.filter((c) => sent.has(c)))].slice(0, 20)
      strippedCites += item.cites.length - item.cites.filter((c) => sent.has(c)).length
      if (valid.length === 0) {
        droppedItems++
        continue
      }
      out.push({ ...item, cites: valid })
    }
    return out
  }
  const d = r.data
  const draft: CloudDraft = {
    title: d.title.trim(),
    steps: keep(d.steps).map((s) => ({ title: s.title.trim(), detail: s.detail.trim(), cites: s.cites })),
    artifacts: keep(d.artifacts).map((a) => ({ name: a.name.trim(), kind: a.kind.trim(), cites: a.cites })),
    rules: keep(d.rules).map((x) => ({ text: x.text.trim(), cites: x.cites })),
    problems: keep(d.problems).map((p) => ({ text: p.text.trim(), resolution: p.resolution.trim(), cites: p.cites }))
  }
  if (draft.steps.length === 0) return { ok: false, error: tr('The cloud returned no steps with valid citations; no draft was generated', '云端没有返回任何带有效引用的步骤，未生成草稿') }
  return { ok: true, draft, droppedItems, strippedCites }
}

// --- draft → Workflow content -----------------------------------------------------------------

export function stepText(s: { title: string; detail: string }): string {
  const t = s.title.trim()
  const d = s.detail.trim()
  return (d ? `${t}：${d}` : t).slice(0, 4000)
}

export function artifactText(a: { name: string; kind: string }): string {
  const k = a.kind.trim()
  return (k ? `${a.name.trim()}（${k}）` : a.name.trim()).slice(0, 500)
}

/** Only the fields the reply can carry are filled; goal / context / inputs / tools / tags stay empty. */
export function editFromCloudDraft(d: CloudDraft): WorkflowEdit {
  return {
    title: d.title.trim().slice(0, 500),
    goal: '',
    context: '',
    inputs: [],
    tools: [],
    steps: d.steps.map((s, i) => ({ order: i + 1, text: stepText(s) })),
    artifacts: d.artifacts.map(artifactText),
    rules: d.rules.map((r) => r.text.trim()),
    problems: d.problems.map((p) => ({ problem: p.text.trim(), solution: p.resolution.trim() })),
    tags: []
  }
}

export function itemCitesOf(d: CloudDraft): ItemCites {
  return {
    steps: d.steps.map((s) => s.cites),
    artifacts: d.artifacts.map((a) => a.cites),
    rules: d.rules.map((r) => r.cites),
    problems: d.problems.map((p) => p.cites)
  }
}

export function citedIds(d: CloudDraft): string[] {
  const out = new Set<string>()
  for (const list of [d.steps, d.artifacts, d.rules, d.problems]) for (const it of list) for (const c of it.cites) out.add(c)
  return [...out]
}

type Content = Pick<WorkflowEdit, ContentKey>

function fieldShape(w: Content, k: ContentKey): unknown {
  if (k === 'steps') return w.steps.map((s) => s.text)
  if (k === 'problems') return w.problems.map((p) => [p.problem, p.solution])
  return w[k]
}

/** Content fields whose user-visible value differs between `a` and `b` (step order counts). */
export function changedFields(a: Content, b: Content): ContentKey[] {
  return CONTENT_KEYS.filter((k) => JSON.stringify(fieldShape(a, k)) !== JSON.stringify(fieldShape(b, k)))
}

/** Changed fields of the reviewed draft vs what the cloud returned; cite changes in an item count too. */
export function draftEditedFields(original: CloudDraft, current: CloudDraft): ContentKey[] {
  const fields = new Set(changedFields(editFromCloudDraft(original), editFromCloudDraft(current)))
  const a = itemCitesOf(original)
  const b = itemCitesOf(current)
  for (const k of ['steps', 'artifacts', 'rules', 'problems'] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) fields.add(k)
  return CONTENT_KEYS.filter((k) => fields.has(k))
}
