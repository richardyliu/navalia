// S1-FULL C12 / C13 / C14 — Lens Meetings service (main only).
//
// C12 consent + recording: `start` refuses before any dialog / request while cloud is OFF or signed
// out; then main's native confirm (consent text), macOS microphone access, `POST /v1/meetings`
// with `{consent:{version:1, participants_informed:true}}`, and only then the mic gate is armed
// for that meeting. `chunk` is refused unless the gate is armed for exactly that meeting.
// C13 upload: each chunk is written to `<LensStore>/meetings/<id>/audio/<seq>.<ext>` (0600, dirs
// 0700), hashed (sha256) and PUT with bounded concurrency, retry + backoff on network / 5xx /
// 429, idempotent re-PUT (same seq + sha ⇒ 200 server-side). `stop` disarms, drains, `finish`es
// (re-uploading what the server says is missing), then polls status with backoff until ready /
// failed (bounded attempts, stops on disabled / signed out / dispose), stores the transcript
// (0600) and deletes the local audio.
// C14: deterministic Markdown (redacted) → preview → native confirm → temp folder →
// `persome import-data --source folder --path <tmp> --no-build` through import/cli.ts
// `runImportCli` → temp folder removed (prefix-guarded). Optional cloud summary over transcript
// slices via `/v1/chat/completions`, rememberable via MCP `remember` after a native confirm.
// Delete: server DELETE + local folder removal; what was imported into the Runtime cannot be
// deleted per item (no upstream command) and the result says so.
// Network access only via client.ts (this file never calls the network API directly).
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { defaultExec, runImportCli, type ExecFn } from '../import/cli'
import { ensureSecureDir, readFileIfExists, writeFileSecure } from '../store/paths'
import type { CloudErrorCode } from './api'
import { CHAT_LIMITS, type ChatContextItem } from './chat-api'
import { tr } from '../../shared/i18n'
import { CloudError } from './errors'
import {
  consentText,
  leavesMachineNote,
  MEETING_ID_RE,
  MEETING_LIMITS,
  MEETING_MIME_ALLOWLIST,
  normalizeMime,
  type MeetingChunkState,
  type MeetingDeleteResult,
  type MeetingDetail,
  type MeetingImportResult,
  type MeetingMarkdownPreview,
  type MeetingMeta,
  type MeetingRuntimeDeleteResult,
  type MeetingStarted,
  type MeetingSummary,
  type MeetingSummaryPreview,
  type MeetingSummaryRow,
  type MeetingTranscript
} from './meetings-api'
import { RuntimeError, type RuntimeClient } from '../runtime/client'
import { refusalText } from '../runtime/owner-delete'
import { buildMeetingMarkdown, redactField } from './meetings-markdown'
import { createMicArm, type MicArm } from './meetings-mic-gate'
import type { CloudConfirm } from './service'
import { confirmOrCancel, createPreviewStore, requireReady, type CloudHandle } from './subs-common'

export interface MeetingsDeps {
  storeRoot: string
  cloud: CloudHandle
  /** Main-owned native confirm (security.ts nativeConfirm). Absent ⇒ start / import / delete refused. */
  nativeConfirm?: CloudConfirm
  /** Production: `systemPreferences.askForMediaAccess` (macOS). Absent ⇒ no OS prompt is shown. */
  askForMediaAccess?: (media: 'microphone') => Promise<boolean>
  /** Shared with security.ts's permission handlers (production wires the same instance). */
  micArm?: MicArm
  runtimeRoot: () => string
  persomeBin: () => string | null
  exec?: ExecFn
  /** Runtime MCP tool call (for `remember`). */
  ossTool?: (name: string, args: Record<string, unknown>) => Promise<string>
  /** Loopback Runtime REST client (R10 per-item delete). Absent → deleteFromRuntime is unavailable. */
  runtime?: () => RuntimeClient
  knownSecrets?: () => string[]
  /** Parent of the import temp folder (default os.tmpdir()). */
  tmpRoot?: string
  timeZone?: string
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  randomHex?: (bytes: number) => string
  uploadConcurrency?: number
  maxUploadAttempts?: number
  /** Retry delays between upload attempts (ms). */
  backoffMs?: readonly number[]
  pollInitialMs?: number
  pollMaxMs?: number
  pollMaxAttempts?: number
  chunkTimeoutMs?: number
  /** C17 publisher: transcript fetched and stored (segment ids + time spans only, no text). */
  onTranscriptReady?: (id: string, items: Array<{ id: string; evidence: string }>) => void
}

export interface MeetingsService {
  list(): MeetingSummaryRow[]
  refresh(): Promise<MeetingSummaryRow[]>
  get(meetingId: string): MeetingDetail
  start(args: { title: string; participantsInformed: true; languageHints?: string[] }, sender?: unknown): Promise<MeetingStarted>
  chunk(args: { meetingId: string; seq: number; mime: string; durationMs: number; data: Uint8Array }): { seq: number; stored: true }
  stop(args: { meetingId: string; chunks: number }): MeetingMeta
  retry(meetingId: string): MeetingMeta
  markdownPreview(meetingId: string): MeetingMarkdownPreview
  importToRuntime(previewId: string, sender?: unknown): Promise<MeetingImportResult>
  summaryPreview(meetingId: string): MeetingSummaryPreview
  summarySend(args: { previewId: string; includeIds: string[] }): Promise<MeetingSummary>
  rememberSummary(meetingId: string, sender?: unknown): Promise<{ entryId: string }>
  delete(args: { meetingId: string; localOnly?: boolean }, sender?: unknown): Promise<MeetingDeleteResult>
  deleteFromRuntime(meetingId: string, sender?: unknown): Promise<MeetingRuntimeDeleteResult>
  micArm: MicArm
  /** Resolves when background uploads / finish / polling for this meeting are idle (tests). */
  idle(meetingId: string): Promise<void>
  /** Stop polling loops (app quit). */
  dispose(): void
}

