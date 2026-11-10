/**
 * Workflow object (S1-06). zod only, no Node imports, so the renderer can share the types.
 *
 * A Workflow is the structured form of one piece of repeated real work: goal, inputs, tools,
 * ordered steps, artifacts, rules and problem→solution pairs, with the evidence refs that
 * support it. Fields that cannot be mapped from the source stay empty: nothing is invented.
 */
import { z } from 'zod'

export const WORKFLOW_SCHEMA_VERSION = 1
export const WORKFLOW_EXPORT_FORMAT = 'navalia.workflow'
/** Previous name (Grapple); still accepted on import. */
export const PREV_WORKFLOW_EXPORT_FORMAT = 'grapple.workflow'
/** Pre-rename (Persome Lens) export format; still accepted on import. */
export const LEGACY_WORKFLOW_EXPORT_FORMAT = 'persome-lens.workflow'

/**
 * Where this version of the Workflow came from.
 * - observed: mapped from Runtime behavioral memory (`skills/skill-*.md` / behavior_patterns)
 * - imported: read from a JSON file the user chose
 * - user_edited: a manual edit in Lens on top of an earlier version
 * - shared: received from another person as a signed `.navaliaskill` package (S1-10)
 */
export const PROVENANCE_KINDS = ['observed', 'imported', 'user_edited', 'shared'] as const
export const ProvenanceKindSchema = z.enum(PROVENANCE_KINDS)
export type ProvenanceKind = z.infer<typeof ProvenanceKindSchema>

export const SOURCE_TYPES = ['runtime_skill_file', 'runtime_behavior_patterns', 'import_file', 'lens_store', 'share'] as const
export const SourceTypeSchema = z.enum(SOURCE_TYPES)

export const WorkflowIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._~-]{0,127}$/, 'workflow id: lowercase letters, digits, . _ ~ -')

const Text = z.string().max(4000)
const ShortText = z.string().max(500)
const NullableIso = z.string().max(64).nullable()

export const EvidenceRefSchema = z.strictObject({
  /** Runtime receipt (`⟨id:path⟩`), entry id, or memory path, exactly as the source carried it. */
  ref: z.string().min(1).max(500),
  /** S2-07: `quote` = a short verbatim quote from a pasted transcript (ref holds the quote text). */
  /** S1-R3-03: `capture` = a bare Runtime capture id cited by a Steps/Artifacts/Rules/Problems item. */
  kind: z.enum(['receipt', 'entry', 'file', 'quote', 'capture']),
  /** When the supporting observation was written (Runtime entry heading), if known. */
  timestamp: NullableIso.default(null),
  /** local = from this machine's Runtime; imported = carried in by an import (may not resolve here). */
  origin: z.enum(['local', 'imported']).default('local')
})
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

/** Evidence pointers for one item (Runtime R8): a capture id or a `⟨entry_id:path⟩` receipt. */
export const ItemEvidenceSchema = z.array(z.string().min(1).max(500)).max(20)

export const StepSchema = z.strictObject({
  order: z.number().int().min(1).max(500),
  text: Text.min(1),
  /** S1-R3-03 (additive, optional): pointers the Runtime cited for this step. Absent for legacy / edited steps. */
  evidence: ItemEvidenceSchema.optional()
})
export type WorkflowStep = z.infer<typeof StepSchema>

export const ProblemSchema = z.strictObject({ problem: Text.min(1), solution: Text })
export type WorkflowProblem = z.infer<typeof ProblemSchema>

const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/)

/** One hop of a Workflow's history as carried inside a `.navaliaskill` package (S1-10). */
export const ProvenanceStepSchema = z.strictObject({
  kind: ProvenanceKindSchema,
  at: NullableIso,
  /** shared hops: the signer's key fingerprint. */
  fingerprint: Fingerprint.nullable(),
  /** imported hops: the file name; never a full local path. */
  from: z.string().max(200).nullable()
})
export type ProvenanceStep = z.infer<typeof ProvenanceStepSchema>

/**
 * S2-07: the Workflow was drafted by an external agent (Claude Code / Codex run by the user) from
 * a session or text, then pasted back into Lens. Lens itself never calls an LLM (X7).
 */
