import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { redactText } from '../redact'

export type Json = Record<string, unknown>
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
import { SUMMARY_MAX, type AgentSignal, type WarningCounts } from '../types'

/**
 * Read-only helpers shared by transcript adapters. Nothing in this directory may write
 * to the filesystem; `tests/het/readonly.test.ts` enforces that statically.
 * Files are opened O_RDONLY|O_NOFOLLOW, must be regular files (fstat), and reads are
 * capped at MAX_READ_BYTES per call (security finding #8).
 */

export function bump(w: WarningCounts, code: string, n = 1): void {
  w[code] = (w[code] ?? 0) + n
}

export function mergeWarnings(into: WarningCounts, from: WarningCounts): void {
  for (const [k, v] of Object.entries(from)) bump(into, k, v)
}

/** Redact (see ../redact.ts), collapse whitespace, truncate. Redaction runs on the raw text first. */
export function shortSummary(text: string, max = SUMMARY_MAX): string {
  // Bound work on huge inputs before regexes run; the result is truncated anyway.
  let s = redactText(text.length > 20_000 ? text.slice(0, 20_000) : text)
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

export function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000
  if (typeof v !== 'string' || v.length < 10) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * Project key from cwd. Strips agent worktree suffixes so a worktree session lands on
 * the same project as its parent checkout.
 */
export function projectKeyFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd || typeof cwd !== 'string') return null
  let p = cwd.replace(/\/+$/, '')
  p = p.replace(/\/\.claude\/worktrees\/[^/]+$/, '')
  p = p.replace(/\/\.worktrees\/[^/]+$/, '')
  return p || null
}

/** Content-free git/PR signals from a shell command string. */
export function shellSignals(cmd: string): AgentSignal[] {
  const out: AgentSignal[] = []
  if (/\bgit\s+(-C\s+\S+\s+)?commit\b/.test(cmd)) out.push('git_commit')
  if (/\bgit\s+(-C\s+\S+\s+)?push\b/.test(cmd)) out.push('git_push')
  if (/\bgh\s+pr\s+create\b/.test(cmd)) out.push('pr_create')
  return out
}

/** Recursively list `*.jsonl` under root. Missing root → []. */
export function listJsonl(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

export const MAX_READ_BYTES = 64 * 1024 * 1024

export type ReadErrorCode = 'file_too_large' | 'not_regular_file' | 'file_unreadable'
export class TranscriptReadError extends Error {
  constructor(readonly code: ReadErrorCode) {
    super(code)
  }
}

function openRegularReadOnly(p: string): { fd: number; size: number } {
  let fd: number
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new TranscriptReadError('file_unreadable') // includes ELOOP for symlinks
  }
  const st = fstatSync(fd)
  if (!st.isFile()) {
    closeSync(fd)
    throw new TranscriptReadError('not_regular_file')
  }
  return { fd, size: st.size }
}

function readAt(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length)
  let got = 0
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, start + got)
    if (n === 0) break
    got += n
  }
  return buf.subarray(0, got)
}

/** Whole-file read for one-shot adapters. Throws TranscriptReadError (file_too_large above cap). */
export function readTextReadOnly(p: string, maxBytes = MAX_READ_BYTES): string {
  const { fd, size } = openRegularReadOnly(p)
  try {
    if (size > maxBytes) throw new TranscriptReadError('file_too_large')
    return readAt(fd, 0, size).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export interface RangeRead {
  /** Complete lines only (ends at the last '\n' read). */
  text: string
  /** Byte offset just after the last complete line. */
  endOffset: number
  size: number
  /** False when the cap stopped the read before EOF. */
  complete: boolean
  /** The ≤64 bytes ending at endOffset (rewrite detection on the next call). */
  tail: Buffer
  /** Rows skipped because a single line exceeded `maxBytes` (counted as `line_too_large`). */
  skippedRows: number
}

/** Bytes ending at `offset` — compared against a stored tail to detect rewrites. */
export function readTailReadOnly(p: string, offset: number, len = 64): Buffer | null {
  try {
    const { fd } = openRegularReadOnly(p)
    try {
      const start = Math.max(0, offset - len)
      return readAt(fd, start, offset - start)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Read complete lines from `start`, at most `maxBytes`. Partial trailing line stays unread. */
export function readLinesFrom(p: string, start: number, maxBytes = MAX_READ_BYTES): RangeRead {
  const { fd, size } = openRegularReadOnly(p)
  try {
    const want = Math.max(0, Math.min(size - start, maxBytes))
    const buf = readAt(fd, start, want)
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl < 0 && start + want < size) {
      // One line longer than the cap: skip to just past its newline without keeping it.
      let pos = start + want
      while (pos < size) {
        const chunk = readAt(fd, pos, Math.min(1 << 20, size - pos))
        const nl = chunk.indexOf(0x0a)
        if (nl >= 0) {
          const endOffset = pos + nl + 1
          return { text: '', endOffset, size, complete: endOffset >= size, tail: readAt(fd, Math.max(0, endOffset - 64), Math.min(64, endOffset)), skippedRows: 1 }
        }
        pos += chunk.length
        if (chunk.length === 0) break
      }
      // no newline until EOF: an incomplete (still being written) line; wait for more data
      return { text: '', endOffset: start, size, complete: true, tail: readAt(fd, Math.max(0, start - 64), Math.min(64, start)), skippedRows: 0 }
    }
    const usable = lastNl < 0 ? 0 : lastNl + 1
    const endOffset = start + usable
    const tailStart = Math.max(0, usable - 64)
    const tail =
      usable >= 64 || start === 0 ? Buffer.from(buf.subarray(tailStart, usable)) : readAt(fd, Math.max(0, endOffset - 64), Math.min(64, endOffset))
    return { text: buf.subarray(0, usable).toString('utf8'), endOffset, size, complete: start + want >= size, tail, skippedRows: 0 }
  } finally {
    closeSync(fd)
  }
}

/**
 * Pin every event's `project` to its session's launch project (earliest non-sidechain
 * event with a cwd). Agents `cd` into subdirectories or sibling repos mid-session; raw cwd
 * fragmented 119 of 719 real Claude sessions across 106 keys (2026-11-04 aggregate spike).
 * Raw `cwd` stays on each event. Returns a new array; input is not mutated.
 */
export function pinSessionProject<E extends { agent: string; sessionId: string; ts: number; cwd: string | null; project: string | null; sidechain: boolean }>(
  events: E[]
): E[] {
  const launch = new Map<string, { ts: number; project: string; side: boolean }>()
  for (const e of events) {
    if (!e.project) continue
    const k = `${e.agent}\u0000${e.sessionId}`
    const cur = launch.get(k)
    const better = !cur || (cur.side && !e.sidechain) || (cur.side === e.sidechain && e.ts < cur.ts)
    if (better) launch.set(k, { ts: e.ts, project: e.project, side: e.sidechain })
  }
  return events.map((e) => {
    const l = launch.get(`${e.agent}\u0000${e.sessionId}`)
    return l && l.project !== e.project ? { ...e, project: l.project } : e
  })
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)]
}