export const MEETINGS_DIR = 'meetings'
export const IMPORT_TMP_PREFIX = 'lens-meet-import-'
export const MEETING_REMEMBER_TAGS = ['lens-meeting', 'cloud-summary'] as const
export const SUMMARY_QUESTION =
  '请为这次会议生成中文摘要：1) 主要议题与要点；2) 达成的决定；3) 待办事项（有负责人和时间就写上）。只依据提供的会议转写，没有的内容不要补充或猜测，引用时标注 [ctx-N]。'
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
const RETRYABLE: ReadonlySet<CloudErrorCode> = new Set(['network', 'timeout', 'server', 'rate_limited', 'stt_unavailable', 'checksum_mismatch'])
const PREVIEW_TTL_MS = 15 * 60_000
const MAX_SUMMARY_CHARS = 100_000
const EXCERPT_CHARS = 400
const EXT: Record<string, string> = { webm: 'webm', ogg: 'ogg', wav: 'wav' }

// --- server schemas (non-strict: extra server fields tolerated) -------------------------------

const ServerStatus = z.enum(['recording', 'transcribing', 'ready', 'failed'])
const CreateSchema = z.object({
  meeting_id: z.string().regex(MEETING_ID_RE),
  status: z.literal('recording'),
  max_chunks: z.number().int().min(1).max(100_000),
  chunk_max_bytes: z.number().int().min(1),
  chunk_max_ms: z.number().int().min(1)
})
const ChunkAck = z.object({ seq: z.number().int().nonnegative(), status: z.string().max(32) })
const FinishSchema = z.object({ status: z.string().max(32) })
const SERVER_STATES: ReadonlySet<string> = new Set(['recording', 'transcribing', 'ready', 'failed'])
const ServerMeeting = z.object({
  meeting_id: z.string().regex(MEETING_ID_RE),
  status: ServerStatus,
  duration_ms: z.number().nonnegative().nullable().optional(),
  error_code: z.string().max(64).nullable().optional()
})
const ServerList = z.union([z.array(ServerMeeting).max(1000), z.object({ meetings: z.array(ServerMeeting).max(1000) })])
const TranscriptSchema = z.object({
  meeting_id: z.string().regex(MEETING_ID_RE),
  language: z.string().max(32).nullable().optional(),
  segments: z
    .array(
      z.object({
        start_ms: z.number().nonnegative(),
        end_ms: z.number().nonnegative(),
        speaker: z.union([z.string().max(64), z.number().int()]).nullable().optional(),
        text: z.string().max(50_000)
      })
    )
    .max(50_000),
  text: z.string().max(4_000_000)
})
const DeltaSchema = z.object({ text: z.string() })
const DoneSchema = z.object({ finish_reason: z.enum(['stop', 'length', 'error']) })
const UsageSchema = z.object({ model: z.string().max(200) })
const RememberResponse = z.object({ entry_id: z.string().min(1).max(256) })

// --- local schemas (fail closed on anything unexpected) ---------------------------------------

const ChunkStateSchema = z.object({
  seq: z.number().int().nonnegative(),
  mime: z.string().max(64),
  durationMs: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploaded: z.boolean(),
  attempts: z.number().int().nonnegative(),
  error: z.string().max(64).nullable()
})
const MetaSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(MEETING_ID_RE),
  title: z.string().max(400),
  createdAt: z.string(),
  consent: z.object({ version: z.literal(1), participantsInformed: z.literal(true), at: z.string() }),
  languageHints: z.array(z.string().max(16)).max(8),
  limits: z.object({ maxChunks: z.number().int(), chunkMaxBytes: z.number().int(), chunkMaxMs: z.number().int() }),
  localStatus: z.enum(['recording', 'finishing', 'transcribing', 'ready', 'failed']),
  serverStatus: ServerStatus.nullable(),
  chunks: z.array(ChunkStateSchema).max(100_000),
  totalChunks: z.number().int().nonnegative().nullable(),
  durationMs: z.number().nonnegative(),
  errorCode: z.string().max(64).nullable(),
  audioDeleted: z.boolean(),
  transcript: z.object({ language: z.string().nullable(), segments: z.number().int(), chars: z.number().int(), fetchedAt: z.string() }).nullable(),
  imported: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      counts: z.object({ imported: z.number().int(), unchanged: z.number().int(), skipped: z.number().int() }).nullable(),
      fileName: z.string().max(256),
      sha256: z.string().max(64),
      runtimeDeletedAt: z.string().max(64).nullable().optional()
    })
    .nullable(),
  summary: z
    .object({
      text: z.string().max(MAX_SUMMARY_CHARS),
      at: z.string(),
      status: z.enum(['complete', 'truncated', 'error']),
      model: z.string().max(200).nullable(),
      rememberedEntryId: z.string().max(256).nullable()
    })
    .nullable(),
  serverGone: z.boolean().optional(),
  updatedAt: z.string()
})

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')
const codeOf = (e: unknown): CloudErrorCode => (e instanceof CloudError ? e.code : 'unknown')

function mimeExt(mime: string): string {
  return EXT[/^audio\/([a-z]+)/.exec(mime)?.[1] ?? ''] ?? 'bin'
}

