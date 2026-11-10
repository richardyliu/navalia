import { createHash } from 'node:crypto'
import { chmodSync, closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ensureDefaultAnchors, getAnchors, minutesTenths, type AdoptionLevel, type AnchorKind, type Complexity, type SizeBucket } from './anchors'
import type { HetActivity, HetPanelState, HetPeriod, HetPeriodCounts, HetSummary, HetTaskDto, HetWaitingKey } from './api'
import type { AssessorEvidence, Verdict } from './assessor'
import { migrateHet, type SqlDb } from './schema'
import { dayIn, daysBetween, lastDays, systemTimeZone } from './tz'
import type { AgentEvent, AgentSignal, HetCorrection, HetLedgerStatus, HetTask } from './types'

/**
 * het.db ledger. All writes go through this module. Persisted per task: shape/aggregates,
 * verdict (no minutes from the model), anchor-derived minutes, correction, bounded evidence.
 */

/** Owner-only modes for het.db and its WAL/SHM side files (security finding #4). */
export function secureDbFiles(file: string): void {
  if (file === ':memory:') return
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(f, 0o600)
    } catch {
      // side file not created yet
    }
  }
}

export function openHetDb(file: string, now: number): DatabaseSync {
  if (file !== ':memory:') closeSync(openSync(file, 'a', 0o600)) // create 0600 before SQLite does
  secureDbFiles(file)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  migrateHet(db)
  ensureDefaultAnchors(db, now)
  secureDbFiles(file) // WAL/SHM exist after the first write
  return db
}

export function eventId(e: AgentEvent): string {
  return 'ev_' + createHash('sha256').update(`${e.agent}\u0000${e.sessionId}\u0000${e.source.file}\u0000${e.source.line}`).digest('hex').slice(0, 16)
}

export function fingerprint(t: HetTask): string {
  return createHash('sha256')
    .update(
      JSON.stringify([t.project, t.start, t.end, t.sessionIds, t.stats, t.filesWritten, t.signals])
    )
    .digest('hex')
    .slice(0, 24)
}

/** Deterministic bounded evidence selection: signals > writes > human turns > final reply. */
export function selectEvidence(events: AgentEvent[], cap: number): AgentEvent[] {
  const prio = (e: AgentEvent, i: number): number => {
    if (e.signals.length) return 0
    if (e.filesWritten.length) return 1
    if (e.role === 'user' && !e.sidechain) return 2
    if (i === lastAssistant) return 3
    return 9
  }
  let lastAssistant = -1
  events.forEach((e, i) => {
    if (e.role === 'assistant' && !e.sidechain) lastAssistant = i
  })
  const picked = events
    .map((e, i) => ({ e, i, p: prio(e, i) }))
    .filter((x) => x.p < 9)
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .slice(0, cap)
    .sort((a, b) => a.i - b.i)
  return picked.map((x) => x.e)
}

// ── rows ─────────────────────────────────────────────────────────────────────

export interface TaskRow {
  id: string
  agent: string
  project: string | null
  title: string | null
  start_ms: number
  end_ms: number
  status: HetLedgerStatus
  kind: string
  complexity: Complexity | null
  size: SizeBucket | null
  agent_share: number | null
  adoption: 'strong' | 'weak' | 'unknown' | null
  adoption_evidence: string | null
  minutes_tenths: number | null
  anchor_version: number | null
  correction: HetCorrection | null
  fingerprint: string
  session_ids: string
  stats: string
  files_written: string
  signals: string
  attended_ms: number | null
  attempts: number
  last_attempt_ms: number | null
  last_error: string | null
}

const getRow = (db: SqlDb, id: string): TaskRow | undefined =>
  db.prepare('SELECT * FROM het_tasks WHERE id = ?').get(id) as TaskRow | undefined

function audit(db: SqlDb, taskId: string, now: number, kind: string, actor: 'tick' | 'assessor' | 'user', payload: object = {}): void {
  db.prepare('INSERT INTO het_events (task_id, at_ms, kind, actor, payload) VALUES (?, ?, ?, ?, ?)').run(
    taskId,
    now,
    kind,
    actor,
    JSON.stringify(payload)
  )
}

