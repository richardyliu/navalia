import type { AttendedWindow } from './types'

/**
 * Runtime timeline → attended windows.
 *
 * What the OSS runtime (personal-model) exposes, checked read-only 2026-11-04:
 *  - REST: no timeline endpoint (only `/status` reports a block count / last end).
 *  - MCP `attention_trajectory({since?, until?, hours?})` → JSON
 *    `{ by_dwell: [...], trajectory: [{surface, rung, start, end, dwell_minutes}], window }`
 *    (src/persome/mcp/server.py, src/persome/timeline/attention_trajectory.py).
 *    Populated only for blocks captured after the attention-locus pipeline shipped.
 *  - MCP `current_context()` → `recent_timeline_blocks` (last ~8 one-minute blocks).
 *  - SQLite `timeline_blocks(start_time, end_time, ...)` in Runtime `index.db` — Lens must
 *    not read/write Runtime schema directly, so this is not used.
 *
 * Main is expected to call `attention_trajectory` over MCP (existing `getMcp()` client)
 * for the segmenting window and pass the parsed JSON here. Both mappers are pure.
 */

const toMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

export function attendedFromTrajectory(payload: unknown): AttendedWindow[] {
  const obj = typeof payload === 'string' ? safeParse(payload) : payload
  if (typeof obj !== 'object' || obj === null) return []
  const traj = (obj as { trajectory?: unknown }).trajectory
  if (!Array.isArray(traj)) return []
  const out: AttendedWindow[] = []
  for (const s of traj) {
    if (typeof s !== 'object' || s === null) continue
    const r = s as Record<string, unknown>
    const start = toMs(r.start)
    const end = toMs(r.end)
    if (start === null || end === null || end < start) continue
    out.push({ start, end, surface: typeof r.surface === 'string' ? r.surface : undefined })
  }
  return out
}

/** For `{start_time, end_time}` block lists (e.g. `current_context().recent_timeline_blocks`). */
export function attendedFromBlocks(blocks: unknown): AttendedWindow[] {
  if (!Array.isArray(blocks)) return []
  const out: AttendedWindow[] = []
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue
    const r = b as Record<string, unknown>
    const start = toMs(r.start_time ?? r.start)
    const end = toMs(r.end_time ?? r.end)
    if (start === null || end === null || end < start) continue
    out.push({ start, end })
  }
  return out
}

/** Sort + coalesce overlapping/touching windows. */
export function unionWindows(ws: AttendedWindow[]): Array<{ start: number; end: number }> {
  const s = ws.map((w) => ({ start: w.start, end: w.end })).sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = []
  for (const w of s) {
    const last = out[out.length - 1]
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end)
    else out.push({ ...w })
  }
  return out
}

export function overlapMs(union: Array<{ start: number; end: number }>, start: number, end: number): number {
  let total = 0
  for (const w of union) {
    if (w.end <= start) continue
    if (w.start >= end) break
    total += Math.min(end, w.end) - Math.max(start, w.start)
  }
  return total
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
