/**
 * S1-FULL C15 — agent sessions the user can pick for a cloud Workflow extraction.
 *
 * Read-only, through the existing HET transcript adapters (Claude Code `~/.claude/projects`, Codex
 * `~/.codex/sessions`; roots overridable for tests / E2E). Only the newest transcript files are
 * parsed. The renderer only ever sees an opaque session key, never a file path. Event summaries are
 * the adapters' own (whitespace-collapsed, secret-redacted, ≤200 chars); everything that becomes a
 * context item is redacted again by `buildBundle` → `redactForCloud`.
 */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { parseClaudeTranscript } from '../het/adapters/claudeCode'
import { parseCodexRollout } from '../het/adapters/codex'
import { listJsonl, readTextReadOnly } from '../het/adapters/common'
import type { AgentEvent, AgentId } from '../het/types'
import { redactForCloud, type ContextCandidate } from '../cloud/context'
import type { SessionSummary } from './api'

export interface SessionRoots {
  claudeRoot: string | null
  codexRoot: string | null
}

export interface SessionSourceOptions extends SessionRoots {
  /** Newest N transcript files considered (default 30). */
  maxFiles?: number
  /** Per-file read cap (default 16 MiB); bigger files are skipped. */
  maxBytesPerFile?: number
  knownSecrets?: () => string[]
}

export interface SessionSource {
  list(): SessionSummary[]
  /** Non-sidechain events of one session, oldest first; null when the key is unknown / gone. */
  events(key: string): { summary: SessionSummary; events: AgentEvent[] } | null
}

interface Located {
  agent: AgentId
  file: string
  sessionId: string
}

const DEFAULT_MAX_FILES = 30
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
export const MAX_TURN_ITEMS = 60

function keyOf(agent: AgentId, file: string, sessionId: string): string {
  return createHash('sha256').update(`${agent}\0${file}\0${sessionId}`, 'utf8').digest('hex').slice(0, 16)
}

function parseFile(agent: AgentId, file: string, maxBytes: number): { events: AgentEvent[]; titles: Record<string, string> } | null {
  let text: string
  try {
    text = readTextReadOnly(file, maxBytes)
  } catch {
    return null
  }
  if (agent === 'claude-code') {
    const titles: Record<string, string> = {}
    const r = parseClaudeTranscript(text, file, titles)
    return { events: r.events, titles }
  }
  return { events: parseCodexRollout(text, file).events, titles: {} }
}

function iso(ts: number | undefined): string | null {
  return ts === undefined || !Number.isFinite(ts) ? null : new Date(ts).toISOString()
}

export function createSessionSource(opts: SessionSourceOptions): SessionSource {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES
  const located = new Map<string, Located>()
  const known = (): string[] => {
    try {
      return opts.knownSecrets?.() ?? []
    } catch {
      return []
    }
  }

  function cleanTitle(raw: string): string {
    const r = redactForCloud(raw.replace(/\s+/g, ' ').trim(), known())
    return r.dropped ? '（标题已省略）' : r.text.slice(0, 120)
  }

  function summarize(agent: AgentId, file: string, sessionId: string, events: AgentEvent[], titles: Record<string, string>): SessionSummary {
    const firstUser = events.find((e) => e.role === 'user' && e.summary.trim())
    const title = stripPaths(titles[sessionId] || firstUser?.summary || '（无标题）')
    return {
      key: keyOf(agent, file, sessionId),
      agent,
      title: cleanTitle(title),
      startedAt: iso(events[0]?.ts),
      endedAt: iso(events[events.length - 1]?.ts),
      userTurns: events.filter((e) => e.role === 'user').length,
      events: events.length
    }
  }

  function group(agent: AgentId, parsed: { events: AgentEvent[]; titles: Record<string, string> }): Array<{ sessionId: string; events: AgentEvent[] }> {
    const by = new Map<string, AgentEvent[]>()
    for (const e of parsed.events) {
      if (e.sidechain || e.agent !== agent) continue
      const list = by.get(e.sessionId) ?? []
      list.push(e)
      by.set(e.sessionId, list)
    }
    return [...by.entries()].map(([sessionId, events]) => ({ sessionId, events: events.sort((a, b) => a.ts - b.ts) }))
  }

  function candidates(): Array<{ agent: AgentId; file: string; mtime: number }> {
    const out: Array<{ agent: AgentId; file: string; mtime: number }> = []
    const roots: Array<[AgentId, string | null]> = [
      ['claude-code', opts.claudeRoot],
      ['codex', opts.codexRoot]
    ]
    for (const [agent, root] of roots) {
      if (!root) continue
      for (const file of listJsonl(root)) {
        try {
          const st = statSync(file)
          if (st.isFile()) out.push({ agent, file, mtime: st.mtimeMs })
        } catch {
          // gone between listing and stat
        }
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file)).slice(0, maxFiles)
  }

  function list(): SessionSummary[] {
    located.clear()
    const out: SessionSummary[] = []
    for (const c of candidates()) {
      const parsed = parseFile(c.agent, c.file, maxBytes)
      if (!parsed) continue
      for (const g of group(c.agent, parsed)) {
        if (!g.events.some((e) => e.role === 'user')) continue
        const s = summarize(c.agent, c.file, g.sessionId, g.events, parsed.titles)
        located.set(s.key, { agent: c.agent, file: c.file, sessionId: g.sessionId })
        out.push(s)
      }
    }
    return out.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
  }

  return {
    list,
    events(key) {
      if (!located.has(key)) list()
      const loc = located.get(key)
      if (!loc) return null
      const parsed = parseFile(loc.agent, loc.file, maxBytes)
      if (!parsed) return null
      const g = group(loc.agent, parsed).find((x) => x.sessionId === loc.sessionId)
      if (!g || g.events.length === 0) return null
      return { summary: summarize(loc.agent, loc.file, loc.sessionId, g.events, parsed.titles), events: g.events }
    }
  }
}

