// Meetings (C13): consented recording → audio chunk upload → speech-to-text → transcript.
//
// Privacy / retention:
// - Audio bytes live only in CLOUD_AUDIO_DIR (dir 0700, files 0600, random hex names; no title, no
//   account id in the name). A chunk's file is deleted as soon as that chunk is transcribed or fails
//   terminally; sweepAudio() deletes any file older than 24 h regardless, and any file the DB does not
//   reference (e.g. left behind by a crash).
// - Per-chunk results are dropped when the meeting transcript is assembled. The meeting row (title +
//   transcript) is deleted 7 days after it became ready/failed (or 7 days after creation if it never
//   finished), or on DELETE /v1/meetings/:id, or on account deletion. There is no "expired" status:
//   an expired meeting simply 404s.
// - Nothing here logs. Titles, transcript text, audio and keys never reach a log line or an error message.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Db } from './db.ts'
import { HttpError, readJson, readRaw } from './http.ts'
import { secondsToUtcMidnight, utcDay } from './chat.ts'
import { SttError, type Segment, type SttAdapter, type SttResult } from './stt.ts'

export const MAX_CHUNKS = 240
export const CHUNK_MAX_BYTES = 4 * 1024 * 1024
export const CHUNK_MAX_MS = 35_000
export const MAX_TITLE_CHARS = 200
export const MAX_LANGUAGE_HINTS = 4
export const AUDIO_MAX_AGE_MS = 24 * 3600 * 1000
export const TRANSCRIPT_RETENTION_MS = 7 * 24 * 3600 * 1000
export const MAX_ATTEMPTS = 2
export const RETRY_BACKOFF_MS = 30_000
export const CONTENT_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/wav'])

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AUDIO_NAME_RE = /^[0-9a-f]{32}$/
// C0/C1 controls, DEL, line/paragraph separators: a title is a single line.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export interface MeetingDeps {
  db: Db
  now: () => number
  stt: SttAdapter | null
  dailySeconds: number
  audioDir: string
  /** Called after work was queued (chunk accepted / finish). */
  poke: () => void
}

type MeetingStatus = 'recording' | 'transcribing' | 'ready' | 'failed'
type ChunkStatus = 'queued' | 'transcribing' | 'done' | 'failed'

interface MeetingRow {
  id: string
  account_id: string
  title: string
  status: MeetingStatus
  language_hints: string
  created_at: number
  chunk_count: number | null
  duration_ms: number
  error_code: string | null
  transcript: string | null
}

interface ChunkRow {
  id: number
  seq: number
  sha256: string
  status: ChunkStatus
  duration_ms: number
}

const bad = (msg: string): HttpError => new HttpError(400, 'invalid_request', msg)
const notFound = (): HttpError => new HttpError(404, 'not_found', 'Meeting not found')

// ---------------------------------------------------------------- audio storage

export function ensureAudioDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function audioPath(dir: string, name: string): string {
  if (!AUDIO_NAME_RE.test(name)) throw new Error('bad audio name')
  return join(dir, name)
}

/** Deletes one stored chunk file. Missing file is fine. */
export function removeAudio(dir: string, name: string | null): void {
  if (!name || !AUDIO_NAME_RE.test(name)) return
  try {
    unlinkSync(audioPath(dir, name))
  } catch {
    /* already gone */
  }
}

/** Audio file names of every chunk (still holding audio) of an account. Call BEFORE deleting the account. */
export function audioNamesForAccount(db: Db, accountId: string): string[] {
  return (db.prepare('SELECT audio_name FROM meeting_chunks WHERE account_id = ? AND audio_name IS NOT NULL').all(accountId) as Array<{ audio_name: string }>).map(
    (r) => r.audio_name
  )
}

// ---------------------------------------------------------------- quota

function usedMs(db: Db, accountId: string, day: string): number {
  const r = db.prepare('SELECT ms FROM stt_usage WHERE account_id = ? AND day = ?').get(accountId, day) as { ms: number } | undefined
  return r?.ms ?? 0
}

function quotaError(now: number): HttpError {
  return new HttpError(429, 'quota_exceeded', 'Daily audio budget exhausted', { 'retry-after': String(secondsToUtcMidnight(now)) })
}

// ---------------------------------------------------------------- handlers

