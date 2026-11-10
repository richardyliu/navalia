import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentEvent, AgentRole, AgentSignal, WarningCounts } from '../types'
import {
  bump,
  parseTs,
  projectKeyFromCwd,
  shellSignals,
  shortSummary,
  uniq,
  isObj,
  str,
  type Json
} from './common'

/**
 * Read-only adapter for Codex CLI rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 *
 * FORMAT PROVENANCE: built from public knowledge of the open-source Codex CLI rollout
 * recorder, NOT from a real local file (`~/.codex` does not exist on the dev machine).
 * Real-run fidelity is UNKNOWN until a real rollout is parsed.
 *
 * Supported shapes:
 *  - Current: every line is `{timestamp, type, payload}` with type in
 *    `session_meta | turn_context | response_item | event_msg | compacted`.
 *    `response_item.payload.type` in `message | reasoning | function_call |
 *    function_call_output | custom_tool_call | custom_tool_call_output | local_shell_call |
 *    web_search_call`.
 *  - Legacy (early 2025): first line `{id, timestamp, instructions?, git?}`, then bare
 *    response items `{type: 'message' | 'function_call' | ...}` and `{record_type: 'state'}`.
 *    Legacy items carry no per-line timestamp → dropped and counted (`codex_legacy_no_ts`).
 */

export const CODEX_SESSIONS_ROOT = join(homedir(), '.codex', 'sessions')

const KNOWN_TOP = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted'])
const KNOWN_ITEMS = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'local_shell_call',
  'web_search_call'
])

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** Paths named in an apply_patch envelope (`*** Add|Update|Delete File: <path>`, `*** Move to:`). */
export function patchPaths(patch: string): string[] {
  const out: string[] = []
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(patch))) out.push((m[1] ?? m[2]).trim())
  return uniq(out)
}

function isInjectedCodexUserText(t: string): boolean {
  const s = t.trimStart()
  return (
    s.startsWith('<environment_context>') ||
    s.startsWith('<user_instructions>') ||
    s.startsWith('# AGENTS.md') ||
    s.startsWith('<turn_aborted>')
  )
}

/** Parse a shell command from function_call arguments (JSON string) or local_shell_call action. */
function shellCommand(v: unknown): string | null {
  let obj: unknown = v
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!isObj(obj)) return null
  const c = obj.command
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join(' ')
  return str(c)
}

interface SessionState {
  sessionId: string
  cwd: string | null
}

export interface CodexParseResult {
  events: AgentEvent[]
  lines: number
  sessionId: string
}

