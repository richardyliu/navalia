import { z } from 'zod'
import type { SignedCard } from '../identity/card-schema'
import type { GrantView } from '../identity/grants-schema'
import { TYPING_CHARS_PER_MINUTE, type AuditLog } from './audit'
import { TOOL_CATALOG, toolMeta, type ToolMeta } from './catalog'
import { argsSchema } from './jsonschema-zod'
import ossTools from './oss-tools.json'
import type { RewindFramesResult, RewindScreenshot } from './rewind'
import { deepScrub } from './scrub'
import { scrubText } from '../identity/redact'
import type { WorkflowDetail } from '../workflows/api'
import { PROVENANCE_KINDS, type Workflow } from '../workflows/schema'
import { searchWorkflows } from '../workflows/search'

/** Everything the Broker reaches goes through main-process clients; the renderer is never involved. */
export interface BrokerBackend {
  card(): SignedCard | null
  /** One call to the OSS runtime MCP tool (PersomeMcp, stdio). No retries. Returns the tool's text. */
  ossTool(name: string, args: Record<string, unknown>): Promise<string>
  rewindFrames(q: { since?: string; until?: string; app_name?: string; limit?: number; cursor?: string }): Promise<RewindFramesResult>
  rewindScreenshot(stem: string): Promise<RewindScreenshot>
  /** Agent-funding budget (src/main/ipc.ts readBudget). LLM tools run only when enabled and not exhausted. */
  budget(): { enabled: boolean; exhausted: boolean }
  /** S1-06 Workflows (Lens Store + Runtime skill files, read-only). Absent → the workflow tools fail closed. */
  workflows?: WorkflowReader
}

export interface WorkflowReader {
  list(): Workflow[]
  get(id: string): WorkflowDetail | null
}

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolOutput {
  content: Content[]
  itemIds: string[]
  count: number
  /** Characters returned to the agent (text) or base64 length (image). */
  responseChars: number
  /** What the Access log stores as resultPreview (scrubbed text, or an image note). */
  preview: string
  /** Set when the Broker cut the result to its char budget; recorded in the Access log. */
  truncated?: { originalChars: number; returnedChars: number; budget: number }
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema advertised in tools/list. */
  inputSchema: Record<string, unknown>
  validate: z.ZodTypeAny
  meta: ToolMeta
  run(args: Record<string, unknown>, grant: GrantView, ctx: { backend: BrokerBackend; audit: AuditLog }): Promise<ToolOutput>
}

/** Hard ceiling on text returned by one call, so no single call can stream the whole DB. */
export const MAX_RESULT_CHARS = 200_000

/**
 * Tighter per-tool budgets for passthrough tools whose upstream output is unbounded. Empty since
 * Runtime schema 2026-11-05.3: MEM-10 (docs/upstream/MEM-10.md) is fixed upstream, `read_memory`
 * pages itself (`limit` ≤ 100, opaque `cursor`, ≤ 64 KiB compact JSON per page with `has_more` /
 * `next_cursor` after `entries`). The former Lens-only 50,000-char cut landed inside a full page
 * (re-serialized with indentation it exceeds 50k) and dropped `next_cursor`, so it was removed.
 * MAX_RESULT_CHARS still bounds an older runtime that returns a whole file.
 */
export const TOOL_RESULT_CHARS: Readonly<Record<string, number>> = {}

export const resultBudget = (tool: string): number => Math.min(TOOL_RESULT_CHARS[tool] ?? MAX_RESULT_CHARS, MAX_RESULT_CHARS)

/** Per-argument caps applied before the runtime sees the call (bounded outputs). */
const ARG_CAPS: Record<string, number> = {
  top_k: 50,
  limit: 200,
  tail_n: 500,
  fulltext_limit: 50,
  headline_limit: 50,
  timeline_limit: 100,
  depth: 3,
  window_minutes: 24 * 60,
  hours: 24 * 30,
  max_sessions: 1, // one unit of model work per invocation
  fresh_within_days: 365
}

function clampArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue
    out[k] = typeof v === 'number' && k in ARG_CAPS ? Math.min(v, ARG_CAPS[k]) : v
  }
  return out
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Best-effort item ids + count from a runtime result: the first list-valued field wins. */
export function itemsOf(value: unknown): { ids: string[]; count: number } {
  if (Array.isArray(value)) return idsFrom(value)
  if (value && typeof value === 'object') {
    for (const key of ['results', 'entries', 'files', 'hits', 'items', 'frames', 'memories', 'events', 'sessions', 'edges', 'faces', 'aliases']) {
      const v = (value as Record<string, unknown>)[key]
      if (Array.isArray(v)) return idsFrom(v)
    }
    return { ids: [], count: Object.keys(value).length === 0 ? 0 : 1 }
  }
  if (typeof value === 'string') return { ids: [], count: value.trim() ? 1 : 0 }
  return { ids: [], count: 0 }
}

function idsFrom(list: unknown[]): { ids: string[]; count: number } {
  const ids: string[] = []
  for (const it of list) {
    if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>
      const id = o.id ?? o.entry_id ?? o.file_stem ?? o.reference ?? o.path ?? o.alias_key
      if (typeof id === 'string' && id) ids.push(id)
    }
  }
  return { ids: ids.slice(0, 200), count: list.length }
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/