function ownMeeting(d: MeetingDeps, accountId: string, rawId: string): MeetingRow {
  if (!ID_RE.test(rawId)) throw notFound()
  const m = d.db.prepare('SELECT * FROM meetings WHERE id = ? AND account_id = ?').get(rawId, accountId) as MeetingRow | undefined
  if (!m) throw notFound()
  return m
}

export async function createMeeting(d: MeetingDeps, req: IncomingMessage, bodyLimit: number, accountId: string): Promise<Record<string, unknown>> {
  const body = (await readJson(req, bodyLimit, true))!
  const consent = body.consent
  if (
    !consent ||
    typeof consent !== 'object' ||
    Array.isArray(consent) ||
    (consent as Record<string, unknown>).version !== 1 ||
    (consent as Record<string, unknown>).participants_informed !== true
  ) {
    throw new HttpError(400, 'consent_required', 'Recording requires consent: {"version":1,"participants_informed":true}')
  }
  const title = body.title
  if (typeof title !== 'string' || title.trim() === '' || [...title].length > MAX_TITLE_CHARS || CONTROL_RE.test(title)) {
    throw bad(`title must be a non-empty single-line string of at most ${MAX_TITLE_CHARS} chars`)
  }
  let hints: string[] = []
  if (body.language_hints !== undefined && body.language_hints !== null) {
    const h = body.language_hints
    if (!Array.isArray(h) || h.length > MAX_LANGUAGE_HINTS || !h.every((x) => typeof x === 'string' && /^[a-z]{2}$/.test(x))) {
      throw bad(`language_hints must be an array of at most ${MAX_LANGUAGE_HINTS} two-letter lowercase codes`)
    }
    hints = [...new Set(h as string[])]
  }
  if (!d.stt) throw new HttpError(503, 'stt_unavailable', 'Meeting transcription is not configured on this server')
  const now = d.now()
  if (usedMs(d.db, accountId, utcDay(now)) >= d.dailySeconds * 1000) throw quotaError(now)
  const id = randomUUID()
  d.db
    .prepare('INSERT INTO meetings (id, account_id, title, status, consent_version, language_hints, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(id, accountId, title, 'recording', JSON.stringify(hints), now)
  return { meeting_id: id, status: 'recording', max_chunks: MAX_CHUNKS, chunk_max_bytes: CHUNK_MAX_BYTES, chunk_max_ms: CHUNK_MAX_MS }
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name]
  return typeof v === 'string' ? v.trim() : null
}

export interface ChunkReply {
  status: number
  body: { seq: number; status: ChunkStatus }
}