export function parseCodexRollout(text: string, file: string, warnings: WarningCounts = {}): CodexParseResult {
  const fallbackId = UUID_RE.exec(basename(file))?.[1] ?? basename(file)
  const st: SessionState = { sessionId: fallbackId, cwd: null }
  const events: AgentEvent[] = []
  const rows = text.split('\n')
  let lines = 0

  const emit = (
    ts: number,
    role: AgentRole,
    summary: string,
    extra: Partial<Pick<AgentEvent, 'toolNames' | 'filesWritten' | 'filesRead' | 'signals'>>,
    line: number
  ): void => {
    events.push({
      agent: 'codex',
      sessionId: st.sessionId,
      ts,
      cwd: st.cwd,
      project: projectKeyFromCwd(st.cwd),
      role,
      toolNames: extra.toolNames ?? [],
      filesWritten: extra.filesWritten ?? [],
      filesRead: extra.filesRead ?? [],
      signals: uniq(extra.signals ?? []),
      summary: shortSummary(summary),
      sidechain: false,
      source: { file, line }
    })
  }

  const handleItem = (item: Json, ts: number | null, line: number): void => {
    const it = str(item.type) ?? '?'
    if (!KNOWN_ITEMS.has(it)) {
      bump(warnings, `codex_unknown_item:${it.slice(0, 40)}`)
      return
    }
    if (it === 'reasoning') return // never summarised
    if (ts === null) {
      bump(warnings, 'codex_legacy_no_ts')
      return
    }
    if (it === 'message') {
      const role = str(item.role)
      const parts = Array.isArray(item.content) ? item.content : []
      const texts = parts
        .filter(isObj)
        .map((p) => str(p.text) ?? '')
        .filter((t) => t.trim())
      const joined = texts.join(' ')
      if (role === 'user') {
        const injected = texts.length > 0 && texts.every(isInjectedCodexUserText)
        emit(ts, injected ? 'system' : 'user', injected ? 'harness context' : joined, {}, line)
      } else if (role === 'assistant') emit(ts, 'assistant', joined, {}, line)
      else emit(ts, 'system', 'harness context', {}, line) // developer / system
      return
    }
    if (it === 'function_call' || it === 'local_shell_call') {
      const name = str(item.name) ?? (it === 'local_shell_call' ? 'local_shell' : '?')
      const cmd = shellCommand(it === 'local_shell_call' && isObj(item.action) ? item.action : item.arguments)
      const signals: AgentSignal[] = cmd ? shellSignals(cmd) : []
      // Older CLIs run apply_patch through the shell tool.
      const written = cmd && /\bapply_patch\b/.test(cmd) ? patchPaths(cmd.replace(/^.*?apply_patch\s*/s, '')) : []
      emit(ts, 'assistant', `tools: ${name}`, { toolNames: [name], signals, filesWritten: written }, line)
      return
    }
    if (it === 'custom_tool_call') {
      const name = str(item.name) ?? '?'
      const input = str(item.input) ?? ''
      const written = name === 'apply_patch' ? patchPaths(input) : []
      emit(ts, 'assistant', `tools: ${name}`, { toolNames: [name], filesWritten: written }, line)
      return
    }
    if (it === 'web_search_call') {
      emit(ts, 'assistant', 'tools: web_search', { toolNames: ['web_search'] }, line)
      return
    }
    // function_call_output / custom_tool_call_output
    let isErr = false
    const out = item.output
    const parsed = typeof out === 'string' ? safeJson(out) : out
    if (isObj(parsed) && isObj(parsed.metadata) && typeof parsed.metadata.exit_code === 'number') {
      isErr = parsed.metadata.exit_code !== 0
    }
    emit(ts, 'tool_result', isErr ? 'tool result (error)' : 'tool result', { signals: isErr ? ['tool_error'] : [] }, line)
  }

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    if (!raw.trim()) continue
    lines++
    let o: unknown
    try {
      o = JSON.parse(raw)
    } catch {
      bump(warnings, 'json_parse')
      continue
    }
    if (!isObj(o)) {
      bump(warnings, 'non_object_line')
      continue
    }
    const line = i + 1
    const top = str(o.type)

    // Current format: {timestamp, type, payload}
    if (top && KNOWN_TOP.has(top) && 'payload' in o) {
      const ts = parseTs(o.timestamp)
      const p = isObj(o.payload) ? o.payload : {}
      if (top === 'session_meta') {
        const meta = isObj(p.meta) ? p.meta : p // some versions nest under `meta`
        const id = str(meta.id)
        if (id) st.sessionId = id
        const cwd = str(meta.cwd)
        if (cwd) st.cwd = cwd
      } else if (top === 'turn_context') {
        const cwd = str(p.cwd)
        if (cwd) st.cwd = cwd
      } else if (top === 'response_item') {
        handleItem(p, ts, line)
      }
      // event_msg duplicates response items (user_message/agent_message) or is
      // telemetry (token_count); compacted carries a summary we do not need.
      continue
    }

    // Legacy header: {id, timestamp, ...} without type.
    if (!top && str(o.id) && 'timestamp' in o && i < 3) {
      st.sessionId = str(o.id) ?? st.sessionId
      continue
    }
    if (!top && 'record_type' in o) continue
    if (top && KNOWN_ITEMS.has(top)) {
      handleItem(o, parseTs(o.timestamp), line)
      continue
    }
    bump(warnings, `codex_unknown_type:${(top ?? 'none').slice(0, 40)}`)
  }
  return { events, lines, sessionId: st.sessionId }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
