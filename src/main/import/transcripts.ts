import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseClaudeTranscript } from '../het/adapters/claudeCode'
import { parseCodexRollout } from '../het/adapters/codex'
import { patchPaths } from '../het/adapters/codex'
import { bump, listJsonl, MAX_READ_BYTES, readTextReadOnly, TranscriptReadError, isObj, str, type Json } from '../het/adapters/common'
import type { AgentEvent, WarningCounts } from '../het/types'
import type { ImportSource } from './api'

/**
 * Read-only transcript discovery + full-text extraction for import.
 *
 * Role classification (human prompt vs harness injection vs tool result), session ids, cwd →
 * project keys and timestamps come from the HET adapters. The adapters keep only a 200-char
 * summary per event, so full message text is re-read from the raw JSONL line the adapter
 * points at (`event.source.line`). Only text blocks of main-thread `user` / `assistant` events
 * are kept; tool results, thinking/reasoning, images and sidechains are dropped.
 *
 * Memory/latency bounds (security review S1-07 #1): files are processed ONE AT A TIME and the
 * caller yields to the event loop between files. `scanTranscripts` retains no text: only
 * per-session summaries (counts, ts range, title, file refs, short message hashes for dedupe).
 * Full text is materialised only by `loadSession`, for one selected session at a time.
 */

/**
 * S1-R3-06: one tool call reduced to what the optional 「工具调用摘要」 may show — the tool name,
 * the command (shell tools) and artifact paths named in the call's INPUT. Tool OUTPUT (tool_result,
 * function_call_output) is never read into this structure.
 */
export interface ToolCall {
  name: string
  command: string | null
  paths: string[]
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  ts: number
  text: string
  tools: string[]
  /** Input-side tool call summaries (name / command / paths). Absent on older callers. */
  toolCalls?: ToolCall[]
}

export interface TranscriptSession {
  key: string
  source: ImportSource
  sessionId: string
  /** Raw launch project (absolute cwd), or null. */
  project: string | null
  title: string | null
  /** Absolute transcript files that carry main-thread events of this session. */
  files: string[]
  messages: TranscriptMessage[]
  startTs: number | null
  endTs: number | null
}

/** Scan result per session: no message text is retained. */
export interface SessionSummary {
  key: string
  source: ImportSource
  sessionId: string
  project: string | null
  title: string | null
  files: string[]
  messageCount: number
  startTs: number | null
  endTs: number | null
}

export interface TranscriptRoots {
  claudeProjects: string
  codexSessions: string
}

export function transcriptRoots(home: string): TranscriptRoots {
  return { claudeProjects: join(home, '.claude', 'projects'), codexSessions: join(home, '.codex', 'sessions') }
}

export interface ScanLimits {
  /** Max transcript files read per scan (newest first). */
  maxFiles: number
  /** Max total bytes read per scan (newest first). */
  maxBytes: number
}
export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxFiles: 4000, maxBytes: 1024 * 1024 * 1024 }

/** Yields to the event loop (IPC, Broker, UI) between files. */
export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Text blocks that are harness injections even inside a human turn. */
function isInjected(t: string): boolean {
  const s = t.trimStart()
  return (
    s.startsWith('<system-reminder>') ||
    s.startsWith('<command-') ||
    s.startsWith('<local-command') ||
    s.startsWith('<task-notification>') ||
    s.startsWith('Caveat: The messages below') ||
    s.startsWith('<environment_context>') ||
    s.startsWith('<user_instructions>') ||
    s.startsWith('# AGENTS.md') ||
    s.startsWith('<turn_aborted>')
  )
}

function parseLine(rows: string[], line: number): Json | null {
  try {
    const o: unknown = JSON.parse(rows[line - 1] ?? '')
    return isObj(o) ? o : null
  } catch {
    return null
  }
}

function blockTexts(content: unknown): string[] {
  if (typeof content === 'string') return isInjected(content) ? [] : [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content) {
    if (!isObj(b)) continue
    const t = str(b.type)
    // Claude: text; Codex: input_text / output_text. Everything else (tool_result, thinking, image…) is dropped.
    if (t !== 'text' && t !== 'input_text' && t !== 'output_text') continue
    const text = str(b.text)
    if (text && text.trim() && !isInjected(text)) out.push(text)
  }
  return out
}

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