export async function putChunk(d: MeetingDeps, req: IncomingMessage, accountId: string, rawId: string, rawSeq: string): Promise<ChunkReply> {
  const m = ownMeeting(d, accountId, rawId)
  if (!/^\d{1,3}$/.test(rawSeq) || Number(rawSeq) >= MAX_CHUNKS) throw bad(`seq must be an integer 0..${MAX_CHUNKS - 1}`)
  const seq = Number(rawSeq)
  const ct = header(req, 'content-type')
  const mediaType = ct ? ct.split(';')[0].trim().toLowerCase() : ''
  if (!CONTENT_TYPES.has(mediaType)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be audio/webm, audio/ogg or audio/wav')
  const durRaw = header(req, 'x-chunk-duration-ms')
  if (durRaw === null || !/^\d{1,6}$/.test(durRaw) || Number(durRaw) < 1 || Number(durRaw) > CHUNK_MAX_MS) {
    throw bad(`X-Chunk-Duration-Ms must be an integer 1..${CHUNK_MAX_MS}`)
  }
  const durationMs = Number(durRaw)
  const shaRaw = header(req, 'x-chunk-sha256')
  if (shaRaw === null || !/^[0-9a-fA-F]{64}$/.test(shaRaw)) throw bad('X-Chunk-Sha256 must be the hex SHA-256 of the body')
  const sha = shaRaw.toLowerCase()

  const audio = await readRaw(req, CHUNK_MAX_BYTES, 2 * CHUNK_MAX_BYTES)
  if (audio.length === 0) throw bad('chunk body must not be empty')
  if (createHash('sha256').update(audio).digest('hex') !== sha) throw new HttpError(400, 'checksum_mismatch', 'X-Chunk-Sha256 does not match the body')

  // Everything below is synchronous: no other request or worker step can interleave.
  const db = d.db
  const existing = db.prepare('SELECT id, seq, sha256, status, duration_ms FROM meeting_chunks WHERE meeting_id = ? AND seq = ?').get(m.id, seq) as ChunkRow | undefined
  if (existing) {
    if (existing.sha256 === sha) return { status: 200, body: { seq, status: existing.status } }
    throw new HttpError(409, 'chunk_conflict', 'A different chunk was already uploaded with this seq')
  }
  const cur = db.prepare('SELECT status FROM meetings WHERE id = ?').get(m.id) as { status: MeetingStatus } | undefined
  if (!cur) throw notFound()
  if (cur.status !== 'recording') throw new HttpError(409, 'meeting_closed', 'Meeting is no longer recording')
  if (!d.stt) throw new HttpError(503, 'stt_unavailable', 'Meeting transcription is not configured on this server')
  const now = d.now()
  const day = utcDay(now)
  if (usedMs(db, accountId, day) + durationMs > d.dailySeconds * 1000) throw quotaError(now)

  ensureAudioDir(d.audioDir)
  const name = randomBytes(16).toString('hex')
  writeFileSync(audioPath(d.audioDir, name), audio, { mode: 0o600, flag: 'wx' })
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO meeting_chunks (meeting_id, account_id, seq, sha256, content_type, duration_ms, bytes, audio_name, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`
    ).run(m.id, accountId, seq, sha, mediaType, durationMs, audio.length, name, now, now, now)
    db.prepare('UPDATE meetings SET duration_ms = duration_ms + ? WHERE id = ?').run(durationMs, m.id)
    db.prepare('INSERT INTO stt_usage (account_id, day, ms) VALUES (?, ?, ?) ON CONFLICT (account_id, day) DO UPDATE SET ms = ms + excluded.ms').run(accountId, day, durationMs)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    removeAudio(d.audioDir, name)
    throw err
  }
  d.poke()
  return { status: 202, body: { seq, status: 'queued' } }
}

export async function finishMeeting(d: MeetingDeps, req: IncomingMessage, bodyLimit: number, accountId: string, rawId: string): Promise<{ status: string }> {
  const m = ownMeeting(d, accountId, rawId)
  const body = (await readJson(req, bodyLimit, true))!
  const n = body.chunks
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CHUNKS) throw bad(`chunks must be an integer 1..${MAX_CHUNKS}`)
  const cur = d.db.prepare('SELECT status, chunk_count FROM meetings WHERE id = ?').get(m.id) as { status: MeetingStatus; chunk_count: number | null } | undefined
  if (!cur) throw notFound()
  if (cur.status !== 'recording') {
    // Idempotent retry of the same finish (e.g. the first response was lost).
    if (cur.chunk_count === n) return { status: cur.status }
    throw new HttpError(409, 'meeting_closed', 'Meeting is no longer recording')
  }
  const seqs = new Set((d.db.prepare('SELECT seq FROM meeting_chunks WHERE meeting_id = ?').all(m.id) as Array<{ seq: number }>).map((r) => r.seq))
  const missing: number[] = []
  for (let i = 0; i < n; i++) if (!seqs.has(i)) missing.push(i)
  if (missing.length > 0) throw new HttpError(409, 'chunks_missing', 'Some chunks were not uploaded', {}, { missing })
  if (seqs.size !== n) throw new HttpError(409, 'chunks_mismatch', 'More chunks were uploaded than declared')
  d.db.prepare("UPDATE meetings SET status = 'transcribing', finished_at = ?, chunk_count = ? WHERE id = ? AND status = 'recording'").run(d.now(), n, m.id)
  d.poke()
  return { status: 'transcribing' }
}

const iso = (ms: number): string => new Date(ms).toISOString()

export function listMeetings(d: MeetingDeps, accountId: string): unknown[] {
  const rows = d.db.prepare('SELECT id, title, status, created_at, duration_ms FROM meetings WHERE account_id = ? ORDER BY created_at DESC, id').all(accountId) as unknown as MeetingRow[]
  return rows.map((r) => ({ meeting_id: r.id, title: r.title, status: r.status, created_at: iso(r.created_at), duration_ms: r.duration_ms }))
}

export function getMeeting(d: MeetingDeps, accountId: string, rawId: string): Record<string, unknown> {
  const m = ownMeeting(d, accountId, rawId)
  const chunks = d.db.prepare('SELECT seq, status, duration_ms FROM meeting_chunks WHERE meeting_id = ? ORDER BY seq').all(m.id) as Array<{ seq: number; status: ChunkStatus; duration_ms: number }>
  return {
    meeting_id: m.id,
    title: m.title,
    status: m.status,
    created_at: iso(m.created_at),
    duration_ms: m.duration_ms,
    chunks: chunks.map((c) => ({ seq: c.seq, status: c.status, duration_ms: c.duration_ms })),
    error_code: m.error_code
  }
}

export function getTranscript(d: MeetingDeps, accountId: string, rawId: string): Record<string, unknown> {
  const m = ownMeeting(d, accountId, rawId)
  if (m.status !== 'ready' || m.transcript === null) throw new HttpError(409, 'not_ready', 'Transcript is not ready')
  const t = JSON.parse(m.transcript) as { language: string | null; segments: Segment[]; text: string }
  return { meeting_id: m.id, language: t.language, segments: t.segments, text: t.text }
}

/** Deletes rows first (so the worker can no longer write to them), then the audio files. */
export function deleteMeeting(d: MeetingDeps, accountId: string, rawId: string): void {
  const m = ownMeeting(d, accountId, rawId)
  const names = (d.db.prepare('SELECT audio_name FROM meeting_chunks WHERE meeting_id = ? AND audio_name IS NOT NULL').all(m.id) as Array<{ audio_name: string }>).map(
    (r) => r.audio_name
  )
  d.db.prepare('DELETE FROM meetings WHERE id = ? AND account_id = ?').run(m.id, accountId)
  for (const n of names) removeAudio(d.audioDir, n)
}

// ---------------------------------------------------------------- retention

/** Deletes audio older than 24 h (marking still-pending chunks failed) and unreferenced files. Returns files removed. */
export function sweepAudio(db: Db, audioDir: string, now: number): number {
  let removed = 0
  const old = db
    .prepare('SELECT id, audio_name, status FROM meeting_chunks WHERE audio_name IS NOT NULL AND created_at <= ?')
    .all(now - AUDIO_MAX_AGE_MS) as Array<{ id: number; audio_name: string; status: ChunkStatus }>
  for (const r of old) {
    db.prepare(
      "UPDATE meeting_chunks SET audio_name = NULL, status = CASE WHEN status IN ('queued', 'transcribing') THEN 'failed' ELSE status END, error_code = CASE WHEN status IN ('queued', 'transcribing') THEN 'audio_expired' ELSE error_code END, updated_at = ? WHERE id = ?"
    ).run(now, r.id)
    removeAudio(audioDir, r.audio_name)
    removed++
  }
  // Files the DB no longer references (crash between write and insert, account deleted mid-way, …).
  let entries: string[] = []
  try {
    entries = readdirSync(audioDir)
  } catch {
    return removed
  }
  const known = new Set((db.prepare('SELECT audio_name FROM meeting_chunks WHERE audio_name IS NOT NULL').all() as Array<{ audio_name: string }>).map((r) => r.audio_name))
  for (const e of entries) {
    if (!AUDIO_NAME_RE.test(e) || known.has(e)) continue
    try {
      if (statSync(join(audioDir, e)).isFile()) {
        unlinkSync(join(audioDir, e))
        removed++
      }
    } catch {
      /* ignore */
    }
  }
  return removed
}

/** Deletes meetings 7 d after ready/failed, or 7 d after creation if they never reached a terminal state. */
export function purgeMeetings(db: Db, audioDir: string, now: number): number {
  const cutoff = now - TRANSCRIPT_RETENTION_MS
  const ids = (db.prepare('SELECT id FROM meetings WHERE COALESCE(ended_at, created_at) <= ?').all(cutoff) as Array<{ id: string }>).map((r) => r.id)
  for (const id of ids) {
    const names = (db.prepare('SELECT audio_name FROM meeting_chunks WHERE meeting_id = ? AND audio_name IS NOT NULL').all(id) as Array<{ audio_name: string }>).map((r) => r.audio_name)
    db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
    for (const n of names) removeAudio(audioDir, n)
  }
  // Old usage rows are only needed for today's budget.
  db.prepare('DELETE FROM stt_usage WHERE day < ?').run(utcDay(now - 2 * 24 * 3600 * 1000))
  return ids.length
}

// ---------------------------------------------------------------- worker

export interface SttDrainStats {
  done: number
  retried: number
  failed: number
  assembled: number
}

interface ClaimRow {
  id: number
  meeting_id: string
  seq: number
  content_type: string
  duration_ms: number
  audio_name: string | null
  attempts: number
}

export interface SttWorkerDeps {
  db: Db
  now: () => number
  stt: SttAdapter | null
  audioDir: string
  concurrency?: number
  intervalMs?: number
}

/**
 * DB-backed transcription queue (same shape as the mail outbox):
 * - chunks are claimed atomically (queued → transcribing), at most `concurrency` in flight;
 * - ≤ MAX_ATTEMPTS attempts, retry after RETRY_BACKOFF_MS (a drain never re-claims what it just failed);
 * - the chunk's audio file is deleted after success or terminal failure;
 * - a finished meeting whose chunks are all terminal is assembled into ready / failed;
 * - every write is conditional on the row still existing, so a meeting deleted mid-transcription stays deleted.
 */
export class SttWorker {
  private readonly d: SttWorkerDeps
  private readonly concurrency: number
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private running: Promise<SttDrainStats> | null = null
  private again = false
  private ac = new AbortController()

  constructor(d: SttWorkerDeps) {
    this.d = d
    this.concurrency = Math.max(1, d.concurrency ?? 2)
    this.intervalMs = d.intervalMs ?? 2000
    // Crash recovery: chunks left "transcribing" by a previous process are retried.
    d.db.prepare("UPDATE meeting_chunks SET status = 'queued' WHERE status = 'transcribing'").run()
  }

  start(): void {
    if (this.timer || !this.d.stt) return
    this.ac = new AbortController()
    this.timer = setInterval(() => this.poke(), this.intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.again = false
    this.ac.abort()
    if (this.running) await this.running.catch(() => undefined)
  }

  poke(): void {
    if (!this.timer) return
    if (this.running) {
      this.again = true
      return
    }
    void this.drain()
      .catch(() => undefined)
      .then(() => {
        if (this.again && this.timer) {
          this.again = false
          this.poke()
        }
      })
  }

  /** Transcribes everything currently due and assembles finished meetings. Concurrent callers share one drain. */
  drain(): Promise<SttDrainStats> {
    if (this.running) return this.running
    this.running = this.drainOnce().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async drainOnce(): Promise<SttDrainStats> {
    const stats: SttDrainStats = { done: 0, retried: 0, failed: 0, assembled: 0 }
    if (this.d.stt) {
      for (;;) {
        // After stop() nothing is claimed (aborted claims are re-queued unchanged, so this also prevents a tight loop).
        if (this.ac.signal.aborted) break
        const rows = this.claim()
        if (rows.length === 0) break
        await Promise.all(rows.map((r) => this.process(r, stats)))
      }
    }
    stats.assembled += this.assembleAll()
    return stats
  }

  private claim(): ClaimRow[] {
    return this.d.db
      .prepare(
        `UPDATE meeting_chunks SET status = 'transcribing', updated_at = ? WHERE id IN (
           SELECT id FROM meeting_chunks WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?)
         RETURNING id, meeting_id, seq, content_type, duration_ms, audio_name, attempts`
      )
      .all(this.d.now(), this.d.now(), this.concurrency) as unknown as ClaimRow[]
  }

  private terminal(r: ClaimRow, status: 'done' | 'failed', attempts: number, errorCode: string | null, result: SttResult | null): void {
    // Conditional on the row still being ours: a DELETE in the meantime wins.
    this.d.db
      .prepare("UPDATE meeting_chunks SET status = ?, attempts = ?, error_code = ?, result = ?, audio_name = NULL, updated_at = ? WHERE id = ? AND status = 'transcribing'")
      .run(status, attempts, errorCode, result ? JSON.stringify(result) : null, this.d.now(), r.id)
    removeAudio(this.d.audioDir, r.audio_name)
  }

  private async process(r: ClaimRow, stats: SttDrainStats): Promise<void> {
    const attempts = r.attempts + 1
    let audio: Buffer
    try {
      if (!r.audio_name) throw new Error('no audio')
      audio = readFileSync(audioPath(this.d.audioDir, r.audio_name))
    } catch {
      this.terminal(r, 'failed', attempts, 'audio_missing', null)
      stats.failed++
      return
    }
    const meeting = this.d.db.prepare('SELECT language_hints FROM meetings WHERE id = ?').get(r.meeting_id) as { language_hints: string } | undefined
    if (!meeting) {
      // Deleted between claim and now: nothing to write back, just make sure the file is gone.
      removeAudio(this.d.audioDir, r.audio_name)
      return
    }
    try {
      const result = await this.d.stt!.transcribe(
        { audio, contentType: r.content_type, durationMs: r.duration_ms, seq: r.seq, languageHints: JSON.parse(meeting.language_hints) as string[] },
        this.ac.signal
      )
      this.terminal(r, 'done', attempts, null, sanitize(result, r.duration_ms))
      stats.done++
    } catch (err) {
      const e = err instanceof SttError ? err : new SttError('stt_unavailable', false)
      if (e.code === 'aborted') {
        // Shutdown: give the claim back without spending an attempt.
        this.d.db.prepare("UPDATE meeting_chunks SET status = 'queued' WHERE id = ? AND status = 'transcribing'").run(r.id)
        return
      }
      if (e.permanent || attempts >= MAX_ATTEMPTS) {
        this.terminal(r, 'failed', attempts, e.code, null)
        stats.failed++
      } else {
        this.d.db
          .prepare("UPDATE meeting_chunks SET status = 'queued', attempts = ?, error_code = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'transcribing'")
          .run(attempts, e.code, this.d.now() + RETRY_BACKOFF_MS, this.d.now(), r.id)
        stats.retried++
      }
    }
  }

  /** Assembles every finished meeting whose chunks are all terminal. Returns how many. */
  assembleAll(): number {
    const db = this.d.db
    const ready = db
      .prepare(
        `SELECT m.id FROM meetings m WHERE m.status = 'transcribing' AND NOT EXISTS (
           SELECT 1 FROM meeting_chunks c WHERE c.meeting_id = m.id AND c.status NOT IN ('done', 'failed'))`
      )
      .all() as Array<{ id: string }>
    for (const { id } of ready) assemble(db, id, this.d.now())
    return ready.length
  }
}

/** Clamps adapter output into the chunk's [0, duration] window and drops junk. */
function sanitize(r: SttResult, durationMs: number): SttResult {
  const segments: Segment[] = []
  for (const s of r.segments) {
    if (typeof s.text !== 'string' || s.text.trim() === '') continue
    const start = Math.max(0, Math.min(durationMs, Math.round(Number(s.start_ms) || 0)))
    const end = Math.max(start, Math.min(durationMs, Math.round(Number(s.end_ms) || 0)))
    segments.push({ start_ms: start, end_ms: end, speaker: typeof s.speaker === 'string' ? s.speaker : null, text: s.text })
  }
  segments.sort((a, b) => a.start_ms - b.start_ms)
  return { language: typeof r.language === 'string' ? r.language : null, segments }
}

function assemble(db: Db, meetingId: string, now: number): void {
  const chunks = db
    .prepare('SELECT seq, status, duration_ms, error_code, result FROM meeting_chunks WHERE meeting_id = ? ORDER BY seq')
    .all(meetingId) as Array<{ seq: number; status: ChunkStatus; duration_ms: number; error_code: string | null; result: string | null }>
  const failed = chunks.find((c) => c.status === 'failed')
  db.exec('BEGIN IMMEDIATE')
  try {
    if (failed) {
      db.prepare("UPDATE meetings SET status = 'failed', error_code = ?, ended_at = ? WHERE id = ? AND status = 'transcribing'").run(failed.error_code ?? 'stt_failed', now, meetingId)
    } else {
      const segments: Segment[] = []
      const langs = new Map<string, number>()
      let offset = 0
      for (const c of chunks) {
        const r = c.result ? (JSON.parse(c.result) as SttResult) : { language: null, segments: [] }
        if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1)
        for (const s of r.segments) segments.push({ start_ms: offset + s.start_ms, end_ms: offset + s.end_ms, speaker: s.speaker, text: s.text })
        offset += c.duration_ms
      }
      let language: string | null = null
      let best = 0
      for (const [l, n] of langs) if (n > best) [language, best] = [l, n]
      const transcript = { language, segments, text: segments.map((s) => s.text).join('\n') }
      db.prepare("UPDATE meetings SET status = 'ready', transcript = ?, error_code = NULL, ended_at = ? WHERE id = ? AND status = 'transcribing'").run(JSON.stringify(transcript), now, meetingId)
    }
    // Per-chunk results are now redundant (and the transcript lives in exactly one place).
    db.prepare('UPDATE meeting_chunks SET result = NULL WHERE meeting_id = ?').run(meetingId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