function b64urlDecode(value: string, maxChars: number): Buffer | null {
  if (value.length > maxChars || !B64URL_RE.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  // Canonical only: re-encoding must give the same text (no padding, no ignored trailing bits).
  return bytes.toString('base64url') === value ? bytes : null
}

/**
 * read_memory `next_cursor` (Runtime mcp/memory_paging.py `_encode_cursor`): urlsafe base64 without '='
 * of compact JSON `{"v":1,"q":<16 hex>,"a":<entry id>,"o":<int>}`. Entry ids come from store/entries.py
 * make_id: `YYYYMMDD-HHMM-<6 hex>`. Anything else (extra keys, other anchors) is not a cursor.
 */
export function isMemoryCursor(value: string): boolean {
  const bytes = b64urlDecode(value, 1024)
  if (!bytes) return false
  let d: unknown
  try {
    d = JSON.parse(bytes.toString('utf8'))
  } catch {
    return false
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false
  const o = d as Record<string, unknown>
  if (Object.keys(o).sort().join(',') !== 'a,o,q,v') return false
  if (o.v !== 1 || typeof o.q !== 'string' || !/^[0-9a-f]{16}$/.test(o.q)) return false
  if (typeof o.a !== 'string' || !/^\d{8}-\d{4}-[0-9a-f]{6}$/.test(o.a)) return false
  if (typeof o.o !== 'number' || !Number.isSafeInteger(o.o) || o.o < 0) return false
  return JSON.stringify({ v: o.v, q: o.q, a: o.a, o: o.o }) === bytes.toString('utf8')
}

/** Runtime mcp/model_projection.py PAGE_SECTIONS (points, lines, faces, volumes, root, receipts) → codes 1..6. */
const SNAPSHOT_SECTION_CODES = 6

/**
 * get_model_snapshot `page.next_cursor` (Runtime mcp/model_projection.py `_encode_cursor`): urlsafe base64
 * of struct `>BBQ32s` (projection version 1, section code, index, sha256) = 42 bytes = exactly 56 chars.
 */
export function isSnapshotCursor(value: string): boolean {
  if (value.length !== 56) return false
  const bytes = b64urlDecode(value, 56)
  return !!bytes && bytes.length === 42 && bytes[0] === 1 && bytes[1] >= 1 && bytes[1] <= SNAPSHOT_SECTION_CODES
}

interface CursorRule {
  path: readonly string[]
  valid: (value: string) => boolean
}

/**
 * The only values exempt from PII scrubbing: Runtime paging cursors at their exact upstream JSON path,
 * per tool, in their exact upstream format (security review F2/F3). The generic 40+ char token rule
 * would otherwise make paging through the Broker impossible. Everything else is scrubbed.
 */
const CURSOR_RULES: Readonly<Record<string, readonly CursorRule[]>> = {
  read_memory: [{ path: ['next_cursor'], valid: isMemoryCursor }],
  get_model_snapshot: [{ path: ['page', 'next_cursor'], valid: isSnapshotCursor }]
}

function at(value: unknown, path: readonly string[]): unknown {
  let cur = value
  for (const k of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/** deepScrub, then put back the allowlisted cursors (path keys are plain words the scrubber never changes). */
export function scrubToolResult(tool: string | null, raw: unknown): unknown {
  if (typeof raw === 'string') return scrubText(raw)
  const scrubbed = deepScrub(raw)
  for (const rule of (tool && CURSOR_RULES[tool]) || []) {
    const original = at(raw, rule.path)
    if (typeof original !== 'string' || !rule.valid(original)) continue
    const parent = at(scrubbed, rule.path.slice(0, -1))
    if (parent && typeof parent === 'object' && !Array.isArray(parent)) (parent as Record<string, unknown>)[rule.path[rule.path.length - 1]] = original
  }
  return scrubbed
}

/** Scrub, bound, and package a text result. Truncation carries an explicit marker with the original length. */
function textOutput(raw: unknown, budget = MAX_RESULT_CHARS, tool: string | null = null): ToolOutput {
  const scrubbed = scrubToolResult(tool, raw)
  let text = typeof scrubbed === 'string' ? scrubbed : JSON.stringify(scrubbed, null, 2)
  let truncated: ToolOutput['truncated']
  if (text.length > budget) {
    const originalChars = text.length
    text = `${text.slice(0, budget)}\n…[truncated by Navalia Broker: returned ${budget} of ${originalChars} chars; narrow the query or use limit/cursor]`
    truncated = { originalChars, returnedChars: text.length, budget }
  }
  const { ids, count } = itemsOf(raw)
  const preview = truncated ? `[truncated: ${truncated.originalChars} → ${truncated.budget} chars] ${text.slice(0, 400)}…` : text
  return { content: [{ type: 'text', text }], itemIds: ids, count, responseChars: text.length, preview, ...(truncated ? { truncated } : {}) }
}

const ossByName = new Map((ossTools.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>).map((t) => [t.name, t]))

function label(meta: ToolMeta): string {
  const tags: string[] = []
  if (meta.origin === 'product') tags.push('Rewind; argument and result shapes are Navalia-defined')
  if (meta.origin === 'extension') tags.push('Navalia extension')
  if (meta.write) tags.push('writes to your Personal Model')
  if (meta.llm) tags.push('may spend LLM budget; refused when the agent budget is disabled or exhausted')
  if (meta.image) tags.push('returns an image that is NOT PII-scrubbed')
  return tags.length ? `[${tags.join('; ')}] ` : ''
}

/** Lens extension: may this grant see evidence quotes? Full access always; scoped grants need evidence:read. */
function grantSeesEvidence(grant: GrantView): boolean {
  return grant.access.mode !== 'scoped' || grant.access.scopes.includes('evidence:read')
}

/** owner_aliases row fields (Runtime store/owner_aliases.py review_list) a grant without evidence:read may see. */
const ALIAS_ROW_FIELDS = ['alias', 'alias_key', 'status', 'confidence', 'evidence_count', 'first_seen_at', 'last_seen_at', 'activated_at', 'decision_source'] as const

const EVIDENCE_WITHHELD = 'evidence quotes need the evidence:read scope (Navalia extension)'

/**
 * Fail closed (security review F5): without evidence:read only the allowlisted row fields survive, each
 * row gets `evidence: []`, non-object rows are dropped, and output that is not the expected
 * `{status, aliases: [...]}` object is withheld entirely.
 */
export function withoutAliasEvidence(value: unknown): unknown {
  const v = value as { status?: unknown; aliases?: unknown } | null
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.aliases)) {
    return { status: null, aliases: [], evidence_withheld: `${EVIDENCE_WITHHELD}; unexpected Runtime output withheld` }
  }
  const rows = v.aliases
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => {
      const out: Record<string, unknown> = {}
      for (const k of ALIAS_ROW_FIELDS) if (k in row) out[k] = row[k]
      out.evidence = []
      return out
    })
  return { status: typeof v.status === 'string' ? v.status : null, aliases: rows, evidence_withheld: EVIDENCE_WITHHELD }
}

const OSS_RESULT_FILTERS: Readonly<Record<string, (value: unknown, grant: GrantView) => unknown>> = {
  owner_aliases: (value, grant) => (grantSeesEvidence(grant) ? value : withoutAliasEvidence(value))
}

function ossDef(meta: ToolMeta): ToolDef {
  const src = ossByName.get(meta.name)
  if (!src) throw new Error(`OSS tool schema missing for ${meta.name}`)
  return {
    name: meta.name,
    description: `${label(meta)}${src.description}`.slice(0, 4000),
    inputSchema: src.inputSchema,
    validate: argsSchema(src.inputSchema),
    meta,
    async run(args, grant, { backend }) {
      const raw = parseMaybeJson(await backend.ossTool(meta.name, clampArgs(args)))
      const filter = OSS_RESULT_FILTERS[meta.name]
      return textOutput(filter ? filter(raw, grant) : raw, resultBudget(meta.name), meta.name)
    }
  }
}

const IsoString = { type: 'string', description: 'ISO-8601 timestamp, e.g. 2026-11-04T09:00:00-08:00' }

const REWIND_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500, description: 'Text to find in captured screen frames.' },
    app_name: { type: 'string', maxLength: 200 },
    since: IsoString,
    until: IsoString,
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
  },
  required: ['query']
}
const REWIND_FRAMES_SCHEMA = {
  type: 'object',
  properties: {
    since: IsoString,
    until: IsoString,
    app_name: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    cursor: { type: 'string', maxLength: 64, description: 'next_cursor from a previous call' }
  }
}
const REWIND_SHOT_SCHEMA = {
  type: 'object',
  properties: { file_stem: { type: 'string', minLength: 10, maxLength: 64, description: 'file_stem from rewind_frames / search_rewind' } },
  required: ['file_stem']
}