export const CONTENT_KEYS = ['title', 'goal', 'context', 'inputs', 'tools', 'steps', 'artifacts', 'rules', 'problems', 'tags'] as const
export type ContentKey = (typeof CONTENT_KEYS)[number]

/**
 * S1-FULL C15: `cloud_extracted` = drafted by the opt-in Lens cloud (`task: workflow_extract`) from
 * a session the user picked and previewed, then reviewed / edited in Lens before saving.
 */
export const EXTRACTION_SOURCES = ['external_agent', 'cloud_extracted'] as const
export const CtxIdSchema = z.string().regex(/^ctx-\d{1,3}$/)
const CiteIds = z.array(CtxIdSchema).max(20)

/** C15: which local agent session the cloud extraction was drafted from (no file path, ever). */
export const CloudSessionRefSchema = z.strictObject({
  agent: z.enum(['claude-code', 'codex']),
  /** Opaque key (sha256 prefix of agent + transcript file + session id). */
  key: z.string().regex(/^[0-9a-f]{16}$/),
  title: z.string().max(200),
  started_at: NullableIso,
  ended_at: NullableIso
})
export type CloudSessionRef = z.infer<typeof CloudSessionRefSchema>

/** C15: snapshot of one context item exactly as it was sent (redacted), kept when it was cited. */
export const CitedItemSchema = z.strictObject({
  id: CtxIdSchema,
  kind: z.string().max(32),
  title: z.string().max(400),
  text: z.string().max(8200),
  ref: z.string().max(512).nullable()
})
export type CitedItem = z.infer<typeof CitedItemSchema>

/** C15: cites per saved item, index-aligned with the field. A field the user later edits loses its alignment ([]). */
export const ItemCitesSchema = z.strictObject({
  steps: z.array(CiteIds).max(200),
  artifacts: z.array(CiteIds).max(100),
  rules: z.array(CiteIds).max(100),
  problems: z.array(CiteIds).max(100)
})
export type ItemCites = z.infer<typeof ItemCitesSchema>

export const ExtractionMetaSchema = z.strictObject({
  source: z.enum(EXTRACTION_SOURCES),
  /** Label the user picked for the agent that produced the JSON (e.g. "Claude Code"); C15: "Lens 云端". */
  agent: z.string().min(1).max(100),
  extracted_at: z.string().max(64),
  // --- C15 cloud_extracted (all optional: S2-07 files without them still load) ---
  /** Model reported by the server's `usage` event, if any. */
  model: z.string().max(200).nullable().optional(),
  session: CloudSessionRefSchema.optional(),
  /** ctx ids that were actually sent. */
  sent_ids: z.array(CtxIdSchema).max(100).optional(),
  /** Snapshots of the sent items that the saved content cites. */
  cited_items: z.array(CitedItemSchema).max(100).optional(),
  item_cites: ItemCitesSchema.optional(),
  /** Content fields the user changed relative to what the cloud returned (preview edits + later edits). */
  edited_fields: z.array(z.enum(CONTENT_KEYS)).max(CONTENT_KEYS.length).optional()
})
export type ExtractionMeta = z.infer<typeof ExtractionMetaSchema>

export const ProvenanceSchema = z.strictObject({
  kind: ProvenanceKindSchema,
  /** observed: timestamp of the newest supporting entry. */
  observed_at: NullableIso.default(null),
  imported_at: NullableIso.default(null),
  edited_at: NullableIso.default(null),
  /** For imported / shared: the file name or sender label. Never a full local path of someone else. */
  from: z.string().max(200).nullable().default(null),
  /** Imported: the id/version/provenance the file declared before Lens re-labelled it. */
  original_id: z.string().max(200).nullable().default(null),
  original_version: z.number().int().min(1).nullable().default(null),
  original_kind: ProvenanceKindSchema.nullable().default(null),
  /** user_edited: the version this edit was based on. */
  based_on_version: z.number().int().min(1).nullable().default(null),
  /** shared (S1-10): when the sender exported the signed package. */
  shared_at: NullableIso.default(null),
  /** shared (S1-10): fingerprint of the self-signed Ed25519 key that signed the package. */
  signer_fingerprint: Fingerprint.nullable().default(null),
  /** shared (S1-10): sha256 of the canonical signed payload (dedupe key). */
  package_hash: Fingerprint.nullable().default(null),
  /** shared (S1-10): provenance chain carried by the package, oldest first. */
  chain: z.array(ProvenanceStepSchema).max(50).default([]),
  /** S2-07 (additive, optional): set when the content came from an external-agent extraction. */
  extraction: ExtractionMetaSchema.optional()
})
export type Provenance = z.infer<typeof ProvenanceSchema>

