import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { CLAUDE_PROJECTS_ROOT, parseClaudeTranscript } from './adapters/claudeCode'
import { CODEX_SESSIONS_ROOT, parseCodexRollout } from './adapters/codex'
import {
  listJsonl,
  MAX_READ_BYTES,
  mergeWarnings,
  pinSessionProject,
  readLinesFrom,
  readTailReadOnly,
  readTextReadOnly,
  TranscriptReadError
} from './adapters/common'
import type { SegmenterInput } from './segmenter'
import type { AgentEvent, WarningCounts } from './types'

/**
 * Incremental, read-only transcript source for the main-process tick.
 *
 * Claude Code transcripts are append-only JSONL, so each file is parsed from the last
 * consumed byte offset: only complete new lines are read, at most `maxBytesPerFile`
 * per refresh (a larger file continues on the next refresh, counted as `file_partial_read`).
 * A rewrite (mtime changed without growth, file shrank, or the 64 bytes before the stored
 * offset changed) triggers a full re-parse. Codex rollouts carry per-file session state, so they are re-read whole
 * when changed (capped → `file_too_large`). Yields to the event loop between files.
 */

interface FileEntry {
  mtimeMs: number
  size: number
  offset: number
  rows: number
  tail: Buffer
  events: AgentEvent[]
  titles: Record<string, string>
  customTitles: Set<string>
  warnings: WarningCounts
}

export interface TranscriptSource {
  /** Rejects with `HetAbortError` at the next file boundary once `signal` aborts; the cache stays consistent. */
  refresh(signal?: AbortSignal): Promise<SegmenterInput & { warnings: WarningCounts; files: number; reparsed: number; partial: number }>
}

export class HetAbortError extends Error {
  constructor() {
    super('het_tick_aborted')
  }
}

export const CLAUDE_ROOT_ENV = 'LENS_HET_CLAUDE_ROOT'
export const CODEX_ROOT_ENV = 'LENS_HET_CODEX_ROOT'

/**
 * Transcript roots from env (E2E harness): unset → default root; empty string → source
 * disabled (null); otherwise the path (`~` expanded, resolved).
 */
export function hetRootsFromEnv(env: NodeJS.ProcessEnv = process.env): { claudeRoot: string | null; codexRoot: string | null } {
  const pick = (v: string | undefined, def: string): string | null => {
    if (v === undefined) return def
    const t = v.trim()
    if (!t) return null
    return resolve(t === '~' ? homedir() : t.startsWith('~/') ? homedir() + t.slice(1) : t)
  }
  return { claudeRoot: pick(env[CLAUDE_ROOT_ENV], CLAUDE_PROJECTS_ROOT), codexRoot: pick(env[CODEX_ROOT_ENV], CODEX_SESSIONS_ROOT) }
}

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))
const freshEntry = (): FileEntry => ({
  mtimeMs: -1,
  size: -1,
  offset: 0,
  rows: 0,
  tail: Buffer.alloc(0),
  events: [],
  titles: {},
  customTitles: new Set(),
  warnings: {}
})