function rewindDefs(): ToolDef[] {
  const m = (n: string) => toolMeta(n) as ToolMeta
  return [
    {
      name: 'search_rewind',
      description: `${label(m('search_rewind'))}Full-text search over captured screen frames (delegates to the runtime capture index). Returns frame metadata and snippets.`,
      inputSchema: REWIND_SEARCH_SCHEMA,
      validate: argsSchema(REWIND_SEARCH_SCHEMA),
      meta: m('search_rewind'),
      async run(args, _g, { backend }) {
        return textOutput(parseMaybeJson(await backend.ossTool('search_captures', clampArgs({ limit: 20, ...args }))))
      }
    },
    {
      name: 'rewind_frames',
      description: `${label(m('rewind_frames'))}Captured frames in a time range, oldest first: app, window, URL, visible text (≤1500 chars each). At most 100 per call and at most 300 capture files examined per call; when partial is true (or next_cursor is non-null) pass next_cursor to continue.`,
      inputSchema: REWIND_FRAMES_SCHEMA,
      validate: argsSchema(REWIND_FRAMES_SCHEMA),
      meta: m('rewind_frames'),
      async run(args, _g, { backend }) {
        return textOutput(await backend.rewindFrames(args as never))
      }
    },
    {
      name: 'view_rewind_screenshot',
      description: `${label(m('view_rewind_screenshot'))}The screenshot of one captured frame, decrypted locally. Frames stored without encryption are refused (error code plaintext_refused). Screenshots are kept only for the runtime's retention window (24 h by default).`,
      inputSchema: REWIND_SHOT_SCHEMA,
      validate: argsSchema(REWIND_SHOT_SCHEMA),
      meta: m('view_rewind_screenshot'),
      async run(args, _g, { backend }) {
        const shot = await backend.rewindScreenshot(String(args.file_stem))
        if (!shot.encrypted) {
          // OG-D6b: same rule as the Rewind page — plaintext legacy frames are never served.
          shot.data.fill(0)
          throw Object.assign(new Error('screenshot is stored unencrypted; refused (CAP-03)'), { code: 'plaintext_refused' })
        }
        const data = shot.data.toString('base64')
        const note = { file_stem: shot.file_stem, mime: shot.mime, width: shot.width, height: shot.height, bytes: shot.data.length, note: 'image, not scrubbed' }
        return {
          content: [
            { type: 'image', data, mimeType: shot.mime },
            { type: 'text', text: JSON.stringify(note) }
          ],
          itemIds: [shot.file_stem],
          count: 1,
          responseChars: data.length,
          preview: JSON.stringify(note)
        }
      }
    }
  ]
}

