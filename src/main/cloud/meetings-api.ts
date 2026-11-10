// Lens Meetings (S1-FULL C12 / C13 / C14) — channel names, limits and renderer-safe types. No node
// imports: the renderer and preload import this file. Merged into `CloudApi` (api.ts) as the
// `meetings` namespace, so it reaches `window.lens.meetings` through the existing cloud preload.
import { tr } from '../../shared/i18n'
import type { CloudResult } from './api'
import type { ChatContextItem } from './chat-api'

export const MEETINGS_CHANNELS = {
  list: 'lens:meetings:list',
  refresh: 'lens:meetings:refresh',
  get: 'lens:meetings:get',
  start: 'lens:meetings:start',
  chunk: 'lens:meetings:chunk',
  stop: 'lens:meetings:stop',
  retry: 'lens:meetings:retry',
  markdownPreview: 'lens:meetings:markdown-preview',
  importToRuntime: 'lens:meetings:import',
  summaryPreview: 'lens:meetings:summary-preview',
  summarySend: 'lens:meetings:summary-send',
  rememberSummary: 'lens:meetings:remember-summary',
  delete: 'lens:meetings:delete',
  deleteFromRuntime: 'lens:meetings:delete-from-runtime'
} as const

/** Server ids are put into URL paths; anything else is refused before a request is built. */
export const MEETING_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Client-side ceilings (the server's own limits from `POST /v1/meetings` may be lower). */
export const MEETING_LIMITS = {
  maxChunks: 240,
  chunkMaxBytes: 4 * 1024 * 1024,
  chunkMaxMs: 35_000,
  /** The recorder rotates (stop + restart) MediaRecorder after this much recorded time. */
  rotateMs: 30_000,
  maxTitleChars: 120,
  maxLanguageHints: 4
} as const

/** Normalized (lower-case, no spaces) MIME types main accepts for a chunk. */
export const MEETING_MIME_ALLOWLIST = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/wav'] as const

export function normalizeMime(mime: string): string {
  return mime.toLowerCase().replace(/\s+/g, '')
}

/** The exact consent sentence the user ticks (also shown in main's native confirm). */
export function consentText(): string {
  return tr(
    'I have told every participant that this meeting is being recorded and the audio is uploaded in chunks to your configured cloud for transcription',
    '我已告知所有参会者：正在录音，音频会分片上传到你配置的云端做转写'
  )
}

/** What leaves the machine (shown on the page and in the confirm). */
export function leavesMachineNote(): string {
  return tr(
    'Only audio chunks leave this Mac (about 30 seconds each, uploaded to your configured cloud server for transcription); the transcript then comes back to this Mac. The server deletes the audio as soon as transcription finishes and keeps the transcript for at most 7 days. This Mac deletes its local audio once transcription is done.',
    '离开本机的只有音频分片（约 30 秒一段，上传到你配置的云端服务器做转写），之后转写文字返回本机。服务器在转写完成后立即删除音频，转写最多保留 7 天；本机在转写完成后删除本地音频。'
  )
}

export type MeetingLocalStatus = 'recording' | 'finishing' | 'transcribing' | 'ready' | 'failed'
export type MeetingServerStatus = 'recording' | 'transcribing' | 'ready' | 'failed'

export interface MeetingChunkState {
  seq: number
  mime: string
  durationMs: number
  bytes: number
  sha256: string
  uploaded: boolean
  attempts: number
  /** Fixed error code of the last failed attempt (never body text). */
  error: string | null
}

export interface MeetingImportRecord {
  at: string
  ok: boolean
  exitCode: number | null
  counts: { imported: number; unchanged: number; skipped: number } | null
  /** File name of the Markdown handed to `persome import-data` (how it shows up in the timeline). */
  fileName: string
  /** sha256 of the imported Markdown. */
  sha256: string
  /** Runtime R10: when the owner deleted this import from the Runtime (`POST /imports/delete`). */
  runtimeDeletedAt?: string | null
}

export interface MeetingSummary {
  text: string
  at: string
  status: 'complete' | 'truncated' | 'error'
  model: string | null
  rememberedEntryId: string | null
}

export interface MeetingMeta {
  version: 1
  id: string
  title: string
  createdAt: string
  consent: { version: 1; participantsInformed: true; at: string }
  languageHints: string[]
  limits: { maxChunks: number; chunkMaxBytes: number; chunkMaxMs: number }
  localStatus: MeetingLocalStatus
  serverStatus: MeetingServerStatus | null
  chunks: MeetingChunkState[]
  /** Number of chunks declared at stop (null while recording). */
  totalChunks: number | null
  durationMs: number
  errorCode: string | null
  audioDeleted: boolean
  transcript: { language: string | null; segments: number; chars: number; fetchedAt: string } | null
  imported: MeetingImportRecord | null
  summary: MeetingSummary | null
  /** The server returned 404 for this meeting (7-day retention): any local transcript is kept. */
  serverGone?: boolean
  updatedAt: string
}

export interface MeetingSummaryRow {
  id: string
  title: string
  createdAt: string
  localStatus: MeetingLocalStatus
  serverStatus: MeetingServerStatus | null
  durationMs: number
  chunks: number
  uploaded: number
  hasTranscript: boolean
  imported: boolean
}

export interface MeetingStartArgs {
  title: string
  /** Must be literally `true`: the user ticked the consent checkbox. Main also asks natively. */
  participantsInformed: true
  languageHints?: string[]
}

export interface MeetingStarted {
  meetingId: string
  limits: MeetingMeta['limits']
  /** MIME types main accepts; the recorder picks the first one `MediaRecorder` supports. */
  mimeAllowlist: string[]
}

export interface MeetingChunkArgs {
  meetingId: string
  seq: number
  mime: string
  durationMs: number
  data: Uint8Array
}

export interface MeetingTranscriptSegment {
  start_ms: number
  end_ms: number
  speaker: string | null
  text: string
}

export interface MeetingTranscript {
  meeting_id: string
  language: string | null
  segments: MeetingTranscriptSegment[]
  text: string
}

export interface MeetingDetail {
  meta: MeetingMeta
  transcript: MeetingTranscript | null
}

export interface MeetingMarkdownPreview {
  previewId: string
  meetingId: string
  /** Exactly the bytes that `importToRuntime` writes and imports. */
  markdown: string
  chars: number
  redactions: number
  fileName: string
  expiresAt: string
}

export interface MeetingImportResult {
  ok: boolean
  exitCode: number | null
  counts: MeetingImportRecord['counts']
  /** Redacted CLI stderr tail (empty on success). */
  stderr: string
}

export interface MeetingSummaryPreview {
  previewId: string
  meetingId: string
  question: string
  items: ChatContextItem[]
  totalChars: number
  warnings: string[]
  expiresAt: string
}

export interface MeetingDeleteResult {
  serverDeleted: boolean
  localDeleted: boolean
  /** True when transcript text was imported / remembered into the Runtime and stays there. */
  runtimeRemains: boolean
  /** Exact, honest description of what remains in the Runtime and how to remove it. */
  runtimeNote: string | null
}

/** Outcome of deleting a meeting's Runtime copies (R10 `/imports/delete` + `/memory/entries/delete`). */
export interface MeetingRuntimeDeleteResult {
  /** The imported transcript (`import-data`). `none`: nothing was imported. */
  import: {
    status: 'deleted' | 'already_deleted' | 'not_found' | 'none'
    timelineBlocks: number
    sessions: number
    /** Sessions the Runtime had already modeled: memory derived from them is NOT deleted. */
    modeledSessions: number
  }
  /** The remembered summary entry (`remember`). */
  summary: { status: 'erased' | 'already_deleted' | 'not_found' | 'refused' | 'none'; reason: string | null }
  /** Honest text about anything that stays in the Runtime (null when nothing). */
  note: string | null
}

export interface MeetingsApiFragment {
  meetings: {
    /** Local list only (no network). Resumes status polling for meetings still transcribing. */
    list(): Promise<CloudResult<MeetingSummaryRow[]>>
    /** `GET /v1/meetings` merged into local state (server-only meetings are not added). */
    refresh(): Promise<CloudResult<MeetingSummaryRow[]>>
    get(meetingId: string): Promise<CloudResult<MeetingDetail>>
    /** Consent → native confirm → microphone access → `POST /v1/meetings` → mic gate armed. */
    start(args: MeetingStartArgs): Promise<CloudResult<MeetingStarted>>
    chunk(args: MeetingChunkArgs): Promise<CloudResult<{ seq: number; stored: true }>>
    /** Disarms the mic gate, uploads what is left, then `finish` (in the background). */
    stop(args: { meetingId: string; chunks: number }): Promise<CloudResult<MeetingMeta>>
    /** Re-run uploads + finish for a meeting stuck in `finishing`, or re-start status polling. */
    retry(meetingId: string): Promise<CloudResult<MeetingMeta>>
    markdownPreview(meetingId: string): Promise<CloudResult<MeetingMarkdownPreview>>
    /** Native confirm in main, then `persome import-data --source folder --path <tmp> --no-build`. */
    importToRuntime(previewId: string): Promise<CloudResult<MeetingImportResult>>
    summaryPreview(meetingId: string): Promise<CloudResult<MeetingSummaryPreview>>
    summarySend(args: { previewId: string; includeIds: string[] }): Promise<CloudResult<MeetingSummary>>
    /** Native confirm in main, then Runtime MCP `remember`. */
    rememberSummary(meetingId: string): Promise<CloudResult<{ entryId: string }>>
    /** Native confirm; server DELETE (unless `localOnly`) + local folder removal. */
    delete(args: { meetingId: string; localOnly?: boolean }): Promise<CloudResult<MeetingDeleteResult>>
    /** Native confirm in main; R10 Runtime per-item delete of the imported transcript + remembered summary. */
    deleteFromRuntime(meetingId: string): Promise<CloudResult<MeetingRuntimeDeleteResult>>
  }
}
