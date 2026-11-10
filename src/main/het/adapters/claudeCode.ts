import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentRole, AgentSignal, WarningCounts } from '../types'
import {
  bump,
  parseTs,
  projectKeyFromCwd,
  shellSignals,
  shortSummary,
  uniq,
  isObj,
  str
} from './common'

/**
 * Read-only adapter for Claude Code transcripts: `~/.claude/projects/<proj>/<session>.jsonl`
 * plus subagent files `<proj>/<session>/subagents/**\/agent-*.jsonl` (same `sessionId`,
 * `isSidechain: true`).
 *
 * Line shapes were surveyed on the local machine (key names/types only, 2026-11-04,
 * Claude Code `version` field present on message lines). Only `user`, `assistant` and
 * `pr-link` lines produce events. Every other known type is ignored silently; unknown
 * types and unknown content-block types are counted as warnings.
 */

export const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/** Line `type`s observed in the survey that carry no task-judgement signal. */
const KNOWN_IGNORED = new Set([
  'queue-operation',
  'attachment',
  'last-prompt',
  'mode',
  'system',
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'agent-name',
  'cost-state',
  'bridge-session',
  'api-request-shape',
  'api-request-blob',
  'api-request',
  'tools-used',
  'launched',
  'started',
  'result',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'session-owner',
  'permission-mode',
  'relocated',
  'worktree-state',
  'summary'
])

const KNOWN_BLOCKS = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result',
  'image',
  'document',
  'server_tool_use',
  'web_search_tool_result'
])

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read'])

/** Harness-injected user strings that are not human prompts. */
function isInjectedUserText(s: string): boolean {
  const t = s.trimStart()
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('Caveat: The messages below')
  )
}

export interface ClaudeLineContext {
  file: string
  line: number
  titles: Record<string, string>
  customTitles: Set<string>
  warnings: WarningCounts
}

/** Parse one JSONL line. Pure apart from mutating `ctx` (titles, warnings). */
export function parseClaudeLine(raw: string, ctx: ClaudeLineContext): AgentEvent | null {
  if (!raw.trim()) return null
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    bump(ctx.warnings, 'json_parse')
    return null
  }
  if (!isObj(o)) {
    bump(ctx.warnings, 'non_object_line')
    return null
  }
  const type = str(o.type)
  if (!type) {
    bump(ctx.warnings, 'missing_type')
    return null
  }

  if (type === 'ai-title' || type === 'custom-title') {
    const sid = str(o.sessionId)
    const t = str(type === 'ai-title' ? o.aiTitle : o.customTitle)
    if (sid && t) {
      // custom (user-set) title wins over the generated one.
      if (type === 'custom-title') {
        ctx.titles[sid] = shortSummary(t, 120)
        ctx.customTitles.add(sid)
      } else if (!ctx.customTitles.has(sid)) ctx.titles[sid] = shortSummary(t, 120)
    }
    return null
  }
  if (type !== 'user' && type !== 'assistant' && type !== 'pr-link') {
    if (!KNOWN_IGNORED.has(type)) bump(ctx.warnings, `unknown_type:${type.slice(0, 40)}`)
    return null
  }

  const sessionId = str(o.sessionId)
  if (!sessionId) {
    bump(ctx.warnings, `missing_session:${type}`)
    return null
  }
  const ts = parseTs(o.timestamp)
  if (ts === null) {
    bump(ctx.warnings, `missing_timestamp:${type}`)
    return null
  }
  const cwd = str(o.cwd)
  const base = {
    agent: 'claude-code' as const,
    sessionId,
    ts,
    cwd,
    project: projectKeyFromCwd(cwd),
    sidechain: o.isSidechain === true,
    source: { file: ctx.file, line: ctx.line }
  }

  if (type === 'pr-link') {
    const n = typeof o.prNumber === 'number' ? o.prNumber : null
    const repo = str(o.prRepository)
    return {
      ...base,
      role: 'system',
      toolNames: [],
      filesWritten: [],
      filesRead: [],
      signals: ['pr_link'],
      summary: shortSummary(`PR ${repo ?? '?'}#${n ?? '?'}`)
    }
  }

  const msg = o.message
  if (!isObj(msg)) {
    bump(ctx.warnings, `missing_message:${type}`)
    return null
  }
  const content = msg.content
  const texts: string[] = []
  const toolNames: string[] = []
  const filesWritten: string[] = []
  const filesRead: string[] = []
  const signals: AgentSignal[] = []
  let hasToolResult = false
  let hasHumanBlock = false

  if (typeof content === 'string') {
    texts.push(content)
    hasHumanBlock = !isInjectedUserText(content)
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) {
        bump(ctx.warnings, 'non_object_block')
        continue
      }
      const bt = str(b.type) ?? '?'
      if (!KNOWN_BLOCKS.has(bt)) bump(ctx.warnings, `unknown_block:${bt.slice(0, 40)}`)
      if (bt === 'text') {
        const t = str(b.text) ?? ''
        texts.push(t)
        if (!isInjectedUserText(t)) hasHumanBlock = true
      } else if (bt === 'image' || bt === 'document') {
        hasHumanBlock = true
      } else if (bt === 'tool_use' || bt === 'server_tool_use') {
        const name = str(b.name) ?? '?'
        toolNames.push(name)
        const input = isObj(b.input) ? b.input : {}
        const fp = str(input.file_path) ?? str(input.notebook_path)
        if (fp && WRITE_TOOLS.has(name)) filesWritten.push(fp)
        else if (fp && READ_TOOLS.has(name)) filesRead.push(fp)
        const cmd = str(input.command)
        if (name === 'Bash' && cmd) signals.push(...shellSignals(cmd))
      } else if (bt === 'tool_result') {
        hasToolResult = true
        if (b.is_error === true) signals.push('tool_error')
      }
      // thinking / redacted_thinking: never summarised.
    }
  } else {
    bump(ctx.warnings, `unknown_content:${type}`)
  }

  let role: AgentRole
  if (type === 'assistant') role = 'assistant'
  else if (hasToolResult) role = 'tool_result'
  else if (o.isMeta === true || o.isCompactSummary === true || !hasHumanBlock) role = 'system'
  else role = 'user'

  let summary: string
  if (role === 'tool_result') summary = signals.includes('tool_error') ? 'tool result (error)' : 'tool result'
  else if (role === 'system') summary = 'harness context'
  else {
    const joined = texts.filter((t) => t.trim()).join(' ')
    summary = joined ? shortSummary(joined) : toolNames.length ? `tools: ${uniq(toolNames).join(', ')}` : ''
    if (!summary && role === 'user') summary = '[attachment]'
  }

  return {
    ...base,
    role,
    toolNames,
    filesWritten: uniq(filesWritten),
    filesRead: uniq(filesRead),
    signals: uniq(signals),
    summary: shortSummary(summary)
  }
}

export function parseClaudeTranscript(
  text: string,
  file: string,
  titles: Record<string, string> = {},
  warnings: WarningCounts = {},
  customTitles: Set<string> = new Set(),
  /** Number of rows already consumed before `text` (incremental reads); keeps line numbers absolute. */
  lineOffset = 0
): { events: AgentEvent[]; lines: number } {
  const events: AgentEvent[] = []
  const rows = text.split('\n')
  let lines = 0
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].trim()) continue
    lines++
    const ev = parseClaudeLine(rows[i], { file, line: lineOffset + i + 1, titles, customTitles, warnings })
    if (ev) events.push(ev)
  }
  return { events, lines }
}
