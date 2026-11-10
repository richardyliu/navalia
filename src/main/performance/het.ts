// S1-FULL C16: read-only access to het.db for the owner-only 「表现」 counts.
//
// - Opened with `readOnly: true` per call and closed right after; Lens never writes het.db from here
//   (the HET service in src/main/het/** owns all writes). A missing file is not created.
// - Queries use fixed SQL with bound parameters only.
// - "Unknown" (null) vs 0: het.db missing / unreadable / with no HET task at all means HET has not
//   seen any agent session, so the counts are unknown, not 0.
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tr } from '../../shared/i18n'
import type { SqlDb } from '../het/schema'
import { dayIn } from '../het/tz'
import type { EvidenceRef, PerformanceRow, SourceState } from './api'

export interface HetReadResult<T> {
  state: SourceState
  value: T | null
}

/** Opens het.db read-only, runs `fn`, closes. Never creates the file. */
export function withHetDb<T>(file: string, fn: (db: SqlDb) => T): HetReadResult<T> {
  if (!file || !fs.existsSync(file)) return { state: { state: 'unknown', reason: tr('Not connected: no het.db yet (HET has not run)', '未接入：还没有 het.db（HET 还没有运行过）') }, value: null }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const hasTasks = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='het_tasks'").get()
    if (!hasTasks) return { state: { state: 'unknown', reason: tr('Not connected: het.db has no HET tables yet', '未接入：het.db 里还没有 HET 表') }, value: null }
    const n = (db.prepare('SELECT COUNT(*) AS n FROM het_tasks').get() as { n: number }).n
    if (Number(n) === 0) return { state: { state: 'unknown', reason: tr('Not connected: HET has not read any Claude Code / Codex sessions yet', '未接入：HET 还没有读到任何 Claude Code / Codex 会话') }, value: null }
    return { state: { state: 'ok', detail: tr(`het.db: ${Number(n)} HET tasks`, `het.db：${Number(n)} 个 HET 任务`) }, value: fn(db) }
  } catch {
    return { state: { state: 'unknown', reason: tr('Unknown: failed to read het.db', '未知：het.db 读取失败') }, value: null }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

/** `~/…` when under home, else the path as stored. */
export function displayPath(file: string, home: string | null): string {
  if (home && (file === home || file.startsWith(home.endsWith('/') ? home : `${home}/`))) return `~${file.slice(home.replace(/\/+$/, '').length)}`
  return file
}

const parseIds = (raw: unknown): string[] => {
  try {
    const v = JSON.parse(String(raw)) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : []
  } catch {
    return []
  }
}

function firstEvidence(db: SqlDb, taskId: string, home: string | null): EvidenceRef | null {
  const r = db.prepare('SELECT source_file, source_line FROM het_evidence WHERE task_id = ? ORDER BY ts_ms ASC, source_line ASC LIMIT 1').get(taskId) as
    | { source_file: string; source_line: number }
    | undefined
  return r ? { file: displayPath(r.source_file, home), line: Number(r.source_line) } : null
}

export type CorrectionKind = 'accepted' | 'rejected' | 'not_agent'

/**
 * Tasks whose CURRENT correction is `kind`, counted at the time of the latest `corrected` event that
 * set that action (falls back to the task end when no audit event exists). Window [start, end).
 */
export function correctionRows(db: SqlDb, kind: CorrectionKind, start: number, end: number, tz: string, home: string | null): PerformanceRow[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.agent, t.project, t.session_ids, t.end_ms,
              (SELECT MAX(e.at_ms) FROM het_events e
                WHERE e.task_id = t.id AND e.kind = 'corrected' AND json_extract(e.payload, '$.action') = t.correction) AS corrected_ms
         FROM het_tasks t
        WHERE t.correction = ?`
    )
    .all(kind) as Array<{ id: string; agent: string; project: string | null; session_ids: string; end_ms: number; corrected_ms: number | null }>
  const out: PerformanceRow[] = []
  for (const r of rows) {
    const at = r.corrected_ms ?? r.end_ms
    if (at < start || at >= end) continue
    out.push({
      kind,
      id: r.id,
      at: new Date(at).toISOString(),
      day: dayIn(at, tz),
      atSource: r.corrected_ms !== null ? 'corrected_at' : 'task_end',
      agent: r.agent,
      taskId: r.id,
      sessionIds: parseIds(r.session_ids),
      project: r.project,
      evidence: firstEvidence(db, r.id, home),
      commit: null
    })
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
}

/** Raw transcript commit events (absolute source path kept for the hash lookup, main only). */
export interface TranscriptCommitRaw {
  row: PerformanceRow
  absFile: string
  line: number
}

/** het_evidence events carrying the `git_commit` signal, by event time, window [start, end). */
export function transcriptCommitRows(db: SqlDb, start: number, end: number, tz: string, home: string | null, projectPrefixes?: string[]): TranscriptCommitRaw[] {
  const rows = db
    .prepare(
      `SELECT ev.task_id, ev.event_id, ev.ts_ms, ev.source_file, ev.source_line, t.agent, t.project, t.session_ids
         FROM het_evidence ev JOIN het_tasks t ON t.id = ev.task_id
        WHERE ev.ts_ms >= ? AND ev.ts_ms < ?
          AND EXISTS (SELECT 1 FROM json_each(ev.signals) WHERE json_each.value = 'git_commit')
        ORDER BY ev.ts_ms DESC, ev.event_id DESC`
    )
    .all(start, end) as Array<{ task_id: string; event_id: string; ts_ms: number; source_file: string; source_line: number; agent: string; project: string | null; session_ids: string }>
  const out: TranscriptCommitRaw[] = []
  for (const r of rows) {
    if (projectPrefixes && !projectPrefixes.some((p) => r.project !== null && pathUnder(r.project, p))) continue
    out.push({
      absFile: r.source_file,
      line: Number(r.source_line),
      row: {
        kind: 'transcript_commit',
        id: r.event_id,
        at: new Date(r.ts_ms).toISOString(),
        day: dayIn(r.ts_ms, tz),
        atSource: 'event_time',
        agent: r.agent,
        taskId: r.task_id,
        sessionIds: parseIds(r.session_ids),
        project: r.project,
        evidence: { file: displayPath(r.source_file, home), line: Number(r.source_line) },
        commit: { hash: null, hashSource: null, repo: null, subject: null }
      }
    })
  }
  return out
}

/** True when `p` equals `prefix` or lies under it (path-segment aware). */
export function pathUnder(p: string, prefix: string): boolean {
  const a = p.replace(/\/+$/, '')
  const b = prefix.replace(/\/+$/, '')
  return b.length > 0 && (a === b || a.startsWith(`${b}/`))
}

export interface HetTaskHit {
  id: string
  agent: string
  project: string | null
  title: string | null
  endMs: number
  sessionIds: string[]
  evidence: EvidenceRef | null
  matchedBy: string
}

/** HET tasks ending in [start, end) whose project is under one of `paths` or whose title contains a keyword. */
export function matchingTasks(db: SqlDb, start: number, end: number, paths: string[], keywords: string[], home: string | null): HetTaskHit[] {
  const rows = db
    .prepare('SELECT id, agent, project, title, end_ms, session_ids FROM het_tasks WHERE end_ms >= ? AND end_ms < ? ORDER BY end_ms DESC LIMIT 2000')
    .all(start, end) as Array<{ id: string; agent: string; project: string | null; title: string | null; end_ms: number; session_ids: string }>
  const kws = keywords.map((k) => k.toLowerCase())
  const out: HetTaskHit[] = []
  for (const r of rows) {
    let matchedBy: string | null = null
    const pathHit = r.project ? paths.find((p) => pathUnder(r.project as string, p)) : undefined
    if (pathHit) matchedBy = `path:${pathHit}`
    else if (r.title) {
      const t = r.title.toLowerCase()
      const k = kws.find((x) => x && t.includes(x))
      if (k) matchedBy = `keyword:${k}`
    }
    if (!matchedBy) continue
    out.push({
      id: r.id,
      agent: r.agent,
      project: r.project,
      title: r.title,
      endMs: r.end_ms,
      sessionIds: parseIds(r.session_ids),
      evidence: firstEvidence(db, r.id, home),
      matchedBy
    })
  }
  return out
}
