// Typed renderer API fragment for the S1 workflows feature. Owned by the workflows feature agent.
// Types + constants only (no Node imports): the renderer typecheck includes this file.
import type { LensResult } from '../../shared/types'
import type { CloudDraft } from './cloud-draft'
import type { ExtractSaveAs, ExtractionForm } from './extract'
import type { CitedItem, ContentKey, ProvenanceKind, Workflow, WorkflowEdit } from './schema'

export const WORKFLOW_CHANNELS = {
  list: 'lens:workflows:list',
  get: 'lens:workflows:get',
  save: 'lens:workflows:save',
  export: 'lens:workflows:export',
  import: 'lens:workflows:import',
  exportSkill: 'lens:workflows:export-skill',
  importSkill: 'lens:workflows:import-skill',
  /** S2-07: save a Workflow pasted back from an external agent (Lens never calls an LLM). */
  extract: 'lens:workflows:extract',
  /** S1-FULL C15: cloud extraction from a picked agent session (opt-in cloud; preview → send by ids). */
  cloudStatus: 'lens:workflows:cloud-status',
  cloudSessions: 'lens:workflows:cloud-sessions',
  cloudPreview: 'lens:workflows:cloud-preview',
  cloudDiscard: 'lens:workflows:cloud-discard',
  cloudRun: 'lens:workflows:cloud-run',
  cloudCancel: 'lens:workflows:cloud-cancel',
  cloudSave: 'lens:workflows:cloud-save'
} as const

// --- S1-FULL C15: cloud extraction ------------------------------------------------------------

export interface CloudExtractStatus {
  /** False when the cloud service is not wired into the workflows IPC (then nothing can be sent). */
  available: boolean
  enabled: boolean
  signedIn: boolean
  /** Why extraction is unavailable right now (Chinese, user-facing), or null when ready. */
  reason: string | null
}

/** One local agent session (no file path; `key` is opaque). */
export interface SessionSummary {
  key: string
  agent: 'claude-code' | 'codex'
  title: string
  startedAt: string | null
  endedAt: string | null
  userTurns: number
  events: number
}

export interface SessionList {
  sessions: SessionSummary[]
  /** Which sources were configured (a null root = that source is off). */
  sources: { claudeCode: boolean; codex: boolean }
}

/** One context item exactly as it would be sent (same shape as Chat's context items). */
export interface CloudExtractItem extends CitedItem {
  chars: number
}

export interface CloudExtractPreview {
  previewId: string
  session: SessionSummary
  items: CloudExtractItem[]
  totalChars: number
  warnings: string[]
  expiresAt: string
}

export interface CloudExtractDraftResult {
  extractionId: string
  draft: CloudDraft
  /** The items that were sent (so the UI can show what each cite points at). */
  sent: CloudExtractItem[]
  model: string | null
  /** Items dropped because none of their cites pointed at a sent item; cite ids stripped. */
  droppedItems: number
  strippedCites: number
  expiresAt: string
}

export interface CloudSaveResult {
  item: ImportItem
  editedFields: ContentKey[]
}

export interface WorkflowVersionInfo {
  version: number
  provenance: ProvenanceKind
  updated_at: string | null
}

export interface WorkflowDetail {
  workflow: Workflow
  /** Stored versions, oldest first ([] when the Workflow lives only in the Runtime). */
  versions: WorkflowVersionInfo[]
  /** The live Runtime-observed copy with the same id, when there is one. */
  observed: Workflow | null
  /** A stored copy started from an observed version that the Runtime has since changed. */
  runtimeChanged: boolean
}

export interface CatalogSources {
  /** 'ok' | 'missing' | error text */
  runtimeFiles: string
  /** 'ok' | 'skipped' | error text */
  behaviorPatterns: string
  /** Number of Workflows in the Lens Store. */
  store: number
}

export interface WorkflowCatalog {
  workflows: Workflow[]
  sources: CatalogSources
}

export interface ImportItem {
  id: string
  title: string
  outcome: 'imported' | 'duplicate'
  /** Duplicates: the id that already holds the same content. Renamed imports: the original id. */
  detail: string | null
}

export interface ImportReport {
  file: string
  items: ImportItem[]
  imported: number
  duplicates: number
}

export interface SaveResult {
  workflow: Workflow
  unchanged: boolean
}

export interface ExportResult {
  /** null when the dialog was cancelled. */
  path: string | null
  count: number
}

/** S1-10: result of exporting one Workflow as a signed `.navaliaskill`. */
export interface SkillExportResult {
  /** null when the dialog was cancelled. */
  path: string | null
  /** Signer key fingerprint (lowercase hex SHA-256 of the raw Ed25519 public key). */
  fingerprint: string
  /** Field paths the scrubber redacted before signing. */
  redacted: string[]
}

/** S1-10: result of importing one verified `.navaliaskill`. */
export interface SkillImportReport {
  file: string
  item: ImportItem
  /** Fingerprint of the self-signed key that signed the package. */
  fingerprint: string
  /** When the sender exported it (signed). */
  sharedAt: string
  /** Always the self-signed trust note: integrity + key match, not identity. */
  trustNote: string
}

/** S2-07: result of saving one external-agent extraction. */
export interface ExtractSaveResult {
  /** outcome 'imported' → new `ext-*` id; 'duplicate' → id/detail = the existing Workflow with the same content. */
  item: ImportItem
  /** Which accepted JSON form was pasted. */
  form: ExtractionForm
}

export interface WorkflowsApi {
  workflows: {
    list(): Promise<LensResult<WorkflowCatalog>>
    get(id: string): Promise<LensResult<WorkflowDetail | null>>
    save(id: string, baseVersion: number, edit: WorkflowEdit): Promise<LensResult<SaveResult>>
    /** Opens a save dialog; writes one export file with the given ids. */
    export(ids: string[]): Promise<LensResult<ExportResult>>
    /** Opens an open-file dialog; null when cancelled. */
    import(): Promise<LensResult<ImportReport | null>>
    /** S1-10: sign one Workflow with the identity key and save it as `.navaliaskill`. */
    exportSkill(id: string): Promise<LensResult<SkillExportResult>>
    /** S1-10: verify + import one `.navaliaskill`; null when cancelled. Rejected files → ok:false. */
    importSkill(): Promise<LensResult<SkillImportReport | null>>
    /** S2-07: validate pasted JSON (from Claude Code / Codex) and save it as `user_edited` or `imported`. */
    extract(text: string, as: ExtractSaveAs, agent: string): Promise<LensResult<ExtractSaveResult>>
    /** C15: whether cloud extraction can run (cloud wired + ON + signed in). */
    cloudStatus(): Promise<LensResult<CloudExtractStatus>>
    /** C15: newest local Claude Code / Codex sessions (read-only). */
    cloudSessions(): Promise<LensResult<SessionList>>
    /** C15: build + park the redacted context of one session; nothing is sent. */
    cloudPreview(sessionKey: string, hint?: string): Promise<LensResult<CloudExtractPreview>>
    cloudDiscard(previewId: string): Promise<LensResult<boolean>>
    /** C15: send exactly the selected parked items; resolves with an unsaved draft. */
    cloudRun(previewId: string, includeIds: string[]): Promise<LensResult<CloudExtractDraftResult>>
    cloudCancel(previewId: string): Promise<LensResult<boolean>>
    /** C15: save the reviewed / edited draft as a new `cloud_extracted` Workflow. */
    cloudSave(extractionId: string, draft: CloudDraft): Promise<LensResult<CloudSaveResult>>
  }
}