function extensionDefs(): ToolDef[] {
  const m = (n: string) => toolMeta(n) as ToolMeta
  const empty = { type: 'object', properties: {} }
  return [
    {
      name: 'card_get',
      description: `${label(m('card_get'))}Return the user's latest signed Personal Card (Ed25519, RFC 8785 canonical JSON). Verifiable offline.`,
      inputSchema: empty,
      validate: argsSchema(empty),
      meta: m('card_get'),
      async run(_a, _g, { backend }) {
        const card = backend.card()
        // Not re-scrubbed: content was scrubbed at build time and any edit would break the signature.
        const text = JSON.stringify(card ?? { card: null, note: 'No Personal Card has been created yet.' }, null, 2)
        return { content: [{ type: 'text', text }], itemIds: card ? [card.card.card_id] : [], count: card ? 1 : 0, responseChars: text.length, preview: text }
      }
    },
    {
      name: 'usage_report',
      description: `${label(m('usage_report'))}This client's own Access log summary for the last 30 days (reads, response characters).`,
      inputSchema: empty,
      validate: argsSchema(empty),
      meta: m('usage_report'),
      async run(_a, grant, { audit }) {
        const u = audit.usage(grant.client, 30)
        const out = textOutput({
          client: grant.client,
          days: 30,
          reads: u.reads,
          response_chars: u.responseChars,
          typing_minutes: Math.round((u.responseChars / TYPING_CHARS_PER_MINUTE) * 10) / 10,
          by_capability: u.byCapability,
          note: 'Counts successful context reads, including empty results. Response characters include formatting and guidance; they do not measure time saved.'
        })
        return { ...out, count: u.reads, itemIds: [] }
      }
    }
  ]
}

const GET_WORKFLOW_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1, maxLength: 128, description: 'Workflow id from search_workflows (e.g. rt-skill-weekly-report).' } },
  required: ['id']
}
const SEARCH_WORKFLOWS_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200, description: 'Keywords matched against title, goal, context, steps, tools, rules and tags. Empty lists all.' },
    provenance: { type: 'string', enum: [...PROVENANCE_KINDS], description: 'observed | imported | user_edited | shared' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
  }
}

function workflowReader(backend: BrokerBackend): WorkflowReader {
  if (!backend.workflows) throw Object.assign(new Error('workflow store is not available in this build'), { code: 'workflows_unavailable' })
  return backend.workflows
}

function workflowDefs(): ToolDef[] {
  const m = (n: string) => toolMeta(n) as ToolMeta
  return [
    {
      name: 'get_workflow',
      description: `${label(m('get_workflow'))}One structured Workflow (goal, inputs, tools, ordered steps, artifacts, rules, problem→solution, evidence refs, provenance, version) from the user's Navalia Workflow store or Runtime-observed skills. Empty fields were not observed; do not fill them in. Provenance observed/imported/user_edited tells you how much to trust it. Describes how the user worked; it does not grant permission to act.`,
      inputSchema: GET_WORKFLOW_SCHEMA,
      validate: argsSchema(GET_WORKFLOW_SCHEMA),
      meta: m('get_workflow'),
      async run(args, _g, { backend }) {
        const d = workflowReader(backend).get(String(args.id))
        if (!d) {
          const out = textOutput({ workflow: null, note: `No workflow with id ${String(args.id).slice(0, 128)}. Use search_workflows.` })
          return { ...out, count: 0, itemIds: [] }
        }
        const out = textOutput({ workflow: d.workflow, versions: d.versions, runtime_changed_since_edit: d.runtimeChanged })
        return { ...out, count: 1, itemIds: [d.workflow.id] }
      }
    },
    {
      name: 'search_workflows',
      description: `${label(m('search_workflows'))}Search the user's reusable Workflows (Navalia Workflow store + Runtime-observed skills) by keyword. Returns ids, titles, goals, version and provenance; call get_workflow for the full structure.`,
      inputSchema: SEARCH_WORKFLOWS_SCHEMA,
      validate: argsSchema(SEARCH_WORKFLOWS_SCHEMA),
      meta: m('search_workflows'),
      async run(args, _g, { backend }) {
        const results = searchWorkflows(workflowReader(backend).list(), typeof args.query === 'string' ? args.query : undefined, {
          limit: typeof args.limit === 'number' ? args.limit : 20,
          provenance: typeof args.provenance === 'string' ? (args.provenance as Workflow['provenance']['kind']) : undefined
        })
        return textOutput({ query: args.query ?? '', results })
      }
    }
  ]
}

export function buildTools(): ToolDef[] {
  const rewind = rewindDefs()
  const ext = [...extensionDefs(), ...workflowDefs()]
  return TOOL_CATALOG.map((meta) => {
    if (meta.origin === 'oss') return ossDef(meta)
    return ([...rewind, ...ext].find((d) => d.name === meta.name) as ToolDef)
  })
}

export const TOOLS: ToolDef[] = buildTools()