function speakerOf(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

/** Cumulative start offset of each chunk (seq order), from the durations sent with the chunks. */
export function chunkStarts(m: Pick<MeetingMeta, 'chunks'>): number[] {
  const out: number[] = []
  let t = 0
  for (const c of [...m.chunks].sort((a, b) => a.seq - b.seq)) {
    out.push(t)
    t += c.durationMs
  }
  return out
}

/** Remove a folder only if it is a direct child of `parent` with the expected basename. */
export function removeGuarded(dir: string, parent: string, accept: (base: string) => boolean): boolean {
  const d = path.resolve(dir)
  const p = path.resolve(parent)
  if (d === p || path.dirname(d) !== p || !accept(path.basename(d))) return false
  fs.rmSync(d, { recursive: true, force: true })
  return true
}

export function createMeetingsService(deps: MeetingsDeps): MeetingsService {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const hex = deps.randomHex ?? ((n: number) => randomBytes(n).toString('hex'))
  const exec = deps.exec ?? defaultExec
  const micArm = deps.micArm ?? createMicArm()
  const concurrency = Math.min(2, Math.max(1, deps.uploadConcurrency ?? 2))
  const maxAttempts = Math.max(1, deps.maxUploadAttempts ?? 5)
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF_MS
  const pollInitial = deps.pollInitialMs ?? 3_000
  const pollMax = deps.pollMaxMs ?? 30_000
  const pollAttempts = deps.pollMaxAttempts ?? 600
  const chunkTimeoutMs = deps.chunkTimeoutMs ?? 120_000
  const root = path.join(deps.storeRoot, MEETINGS_DIR)
  const known = (): string[] => {
    try {
      return deps.knownSecrets?.() ?? []
    } catch {
      return []
    }
  }
  const mdPreviews = createPreviewStore<{ meetingId: string; markdown: string; fileName: string }>({ ttlMs: PREVIEW_TTL_MS, max: 8, now, randomHex: hex })
  const sumPreviews = createPreviewStore<MeetingSummaryPreview>({ ttlMs: PREVIEW_TTL_MS, max: 8, now, randomHex: hex })

  // --- storage -------------------------------------------------------------------------------

  function dirOf(id: string): string {
    if (!MEETING_ID_RE.test(id)) throw new CloudError('invalid_args')
    return path.join(root, id)
  }
  const metaFile = (id: string): string => path.join(dirOf(id), 'meeting.json')
  const audioDir = (id: string): string => path.join(dirOf(id), 'audio')
  const transcriptFile = (id: string): string => path.join(dirOf(id), 'transcript.json')

  function load(id: string): MeetingMeta | null {
    const buf = readFileIfExists(metaFile(id))
    if (!buf) return null
    try {
      return MetaSchema.parse(JSON.parse(buf.toString('utf8'))) as MeetingMeta
    } catch {
      return null
    }
  }

  function save(m: MeetingMeta): void {
    m.updatedAt = now().toISOString()
    ensureSecureDir(root)
    ensureSecureDir(dirOf(m.id))
    writeFileSecure(metaFile(m.id), `${JSON.stringify(m, null, 2)}\n`)
  }

  /** Synchronous load → mutate → save (single-threaded, so no interleaving). No-op if deleted. */
  function update(id: string, fn: (m: MeetingMeta) => void): MeetingMeta | null {
    const m = load(id)
    if (!m) return null
    fn(m)
    save(m)
    return m
  }

  function mustLoad(id: string): MeetingMeta {
    const m = load(id)
    if (!m) throw new CloudError('not_found', { detail: tr('Meeting not found', '会议不存在') })
    return m
  }

  function loadTranscript(id: string): MeetingTranscript | null {
    const buf = readFileIfExists(transcriptFile(id))
    if (!buf) return null
    try {
      const t = TranscriptSchema.parse(JSON.parse(buf.toString('utf8')))
      return { meeting_id: t.meeting_id, language: t.language ?? null, segments: t.segments.map((s) => ({ ...s, speaker: speakerOf(s.speaker) })), text: t.text }
    } catch {
      return null
    }
  }

  function row(m: MeetingMeta): MeetingSummaryRow {
    return {
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      localStatus: m.localStatus,
      serverStatus: m.serverStatus,
      durationMs: m.durationMs,
      chunks: m.totalChunks ?? m.chunks.length,
      uploaded: m.chunks.filter((c) => c.uploaded).length,
      hasTranscript: m.transcript !== null,
      imported: m.imported?.ok === true
    }
  }

  function allMetas(): MeetingMeta[] {
    if (!fs.existsSync(root)) return []
    const out: MeetingMeta[] = []
    for (const f of fs.readdirSync(root)) {
      if (!MEETING_ID_RE.test(f)) continue
      const m = load(f)
      if (m) out.push(m)
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  function deleteAudio(id: string): void {
    removeGuarded(audioDir(id), dirOf(id), (b) => b === 'audio')
  }

  // --- upload queue (bounded concurrency) ----------------------------------------------------

  let active = 0
  const waiters: Array<() => void> = []
  const pending = new Map<string, Set<Promise<void>>>() // meetingId → in-flight / queued jobs
  const queued = new Set<string>() // `${id}:${seq}`

  async function acquire(): Promise<void> {
    if (active < concurrency) {
      active++
      return
    }
    await new Promise<void>((r) => waiters.push(r)) // slot handed over by release()
  }
  function release(): void {
    const w = waiters.shift()
    if (w) w()
    else active--
  }

  function track(id: string, p: Promise<void>): void {
    let set = pending.get(id)
    if (!set) pending.set(id, (set = new Set()))
    set.add(p)
    void p.finally(() => {
      set!.delete(p)
      if (set!.size === 0 && pending.get(id) === set) pending.delete(id)
    })
  }

  async function drain(id: string): Promise<void> {
    for (;;) {
      const set = pending.get(id)
      if (!set || set.size === 0) return
      await Promise.allSettled([...set])
    }
  }

  async function uploadOnce(id: string, c: MeetingChunkState): Promise<void> {
    const file = path.join(audioDir(id), `${c.seq}.${mimeExt(c.mime)}`)
    const bytes = readFileIfExists(file)
    if (!bytes || sha256(bytes) !== c.sha256) throw new CloudError('invalid_args', { detail: tr('A local audio chunk is missing or damaged', '本地音频分片缺失或已损坏') })
    const ack = await deps.cloud.client.putBytes(
      `/v1/meetings/${id}/chunks/${c.seq}`,
      new Uint8Array(bytes),
      c.mime,
      { 'x-chunk-duration-ms': String(c.durationMs), 'x-chunk-sha256': c.sha256 },
      ChunkAck,
      { timeoutMs: chunkTimeoutMs }
    )
    if (ack.seq !== c.seq) throw new CloudError('bad_response')
  }

  async function uploadWithRetry(id: string, seq: number): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const m = load(id)
      const c = m?.chunks.find((x) => x.seq === seq)
      if (!m || !c || c.uploaded) return // deleted meanwhile / already done
      try {
        await uploadOnce(id, c)
        update(id, (mm) => {
          const cc = mm.chunks.find((x) => x.seq === seq)
          if (cc) Object.assign(cc, { uploaded: true, attempts: cc.attempts + 1, error: null })
        })
        return
      } catch (e) {
        const code = codeOf(e)
        update(id, (mm) => {
          const cc = mm.chunks.find((x) => x.seq === seq)
          if (cc) Object.assign(cc, { attempts: cc.attempts + 1, error: code })
        })
        if (!RETRYABLE.has(code) || attempt === maxAttempts) return
        const ra = e instanceof CloudError && e.retryAfterS !== undefined ? Math.min(60_000, e.retryAfterS * 1000) : null
        await sleep(ra ?? backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1_000)
      }
    }
  }

  function enqueue(id: string, seq: number): void {
    const key = `${id}:${seq}`
    if (queued.has(key)) return
    queued.add(key)
    const p = (async () => {
      await acquire()
      try {
        await uploadWithRetry(id, seq)
      } finally {
        release()
        queued.delete(key)
      }
    })().catch(() => undefined)
    track(id, p)
  }

  // --- finish + polling ----------------------------------------------------------------------

  const finalizing = new Map<string, Promise<void>>()
  const pollers = new Map<string, Promise<void>>()
  let disposed = false

  async function finishOnce(id: string): Promise<void> {
    for (let round = 0; round < 3; round++) {
      let m = load(id)
      if (!m || m.totalChunks === null) return
      for (const c of m.chunks) if (!c.uploaded) enqueue(id, c.seq)
      await drain(id)
      m = load(id)
      if (!m) return
      try {
        const f = await deps.cloud.client.requestJson('POST', `/v1/meetings/${id}/finish`, { chunks: m.totalChunks }, FinishSchema)
        // `finish` is idempotent server-side: a repeat returns the current status (may be ready / failed).
        const st = SERVER_STATES.has(f.status) ? (f.status as MeetingMeta['serverStatus']) : 'transcribing'
        update(id, (mm) => {
          mm.localStatus = 'transcribing'
          mm.serverStatus = st
          mm.errorCode = null
        })
        startPolling(id) // the next status GET picks up ready (→ transcript) or failed (→ error_code)
        return
      } catch (e) {
        const code = codeOf(e)
        if (code === 'chunks_missing' && round < 2 && e instanceof CloudError) {
          const missing = new Set(e.missing ?? [])
          const local = m.chunks.filter((c) => missing.has(c.seq))
          if (local.length > 0 && local.length === missing.size) {
            update(id, (mm) => {
              for (const c of mm.chunks) if (missing.has(c.seq)) Object.assign(c, { uploaded: false, error: null })
            })
            continue // re-upload exactly what the server is missing, then finish again
          }
        }
        if (code === 'meeting_closed') {
          // Already finished server-side (e.g. a previous finish whose response was lost).
          update(id, (mm) => {
            mm.localStatus = 'transcribing'
            mm.errorCode = null
          })
          startPolling(id)
          return
        }
        update(id, (mm) => {
          mm.errorCode = code
          if (code === 'chunks_missing' || code === 'chunks_mismatch') mm.localStatus = 'failed'
        })
        return
      }
    }
  }

  function finalize(id: string): void {
    if (finalizing.has(id)) return
    const p = finishOnce(id)
      .catch(() => undefined)
      .finally(() => finalizing.delete(id))
    finalizing.set(id, p)
  }

  async function fetchTranscript(id: string): Promise<boolean> {
    let t: z.infer<typeof TranscriptSchema>
    try {
      t = await deps.cloud.client.requestJson('GET', `/v1/meetings/${id}/transcript`, undefined, TranscriptSchema, { timeoutMs: 60_000, maxResponseBytes: 16 * 1024 * 1024 })
    } catch (e) {
      if (codeOf(e) === 'not_ready') return false
      throw e
    }
    if (t.meeting_id !== id) throw new CloudError('bad_response')
    const transcript: MeetingTranscript = {
      meeting_id: t.meeting_id,
      language: t.language ?? null,
      segments: t.segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, speaker: speakerOf(s.speaker), text: s.text })),
      text: t.text
    }
    if (!load(id)) return true // deleted while fetching: do not resurrect
    writeFileSecure(transcriptFile(id), `${JSON.stringify(transcript, null, 2)}\n`)
    deleteAudio(id)
    update(id, (m) => {
      m.localStatus = 'ready'
      m.serverStatus = 'ready'
      m.errorCode = null
      m.audioDeleted = true
      m.transcript = { language: transcript.language, segments: transcript.segments.length, chars: transcript.text.length, fetchedAt: now().toISOString() }
    })
    try {
      deps.onTranscriptReady?.(id, transcript.segments.map((seg, i) => ({ id: String(i), evidence: `${seg.start_ms}-${seg.end_ms}` })))
    } catch {
      // a proactive publisher must never break the meeting flow
    }
    return true
  }

  async function poll(id: string): Promise<void> {
    let delay = pollInitial
    for (let i = 0; i < pollAttempts && !disposed; i++) {
      await sleep(delay)
      delay = Math.min(pollMax, Math.round(delay * 1.5))
      if (disposed) return
      const m = load(id)
      if (!m || m.localStatus === 'ready' || m.localStatus === 'failed') return
      const st = deps.cloud.status()
      if (!st.enabled || !st.signedIn) return // resumes on the next list() / retry()
      try {
        const s = await deps.cloud.client.requestJson('GET', `/v1/meetings/${id}`, undefined, ServerMeeting)
        update(id, (mm) => {
          mm.serverStatus = s.status
          if (typeof s.duration_ms === 'number' && s.duration_ms > 0) mm.durationMs = s.duration_ms
        })
        if (s.status === 'failed') {
          update(id, (mm) => {
            mm.localStatus = 'failed'
            mm.errorCode = s.error_code && /^[a-z0-9_]{1,64}$/.test(s.error_code) ? s.error_code : 'transcription_failed'
          })
          return
        }
        if (s.status === 'ready' && (await fetchTranscript(id))) return
      } catch (e) {
        const code = codeOf(e)
        if (code === 'disabled' || code === 'unauthorized' || code === 'forbidden') return
        if (e instanceof CloudError && e.status === 404) {
          // Retention (7 days) or deleted elsewhere: the server copy is gone. Keep what we have locally.
          update(id, (mm) => {
            mm.serverGone = true
            mm.serverStatus = null
            if (!mm.transcript) {
              mm.localStatus = 'failed'
              mm.errorCode = 'expired'
            }
          })
          return
        }
        update(id, (mm) => {
          mm.errorCode = code
        })
      }
    }
  }

  function startPolling(id: string): void {
    if (disposed || pollers.has(id)) return
    const p = poll(id)
      .catch(() => undefined)
      .finally(() => pollers.delete(id))
    pollers.set(id, p)
  }

  function resumeWork(m: MeetingMeta): void {
    if (m.localStatus === 'transcribing') startPolling(m.id)
  }

  // --- summary helpers -----------------------------------------------------------------------

  function transcriptMarkdown(m: MeetingMeta, t: MeetingTranscript): ReturnType<typeof buildMeetingMarkdown> {
    return buildMeetingMarkdown({
      meetingId: m.id,
      title: m.title,
      createdAt: m.createdAt,
      durationMs: m.durationMs,
      transcript: t,
      chunkStartsMs: chunkStarts(m),
      timeZone: deps.timeZone,
      knownSecrets: known()
    })
  }

  function safeJson(s: string): unknown {
    try {
      return JSON.parse(s) as unknown
    } catch {
      return undefined
    }
  }

  return {
    micArm,

    list() {
      const metas = allMetas()
      for (const m of metas) resumeWork(m)
      return metas.map(row)
    },

    async refresh() {
      requireReady(deps.cloud)
      const r = await deps.cloud.client.requestJson('GET', '/v1/meetings', undefined, ServerList)
      const server = Array.isArray(r) ? r : r.meetings
      const byId = new Map(server.map((s) => [s.meeting_id, s]))
      for (const m of allMetas()) {
        const s = byId.get(m.id)
        if (!s) continue
        update(m.id, (mm) => {
          mm.serverStatus = s.status
        })
      }
      const metas = allMetas()
      for (const m of metas) resumeWork(m)
      return metas.map(row)
    },

    get(meetingId) {
      const meta = mustLoad(meetingId)
      return { meta, transcript: loadTranscript(meetingId) }
    },

    async start(args, sender) {
      if (args.participantsInformed !== true) throw new CloudError('consent_required')
      const base = requireReady(deps.cloud)
      const title = args.title.replace(/\s+/g, ' ').trim().slice(0, MEETING_LIMITS.maxTitleChars)
      if (!title) throw new CloudError('invalid_args', { detail: tr('Meeting title is empty', '会议标题为空') })
      if (micArm.isArmed()) throw new CloudError('busy', { detail: tr('Another meeting is already recording. Stop it first', '已有一场会议正在录音，请先停止') })
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Start recording this meeting?', '开始会议录音？'),
        detail: tr(`"${consentText()}"\n\n${leavesMachineNote()}\n\nServer: ${base}`, `「${consentText()}」\n\n${leavesMachineNote()}\n\n服务器：${base}`),
        confirmLabel: tr('They know, start recording', '已告知，开始录音')
      })
      if (deps.askForMediaAccess) {
        let granted = false
        try {
          granted = await deps.askForMediaAccess('microphone')
        } catch {
          granted = false
        }
        if (!granted) throw new CloudError('mic_denied')
      }
      const hints = (args.languageHints ?? []).slice(0, MEETING_LIMITS.maxLanguageHints)
      const body = { title, consent: { version: 1, participants_informed: true }, ...(hints.length ? { language_hints: hints } : {}) }
      const c = await deps.cloud.client.requestJson('POST', '/v1/meetings', body, CreateSchema)
      if (load(c.meeting_id)) throw new CloudError('bad_response')
      const at = now().toISOString()
      const meta: MeetingMeta = {
        version: 1,
        id: c.meeting_id,
        title,
        createdAt: at,
        consent: { version: 1, participantsInformed: true, at },
        languageHints: hints,
        limits: {
          maxChunks: Math.min(MEETING_LIMITS.maxChunks, c.max_chunks),
          chunkMaxBytes: Math.min(MEETING_LIMITS.chunkMaxBytes, c.chunk_max_bytes),
          chunkMaxMs: Math.min(MEETING_LIMITS.chunkMaxMs, c.chunk_max_ms)
        },
        localStatus: 'recording',
        serverStatus: 'recording',
        chunks: [],
        totalChunks: null,
        durationMs: 0,
        errorCode: null,
        audioDeleted: false,
        transcript: null,
        imported: null,
        summary: null,
        updatedAt: at
      }
      save(meta)
      ensureSecureDir(audioDir(meta.id))
      micArm.arm(meta.id)
      return { meetingId: meta.id, limits: meta.limits, mimeAllowlist: [...MEETING_MIME_ALLOWLIST] }
    },

    chunk(args) {
      if (micArm.armedFor() !== args.meetingId) throw new CloudError('consent_required', { detail: tr('This meeting is not in a confirmed recording state', '这场会议没有处于已确认的录音状态') })
      const m = mustLoad(args.meetingId)
      if (m.localStatus !== 'recording') throw new CloudError('meeting_closed')
      const mime = normalizeMime(args.mime)
      if (!(MEETING_MIME_ALLOWLIST as readonly string[]).includes(mime)) throw new CloudError('invalid_args', { detail: tr('Unsupported audio format', '不支持的音频格式') })
      if (args.seq >= m.limits.maxChunks) throw new CloudError('invalid_args', { detail: tr('This meeting has reached its chunk limit', '已达到单场会议的分片上限') })
      if (args.data.byteLength === 0 || args.data.byteLength > m.limits.chunkMaxBytes) throw new CloudError('invalid_args', { detail: tr('Invalid audio chunk size', '音频分片大小不合法') })
      if (args.durationMs > m.limits.chunkMaxMs) throw new CloudError('invalid_args', { detail: tr('Audio chunk is too long', '音频分片过长') })
      const digest = sha256(args.data)
      const existing = m.chunks.find((c) => c.seq === args.seq)
      if (existing) {
        if (existing.sha256 !== digest) throw new CloudError('chunk_conflict')
        return { seq: args.seq, stored: true }
      }
      ensureSecureDir(audioDir(m.id))
      writeFileSecure(path.join(audioDir(m.id), `${args.seq}.${mimeExt(mime)}`), args.data)
      update(m.id, (mm) => {
        mm.chunks.push({ seq: args.seq, mime, durationMs: args.durationMs, bytes: args.data.byteLength, sha256: digest, uploaded: false, attempts: 0, error: null })
        mm.chunks.sort((a, b) => a.seq - b.seq)
        mm.durationMs = mm.chunks.reduce((n, c) => n + c.durationMs, 0)
      })
      enqueue(m.id, args.seq)
      return { seq: args.seq, stored: true }
    },

    stop(args) {
      const m = mustLoad(args.meetingId)
      micArm.disarm(args.meetingId)
      if (m.localStatus !== 'recording') return m
      const seqs = new Set(m.chunks.map((c) => c.seq))
      for (let i = 0; i < args.chunks; i++) if (!seqs.has(i)) throw new CloudError('invalid_args', { detail: tr(`Audio chunk ${i} is missing on this Mac`, `本机缺少第 ${i} 段音频`) })
      const out = update(m.id, (mm) => {
        mm.totalChunks = args.chunks
        // Chunks the renderer sent beyond the declared count are not part of the meeting.
        mm.chunks = mm.chunks.filter((c) => c.seq < args.chunks)
        if (args.chunks === 0) {
          mm.localStatus = 'failed'
          mm.errorCode = 'no_audio'
        } else mm.localStatus = 'finishing'
      })!
      if (args.chunks > 0) finalize(m.id)
      return out
    },

    retry(meetingId) {
      const m = mustLoad(meetingId)
      requireReady(deps.cloud)
      if (m.localStatus === 'finishing') {
        update(meetingId, (mm) => {
          mm.errorCode = null
          for (const c of mm.chunks) if (!c.uploaded) Object.assign(c, { attempts: 0, error: null })
        })
        finalize(meetingId)
      } else if (m.localStatus === 'transcribing') startPolling(meetingId)
      else throw new CloudError('invalid_args', { detail: tr('This meeting does not need a retry', '这场会议不需要重试') })
      return mustLoad(meetingId)
    },

    markdownPreview(meetingId) {
      const m = mustLoad(meetingId)
      const t = loadTranscript(meetingId)
      if (!t) throw new CloudError('not_ready')
      const md = transcriptMarkdown(m, t)
      const fileName = `meeting-${m.id}.md`
      const p = mdPreviews.put({ meetingId: m.id, markdown: md.markdown, fileName })
      return { previewId: p.id, meetingId: m.id, markdown: md.markdown, chars: md.markdown.length, redactions: md.redactions, fileName, expiresAt: p.expiresAt }
    },

    async importToRuntime(previewId, sender) {
      const p = mdPreviews.get(previewId)
      if (!p) throw new CloudError('not_found', { detail: tr('The preview has expired. Generate a new one', '预览已失效，请重新生成预览') })
      const m = mustLoad(p.meetingId)
      if (m.imported?.ok && !m.imported.runtimeDeletedAt) throw new CloudError('invalid_args', { detail: tr('This meeting is already in memory; writing it again would create duplicate entries', '这场会议已经写入过记忆；再次写入会产生重复条目') })
      const bin = deps.persomeBin()
      if (!bin) throw new CloudError('runtime', { detail: tr('The persome command-line tool was not found', '没有找到 persome 命令行工具') })
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Write this meeting transcript to Persome memory?', '把这场会议的转写写入 Persome 记忆？'),
        detail:
          tr(
            `${p.markdown.length} characters, written to the local Runtime timeline as an imported note (${p.fileName}); the Runtime then builds memories from it. ` +
              'Later you can click "Delete from Persome" in the meeting details to remove this import from the Runtime (needs Runtime R10 or newer); memories the Runtime already built from it are not deleted.\n\n',
            `${p.markdown.length} 字，作为一篇导入笔记（${p.fileName}）写入本机 Runtime 时间线，之后由 Runtime 生成记忆。` +
              '之后可以在会议详情里点「从 Persome 删除」把这份导入从 Runtime 删掉（需要 R10 或更新的 Runtime）；Runtime 已经据此生成的记忆不会随之删除。\n\n'
          ) +
          (p.markdown.length > EXCERPT_CHARS ? `${p.markdown.slice(0, EXCERPT_CHARS)}…` : p.markdown),
        confirmLabel: tr('Write', '写入')
      })
      mdPreviews.delete(previewId)
      const tmpRoot = path.resolve(deps.tmpRoot ?? os.tmpdir())
      const dir = fs.mkdtempSync(path.join(tmpRoot, IMPORT_TMP_PREFIX))
      let outcome: Awaited<ReturnType<typeof runImportCli>>
      try {
        fs.chmodSync(dir, 0o700)
        fs.writeFileSync(path.join(dir, p.fileName), p.markdown, { mode: 0o600 })
        outcome = await runImportCli({ exec, bin, runtimeRoot: deps.runtimeRoot(), stagingDir: dir, build: false })
      } finally {
        removeGuarded(dir, tmpRoot, (b) => b.startsWith(IMPORT_TMP_PREFIX))
      }
      const ok = outcome.exitCode === 0 && outcome.counts !== null
      update(m.id, (mm) => {
        mm.imported = { at: now().toISOString(), ok, exitCode: outcome.exitCode, counts: outcome.counts, fileName: p.fileName, sha256: sha256(p.markdown) }
      })
      return { ok, exitCode: outcome.exitCode, counts: outcome.counts, stderr: ok ? '' : outcome.stderr }
    },

    summaryPreview(meetingId) {
      const m = mustLoad(meetingId)
      const t = loadTranscript(meetingId)
      if (!t) throw new CloudError('not_ready')
      const md = transcriptMarkdown(m, t)
      const lines = md.markdown.split('\n').filter((l) => /^\[\d{2,}:\d{2}\]/.test(l))
      const header = md.markdown.split('\n## 转写')[0].trim()
      const items: ChatContextItem[] = []
      const warnings: string[] = []
      let total = 0
      let buf: string[] = []
      let dropped = 0
      const flush = (): void => {
        if (!buf.length) return
        const title = `会议转写 · ${m.title.slice(0, 60)} · 第 ${items.length + 1} 段`
        const text = buf.join('\n')
        const chars = title.length + text.length
        if (total + chars > CHAT_LIMITS.maxTotalChars || items.length >= CHAT_LIMITS.maxItems) dropped += buf.length
        else {
          items.push({ id: `ctx-${items.length + 1}`, kind: 'recent', title, text, ref: `meeting:${m.id}#${items.length + 1}`, chars })
          total += chars
        }
        buf = []
      }
      const budget = CHAT_LIMITS.maxItemChars - 200
      for (const l of [header, ...lines]) {
        const line = l.length > budget ? `${l.slice(0, budget)}…` : l
        if (buf.join('\n').length + line.length + 1 > budget) flush()
        buf.push(line)
      }
      flush()
      if (dropped > 0) warnings.push(
          tr(
            `Transcript is too long: it exceeds the ${CHAT_LIMITS.maxTotalChars.toLocaleString('en-US')}-character limit, so the last ${dropped} lines were left out and the summary only covers the earlier part`,
            `转写太长：超出 ${CHAT_LIMITS.maxTotalChars.toLocaleString('en-US')} 字符上限，后面 ${dropped} 行没有放进去，摘要只覆盖前面部分`
          )
        )
      if (md.redactions > 0) warnings.push(tr(`Redacted ${md.redactions} likely key / email / path item(s)`, `已脱敏 ${md.redactions} 处疑似密钥 / 邮箱 / 路径`))
      const preview: MeetingSummaryPreview = { previewId: '', meetingId: m.id, question: SUMMARY_QUESTION, items, totalChars: total, warnings, expiresAt: '' }
      const parked = sumPreviews.put(preview) // stored by reference: fill in the id it was parked under
      preview.previewId = parked.id
      preview.expiresAt = parked.expiresAt
      return { ...preview, items: [...items], warnings: [...warnings] }
    },

    async summarySend(args) {
      const p = sumPreviews.get(args.previewId)
      if (!p) throw new CloudError('not_found', { detail: tr('The preview has expired. Preview again', '预览已失效，请重新预览') })
      const wanted = new Set(args.includeIds)
      for (const id of wanted) if (!p.items.some((i) => i.id === id)) throw new CloudError('invalid_args', { detail: tr(`${id} is not in the preview`, `预览里没有 ${id}`) })
      const sent = p.items.filter((i) => wanted.has(i.id))
      if (sent.length === 0) throw new CloudError('invalid_args', { detail: tr('Select at least one transcript part', '至少选择一段转写') })
      requireReady(deps.cloud)
      sumPreviews.delete(args.previewId)
      const body = {
        messages: [{ role: 'user', content: p.question }],
        context: { items: sent.map(({ id, kind, title, text, ref }) => (ref === null ? { id, kind, title, text } : { id, kind, title, text, ref })) },
        task: 'chat'
      }
      let text = ''
      let model: string | null = null
      let done: z.infer<typeof DoneSchema> | null = null
      let failed = false
      try {
        for await (const ev of deps.cloud.client.stream('/v1/chat/completions', body)) {
          const data = safeJson(ev.data)
          if (ev.event === 'delta') {
            const d = DeltaSchema.safeParse(data)
            if (d.success) text = (text + d.data.text).slice(0, MAX_SUMMARY_CHARS)
          } else if (ev.event === 'usage') {
            const u = UsageSchema.safeParse(data)
            if (u.success) model = u.data.model
          } else if (ev.event === 'error') failed = true
          else if (ev.event === 'done') {
            const d = DoneSchema.safeParse(data)
            done = d.success ? d.data : { finish_reason: 'error' }
            break
          }
        }
      } catch (e) {
        if (!text) throw e
        failed = true
      }
      if (!text.trim()) throw new CloudError('upstream_error')
      const status: MeetingSummary['status'] = failed || !done || done.finish_reason === 'error' ? 'error' : done.finish_reason === 'length' ? 'truncated' : 'complete'
      const summary: MeetingSummary = { text, at: now().toISOString(), status, model, rememberedEntryId: null }
      update(p.meetingId, (mm) => {
        mm.summary = summary
      })
      return summary
    },

    async rememberSummary(meetingId, sender) {
      const m = mustLoad(meetingId)
      if (!m.summary || !m.summary.text.trim()) throw new CloudError('invalid_args', { detail: tr('No summary yet', '还没有摘要') })
      if (m.summary.rememberedEntryId) throw new CloudError('invalid_args', { detail: tr('This summary is already in memory', '这条摘要已经写入过记忆') })
      if (!deps.ossTool) throw new CloudError('runtime')
      const raw = `${m.summary.text.trim()}\n\n来源：Navalia 会议「${m.title}」（${m.id}）的云端摘要`
      const r = redactField(raw, known())
      if (r.text.length > 20_000) throw new CloudError('invalid_args', { detail: tr('The summary is too long to write to memory', '摘要过长，不能写入记忆') })
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Write this meeting summary to Persome memory?', '把这条会议摘要写入 Persome 记忆？'),
        detail: `${tr(`${r.text.length} characters, tags: ${MEETING_REMEMBER_TAGS.join(', ')}. Once written, other connected Agents can read it too.`, `${r.text.length} 字，标签：${MEETING_REMEMBER_TAGS.join(', ')}。写入后其他连接的 Agent 也能读到。`)}\n\n${r.text.length > EXCERPT_CHARS ? `${r.text.slice(0, EXCERPT_CHARS)}…` : r.text}`,
        confirmLabel: tr('Write', '写入')
      })
      let out: string
      try {
        out = await deps.ossTool('remember', { content: r.text, tags: MEETING_REMEMBER_TAGS.join(',') })
      } catch {
        throw new CloudError('runtime', { detail: tr('The remember call failed; the write was not confirmed', 'remember 调用失败，未确认写入') })
      }
      let entryId: string
      try {
        entryId = RememberResponse.parse(JSON.parse(out)).entry_id
      } catch {
        throw new CloudError('runtime', { detail: tr('Could not read the remember response. Check in Search whether it was written', 'remember 的返回无法解析；请在「搜索」里确认是否已写入') })
      }
      update(meetingId, (mm) => {
        if (mm.summary) mm.summary.rememberedEntryId = entryId
      })
      return { entryId }
    },

    async delete(args, sender) {
      const m = mustLoad(args.meetingId)
      if (!args.localOnly) requireReady(deps.cloud) // fail before the dialog
      const runtimeNote = runtimeRemainsNote(m)
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Delete this meeting?', '删除这场会议？'),
        detail:
          (args.localOnly
            ? tr(
                'Only the files on this Mac (audio, transcript, summary) are deleted. The cloud copy is not deleted (it is removed automatically after at most 7 days).',
                '只删除本机文件（音频、转写、摘要）；云端副本不会被删除（最多保留 7 天后自动删除）。'
              )
            : tr('Deletes the meeting record and transcript in the cloud, and the audio, transcript and summary on this Mac.', '删除云端的会议记录与转写，并删除本机的音频、转写和摘要。')) +
          (runtimeNote ? `\n\n${runtimeNote}` : ''),
        confirmLabel: tr('Delete', '删除')
      })
      micArm.disarm(m.id)
      let serverDeleted = false
      if (!args.localOnly) {
        try {
          await deps.cloud.client.requestEmpty('DELETE', `/v1/meetings/${m.id}`)
          serverDeleted = true
        } catch (e) {
          if (!(e instanceof CloudError && e.status === 404)) throw e
          serverDeleted = true // already gone server-side
        }
      }
      const localDeleted = removeGuarded(dirOf(m.id), root, (b) => b === m.id)
      return { serverDeleted, localDeleted, runtimeRemains: runtimeNote !== null, runtimeNote }
    },

    async deleteFromRuntime(meetingId, sender) {
      const m = mustLoad(meetingId)
      const importSha = m.imported?.ok && !m.imported.runtimeDeletedAt && /^[0-9a-f]{64}$/.test(m.imported.sha256) ? m.imported.sha256 : null
      const entryId = m.summary?.rememberedEntryId ?? null
      if (!importSha && !entryId) throw new CloudError('invalid_args', { detail: tr('This meeting has nothing written to Persome', '这场会议没有写入 Persome 的内容') })
      if (!deps.runtime) throw new CloudError('runtime', { detail: tr('This version of Navalia is not connected to the Runtime REST API, so items cannot be deleted one by one', '这个版本的 Navalia 没有连接 Runtime REST，无法按条删除') })
      const what = [
        importSha
          ? tr(
              `the imported transcript ("Imported folder note: ${m.imported?.fileName ?? ''}" in the timeline)`,
              `导入的转写（时间线里的「Imported folder note: ${m.imported?.fileName ?? ''}」）`
            )
          : null,
        entryId ? tr(`the meeting summary written to memory (entry ${entryId})`, `写入记忆的会议摘要（entry ${entryId}）`) : null
      ]
        .filter(Boolean)
        .join(tr(', and ', '，以及'))
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Delete what this meeting wrote to Persome?', '从 Persome 删除这场会议写入的内容？'),
        detail:
          tr(
            `Will delete from the local Runtime: ${what}. ` +
              'Memories the Runtime already built from the import are not deleted, and backups made before this still contain the content. The meeting records on this Mac and in the cloud are not affected.',
            `将从本机 Runtime 删除：${what}。` +
              'Runtime 已经根据导入内容生成的记忆不会随之删除；删除前做的备份里仍有这些内容。本机和云端的会议记录不受影响。'
          ),
        confirmLabel: tr('Delete', '删除')
      })
      const client = deps.runtime()
      const result: MeetingRuntimeDeleteResult = {
        import: { status: 'none', timelineBlocks: 0, sessions: 0, modeledSessions: 0 },
        summary: { status: 'none', reason: null },
        note: null
      }
      try {
        if (importSha) {
          const r = await client.deleteImports('content_sha256', [importSha])
          result.import = {
            status: r.deleted_ids.length ? 'deleted' : r.already_deleted.length ? 'already_deleted' : 'not_found',
            timelineBlocks: r.deleted.timeline_blocks ?? 0,
            sessions: r.deleted.sessions ?? 0,
            modeledSessions: r.modeled_sessions ?? 0
          }
          update(m.id, (mm) => {
            if (mm.imported) mm.imported.runtimeDeletedAt = now().toISOString()
          })
        }
        if (entryId) {
          const r = await client.deleteMemoryEntries([entryId])
          const refused = r.refused.find((x) => x.id === entryId)
          result.summary = refused
            ? { status: 'refused', reason: refusalText(refused.reason) }
            : { status: r.deleted_ids.length ? 'erased' : r.already_deleted.length ? 'already_deleted' : 'not_found', reason: null }
          if (!refused)
            update(m.id, (mm) => {
              if (mm.summary) mm.summary.rememberedEntryId = null
            })
        }
      } catch (e) {
        if (e instanceof RuntimeError) throw new CloudError('runtime', { detail: e.message })
        throw e
      }
      const notes: string[] = []
      if (result.import.modeledSessions > 0)
        notes.push(
          tr(
            `The Runtime already built memories from this import (${result.import.modeledSessions} session(s)). Those derived memories are not deleted; you can find them in Search.`,
            `Runtime 已经根据这份导入生成过记忆（${result.import.modeledSessions} 个会话）；这些派生记忆不会被删除，可在「搜索」里查看。`
          )
        )
      if (result.import.status === 'not_found') notes.push(
          tr(
            'The Runtime has no record of this import (it may have been cleared or never written), so it is treated as already gone.',
            'Runtime 里没有找到这份导入（可能已被清空或从未写入成功），视为已不存在。'
          )
        )
      if (result.summary.status === 'refused') notes.push(tr(`Meeting summary was not deleted: ${result.summary.reason}`, `会议摘要没有删除：${result.summary.reason}`))
      result.note = notes.length ? notes.join(tr(' ', '')) : null
      return result
    },

    async idle(meetingId) {
      for (let i = 0; i < 100; i++) {
        await drain(meetingId)
        await finalizing.get(meetingId)
        await pollers.get(meetingId)
        if (!pending.get(meetingId)?.size && !finalizing.has(meetingId) && !pollers.has(meetingId)) return
      }
    },

    dispose() {
      disposed = true
    }
  }
}