/** Claude Code `tool_use` / `server_tool_use` blocks → input-side summaries (never tool_result). */
function claudeToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return []
  const out: ToolCall[] = []
  for (const b of content) {
    if (!isObj(b)) continue
    const t = str(b.type)
    if (t !== 'tool_use' && t !== 'server_tool_use') continue
    const input = isObj(b.input) ? b.input : {}
    const paths = PATH_KEYS.map((k) => str(input[k])).filter((p): p is string => !!p)
    out.push({ name: str(b.name) ?? '?', command: str(input.command), paths })
  }
  return out
}

function codexCommand(v: unknown): string | null {
  let obj: unknown = v
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!isObj(obj)) return null
  // `shell` / `local_shell_call`: `command` (argv array or string); `exec_command` (unified exec): `cmd`.
  const c = obj.command ?? obj.cmd
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join(' ')
  return str(c)
}

/** C20: artifact paths named in Codex function arguments (`path` / `file_path`), never output. */
function codexArgPaths(v: unknown): string[] {
  let obj: unknown = v
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v)
    } catch {
      return []
    }
  }
  if (!isObj(obj)) return []
  const o = obj
  return PATH_KEYS.map((k) => str(o[k])).filter((p): p is string => !!p)
}

/** Codex `function_call` / `local_shell_call` / `custom_tool_call` → input-side summaries (never *_output). */
function codexToolCalls(item: Json): ToolCall[] {
  const it = str(item.type)
  if (it === 'function_call' || it === 'local_shell_call') {
    const name = str(item.name) ?? (it === 'local_shell_call' ? 'local_shell' : '?')
    const command = codexCommand(it === 'local_shell_call' && isObj(item.action) ? item.action : item.arguments)
    const paths =
      command && /\bapply_patch\b/.test(command)
        ? patchPaths(command.replace(/^.*?apply_patch\s*/s, ''))
        : it === 'function_call'
          ? codexArgPaths(item.arguments)
          : []
    // apply_patch bodies are file CONTENT, not a command: keep only the paths.
    return [{ name, command: command && /\bapply_patch\b/.test(command) ? 'apply_patch' : command, paths }]
  }
  if (it === 'custom_tool_call') {
    const name = str(item.name) ?? '?'
    const input = str(item.input) ?? ''
    return [{ name, command: null, paths: name === 'apply_patch' ? patchPaths(input) : [] }]
  }
  if (it === 'web_search_call') return [{ name: 'web_search', command: null, paths: [] }]
  return []
}

function messageFromEvent(ev: AgentEvent, rows: string[]): TranscriptMessage | null {
  if (ev.sidechain || (ev.role !== 'user' && ev.role !== 'assistant')) return null
  const o = parseLine(rows, ev.source.line)
  if (!o) return null
  let texts: string[] = []
  let toolCalls: ToolCall[] = []
  if (ev.agent === 'claude-code') {
    texts = isObj(o.message) ? blockTexts(o.message.content) : []
    if (ev.role === 'assistant' && isObj(o.message)) toolCalls = claudeToolCalls(o.message.content)
  } else {
    const item = isObj(o.payload) && str(o.type) === 'response_item' ? o.payload : o
    if (str(item.type) === 'message') texts = blockTexts(item.content)
    else if (ev.role === 'assistant') toolCalls = codexToolCalls(item)
  }
  const tools = ev.toolNames
  if (!texts.length && !tools.length) return null
  return { role: ev.role, ts: ev.ts, text: texts.join('\n\n'), tools: [...tools], toolCalls }
}

/** Short content hash used to dedupe lines duplicated across resumed-session files. */
const msgSig = (m: TranscriptMessage): string =>
  createHash('sha1').update(`${m.role}\u0000${m.ts}\u0000${m.text}\u0000${m.tools.join(',')}`).digest('base64').slice(0, 16)

interface FileRef {
  source: ImportSource
  file: string
  size: number
  mtimeMs: number
}

