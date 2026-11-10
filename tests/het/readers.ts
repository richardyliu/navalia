// Whole-directory transcript readers used by the HET tests. Production reads incrementally via
// src/main/het/sources.ts; these walk a root once and parse every file with the same parsers.
import { statSync } from 'node:fs'
import { bump, listJsonl, pinSessionProject, readTextReadOnly, TranscriptReadError } from '../../src/main/het/adapters/common'
import { CLAUDE_PROJECTS_ROOT, parseClaudeTranscript } from '../../src/main/het/adapters/claudeCode'
import { CODEX_SESSIONS_ROOT, parseCodexRollout } from '../../src/main/het/adapters/codex'
import { segmentDetailed, type SegmenterInput, type SegmenterOptions } from '../../src/main/het/segmenter'
import type { AdapterResult, AgentEvent, HetTask, WarningCounts } from '../../src/main/het/types'

export interface ReadOptions {
  root?: string
  /** Skip files whose mtime is older than this (epoch ms). */
  modifiedSinceMs?: number
}

function fileMtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function readAll(root: string, opts: ReadOptions, warnings: WarningCounts, parse: (text: string, file: string) => { events: AgentEvent[]; lines: number }) {
  const events: AgentEvent[] = []
  let files = 0
  let lines = 0
  for (const f of listJsonl(root)) {
    if (opts.modifiedSinceMs !== undefined && fileMtimeMs(f) < opts.modifiedSinceMs) continue
    let text: string
    try {
      text = readTextReadOnly(f)
    } catch (e) {
      bump(warnings, e instanceof TranscriptReadError ? e.code : 'file_unreadable')
      continue
    }
    files++
    const r = parse(text, f)
    lines += r.lines
    for (const e of r.events) events.push(e)
  }
  return { files, lines, events: pinSessionProject(events) }
}

/** Walk and parse all Claude Code transcripts under root. Read-only. */
export function readClaudeProjects(opts: ReadOptions = {}): AdapterResult {
  const warnings: WarningCounts = {}
  const titles: Record<string, string> = {}
  const customTitles = new Set<string>()
  const r = readAll(opts.root ?? CLAUDE_PROJECTS_ROOT, opts, warnings, (text, f) => parseClaudeTranscript(text, f, titles, warnings, customTitles))
  return { agent: 'claude-code', ...r, sessionTitles: titles, warnings }
}

/** Walk and parse all Codex rollouts under root. Read-only. */
export function readCodexSessions(opts: ReadOptions = {}): AdapterResult {
  const warnings: WarningCounts = {}
  const r = readAll(opts.root ?? CODEX_SESSIONS_ROOT, opts, warnings, (text, f) => parseCodexRollout(text, f, warnings))
  return { agent: 'codex', ...r, sessionTitles: {}, warnings }
}

export function segment(input: SegmenterInput, now: number, options: Partial<SegmenterOptions> = {}): HetTask[] {
  return segmentDetailed(input, now, options).map((d) => d.task)
}
