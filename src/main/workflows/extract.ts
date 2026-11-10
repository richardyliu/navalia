/**
 * S2-07 Workflow extraction without a Lens LLM (DECISIONS-ROUND2 X7).
 *
 * Lens hands the user a prompt + JSON Schema; the user runs it in an external agent (Claude Code /
 * Codex, optionally with Persome MCP tools or a pasted transcript) and pastes the JSON back. This
 * module only validates that JSON. zod only, no Node imports and no network: the renderer uses it
 * for a live preview, main re-validates before saving.
 */
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { LEGACY_WORKFLOW_EXPORT_FORMAT, PREV_WORKFLOW_EXPORT_FORMAT, WORKFLOW_EXPORT_FORMAT, WorkflowExportSchema, WorkflowSchema, type EvidenceRef, type WorkflowEdit } from './schema'

export const EXTRACTION_FORMAT = 'navalia.workflow-extraction'
const PREV_EXTRACTION_FORMAT = 'grapple.workflow-extraction'
const LEGACY_EXTRACTION_FORMAT = 'persome-lens.workflow-extraction'
export const MAX_EXTRACTION_BYTES = 2 * 1024 * 1024
export const EXTRACT_SAVE_AS = ['user_edited', 'imported'] as const
export type ExtractSaveAs = (typeof EXTRACT_SAVE_AS)[number]

const Text = z.string().max(4000)
const ShortText = z.string().max(500)

/**
 * ISO 8601 calendar date or date-time (`2026-10-16`, `2026-10-16T15:12`, `…:05.123Z`, `…+08:00`;
 * a space separator is tolerated). The calendar date and clock must be real. Garbage strings are
 * rejected so they never reach a Workflow's evidence (S2-SEC M2).
 */
const ISO_TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
export function isIsoTimestamp(value: string): boolean {
  const m = ISO_TS_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return false
  return true
}
export function timestampFormatError(): string {
  return tr('Wrong time format: use an ISO 8601 date or time (e.g. 2026-10-16 or 2026-10-16T15:12), or omit it if unknown', '时间格式不对：应为 ISO 8601 日期或时间（如 2026-10-16 或 2026-10-16T15:12），不知道就省略')
}

export const ExtractedEvidenceSchema = z.strictObject({
  kind: z
    .enum(['receipt', 'entry', 'file', 'quote', 'capture'])
    .describe('receipt = Persome 收据 ⟨id:path⟩；entry = 记忆条目 id；file = 记忆文件路径；quote = 会话原文短引用；capture = Runtime 截屏 id'),
  ref: z.string().min(1).max(500).describe('收据 / 条目 id / 路径原样照抄；quote 时为原文（≤500 字）'),
  timestamp: z
    .string()
    .max(64)
    .refine(isIsoTimestamp, { error: () => timestampFormatError() })
    .nullable()
    .optional()
    .describe('证据发生时间（ISO 8601），不知道就省略')
})

const ExtractedStepSchema = z.union([Text.min(1), z.strictObject({ order: z.number().int().min(1).max(500), text: Text.min(1) })])

/** What the external agent outputs: one Workflow's content. Every field may be omitted (= empty). */
export const ExtractedWorkflowSchema = z.strictObject({
  title: ShortText.default('').describe('简短标题'),
  goal: Text.default('').describe('这个工作要达成什么'),
  context: Text.default('').describe('在什么情境 / 触发条件下做'),
  inputs: z.array(ShortText).max(100).default([]).describe('输入 / 处理的对象'),
  tools: z.array(ShortText).max(100).default([]).describe('用到的工具 / 应用'),
  steps: z.array(ExtractedStepSchema).max(200).default([]).describe('按顺序的步骤；每步一句'),
  artifacts: z.array(ShortText).max(100).default([]).describe('产出物'),
  rules: z.array(Text).max(100).default([]).describe('规则 / 边界 / 约束'),
  problems: z
    .array(z.strictObject({ problem: Text.min(1), solution: Text.default('') }))
    .max(100)
    .default([])
    .describe('遇到的问题 → 解决办法；没有解决办法时 solution 留空'),
  evidence: z.array(ExtractedEvidenceSchema).max(500).default([]).describe('支撑以上内容的证据'),
  evidence_note: Text.default('').describe('证据概述，例如「3 次会话，跨 3 天」'),
  tags: z.array(z.string().max(64)).max(50).default([])
})
export type ExtractedWorkflow = z.infer<typeof ExtractedWorkflowSchema>

/** Wrapped form: `{ "format": "navalia.workflow-extraction", "workflow": { … } }` (format optional). */
const WrappedSchema = z.strictObject({ format: z.union([z.literal(EXTRACTION_FORMAT), z.literal(PREV_EXTRACTION_FORMAT), z.literal(LEGACY_EXTRACTION_FORMAT)]).optional(), workflow: z.unknown() })