export const SourceSchema = z.strictObject({
  type: SourceTypeSchema,
  /** Runtime memory path (e.g. `skills/skill-foo.md`) when the Workflow came from the Runtime. */
  path: z.string().max(500).nullable().default(null),
  /** Runtime entry ids that were mapped (newest first). */
  entry_ids: z.array(z.string().max(100)).max(200).default([]),
  /** Runtime-declared stage / confidence lines, verbatim. */
  stage: z.string().max(100).nullable().default(null),
  confidence: z.string().max(200).nullable().default(null)
})
export type WorkflowSource = z.infer<typeof SourceSchema>

export const WorkflowSchema = z.strictObject({
  schema_version: z.literal(WORKFLOW_SCHEMA_VERSION),
  id: WorkflowIdSchema,
  version: z.number().int().min(1).max(100_000),
  title: ShortText,
  goal: Text,
  /** When / in which situation the workflow happens (Runtime `Context` / `Trigger`). */
  context: Text,
  inputs: z.array(ShortText).max(100),
  tools: z.array(ShortText).max(100),
  steps: z.array(StepSchema).max(200),
  artifacts: z.array(ShortText).max(100),
  rules: z.array(Text).max(100),
  problems: z.array(ProblemSchema).max(100),
  evidence: z.array(EvidenceRefSchema).max(500),
  /** Runtime `Evidence` line verbatim (e.g. "5 sessions across 4 days"), or ''. */
  evidence_note: Text,
  tags: z.array(z.string().max(64)).max(50),
  provenance: ProvenanceSchema,
  source: SourceSchema,
  created_at: NullableIso,
  updated_at: NullableIso
})
export type Workflow = z.infer<typeof WorkflowSchema>

/** Fields a user may change in a manual edit. Evidence, provenance, source, id and version are not editable. */
export const WorkflowEditSchema = z.strictObject({
  title: ShortText,
  goal: Text,
  context: Text,
  inputs: z.array(ShortText).max(100),
  tools: z.array(ShortText).max(100),
  steps: z.array(StepSchema).max(200),
  artifacts: z.array(ShortText).max(100),
  rules: z.array(Text).max(100),
  problems: z.array(ProblemSchema).max(100),
  tags: z.array(z.string().max(64)).max(50)
})
export type WorkflowEdit = z.infer<typeof WorkflowEditSchema>

/** Export envelope: one file, one or more Workflows. */
export const WorkflowExportSchema = z.strictObject({
  format: z.union([z.literal(WORKFLOW_EXPORT_FORMAT), z.literal(PREV_WORKFLOW_EXPORT_FORMAT), z.literal(LEGACY_WORKFLOW_EXPORT_FORMAT)]),
  format_version: z.literal(1),
  exported_at: z.string().max(64),
  workflows: z.array(WorkflowSchema).min(1).max(500)
})

/** An empty Workflow skeleton: every mappable field starts empty. */
export function emptyWorkflow(id: string, provenance: Provenance, source: WorkflowSource): Workflow {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    id,
    version: 1,
    title: '',
    goal: '',
    context: '',
    inputs: [],
    tools: [],
    steps: [],
    artifacts: [],
    rules: [],
    problems: [],
    evidence: [],
    evidence_note: '',
    tags: [],
    provenance,
    source,
    created_at: null,
    updated_at: null
  }
}

export function provenance(kind: ProvenanceKind, extra: Partial<Provenance> = {}): Provenance {
  return ProvenanceSchema.parse({ kind, ...extra })
}

export function source(type: WorkflowSource['type'], extra: Partial<WorkflowSource> = {}): WorkflowSource {
  return SourceSchema.parse({ type, ...extra })
}