function listFiles(home: string): FileRef[] {
  const roots = transcriptRoots(home)
  const out: FileRef[] = []
  for (const [source, root] of [
    ['claude-code', roots.claudeProjects],
    ['codex', roots.codexSessions]
  ] as const) {
    for (const f of listJsonl(root)) {
      try {
        const st = lstatSync(f)
        if (st.isFile()) out.push({ source, file: f, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* vanished */
      }
    }
  }
  return out
}

interface ParseCtx {
  warnings: WarningCounts
  titles: Record<string, string>
  customTitles: Set<string>
}

/**
 * Read + parse ONE file and hand each main-thread event (with its message, if any) to `visit`.
 * The file's text and rows go out of scope when this returns.
 */
function processFile(ref: FileRef, ctx: ParseCtx, visit: (ev: AgentEvent, msg: TranscriptMessage | null) => void): boolean {
  let text: string
  try {
    text = readTextReadOnly(ref.file)
  } catch (e) {
    bump(ctx.warnings, e instanceof TranscriptReadError ? e.code : 'file_unreadable')
    return false
  }
  const events =
    ref.source === 'claude-code'
      ? parseClaudeTranscript(text, ref.file, ctx.titles, ctx.warnings, ctx.customTitles).events
      : parseCodexRollout(text, ref.file, ctx.warnings).events
  const rows = text.split('\n')
  for (const ev of events) {
    if (ev.sidechain) continue
    visit(ev, messageFromEvent(ev, rows))
  }
  return true
}

/** Launch project = earliest main-thread event with a project (same rule as `pinSessionProject`). */
function updateLaunch(cur: { ts: number; project: string } | null, ev: AgentEvent): { ts: number; project: string } | null {
  if (!ev.project) return cur
  return !cur || ev.ts < cur.ts ? { ts: ev.ts, project: ev.project } : cur
}

export interface ScanCap {
  limitFiles: number
  limitBytes: number
  totalFiles: number
  totalBytes: number
  scannedFiles: number
  scannedBytes: number
}

export interface ScanOutput {
  sessions: SessionSummary[]
  warnings: WarningCounts
  roots: { claudeCode: boolean; codex: boolean }
  /** Non-null when the scan stopped at a limit (older files were not read). */
  capped: ScanCap | null
}

/** Discover every session under `home` (newest files first, bounded). Read-only, async, no retained text. */
export async function scanTranscripts(
  home: string,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
  yieldFn: () => Promise<void> = yieldToLoop
): Promise<ScanOutput> {
  const roots = transcriptRoots(home)
  const ctx: ParseCtx = { warnings: {}, titles: {}, customTitles: new Set() }
  const all = listFiles(home).sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
  const totalBytes = all.reduce((a, f) => a + f.size, 0)

  interface Acc {
    s: SessionSummary
    launch: { ts: number; project: string } | null
    sigs: Set<string>
    /** ts*2 + (assistant ? 1 : 0) — enough to count assistant turns after sorting. */
    marks: number[]
  }
  const map = new Map<string, Acc>()
  let scannedFiles = 0
  let scannedBytes = 0
  let capped = false

  for (const ref of all) {
    if (scannedFiles >= limits.maxFiles || scannedBytes + Math.min(ref.size, MAX_READ_BYTES) > limits.maxBytes) {
      capped = true
      break
    }
    scannedFiles++
    scannedBytes += Math.min(ref.size, MAX_READ_BYTES)
    processFile(ref, ctx, (ev, msg) => {
      const key = `${ref.source}:${ev.sessionId}`
      let acc = map.get(key)
      if (!acc) {
        acc = {
          s: { key, source: ref.source, sessionId: ev.sessionId, project: null, title: null, files: [], messageCount: 0, startTs: null, endTs: null },
          launch: null,
          sigs: new Set(),
          marks: []
        }
        map.set(key, acc)
      }
      const s = acc.s
      acc.launch = updateLaunch(acc.launch, ev)
      if (!s.files.includes(ev.source.file)) s.files.push(ev.source.file)
      s.startTs = s.startTs === null ? ev.ts : Math.min(s.startTs, ev.ts)
      s.endTs = s.endTs === null ? ev.ts : Math.max(s.endTs, ev.ts)
      if (!msg) return
      const sig = msgSig(msg)
      if (acc.sigs.has(sig)) return
      acc.sigs.add(sig)
      acc.marks.push(msg.ts * 2 + (msg.role === 'assistant' ? 1 : 0))
    })
    await yieldFn()
  }

  const sessions: SessionSummary[] = []
  for (const acc of map.values()) {
    const marks = acc.marks.sort((a, b) => a - b)
    let count = 0
    let prevAssistant = false
    for (const m of marks) {
      const assistant = m % 2 === 1
      if (!assistant || !prevAssistant) count++
      prevAssistant = assistant
    }
    sessions.push({
      ...acc.s,
      project: acc.launch?.project ?? null,
      title: ctx.titles[acc.s.sessionId] ?? null,
      files: acc.s.files.sort(),
      messageCount: count
    })
  }
  sessions.sort((a, b) => (b.endTs ?? 0) - (a.endTs ?? 0) || a.key.localeCompare(b.key))
  return {
    sessions,
    warnings: ctx.warnings,
    roots: { claudeCode: existsSync(roots.claudeProjects), codex: existsSync(roots.codexSessions) },
    capped: capped
      ? { limitFiles: limits.maxFiles, limitBytes: limits.maxBytes, totalFiles: all.length, totalBytes, scannedFiles, scannedBytes }
      : null
  }
}

/**
 * Full text of ONE session, reading only `files` (from a previous scan), one at a time.
 * Returns null when no main-thread event for the key is found.
 */
export async function loadSession(
  key: string,
  files: string[],
  yieldFn: () => Promise<void> = yieldToLoop
): Promise<TranscriptSession | null> {
  const sep = key.indexOf(':')
  const source = key.slice(0, sep) as ImportSource
  const sessionId = key.slice(sep + 1)
  const ctx: ParseCtx = { warnings: {}, titles: {}, customTitles: new Set() }
  const seen = new Set<string>()
  const msgs: Array<{ m: TranscriptMessage; file: string; line: number }> = []
  let launch: { ts: number; project: string } | null = null
  let startTs: number | null = null
  let endTs: number | null = null
  const used: string[] = []
  for (const file of [...files].sort()) {
    let size = 0
    try {
      size = lstatSync(file).size
    } catch {
      continue
    }
    processFile({ source, file, size, mtimeMs: 0 }, ctx, (ev, msg) => {
      if (ev.sessionId !== sessionId) return
      if (!used.includes(file)) used.push(file)
      launch = updateLaunch(launch, ev)
      startTs = startTs === null ? ev.ts : Math.min(startTs, ev.ts)
      endTs = endTs === null ? ev.ts : Math.max(endTs, ev.ts)
      if (!msg) return
      const sig = msgSig(msg)
      if (seen.has(sig)) return
      seen.add(sig)
      msgs.push({ m: msg, file, line: ev.source.line })
    })
    await yieldFn()
  }
  if (!used.length) return null
  msgs.sort((a, b) => a.m.ts - b.m.ts || a.file.localeCompare(b.file) || a.line - b.line)
  return {
    key,
    source,
    sessionId,
    project: (launch as { project: string } | null)?.project ?? null,
    title: ctx.titles[sessionId] ?? null,
    files: used,
    messages: mergeAssistantRuns(msgs.map((x) => x.m)),
    startTs,
    endTs
  }
}

/**
 * Claude Code writes one JSONL line per assistant content block (text, tool_use, …) of one
 * API turn; merge consecutive assistant entries so a turn is one message.
 */
export function mergeAssistantRuns(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const m of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === 'assistant' && m.role === 'assistant') {
      out[out.length - 1] = {
        ...prev,
        text: [prev.text, m.text].filter((t) => t.trim()).join('\n\n'),
        tools: [...prev.tools, ...m.tools],
        toolCalls: [...(prev.toolCalls ?? []), ...(m.toolCalls ?? [])]
      }
    } else out.push({ ...m, tools: [...m.tools], toolCalls: [...(m.toolCalls ?? [])] })
  }
  return out
}

/** `/Users/alice/work/x` → `~/work/x` (home-relative display; other paths unchanged). */
export function displayPath(p: string | null, home: string): string | null {
  if (!p) return null
  const rel = relative(home, p)
  if (rel === '') return '~'
  if (!rel.startsWith('..') && !rel.startsWith('/')) return `~/${rel}`
  return p
}