/** Honest text about what stays in the Runtime after deleting a meeting (null when nothing). */
export function runtimeRemainsNote(m: Pick<MeetingMeta, 'imported' | 'summary'>): string | null {
  const parts: string[] = []
  if (m.imported?.ok && !m.imported.runtimeDeletedAt)
    parts.push(
      tr(
        `The transcript written to Persome is not deleted: it is the import titled "Imported folder note: ${m.imported.fileName}" in the Runtime timeline, plus the memories built from it later. ` +
          'You can first click "Delete from Persome" in the meeting details (needs Runtime R10 or newer), then delete this meeting.',
        `已写入 Persome 的转写不会被删除：它在 Runtime 时间线里是标题为「Imported folder note: ${m.imported.fileName}」的导入条目，以及之后由它生成的记忆。` +
          '可以先在会议详情里点「从 Persome 删除」（需要 R10 或更新的 Runtime），再删除这场会议。'
      )
    )
  if (m.summary?.rememberedEntryId) parts.push(
      tr(
        `The meeting summary written to memory (entry ${m.summary.rememberedEntryId}) is not deleted either; "Delete from Persome" removes it too.`,
        `已写入记忆的会议摘要（entry ${m.summary.rememberedEntryId}）也不会被删除；「从 Persome 删除」会一并删除它。`
      )
    )
  if (!parts.length) return null
  parts.push(
    tr(
      'Older Runtimes cannot delete single items: you can only delete the whole timeline or all memory in the Privacy section of Settings (which also deletes other data), or run `persome clean timeline` / `persome clean memory`.',
      '旧版 Runtime 没有按条删除：只能在「设置」的隐私区块里整体删除时间线或全部记忆（会同时删除其他数据），或用 `persome clean timeline` / `persome clean memory`。'
    )
  )
  return parts.join(tr(' ', ''))
}