/** Validated, normalized extraction: Workflow content + evidence. Nothing else is carried over. */
export interface ExtractionDraft extends WorkflowEdit {
  evidence: Array<Pick<EvidenceRef, 'ref' | 'kind' | 'timestamp'>>
  evidence_note: string
}

export type ExtractionForm = 'extraction' | 'wrapped' | 'workflow' | 'export'
export type ExtractionParse = { ok: true; draft: ExtractionDraft; form: ExtractionForm } | { ok: false; errors: string[] }

/** JSON Schema text derived from the zod schema, so the prompt and the validator cannot drift. */
export function extractionJsonSchema(): string {
  const schema = z.toJSONSchema(ExtractedWorkflowSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  return JSON.stringify({ title: 'Navalia Workflow（抽取）', ...schema }, null, 2)
}

/** Hand-written example (tested to parse with ExtractedWorkflowSchema). Clearly an example, not data. */
export const EXTRACTION_EXAMPLE = {
  title: '每周五整理周报',
  goal: '把本周已关闭的 issue 汇总成周报发给团队',
  context: '每周五下午团队同步之后',
  inputs: ['本周已关闭的 issue', '同步会议记录'],
  tools: ['Issue tracker', 'Notes', 'Mail'],
  steps: ['在 tracker 里筛选本周已关闭的 issue', '按里程碑分组', '写摘要', '发到团队邮件列表'],
  artifacts: ['周报草稿', '已发送的邮件'],
  rules: ['只写已关闭的 issue', '不写客户名'],
  problems: [{ problem: '筛选漏掉了重新打开过的 issue', solution: '加上 reopened 标签再筛一次' }],
  evidence: [
    { kind: 'receipt', ref: '⟨ev-0003:event-2026-10-16.md⟩', timestamp: '2026-10-16T15:12' },
    { kind: 'quote', ref: '“周报还是按里程碑分组吧”' }
  ],
  evidence_note: '3 次会话，跨 3 天',
  tags: ['weekly']
} as const

/** The prompt the user copies into Claude Code / Codex. `task` = optional description of which work to extract. */
export function buildExtractionPrompt(task = ''): string {
  const what = task.trim() ? `要抽取的工作：${task.trim()}\n\n` : ''
  return `你在帮我把一段真实发生过的重复工作整理成一个 Workflow，供 Navalia 保存。
${what}资料来源（任选）：
- 你可以用 Persome MCP 工具查我的本地记忆：search、read_memory、read_receipt（以及 resolve_evidence、related_events）。
- 或者使用我在下面贴的会话记录 / 文本。

规则：
1. 只输出一个 JSON 对象，描述一个 Workflow。不要输出任何解释、Markdown 或代码块标记。
2. 字段：goal（目标）/ inputs（处理的对象、输入）/ tools / steps（按顺序）/ artifacts（产出）/ rules（规则、边界）/ problems（问题 → 解决）/ evidence（证据），另有 title、context、evidence_note、tags。
3. 只写资料里确实出现过的内容。不知道的字段留空（"" 或 []），绝对不要推测、补全或编造步骤、工具、数字和证据。
4. evidence：Persome 收据（形如 ⟨id:path⟩）、条目 id、记忆路径必须原样照抄工具返回的值；来自会话记录的证据用 kind "quote"，ref 写不超过 500 字的原文短引用。
5. 不要包含密码、token、密钥等敏感信息。
6. 字段名必须与下面的 JSON Schema 完全一致，不要加其他字段。

JSON Schema：
${extractionJsonSchema()}

示例（只示意格式，不要照抄内容）：
${JSON.stringify(EXTRACTION_EXAMPLE, null, 2)}
`
}

// ── Validation ──────────────────────────────────────────────────────────────

function pathText(path: ReadonlyArray<PropertyKey>): string {
  if (!path.length) return tr('(root)', '（根）')
  return path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), '')
}

function typeName(t: string): string {
  const names: Record<string, [string, string]> = { string: ['text', '文本'], number: ['number', '数字'], array: ['array', '数组'], object: ['object', '对象'], boolean: ['boolean', '布尔值'], null: ['null', 'null'] }
  const n = names[t]
  return n ? tr(n[0], n[1]) : t
}

