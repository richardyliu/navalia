// S1-01: read the Runtime's gate-drop counters via `persome delta-report --json-out <tmp>`.
// Read-only, zero-LLM CLI (personal-model src/persome/cli.py `delta_report`). Lens never opens
// index.db itself. Only counts leave main: the rows' `payload` (memory content) is discarded.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactForDisplay } from '../import/redact'
import { tr } from '../../shared/i18n'

/** Reason code → count. Present only when the Runtime itemizes drops (schema 2026-11-05.3+, MOD-07). */
export type DropReasonCounts = Record<string, number>

export interface DeltaReportCounts {
  aggregate: { rows: number; sessions: number; dropped_by_gates: number; drop_reasons?: DropReasonCounts }
  recent: Array<{ session_id: string; created_at: string | null; status: string | null; dropped: number; drop_reasons?: DropReasonCounts }>
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number }
) => Promise<void>

/** Error surfaced to the renderer: fixed text + redacted stderr tail; never the command line. */
export class DeltaReportError extends Error {}

const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      const tail = redactForDisplay(String(stderr ?? '')).slice(-2000).trim()
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
      reject(
        new DeltaReportError(
          tr(
            `persome delta-report failed (${code ?? 'exit'})${tail ? `: ${tail}` : ''}`,
            `persome delta-report 失败（${code ?? 'exit'}）${tail ? `：${tail}` : ''}`
          )
        )
      )
    })
  })

const TMP_PREFIX = 'lens-delta-'
const STALE_MS = 10 * 60_000

/** Remove report dirs left behind by a crash or force-quit (they can hold memory payloads). */
export function sweepStaleDeltaDirs(tmpRoot: string = os.tmpdir(), now: number = Date.now()): number {
  let removed = 0
  let names: string[] = []
  try {
    names = fs.readdirSync(tmpRoot)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue
    const full = path.join(tmpRoot, name)
    try {
      const st = fs.lstatSync(full)
      if (!st.isDirectory() || st.uid !== process.getuid?.() || now - st.mtimeMs < STALE_MS) continue
      fs.rmSync(full, { recursive: true, force: true })
      removed++
    } catch {
      // best effort
    }
  }
  return removed
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

const REASON_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/

/** `{reason: count}` → same, keeping only machine-code reasons and non-negative integer counts. */
function reasonCounts(value: unknown): DropReasonCounts {
  const out: DropReasonCounts = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [k, v] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (REASON_CODE_RE.test(k) && int(v) > 0) out[k] = int(v)
  }
  return out
}

/** `[{head, index, reason, summary}]` → `{reason: count}`. `summary` (memory content) is discarded. */
function itemReasonCounts(value: unknown): DropReasonCounts {
  const counts: DropReasonCounts = {}
  if (!Array.isArray(value)) return counts
  for (const item of value) {
    const reason = typeof item === 'object' && item !== null ? (item as { reason?: unknown }).reason : undefined
    if (typeof reason === 'string' && REASON_CODE_RE.test(reason)) counts[reason] = (counts[reason] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Keep only counters and row metadata; drop everything else (notably `payload` and drop `summary`).
 * Runtime 2026-11-05.3 itemizes drops; their reason codes are kept as counts, only when present.
 */
export function trimDeltaReport(json: unknown): DeltaReportCounts {
  const root = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
  const agg = typeof root.aggregate === 'object' && root.aggregate !== null ? (root.aggregate as Record<string, unknown>) : null
  if (!agg || typeof agg.dropped_by_gates !== 'number') throw new Error(tr('delta-report output is missing aggregate.dropped_by_gates', 'delta-report 输出缺少 aggregate.dropped_by_gates'))
  const recent = Array.isArray(root.recent) ? root.recent : []
  return {
    aggregate: {
      rows: int(agg.rows),
      sessions: int(agg.sessions),
      dropped_by_gates: int(agg.dropped_by_gates),
      ...('drop_reasons' in agg ? { drop_reasons: reasonCounts(agg.drop_reasons) } : {})
    },
    recent: recent
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map((row) => ({
        session_id: String(row.session_id ?? ''),
        created_at: strOrNull(row.created_at),
        status: strOrNull(row.status),
        dropped: int(row.dropped),
        ...('drop_reasons' in row ? { drop_reasons: itemReasonCounts(row.drop_reasons) } : {})
      }))
  }
}

export async function readDeltaReport(
  bin: string | null,
  runtimeRoot: string,
  limit: number,
  exec: ExecFn = defaultExec
): Promise<DeltaReportCounts> {
  if (!bin) throw new Error(tr('persome command not found; cannot read drop counts', '没有找到 persome 命令，无法读取丢弃计数'))
  sweepStaleDeltaDirs()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX))
  const out = path.join(dir, 'report.json')
  try {
    await exec(bin, ['delta-report', '--limit', String(limit), '--json-out', out], {
      env: { ...process.env, PERSOME_ROOT: runtimeRoot },
      timeout: 20_000
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(out, 'utf8'))
    } catch {
      throw new DeltaReportError(tr('persome delta-report wrote no parseable JSON', 'persome delta-report 没有写出可解析的 JSON'))
    }
    return trimDeltaReport(parsed)
  } catch (error) {
    if (error instanceof DeltaReportError) throw error
    // Never forward raw errors (they can carry the command line or config values).
    const detail = redactForDisplay(error instanceof Error ? error.message : String(error)).slice(-500)
    throw new DeltaReportError(tr(`Reading drop counts failed: ${detail}`, `读取丢弃计数失败：${detail}`))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