export function inTx<T>(db: SqlDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ── upsert from segmenter ───────────────────────────────────────────────────

export type UpsertOutcome = 'inserted' | 'settled' | 'updated' | 'reopened' | 'unchanged'

export function upsertTask(
  db: SqlDb,
  task: HetTask,
  events: AgentEvent[],
  opts: { now: number; persistSummaries: boolean; evidencePerTask: number }
): UpsertOutcome {
  const fp = fingerprint(task)
  const row = getRow(db, task.id)
  const nextStatus: HetLedgerStatus = task.status === 'settled' ? 'needs_assessment' : 'unsettled'
  const title = opts.persistSummaries ? task.title : null

  const writeEvidence = (): void => {
    db.prepare('DELETE FROM het_evidence WHERE task_id = ?').run(task.id)
    const ins = db.prepare(
      `INSERT OR IGNORE INTO het_evidence (task_id, event_id, ts_ms, role, tool_names, files_written, signals, summary, source_file, source_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const e of selectEvidence(events, opts.evidencePerTask)) {
      ins.run(
        task.id,
        eventId(e),
        e.ts,
        e.role,
        JSON.stringify([...new Set(e.toolNames)].slice(0, 10)),
        JSON.stringify(e.filesWritten.slice(0, 10)),
        JSON.stringify(e.signals),
        opts.persistSummaries ? e.summary.slice(0, 200) : '',
        e.source.file,
        e.source.line
      )
    }
  }

  if (!row) {
    db.prepare(
      `INSERT INTO het_tasks (id, agent, project, title, start_ms, end_ms, status, fingerprint, session_ids, stats,
         files_written, signals, attended_ms, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id,
      task.agent,
      task.project,
      title,
      task.start,
      task.end,
      nextStatus,
      fp,
      JSON.stringify(task.sessionIds),
      JSON.stringify(task.stats),
      JSON.stringify(task.filesWritten),
      JSON.stringify(task.signals),
      task.attendedMs,
      opts.now,
      opts.now
    )
    writeEvidence()
    audit(db, task.id, opts.now, 'segmented', 'tick', { status: nextStatus })
    return 'inserted'
  }

  if (row.fingerprint === fp) {
    // Side fields that do not change the task's shape.
    if (row.title !== title || row.attended_ms !== task.attendedMs) {
      db.prepare('UPDATE het_tasks SET title = ?, attended_ms = ?, updated_ms = ? WHERE id = ?').run(title, task.attendedMs, opts.now, task.id)
    }
    if (row.status === 'unsettled' && nextStatus === 'needs_assessment') {
      db.prepare("UPDATE het_tasks SET status = 'needs_assessment', updated_ms = ? WHERE id = ?").run(opts.now, task.id)
      audit(db, task.id, opts.now, 'settled', 'tick')
      return 'settled'
    }
    return 'unchanged'
  }

  // Shape changed (task grew / late event). If it had a verdict, supersede it.
  const hadVerdict = row.status === 'assessed' || row.status === 'failed' || row.adoption !== null
  db.prepare(
    `UPDATE het_tasks SET project = ?, title = ?, start_ms = ?, end_ms = ?, status = ?, fingerprint = ?, session_ids = ?,
       stats = ?, files_written = ?, signals = ?, attended_ms = ?, updated_ms = ?
       ${hadVerdict ? `, kind = 'unassessed', complexity = NULL, size = NULL, agent_share = NULL, adoption = NULL,
         adoption_evidence = NULL, minutes_tenths = NULL, anchor_version = NULL, attempts = 0, last_attempt_ms = NULL, last_error = NULL` : ''}
     WHERE id = ?`
  ).run(
    task.project,
    title,
    task.start,
    task.end,
    nextStatus,
    fp,
    JSON.stringify(task.sessionIds),
    JSON.stringify(task.stats),
    JSON.stringify(task.filesWritten),
    JSON.stringify(task.signals),
    task.attendedMs,
    opts.now,
    task.id
  )
  writeEvidence()
  if (hadVerdict) {
    audit(db, task.id, opts.now, 'reopened', 'tick', {
      superseded: {
        status: row.status,
        kind: row.kind,
        size: row.size,
        complexity: row.complexity,
        adoption: row.adoption,
        minutes_tenths: row.minutes_tenths,
        anchor_version: row.anchor_version
      },
      old_end: row.end_ms,
      new_end: task.end
    })
    return 'reopened'
  }
  audit(db, task.id, opts.now, 'updated', 'tick', { old_end: row.end_ms, new_end: task.end })
  return 'updated'
}

// ── minutes ──────────────────────────────────────────────────────────────────

export function effectiveAdoption(row: Pick<TaskRow, 'adoption' | 'correction'>): AdoptionLevel | null {
  if (row.correction === 'accepted') return 'confirmed'
  if (row.correction === 'rejected') return 'rejected'
  return row.adoption
}

function computeMinutes(db: SqlDb, row: TaskRow): number | null {
  if (row.status !== 'assessed' || row.anchor_version === null || !row.size || !row.complexity) return null
  if (row.correction === 'not_agent') return 0
  const adoption = effectiveAdoption(row)
  if (!adoption) return null
  const anchors = getAnchors(db, row.anchor_version)
  return minutesTenths({
    anchorMinutes: anchors[row.kind as AnchorKind].minutes,
    size: row.size,
    complexity: row.complexity,
    adoption
  })
}

export function applyVerdict(
  db: SqlDb,
  taskId: string,
  v: Verdict,
  anchorVersion: number,
  now: number,
  provenance: { client?: string | null; model?: string | null } = {}
): void {
  db.prepare(
    `UPDATE het_tasks SET status = 'assessed', kind = ?, size = ?, complexity = ?, agent_share = ?, adoption = ?,
       adoption_evidence = ?, anchor_version = ?, last_attempt_ms = ?, last_error = NULL, updated_ms = ? WHERE id = ?`
  ).run(v.kind, v.size, v.complexity, v.agent_share, v.adoption, JSON.stringify(v.evidence), anchorVersion, now, now, taskId)
  const row = getRow(db, taskId)!
  const m = computeMinutes(db, row)
  db.prepare('UPDATE het_tasks SET minutes_tenths = ? WHERE id = ?').run(m, taskId)
  audit(db, taskId, now, 'assessed', 'assessor', {
    verdict: v,
    anchor_version: anchorVersion,
    minutes_tenths: m,
    ...(provenance.client !== undefined || provenance.model !== undefined
      ? { client: provenance.client ?? null, model: provenance.model ?? null }
      : {})
  })
}

export function markNeedsAssessment(
  db: SqlDb,
  taskId: string,
  outcome: string,
  reason: string | undefined,
  countAttempt: boolean,
  maxAttempts: number,
  now: number
): HetLedgerStatus {
  const row = getRow(db, taskId)!
  const attempts = row.attempts + (countAttempt ? 1 : 0)
  const status: HetLedgerStatus = attempts >= maxAttempts ? 'failed' : 'needs_assessment'
  db.prepare('UPDATE het_tasks SET status = ?, attempts = ?, last_attempt_ms = ?, last_error = ?, updated_ms = ? WHERE id = ?').run(
    status,
    attempts,
    now,
    reason ? `${outcome}:${reason}` : outcome,
    now,
    taskId
  )
  audit(db, taskId, now, status === 'failed' ? 'failed' : 'needs_assessment', 'assessor', { outcome, reason, attempts })
  return status
}

/**
 * S1-02 gate: the assessor is not allowed to run (disabled / no transport / no budget).
 * Stamps the reason on every waiting task WITHOUT a transport call, an agent_calls row,
 * an attempt, or `last_attempt_ms` (so the task is picked up as soon as the gate opens).
 * Writes (and audits) only tasks whose reason actually changes. Returns rows changed.
 */
export function markGated(db: SqlDb, reason: string, now: number): number {
  const ids = db
    .prepare(
      `SELECT id FROM het_tasks
        WHERE status = 'needs_assessment' AND (correction IS NULL OR correction = 'accepted')
          AND (last_error IS NULL OR last_error != ?)`
    )
    .all(reason) as { id: string }[]
  const upd = db.prepare('UPDATE het_tasks SET last_error = ?, updated_ms = ? WHERE id = ?')
  for (const { id } of ids) {
    upd.run(reason, now, id)
    audit(db, id, now, 'needs_assessment', 'assessor', { outcome: reason.split(':')[0], reason, gated: true })
  }
  return ids.length
}

/** Re-derive minutes from stored verdict + correction + anchor version. Audited if changed. */
export function recompute(db: SqlDb, taskId: string, now: number, actor: 'tick' | 'user' = 'user'): number | null {
  const row = getRow(db, taskId)
  if (!row) throw new Error(`unknown task ${taskId}`)
  const after = computeMinutes(db, row)
  if (after !== row.minutes_tenths) {
    db.prepare('UPDATE het_tasks SET minutes_tenths = ?, updated_ms = ? WHERE id = ?').run(after, now, taskId)
    audit(db, taskId, now, 'recomputed', actor, { before: row.minutes_tenths, after })
  }
  return after
}

export const CORRECTIONS: readonly HetCorrection[] = ['accepted', 'rejected', 'not_agent']

/** User correction. Idempotent for a repeated identical action. */
export function correctTask(db: SqlDb, taskId: string, action: HetCorrection, now: number): { minutesTenths: number | null; changed: boolean } {
  if (!CORRECTIONS.includes(action)) throw new Error(`invalid correction ${String(action)}`)
  return inTx(db, () => {
    const row = getRow(db, taskId)
    if (!row) throw new Error(`unknown task ${taskId}`)
    if (row.correction === action) return { minutesTenths: row.minutes_tenths, changed: false }
    db.prepare('UPDATE het_tasks SET correction = ?, updated_ms = ? WHERE id = ?').run(action, now, taskId)
    audit(db, taskId, now, 'corrected', 'user', { action, before: row.correction, minutes_before: row.minutes_tenths })
    const after = recompute(db, taskId, now, 'user')
    return { minutesTenths: after, changed: true }
  })
}

/**
 * Undo a user correction (OG-08 / DEVIATIONS D17 reversible): correction → NULL, minutes
 * re-derived from the stored verdict + anchors. Audited as `corrected` with
 * `{ action: null, reverted: true }` (het_events.kind is CHECK-constrained; no migration needed).
 * Idempotent: no correction → `changed: false`, no audit row.
 */
export function revertCorrection(db: SqlDb, taskId: string, now: number): { minutesTenths: number | null; changed: boolean } {
  return inTx(db, () => {
    const row = getRow(db, taskId)
    if (!row) throw new Error(`unknown task ${taskId}`)
    if (row.correction === null) return { minutesTenths: row.minutes_tenths, changed: false }
    db.prepare('UPDATE het_tasks SET correction = NULL, updated_ms = ? WHERE id = ?').run(now, taskId)
    audit(db, taskId, now, 'corrected', 'user', { action: null, reverted: true, before: row.correction, minutes_before: row.minutes_tenths })
    const after = recompute(db, taskId, now, 'user')
    return { minutesTenths: after, changed: true }
  })
}

/**
 * HET-08 retry (reference §10.4 "pending / failed tasks are retried"): a user-initiated retry
 * moves `failed` tasks (not excluded by the user) back to `needs_assessment` with attempts
 * reset, so the NEXT tick may assess them within the same hard caps and gate. No assessor
 * call happens here; nothing loops. A quota/offline backoff (`assessor_blocked_until`) is
 * NOT cleared: retry never bypasses a stop. Returns the number of tasks re-queued.
 */
export function retryFailed(db: SqlDb, now: number): number {
  return inTx(db, () => {
    const ids = db
      .prepare("SELECT id FROM het_tasks WHERE status = 'failed' AND (correction IS NULL OR correction = 'accepted') ORDER BY id")
      .all() as { id: string }[]
    const upd = db.prepare(
      "UPDATE het_tasks SET status = 'needs_assessment', attempts = 0, last_attempt_ms = NULL, last_error = NULL, updated_ms = ? WHERE id = ?"
    )
    for (const { id } of ids) {
      upd.run(now, id)
      audit(db, id, now, 'needs_assessment', 'user', { outcome: 'retry', from: 'failed' })
    }
    return ids.length
  })
}

/** Tasks ending in [start, end) whose assessment completed (any correction). */
export function assessedBetween(db: SqlDb, start: number, end: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM het_tasks WHERE end_ms >= ? AND end_ms < ? AND status = 'assessed'").get(start, end) as { n: number }).n
}

// ── assessor queue ───────────────────────────────────────────────────────────

export function assessQueue(db: SqlDb, now: number, backoffMs: number, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM het_tasks
        WHERE status = 'needs_assessment'
          AND (correction IS NULL OR correction = 'accepted')
          AND (last_attempt_ms IS NULL OR last_attempt_ms + ? <= ?)
        ORDER BY attempts ASC, end_ms ASC, id ASC LIMIT ?`
    )
    .all(backoffMs, now, limit) as { id: string }[]
  return rows.map((r) => r.id)
}

export function taskForAssessor(db: SqlDb, id: string): { task: import('./assessor').AssessorTaskView; evidence: AssessorEvidence[] } {
  const r = getRow(db, id)!
  const ev = db
    .prepare('SELECT * FROM het_evidence WHERE task_id = ? ORDER BY ts_ms, source_file, source_line')
    .all(id) as Array<{ event_id: string; ts_ms: number; role: string; tool_names: string; files_written: string; signals: string; summary: string }>
  return {
    task: {
      id: r.id,
      agent: r.agent,
      project: r.project,
      title: r.title,
      start: r.start_ms,
      end: r.end_ms,
      stats: JSON.parse(r.stats),
      filesWritten: JSON.parse(r.files_written),
      signals: JSON.parse(r.signals) as AgentSignal[]
    },
    evidence: ev.map((e) => ({
      eventId: e.event_id,
      ts: e.ts_ms,
      role: e.role,
      toolNames: JSON.parse(e.tool_names),
      filesWritten: JSON.parse(e.files_written),
      signals: JSON.parse(e.signals),
      summary: e.summary
    }))
  }
}

export function recordCall(
  db: SqlDb,
  c: {
    taskId: string | null
    now: number
    day: string
    tickMs: number
    transport: string
    outcome: string
    inputChars: number
    outputChars: number
    /** X3: Runtime `[agent_funding]` client / model the call used (null when unknown). */
    client?: string | null
    model?: string | null
    /** X3: anchors version the verdict was converted with (only for outcome 'ok'). */
    anchorVersion?: number | null
  }
): void {
  db.prepare(
    `INSERT INTO agent_calls (task_id, at_ms, day, tick_ms, transport, outcome, input_chars, output_chars, client, model, anchor_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    c.taskId,
    c.now,
    c.day,
    c.tickMs,
    c.transport,
    c.outcome,
    c.inputChars,
    c.outputChars,
    c.client ?? null,
    c.model ?? null,
    c.anchorVersion ?? null
  )
}

/** Calls that reached a model (budget_unavailable never left Lens). */
export function callsOnDay(db: SqlDb, day: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_calls WHERE day = ? AND outcome != 'budget_unavailable'").get(day) as { n: number }).n
}

export function getMeta(db: SqlDb, key: string): string | null {
  const r = db.prepare('SELECT value FROM het_meta WHERE key = ?').get(key) as { value: string } | undefined
  return r ? r.value : null
}
export function setMeta(db: SqlDb, key: string, value: string): void {
  db.prepare('INSERT INTO het_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ── queries (reference §11.1 shapes, plain functions) ────────────────────────

/** Counted = assessed and not excluded by the user. Pending/failed never count (T-HET-02). */
const COUNTED_SQL = "status = 'assessed' AND (correction IS NULL OR correction NOT IN ('rejected','not_agent'))"

export function toDto(db: SqlDb, r: TaskRow, withEvidence: boolean): HetTaskDto {
  const counted = r.status === 'assessed' && r.correction !== 'rejected' && r.correction !== 'not_agent'
  const dto: HetTaskDto = {
    id: r.id,
    agent: r.agent,
    project: r.project,
    title: r.title,
    start: new Date(r.start_ms).toISOString(),
    end: new Date(r.end_ms).toISOString(),
    kind: r.kind,
    status: r.status,
    minutes: counted && r.minutes_tenths !== null ? r.minutes_tenths / 10 : null,
    minutes_tenths: counted ? r.minutes_tenths : null,
    adoption: effectiveAdoption(r),
    correction: r.correction,
    anchor_version: r.anchor_version,
    counted,
    signals: JSON.parse(r.signals),
    files_written: JSON.parse(r.files_written),
    stats: JSON.parse(r.stats),
    last_error: r.last_error
  }
  if (withEvidence) {
    const ev = db.prepare('SELECT * FROM het_evidence WHERE task_id = ? ORDER BY ts_ms, source_file, source_line').all(r.id) as Array<
      Record<string, string | number>
    >
    dto.evidence = ev.map((e) => ({
      event_id: String(e.event_id),
      ts: new Date(Number(e.ts_ms)).toISOString(),
      role: String(e.role),
      tools: JSON.parse(String(e.tool_names)),
      files: JSON.parse(String(e.files_written)),
      signals: JSON.parse(String(e.signals)),
      summary: String(e.summary),
      source: { file: String(e.source_file), line: Number(e.source_line) }
    }))
  }
  return dto
}

export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** GET /het/summary?days=N. Tasks attributed to the local day of their end. */
export function hetSummary(
  db: SqlDb,
  opts: { now: number; days?: number; timezone?: string; dayOf?: (ms: number) => string }
): HetSummary {
  const days = Math.min(Math.max(1, opts.days ?? 7), 366)
  const tz = opts.timezone ?? systemTimeZone()
  const dayOf = opts.dayOf ?? ((ms: number) => dayIn(ms, tz))
  let labels: string[]
  if (opts.dayOf) {
    labels = []
    for (let i = days - 1; i >= 0; i--) {
      const l = dayOf(opts.now - i * 86_400_000)
      if (!labels.includes(l)) labels.push(l)
    }
  } else labels = lastDays(opts.now, days, tz) // calendar math: DST-safe
  const buckets = new Map(labels.map((d) => [d, { date: d, minutes: 0, minutes_tenths: 0, tasks: 0, pending: 0 }]))
  const since = opts.now - days * 86_400_000 - 86_400_000
  const rows = db.prepare('SELECT * FROM het_tasks WHERE end_ms >= ?').all(since) as unknown as TaskRow[]
  let measured = false
  for (const r of rows) {
    const b = buckets.get(dayOf(r.end_ms))
    if (!b) continue
    if (r.status === 'assessed') measured = true
    const counted = r.status === 'assessed' && r.correction !== 'rejected' && r.correction !== 'not_agent'
    if (counted) {
      b.minutes_tenths += r.minutes_tenths ?? 0
      b.tasks++
    } else if (r.status === 'needs_assessment' && r.correction !== 'rejected' && r.correction !== 'not_agent') b.pending++
  }
  const out = [...buckets.values()].map((b) => ({ ...b, minutes: b.minutes_tenths / 10 }))
  const total = out.reduce((a, b) => a + b.minutes_tenths, 0)
  const count = (sql: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM het_tasks WHERE ${sql}`).get() as { n: number }).n
  const pending = count("status = 'needs_assessment' AND (correction IS NULL OR correction = 'accepted')")
  const failed = count("status = 'failed' AND (correction IS NULL OR correction = 'accepted')")
  const unsettled = count("status = 'unsettled'")
  const all = count('1=1')
  const state: HetPanelState =
    all === 0
      ? 'notStarted'
      : failed > 1
        ? 'manyFailed'
        : failed === 1
          ? 'oneFailed'
          : pending > 1
            ? 'manyPending'
            : pending === 1
              ? 'onePending'
              : unsettled > 0
                ? 'calculating'
                : 'ready'
  return { days: out, total_minutes: total / 10, total_minutes_tenths: total, pending, failed, unsettled, state, timezone: opts.dayOf ? null : tz, measured }
}

/** GET /het/tasks?limit=&include_activity= — newest first. */
export function hetTasks(db: SqlDb, opts: { limit?: number; includeActivity?: boolean } = {}): HetTaskDto[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 200)
  const rows = db.prepare('SELECT * FROM het_tasks ORDER BY end_ms DESC, id DESC LIMIT ?').all(limit) as unknown as TaskRow[]
  return rows.map((r) => toDto(db, r, !!opts.includeActivity))
}

export const encCursor = (end: number, id: string): string => Buffer.from(`${end}:${id}`).toString('base64url')
export function decCursor(c: string): { end: number; id: string } {
  const s = Buffer.from(c, 'base64url').toString('utf8')
  const i = s.indexOf(':')
  const end = Number(s.slice(0, i))
  if (i < 1 || !Number.isFinite(end)) throw new Error('invalid cursor')
  return { end, id: s.slice(i + 1) }
}

/** GET /het/period?start=&end=&cursor=&limit= — tasks ending in [start, end), newest first. */
export function hetPeriod(
  db: SqlDb,
  opts: { start: number; end: number; cursor?: string | null; limit?: number; includeActivity?: boolean; timezone?: string }
): HetPeriod {
  const tz = opts.timezone ?? systemTimeZone()
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200)
  const c = opts.cursor ? decCursor(opts.cursor) : null
  const rows = (
    c
      ? db
          .prepare(
            'SELECT * FROM het_tasks WHERE end_ms >= ? AND end_ms < ? AND (end_ms < ? OR (end_ms = ? AND id < ?)) ORDER BY end_ms DESC, id DESC LIMIT ?'
          )
          .all(opts.start, opts.end, c.end, c.end, c.id, limit + 1)
      : db.prepare('SELECT * FROM het_tasks WHERE end_ms >= ? AND end_ms < ? ORDER BY end_ms DESC, id DESC LIMIT ?').all(opts.start, opts.end, limit + 1)
  ) as unknown as TaskRow[]
  const page = rows.slice(0, limit)
  const total = (
    db.prepare(`SELECT COALESCE(SUM(minutes_tenths), 0) AS s FROM het_tasks WHERE end_ms >= ? AND end_ms < ? AND ${COUNTED_SQL}`).get(opts.start, opts.end) as {
      s: number
    }
  ).s
  const tasks = page.map((r) => ({ ...toDto(db, r, !!opts.includeActivity), day: dayIn(r.end_ms, tz) }))
  const EXCL = "correction IN ('rejected','not_agent')"
  const cnt = db
    .prepare(
      `SELECT COUNT(*) AS tasks,
              COALESCE(SUM(${COUNTED_SQL}), 0) AS counted,
              COALESCE(SUM(status = 'needs_assessment' AND NOT COALESCE(${EXCL}, 0)), 0) AS needs_assessment,
              COALESCE(SUM(status = 'unsettled' AND NOT COALESCE(${EXCL}, 0)), 0) AS unsettled,
              COALESCE(SUM(status = 'failed' AND NOT COALESCE(${EXCL}, 0)), 0) AS failed,
              COALESCE(SUM(COALESCE(${EXCL}, 0)), 0) AS excluded
         FROM het_tasks WHERE end_ms >= ? AND end_ms < ?`
    )
    .get(opts.start, opts.end) as Omit<HetPeriodCounts, 'waiting_by_reason'>
  const reasons = db
    .prepare(
      `SELECT CASE WHEN status = 'unsettled' THEN 'unsettled'
                   WHEN status = 'failed' THEN 'failed'
                   WHEN last_error IS NULL THEN 'queued'
                   ELSE substr(last_error, 1, instr(last_error || ':', ':') - 1) END AS k,
              COUNT(*) AS n
         FROM het_tasks
        WHERE end_ms >= ? AND end_ms < ? AND status != 'assessed' AND NOT COALESCE(${EXCL}, 0)
        GROUP BY k ORDER BY k`
    )
    .all(opts.start, opts.end) as Array<{ k: HetWaitingKey; n: number }>
  const counts: HetPeriodCounts = { ...cnt, waiting_by_reason: Object.fromEntries(reasons.map((r) => [r.k, r.n])) }
  return {
    start: new Date(opts.start).toISOString(),
    end: new Date(opts.end).toISOString(),
    tasks,
    next_cursor: rows.length > limit ? encCursor(page[page.length - 1].end_ms, page[page.length - 1].id) : null,
    total_minutes_tenths: total,
    total_minutes: total / 10,
    page_minutes_tenths: tasks.reduce((a, t) => a + (t.minutes_tenths ?? 0), 0),
    counts,
    timezone: tz,
    measured: assessedBetween(db, opts.start, opts.end) > 0
  }
}

// ── activity (Lens-defined shape; reference gives only the endpoint name) ────

export const ACTIVITY_MAX_DAYS = 92
export const ACTIVITY_MAX_MARKERS = 500

/**
 * GET /het/activity?start=&end=&timezone= equivalent. Tasks are attributed to the local day
 * (in `timezone`) of their END, like summary/period. Markers are tasks ending in range,
 * oldest first, capped at ACTIVITY_MAX_MARKERS (`markers_total` tells the true count).
 */
export function hetActivity(db: SqlDb, opts: { start: number; end: number; timezone?: string }): HetActivity {
  if (!(opts.end > opts.start)) throw new Error('activity: end must be after start')
  if (opts.end - opts.start > ACTIVITY_MAX_DAYS * 86_400_000) throw new Error(`activity: range exceeds ${ACTIVITY_MAX_DAYS} days`)
  const tz = opts.timezone ?? systemTimeZone()
  const labels = daysBetween(opts.start, opts.end, tz)
  const days = new Map(labels.map((d) => [d, { date: d, minutes_tenths: 0, minutes: 0, tasks: 0, pending: 0, unsettled: 0, by_agent: {} as Record<string, { minutes_tenths: number; tasks: number }> }]))
  const rows = db
    .prepare('SELECT * FROM het_tasks WHERE end_ms >= ? AND end_ms < ? ORDER BY start_ms ASC, id ASC')
    .all(opts.start, opts.end) as unknown as TaskRow[]
  const markers: HetActivity['markers'] = []
  let measured = false
  for (const r of rows) {
    if (r.status === 'assessed') measured = true
    const excluded = r.correction === 'rejected' || r.correction === 'not_agent'
    const counted = r.status === 'assessed' && !excluded
    const b = days.get(dayIn(r.end_ms, tz))
    if (b) {
      if (counted) {
        b.minutes_tenths += r.minutes_tenths ?? 0
        b.tasks++
        const a = (b.by_agent[r.agent] ??= { minutes_tenths: 0, tasks: 0 })
        a.minutes_tenths += r.minutes_tenths ?? 0
        a.tasks++
      } else if (!excluded && r.status === 'needs_assessment') b.pending++
      else if (!excluded && r.status === 'unsettled') b.unsettled++
    }
    if (markers.length < ACTIVITY_MAX_MARKERS)
      markers.push({
        id: r.id,
        agent: r.agent,
        start: new Date(r.start_ms).toISOString(),
        end: new Date(r.end_ms).toISOString(),
        status: r.status,
        counted,
        minutes_tenths: counted ? r.minutes_tenths : null
      })
  }
  const out = [...days.values()].map((d) => ({ ...d, minutes: d.minutes_tenths / 10 }))
  const total = out.reduce((a, d) => a + d.minutes_tenths, 0)
  return {
    start: new Date(opts.start).toISOString(),
    end: new Date(opts.end).toISOString(),
    timezone: tz,
    days: out,
    total_minutes_tenths: total,
    total_minutes: total / 10,
    markers,
    markers_total: rows.length,
    markers_truncated: rows.length > markers.length,
    measured
  }
}