/** One zod issue → a localized message with the JSON path. */
export function issueText(issue: z.core.$ZodIssue): string {
  const at = pathText(issue.path)
  switch (issue.code) {
    case 'invalid_type':
      if (/received undefined/.test(issue.message)) return tr(`${at}: missing required field`, `${at}：缺少必填字段`)
      return tr(`${at}: wrong type, expected ${typeName(issue.expected)}`, `${at}：类型不对，应为${typeName(issue.expected)}`)
    case 'unrecognized_keys':
      return tr(`${at}: unknown field ${issue.keys.join(', ')}`, `${at}：不认识的字段 ${issue.keys.join('、')}`)
    case 'too_big':
      return tr(
        `${at}: exceeds the limit of ${String(issue.maximum)}${issue.origin === 'string' ? ' characters' : issue.origin === 'array' ? ' items' : ''}`,
        `${at}：超出上限 ${String(issue.maximum)}${issue.origin === 'string' ? ' 个字符' : issue.origin === 'array' ? ' 项' : ''}`
      )
    case 'too_small':
      if (issue.origin === 'string' && Number(issue.minimum) === 1) return tr(`${at}: cannot be empty`, `${at}：不能为空`)
      return tr(`${at}: at least ${String(issue.minimum)}${issue.origin === 'array' ? ' items' : ''}`, `${at}：至少 ${String(issue.minimum)}${issue.origin === 'array' ? ' 项' : ''}`)
    case 'invalid_value':
      return tr(`${at}: must be one of ${issue.values.map((v) => JSON.stringify(v)).join(' / ')}`, `${at}：取值必须是 ${issue.values.map((v) => JSON.stringify(v)).join(' / ')}`)
    case 'invalid_union':
      return tr(`${at}: wrong format (a step should be text, or {"order": number, "text": text})`, `${at}：格式不对（步骤应为文本，或 {"order": 数字, "text": 文本}）`)
    default:
      return tr(`${at}: ${issue.message}`, `${at}：${issue.message}`)
  }
}

function zodErrors(error: z.ZodError, prefix = ''): string[] {
  return error.issues.slice(0, 8).map((i) => (prefix ? `${prefix}${issueText(i)}` : issueText(i)))
}

function syntaxError(text: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  const pos = /position (\d+)/.exec(msg)
  if (pos) {
    const before = text.slice(0, Number(pos[1]))
    const line = before.split('\n').length
    const col = Number(pos[1]) - before.lastIndexOf('\n')
    return tr(`JSON syntax error (line ${line}, column ${col}). Paste only the JSON object the agent output.`, `JSON 语法错误（第 ${line} 行第 ${col} 列）。请只粘贴 agent 输出的 JSON 对象。`)
  }
  return tr('JSON syntax error. Paste only the JSON object the agent output (no explanatory text).', 'JSON 语法错误。请只粘贴 agent 输出的 JSON 对象（不要包含说明文字）。')
}

/** Accept a ```json … ``` fence around the object (agents often add one despite the prompt). */
function stripFence(text: string): string {
  const t = text.trim()
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(t)
  return m ? m[1].trim() : t
}

const cleanList = (list: string[]) => list.map((s) => s.trim()).filter(Boolean)

function normalize(e: ExtractedWorkflow): ExtractionDraft {
  const steps = e.steps
    .map((s, i) => (typeof s === 'string' ? { order: i + 1, text: s.trim(), i } : { order: s.order, text: s.text.trim(), i }))
    .filter((s) => s.text)
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((s, i) => ({ order: i + 1, text: s.text }))
  return {
    title: e.title.trim(),
    goal: e.goal.trim(),
    context: e.context.trim(),
    inputs: cleanList(e.inputs),
    tools: cleanList(e.tools),
    steps,
    artifacts: cleanList(e.artifacts),
    rules: cleanList(e.rules),
    problems: e.problems.map((p) => ({ problem: p.problem.trim(), solution: p.solution.trim() })).filter((p) => p.problem),
    tags: cleanList(e.tags),
    evidence: e.evidence.map((x) => ({ kind: x.kind, ref: x.ref.trim(), timestamp: x.timestamp ?? null })).filter((x) => x.ref),
    evidence_note: e.evidence_note.trim()
  }
}

function isEmptyDraft(d: ExtractionDraft): boolean {
  return !d.title && !d.goal && !d.context && !d.evidence_note && [d.inputs, d.tools, d.steps, d.artifacts, d.rules, d.problems, d.evidence, d.tags].every((l) => l.length === 0)
}

function fromExtraction(json: unknown, form: ExtractionForm, prefix = ''): ExtractionParse {
  const r = ExtractedWorkflowSchema.safeParse(json)
  return r.success ? { ok: true, draft: normalize(r.data), form } : { ok: false, errors: zodErrors(r.error, prefix) }
}

/**
 * Validate pasted JSON. Accepted forms:
 * 1. a bare extraction object (what the prompt asks for);
 * 2. `{ "format": "navalia.workflow-extraction", "workflow": { … } }` or `{ "workflow": { … } }`;
 * 3. a full Lens Workflow (`schema_version` …) — only its content + evidence are kept;
 * 4. a Lens export envelope with exactly one Workflow.
 */