const ROLE_LABEL: Record<AgentEvent['role'], string> = { user: '用户', assistant: '助手', tool_result: '工具结果', system: '系统' }

/** Absolute / `~/` paths → their last segment (URLs untouched). Bounded segments keep it linear. */
const ABS_PATH_RE = /(?<![:\w/.~-])(?:~\/|\/)(?:[^\s/"'<>()，。、：]{1,255}\/){1,64}([^\s/"'<>()，。、：]{0,255})/g

export function stripPaths(text: string): string {
  return text.replace(ABS_PATH_RE, (_m, last: string) => last || '[dir]')
}

function eventLine(e: AgentEvent): string | null {
  if (e.role === 'system') return null
  const bits: string[] = []
  if (e.summary.trim()) bits.push(stripPaths(e.summary.trim()))
  if (e.toolNames.length) bits.push(`［工具：${[...new Set(e.toolNames)].slice(0, 8).join('、')}］`)
  // File names only — never a directory / absolute path.
  if (e.filesWritten.length) bits.push(`［写入：${[...new Set(e.filesWritten.map((f) => path.basename(f)))].slice(0, 8).join('、')}］`)
  if (e.signals.length) bits.push(`［${e.signals.join('、')}］`)
  return bits.length ? `${ROLE_LABEL[e.role]}：${bits.join(' ')}` : null
}

/**
 * One context candidate per user turn (a turn = a user prompt and everything until the next one),
 * kind `recent`, in session order. More than MAX_TURN_ITEMS turns ⇒ adjacent turns are merged so the
 * whole session is still covered in order. `ref` is an opaque `<agent>:<key>#<turns>` (no path).
 */
export function sessionCandidates(summary: SessionSummary, events: readonly AgentEvent[]): ContextCandidate[] {
  const turns: AgentEvent[][] = []
  for (const e of events) {
    if (e.role === 'user' || turns.length === 0) turns.push([])
    turns[turns.length - 1].push(e)
  }
  const per = Math.max(1, Math.ceil(turns.length / MAX_TURN_ITEMS))
  const out: ContextCandidate[] = []
  for (let i = 0; i < turns.length; i += per) {
    const chunk = turns.slice(i, i + per).flat()
    const lines = chunk.map(eventLine).filter((l): l is string => l !== null)
    if (!lines.length) continue
    const first = i + 1
    const last = Math.min(i + per, turns.length)
    const label = first === last ? `第 ${first} 轮` : `第 ${first}–${last} 轮`
    const at = iso(chunk[0]?.ts)
    out.push({
      kind: 'recent',
      title: `${summary.agent === 'codex' ? 'Codex' : 'Claude Code'} 会话 · ${label}${at ? ` · ${at.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
      text: lines.join('\n'),
      ref: `${summary.agent}:${summary.key}#${first === last ? first : `${first}-${last}`}`,
      score: 0
    })
  }
  return out
}
