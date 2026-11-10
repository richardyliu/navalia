// Typed renderer API fragment for the S1 import feature. Owned by the import feature agent.
// Types only (no runtime imports) so the renderer can import from here.
import type { LensResult } from '../../shared/types'

export const IMPORT_CHANNELS = {
  scan: 'lens:import:scan',
  prepare: 'lens:import:prepare',
  commit: 'lens:import:commit',
  build: 'lens:import:build',
  discard: 'lens:import:discard'
} as const

export type ImportSource = 'claude-code' | 'codex'

/** One discoverable transcript session (preview only; nothing is written). */
export interface ImportSessionPreview {
  /** `<source>:<sessionId>` — the selection key. */
  key: string
  source: ImportSource
  sessionId: string
  /** Launch project (cwd with the home user redacted), or null. */
  project: string | null
  title: string | null
  /** User + assistant messages on the main thread (sidechains / tool results not counted). */
  messageCount: number
  startTs: number | null
  endTs: number | null
  /** Transcript file(s) relative to the scanned home. */
  files: string[]
  /**
   * `imported`: an earlier successful run imported this session and the transcript has not grown since;
   * `changed`: imported before but the transcript has new messages; `new`: never imported.
   */
  importState: 'new' | 'imported' | 'changed'
}

export interface ImportScanResult {
  homeLabel: string
  roots: { claudeCode: boolean; codex: boolean }
  sessions: ImportSessionPreview[]
  /** Adapter warnings (counts by code). */
  warnings: Record<string, number>
  cli: { available: boolean }
  /** Chinese warning when the scan stopped at its file/byte limit (older files not shown). */
  capWarning: string | null
}

export interface StagedDocument {
  key: string
  source: ImportSource
  /** Path relative to the staging dir. */
  file: string
  bytes: number
  messages: number
  redactions: number
  droppedBlocks: number
  /** C20: stable dedupe key (front matter `dedupe_key`: sha256 of agent, session id, turn range, normalised content). */
  dedupeKey?: string
  /** C20: 1-based session turn range in this document. */
  turns?: [number, number]
}

/** S1-R3-06 prepare options. */
export interface PrepareOptions {
  /** 「保留工具调用」: tool name + command first line + paths (redacted); never tool output. C20: default true. */
  includeTools?: boolean
}

/** Per-session note from prepare (continuation / forced full re-import). */
export interface ImportNote {
  key: string
  /** `continued`: only new messages staged; `rewritten` / `legacy`: whole session staged again (older copy stays in the Runtime). */
  kind: 'continued' | 'rewritten' | 'legacy'
  detail: string
}

export type ImportRunStatus = 'staged' | 'imported' | 'import_failed' | 'built' | 'build_failed' | 'discarded'

export interface CliOutcome {
  /** Arguments passed to `persome` (no shell). The staging path is shown as `<staging>`. */
  args: string[]
  exitCode: number | null
  signal: string | null
  /** Redacted, ANSI-stripped, truncated. */
  stdout: string
  stderr: string
  /** Parsed from the CLI receipt line; null when the line was not found. */
  counts: { imported: number; unchanged: number; skipped: number } | null
  durationMs: number
}

export interface ImportRun {
  runId: string
  createdAt: string
  status: ImportRunStatus
  documents: StagedDocument[]
  /** Selected keys skipped because they were already imported with identical content. */
  skippedAlreadyImported: string[]
  /** S1-R3-06: continuation / re-import notes (absent on runs created before S1-R3-06). */
  notes?: ImportNote[]
  /** S1-R3-06: whether tool call summaries were rendered. */
  includeTools?: boolean
  totals: { documents: number; messages: number; bytes: number; redactions: number; droppedBlocks: number }
  importCli: CliOutcome | null
  buildCli: CliOutcome | null
  /** True once the staging dir was removed (after a successful build, discard, or expiry). */
  stagingDeleted?: boolean
}

export interface ImportApi {
  importer: {
    scan(): Promise<LensResult<ImportScanResult>>
    /** Dry run: convert + redact + stage under the Lens Store; never calls the Runtime CLI. */
    prepare(keys: string[], opts?: PrepareOptions): Promise<LensResult<ImportRun>>
    /** Run `persome import-data --source folder --path <Lens Store>/import/source --no-build` (stable path → stable upstream keys). */
    commit(runId: string): Promise<LensResult<ImportRun>>
    /** Explicit, user-confirmed model build (`import-data … --build`, LLM-backed). */
    build(runId: string, confirm: true): Promise<LensResult<ImportRun>>
    discard(runId: string): Promise<LensResult<ImportRun>>
  }
}