export function parseExtraction(text: string): ExtractionParse {
  if (!text.trim()) return { ok: false, errors: [tr('No JSON pasted yet', '还没有粘贴 JSON')] }
  if (new TextEncoder().encode(text).length > MAX_EXTRACTION_BYTES) return { ok: false, errors: [tr(`Content exceeds ${MAX_EXTRACTION_BYTES} bytes`, `内容超过 ${MAX_EXTRACTION_BYTES} 字节`)] }
  const body = stripFence(text)
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (error) {
    return { ok: false, errors: [syntaxError(body, error)] }
  }
  if (Array.isArray(json)) return { ok: false, errors: [tr('(root): expected one JSON object (paste one Workflow at a time), not an array', '（根）：应为一个 JSON 对象（一次只粘贴一个 Workflow），不是数组')] }
  if (!json || typeof json !== 'object') return { ok: false, errors: [tr('(root): expected a JSON object', '（根）：应为一个 JSON 对象')] }
  const obj = json as Record<string, unknown>

  let parsed: ExtractionParse
  if ('schema_version' in obj) {
    const w = WorkflowSchema.safeParse(obj)
    if (!w.success) return { ok: false, errors: zodErrors(w.error, tr('Full Workflow format · ', '完整 Workflow 格式 · ')) }
    parsed = fromExtraction(contentOf(w.data), 'workflow')
  } else if (obj.format === WORKFLOW_EXPORT_FORMAT || obj.format === PREV_WORKFLOW_EXPORT_FORMAT || obj.format === LEGACY_WORKFLOW_EXPORT_FORMAT) {
    const env = WorkflowExportSchema.safeParse(obj)
    if (!env.success) return { ok: false, errors: zodErrors(env.error, tr('Export file format · ', '导出文件格式 · ')) }
    if (env.data.workflows.length !== 1) return { ok: false, errors: [
        tr(
          `workflows: only one Workflow can be saved here at a time (the file has ${env.data.workflows.length}); use "Import JSON" for several`,
          `workflows：这里一次只能保存一个 Workflow（文件里有 ${env.data.workflows.length} 个），多个请用「导入 JSON」`
        )
      ] }
    parsed = fromExtraction(contentOf(env.data.workflows[0]), 'export')
  } else if ('workflow' in obj) {
    const wrap = WrappedSchema.safeParse(obj)
    if (!wrap.success) return { ok: false, errors: zodErrors(wrap.error) }
    if (!wrap.data.workflow || typeof wrap.data.workflow !== 'object' || Array.isArray(wrap.data.workflow)) return { ok: false, errors: [tr('workflow: expected a JSON object', 'workflow：应为一个 JSON 对象')] }
    parsed = fromExtraction(wrap.data.workflow, 'wrapped', 'workflow.')
  } else {
    parsed = fromExtraction(obj, 'extraction')
  }
  if (parsed.ok && isEmptyDraft(parsed.draft)) return { ok: false, errors: [tr('All fields are empty; nothing to save', '所有字段都是空的，没有可保存的内容')] }
  return parsed
}

function contentOf(w: z.infer<typeof WorkflowSchema>): ExtractedWorkflow {
  return {
    title: w.title,
    goal: w.goal,
    context: w.context,
    inputs: w.inputs,
    tools: w.tools,
    // S1-R3-03: per-step Runtime pointers are not carried into an extraction draft; they stay in `evidence`.
    steps: w.steps.map((st) => ({ order: st.order, text: st.text })),
    artifacts: w.artifacts,
    rules: w.rules,
    problems: w.problems,
    evidence: w.evidence.map((e) => ({ kind: e.kind, ref: e.ref, timestamp: e.timestamp })),
    evidence_note: w.evidence_note,
    tags: w.tags
  }
}

/** Which of the 7 structured fields + evidence the draft fills (for the preview). */
export function draftFieldSummary(d: ExtractionDraft): Array<{ key: string; label: string; count: number }> {
  return [
    { key: 'goal', label: tr('Goal', '目标'), count: d.goal ? 1 : 0 },
    { key: 'inputs', label: tr('Inputs', '输入'), count: d.inputs.length },
    { key: 'tools', label: tr('Tools', '工具'), count: d.tools.length },
    { key: 'steps', label: tr('Steps', '步骤'), count: d.steps.length },
    { key: 'artifacts', label: tr('Artifacts', '产出'), count: d.artifacts.length },
    { key: 'rules', label: tr('Rules', '规则'), count: d.rules.length },
    { key: 'problems', label: tr('Problems → fixes', '问题→解决'), count: d.problems.length },
    { key: 'evidence', label: tr('Evidence', '证据'), count: d.evidence.length }
  ]
}
