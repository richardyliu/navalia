export interface ApiEnvelope<T> {
  success: boolean
  data: T
}

export interface OcrState {
  enabled?: boolean
  ready?: boolean
  worker?: string
  tier?: string
  [key: string]: unknown
}

export interface IndexHealth {
  status?: string
  index?: { status?: string } | string
  capture?: { state?: string } | string
  [key: string]: unknown
}

export interface StatusData {
  version: string
  /** Runtime R10+: code schema constant, e.g. `2026-11-05.3`. */
  schema_revision?: string
  /** Runtime R10+: `<version>+g<short-sha>[.dirty]`, or the bare version when the build commit is unknown. */
  build_version?: string
  build_sha?: string | null
  root: string
  daemon: string
  uptime: string
  health: string
  capture: string
  ocr: OcrState
  last_capture?: string
  buffer?: string
  index_health?: IndexHealth
  sessions?: string
  memory?: string
  timeline?: string
  llm_profile?: Record<string, unknown>
  models?: unknown
  models_checked?: boolean
}

export interface HealthData {
  status?: string
  ok?: boolean
  ocr?: unknown
  index?: unknown
  capture?: unknown
  [key: string]: unknown
}

export interface PermissionsData {
  accessibility: 'granted' | 'denied' | 'not_applicable' | string
  screen_recording: 'granted' | 'denied' | 'not_applicable' | string
}

export interface BuildRecord {
  build_id: string | null
  core_commit: string | null
  models: Record<string, string>
  prompt_hashes: Record<string, string>
  config_hash: string | null
  input_window: { start?: string; end?: string } | null
  mode: string | null
  trigger: string | null
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  degraded_stages: string[]
  status: 'complete' | 'degraded' | 'building' | 'not_built' | string
}

export interface Point {
  id: string
  content: string
  layer: string
  status: string
  is_latest: boolean
  supersedes?: string | null
  superseded_by?: string | null
  occurred_at?: string | null
  valid_from?: string | null
  valid_until?: string | null
  created_at?: string | null
  file_name: string
  tags: string[] | string
  confidence: number | null
  conflicted: boolean
  receipt: string
  edit_refusal?: string
}

export interface Line {
  kind: 'evolution' | 'relation' | string
  [key: string]: unknown
}

export interface Face {
  signature: string
  observations: number
  confidence: number
  provenance?: string
  members?: string[]
  source_receipts?: string[]
  edit_refusal?: string
  [key: string]: unknown
}

export interface Volume extends Face {}

export interface Root {
  signature: string
  observations: number
  confidence: number
  provenance?: string
  source_receipts?: string[]
  edit_refusal?: string
  [key: string]: unknown
}

export interface ModelStats {
  points: number
  evolution_lines: number
  relation_lines: number
  faces: number
  volumes: number
  roots: number
  receipts: number
}

export interface ModelSnapshot {
  schema_version: number
  generated_at: string
  build: BuildRecord
  points: Point[]
  lines: Line[]
  faces: Face[]
  volumes: Volume[]
  root: Root | null
  receipts: unknown[]
  stats: ModelStats
}

export interface ModelGraphResponse {
  generated_at: string
  model: ModelSnapshot
  index_health?: IndexHealth
  /**
   * MOD-13: sent since Runtime schema 2026-11-05.3 (`ready` + literal `issues` codes from
   * `persome.model.snapshot.model_status()`, the same list `persome model status` prints). Absent on 0.3.2.
   */
  model_status?: { ready?: boolean; issues?: string[] }
}

export interface EvidenceItem {
  relation?: string
  kind?: string
  id?: string
  reference: string
  label?: string
  timestamp?: string | null
  status?: string | null
  resolvable?: boolean
  [key: string]: unknown
}

export interface EvidenceResponse {
  reference: string
  canonical_reference?: string
  kind: string
  id: string
  status: string
  label: string
  summary?: string
  timestamp?: string | null
  path?: string | null
  metadata?: Record<string, unknown>
  sources: EvidenceItem[]
  context: EvidenceItem[]
  history: EvidenceItem[]
}

export interface NodeRawItem {
  ts?: string
  text?: string
  receipt?: string
}

export interface NodeResponse {
  id: string
  source: string
  raw: NodeRawItem[]
  tree: unknown
}

export interface RuntimeLocationInfo {
  root: string
  port: number
  bin: string | null
  rootExists: boolean
  configPath: string
  envPath: string
  tokenPresent: boolean
}

export interface AppInfo extends RuntimeLocationInfo {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
}

export type LensErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'not_found'
  | 'server'
  | 'schema'
  | 'token_unavailable'
  | 'runtime_missing'
  | 'unknown'

export interface LensError {
  code: LensErrorCode
  message: string
}

export type LensResult<T> = { ok: true; data: T } | { ok: false; error: LensError }

export interface MemorySearchHit {
  id: string
  path: string
  timestamp?: string
  age_days?: number
  content: string
  score?: number
  related_faces?: unknown[]
}

export interface CaptureSearchHit {
  file_stem: string
  timestamp: string
  app_name: string
  bundle_id?: string
  window_title?: string
  url?: string
  snippet: string
  rank?: number
  focused_role?: string
  focused_value_preview?: string
}

export interface SearchResponse<T> {
  query: string
  results: T[]
}

export interface RecentActivityResponse {
  count: number
  entries: MemorySearchHit[]
}

export interface BehaviorPatterns {
  root: { signature: string; confidence: number; created_at?: string } | null
  faces: Array<{
    signature: string
    level?: number
    provenance?: string
    observations: number
    /** Distinct local dates the Face was observed on (Runtime schema 2026-11-05.3+; absent before). */
    observation_dates?: string[]
    confidence: number
  }>
  skills: Array<{
    path: string
    description: string
    updated?: string
    entry_id?: string
    observed_at?: string
    playbook: string
    /** Runtime R8 (og/r8-workflow-structure; absent before): evidence-backed structure of the playbook. */
    steps?: Array<{ order?: number; text: string; evidence: string[] }>
    artifacts?: Array<{ kind?: string; value: string; evidence: string[] }>
    rules?: Array<{ text: string; evidence: string[] }>
    problems?: Array<{ problem: string; solution?: string; evidence: string[] }>
    structure_dropped?: number
  }>
  rendered: string
}

export interface RememberResult {
  entry_id: string
  file: string
  tags: string[]
}

export interface CorrectResult {
  kind: string
  applied: boolean
  reason?: string
  ok: boolean
}

export interface BuildState {
  running: boolean
  startedAt?: number
  finishedAt?: number
  exitCode?: number | null
  lines: string[]
  error?: string
}

export interface BudgetInfo {
  enabled: boolean
  client: string
  used: number
  limit: number
  remaining: number
  exhausted: boolean
  date: string
  resetAt: string
}
