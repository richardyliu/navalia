import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ensureSecureDir, FILE_MODE } from '../store/paths'
import path from 'node:path'
import type { AccessLogDay, AccessLogPreview, AccessLogRow, AuditOutcome } from './api'

/**
 * Access log store (`audit.db`, node:sqlite).
 *
 * Original semantics: every successful context read is logged, including empty results
 * (client, capability, items, count, response chars). Lens additionally records denied and
 * failed calls (`outcome` != 'ok'); the UI hides those by default.
 */

export const PREVIEW_CHARS = 500
/** Original "typing time" conversion: response characters / 300 per minute. */
export const TYPING_CHARS_PER_MINUTE = 300

export interface AuditInput {
  grantId: string | null
  client: string
  capability: string
  argsSha256: string
  argsPreview: string
  itemIds: string[]
  itemCount: number
  responseChars: number
  resultPreview: string
  outcome: AuditOutcome
  httpStatus: number
  errorCode: string | null
  durationMs: number
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function clip(text: string, max = PREVIEW_CHARS): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

export interface AuditLog {
  record(input: AuditInput): void
  /** Rows of the last `days` days, newest first, WITHOUT previews. Successful reads only unless includeFailures. */
  list(options?: { days?: number; includeFailures?: boolean; limit?: number }): AccessLogRow[]
  /** argumentsPreview / resultPreview of one row (on expand only). */
  preview(id: number): AccessLogPreview | null
  /** Per local day and client: successful reads + response chars. Safe fields only (no previews). */
  daily(days?: number): AccessLogDay[]
  /** Successful reads by one client in the last `days` days (usage_report). Safe fields only. */
  usage(client: string, days?: number): { reads: number; responseChars: number; byCapability: Record<string, number> }
  /** Delete every row. Grants and agent configs are not touched. Returns rows removed. */
  clear(): number
  close(): void
}

export function openAuditLog(file: string, now: () => Date = () => new Date()): AuditLog {
  ensureSecureDir(path.dirname(file))
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', FILE_MODE))
  fs.chmodSync(file, FILE_MODE)
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      day TEXT NOT NULL,
      grant_id TEXT,
      client TEXT NOT NULL,
      capability TEXT NOT NULL,
      args_sha256 TEXT NOT NULL,
      args_preview TEXT NOT NULL,
      item_ids TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      response_chars INTEGER NOT NULL,
      result_preview TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','unauthorized','error')),
      http_status INTEGER NOT NULL,
      error_code TEXT,
      duration_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS access_log_day ON access_log(day, client);
  `)

  const insert = db.prepare(`INSERT INTO access_log
    (ts, day, grant_id, client, capability, args_sha256, args_preview, item_ids, item_count, response_chars,
     result_preview, outcome, http_status, error_code, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

  function sinceDay(days: number): string {
    const d = now()
    d.setDate(d.getDate() - (Math.max(1, Math.min(days, 366)) - 1))
    return localDay(d)
  }

  return {
    record(input) {
      const t = now()
      insert.run(
        t.toISOString(),
        localDay(t),
        input.grantId,
        input.client,
        input.capability,
        input.argsSha256,
        clip(input.argsPreview),
        JSON.stringify(input.itemIds.slice(0, 200)),
        input.itemCount,
        input.responseChars,
        clip(input.resultPreview),
        input.outcome,
        input.httpStatus,
        input.errorCode,
        input.durationMs
      )
    },

    list(options = {}) {
      const rows = db
        .prepare(
          `SELECT id, ts, day, grant_id, client, capability, item_ids, item_count, response_chars, outcome, http_status,
             error_code, duration_ms FROM access_log WHERE day >= ? ${options.includeFailures ? '' : "AND outcome = 'ok'"}
           ORDER BY id DESC LIMIT ?`
        )
        .all(sinceDay(options.days ?? 30), Math.max(1, Math.min(options.limit ?? 500, 5000))) as Array<Record<string, unknown>>
      return rows.map((r) => ({
        id: Number(r.id),
        ts: String(r.ts),
        day: String(r.day),
        grantId: (r.grant_id as string | null) ?? null,
        client: String(r.client),
        capability: String(r.capability),
        itemIds: JSON.parse(String(r.item_ids)) as string[],
        itemCount: Number(r.item_count),
        responseChars: Number(r.response_chars),
        outcome: String(r.outcome) as AuditOutcome,
        httpStatus: Number(r.http_status),
        errorCode: (r.error_code as string | null) ?? null,
        durationMs: Number(r.duration_ms)
      }))
    },

    preview(id) {
      const r = db.prepare('SELECT id, args_preview, result_preview FROM access_log WHERE id = ?').get(id) as
        | { id: number; args_preview: string; result_preview: string }
        | undefined
      return r ? { id: Number(r.id), argumentsPreview: String(r.args_preview), resultPreview: String(r.result_preview) } : null
    },

    daily(days = 30) {
      const rows = db
        .prepare(
          `SELECT day, client, COUNT(*) AS reads, SUM(response_chars) AS chars FROM access_log
           WHERE day >= ? AND outcome = 'ok' GROUP BY day, client ORDER BY day, client`
        )
        .all(sinceDay(days)) as Array<{ day: string; client: string; reads: number; chars: number }>
      return rows.map((r) => ({ day: r.day, client: r.client, reads: Number(r.reads), responseChars: Number(r.chars ?? 0) }))
    },

    usage(client, days = 30) {
      const rows = db
        .prepare(
          `SELECT capability, COUNT(*) AS reads, SUM(response_chars) AS chars FROM access_log
           WHERE day >= ? AND outcome = 'ok' AND client = ? GROUP BY capability`
        )
        .all(sinceDay(days), client) as Array<{ capability: string; reads: number; chars: number }>
      const byCapability: Record<string, number> = {}
      let reads = 0
      let responseChars = 0
      for (const r of rows) {
        byCapability[r.capability] = Number(r.reads)
        reads += Number(r.reads)
        responseChars += Number(r.chars ?? 0)
      }
      return { reads, responseChars, byCapability }
    },

    clear() {
      const r = db.prepare('DELETE FROM access_log').run()
      return Number(r.changes)
    },

    close() {
      db.close()
    }
  }
}