export function createTranscriptSource(
  /** A root of `null` disables that source; `undefined` uses the default. */
  opts: { claudeRoot?: string | null; codexRoot?: string | null; maxBytesPerFile?: number } = {}
): TranscriptSource {
  const claudeRoot = opts.claudeRoot === undefined ? CLAUDE_PROJECTS_ROOT : opts.claudeRoot
  const codexRoot = opts.codexRoot === undefined ? CODEX_SESSIONS_ROOT : opts.codexRoot
  const cap = opts.maxBytesPerFile ?? MAX_READ_BYTES
  const cache = new Map<string, FileEntry>()

  function claudeStep(f: string, size: number, mtimeMs: number, e: FileEntry): { entry: FileEntry; partial: boolean } {
    let entry = e
    // Append-only JSONL: we only get here when mtime or size changed. No new bytes ⇒ rewrite;
    // shrink ⇒ rewrite; changed bytes just before the consumed offset ⇒ rewrite. (A rewrite
    // that also grows and leaves the last 64 consumed bytes intact is not detected.)
    const rewritten =
      size <= entry.offset && entry.offset > 0
        ? true
        : entry.offset > 0 && !(readTailReadOnly(f, entry.offset, entry.tail.length)?.equals(entry.tail) ?? false)
    if (rewritten) entry = freshEntry()
    const r = readLinesFrom(f, entry.offset, cap)
    const consumedRows = r.text ? r.text.split('\n').length - 1 : 0
    parseClaudeTranscript(r.text, f, entry.titles, entry.warnings, entry.customTitles, entry.rows).events.forEach((ev) =>
      entry.events.push(ev)
    )
    entry.offset = r.endOffset
    entry.rows += consumedRows + r.skippedRows
    if (r.skippedRows) entry.warnings.line_too_large = (entry.warnings.line_too_large ?? 0) + r.skippedRows
    if (r.text || r.skippedRows) entry.tail = r.tail
    entry.size = r.complete ? size : -1 // force another read next refresh when capped
    entry.mtimeMs = mtimeMs
    return { entry, partial: !r.complete }
  }

  function codexStep(f: string, size: number, mtimeMs: number): FileEntry {
    const entry = freshEntry()
    entry.size = size
    entry.mtimeMs = mtimeMs
    entry.events = parseCodexRollout(readTextReadOnly(f, cap), f, entry.warnings).events
    return entry
  }

  async function scan(
    root: string | null,
    kind: 'claude' | 'codex',
    seen: Set<string>,
    signal?: AbortSignal
  ): Promise<{ reparsed: number; partial: number }> {
    let reparsed = 0
    let partial = 0
    if (root === null) return { reparsed, partial }
    for (const f of listJsonl(root)) {
      if (signal?.aborted) throw new HetAbortError()
      seen.add(f)
      let st
      try {
        st = statSync(f)
      } catch {
        continue
      }
      const prev = cache.get(f) ?? freshEntry()
      if (prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue
      try {
        if (kind === 'claude') {
          const r = claudeStep(f, st.size, st.mtimeMs, prev)
          cache.set(f, r.entry)
          if (r.partial) {
            partial++
            r.entry.warnings.file_partial_read = 1
          } else delete r.entry.warnings.file_partial_read
        } else cache.set(f, codexStep(f, st.size, st.mtimeMs))
      } catch (e) {
        const entry = freshEntry()
        entry.size = st.size
        entry.mtimeMs = st.mtimeMs
        entry.warnings[e instanceof TranscriptReadError ? e.code : 'file_unreadable'] = 1
        cache.set(f, entry)
      }
      reparsed++
      await yieldLoop()
    }
    return { reparsed, partial }
  }

  return {
    async refresh(signal) {
      const seen = new Set<string>()
      const a = await scan(claudeRoot, 'claude', seen, signal)
      const b = await scan(codexRoot, 'codex', seen, signal)
      for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k)
      const files = [...cache.keys()].sort()
      const events: AgentEvent[] = []
      const titles: Record<string, string> = {}
      const custom = new Set<string>()
      const warnings: WarningCounts = {}
      for (const f of files) {
        const e = cache.get(f)!
        for (const ev of e.events) events.push(ev)
        for (const sid of e.customTitles) custom.add(sid)
        mergeWarnings(warnings, e.warnings)
      }
      for (const f of files) {
        const e = cache.get(f)!
        for (const [sid, t] of Object.entries(e.titles)) {
          if (custom.has(sid) ? e.customTitles.has(sid) : !(sid in titles)) titles[sid] = t
        }
      }
      return {
        events: pinSessionProject(events),
        sessionTitles: titles,
        warnings,
        files: cache.size,
        reparsed: a.reparsed + b.reparsed,
        partial: a.partial + b.partial
      }
    }
  }
}
