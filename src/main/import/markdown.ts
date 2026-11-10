import { createHash } from 'node:crypto'
import { stripSecrets } from './redact'
import { displayPath, type TranscriptSession } from './transcripts'

/**
 * Transcript → redacted Markdown. Pure. Output documents stay below the Runtime importer's
 * 2 MiB per-file limit (files above it are skipped silently by `persome import-data`), so a
 * long session is split into numbered parts at message boundaries.
 */

export const MAX_DOC_BYTES = 1_500_000

const SOURCE_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex' } as const
const ROLE_LABEL = { user: '用户', assistant: '助手' } as const

export interface RenderedDocument {
  /** Path relative to the staging dir, e.g. `claude-code/<sessionId>.md`. */
  file: string
  content: string
  messages: number
  /** C20: stable dedupe key (also in the document's front matter). */
  dedupeKey: string
  /** C20: 1-based session turn range covered by this document. */
  turns: [number, number]
}

export interface RenderedSession {
  key: string
  documents: RenderedDocument[]
  messages: number
  redactions: number
  droppedBlocks: number
}

const iso = (ts: number | null): string => (ts === null ? '—' : new Date(ts).toISOString())
/** Session ids become file names: keep a conservative charset. */
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'session'

/**
 * Collision-free file stem: sanitised, shortened id + 10 hex of sha256(raw id). Distinct raw ids
 * that sanitise/truncate to the same text (`a/b` vs `a_b`, long shared prefixes) still differ,
 * and a stem can never equal another session's `.part-N` name (security review S1-07 #9).
 */
export const fileStem = (sessionId: string): string =>
  `${safeName(sessionId).slice(0, 80)}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 10)}`

export interface RenderOptions {
  /**
   * 「保留工具调用」: tool name + command first line + artifact paths (redacted), never tool output.
   * C20: default ON (was opt-in in S1-R3-06); pass `false` to leave tool calls out.
   */
  includeTools?: boolean
  /** C20: Runtime data root; any path under it is replaced by `[persome-runtime]` (tail dropped). */
  runtimeRoot?: string | null
  /** C20: Lens Store root; any path under it is replaced by `[lens-store]` (tail dropped). */
  storeRoot?: string | null
  /**
   * Render only `messages[from..]` (a continuation of an already imported session). The file name
   * gets `.from-<from+1>` so it never collides with (or replaces) the earlier document.
   */
  from?: number
}

/** Max characters of one command line in a tool summary (first line only). */
export const TOOL_COMMAND_MAX = 300

/** Front-matter format of imported transcript documents (C20). Bump when the dedupe-key recipe changes. */
export const IMPORT_DOC_FORMAT = 1

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * C20: local path scrubbing, applied BEFORE the secret redactor:
 *   - Runtime root (`~/.persome` or a custom PERSOME_ROOT) → `[persome-runtime]`, tail dropped;
 *   - Lens Store root → `[lens-store]`, tail dropped;
 *   - the home directory → `~` (tail kept: `~/work/app/x.ts`).
 * Both the absolute form and the `~/…` form of each root are matched. Pure and deterministic.
 */
export function scrubLocalPaths(text: string, home: string, roots: { runtimeRoot?: string | null; storeRoot?: string | null } = {}): string {
  const boundary = '(?=$|[\\s"\'`)\\]>,;:])'
  const tail = '(?:/[^\\s"\'`)\\]>,;]*)?'
  let out = text
  const drop: Array<[string, string]> = []
  for (const [root, label] of [
    [roots.runtimeRoot, '[persome-runtime]'],
    [roots.storeRoot, '[lens-store]']
  ] as const) {
    if (!root || root === '/' || root.length < 4) continue
    const abs = root.replace(/\/+$/, '')
    drop.push([abs, label])
    const tilde = displayPath(abs, home)
    if (tilde && tilde !== abs && tilde !== '~') drop.push([tilde, label])
  }
  // Longest first, so `/Users/a/.persome` wins over `/Users/a`.
  for (const [p, label] of drop.sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`${escapeRe(p)}${tail}${boundary}`, 'g'), label)
  }
  const h = home.replace(/\/+$/, '')
  if (h && h !== '/' && h.length >= 4) out = out.replace(new RegExp(`${escapeRe(h)}(?=/|${boundary})`, 'g'), '~')
  return out
}

/** Whitespace-normalised message text for dedupe keys (CRLF, trailing spaces, outer blank lines). */
const normalizeText = (t: string): string =>
  t
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim()

/** C20: stable session key — sha256(agent, session id). */
export function sessionKey(source: string, sessionId: string): string {
  return createHash('sha256').update(`lens-import/v${IMPORT_DOC_FORMAT}\u0000${source}\u0000${sessionId}`).digest('hex')
}

/**
 * C20: stable dedupe key of one document — sha256(agent, session id, turn range, normalised content
 * of those turns). Independent of render options (tool summary on/off), home dir and file name, so
 * the same turns of the same session always get the same key.
 */
export function dedupeKey(source: string, sessionId: string, firstTurn: number, lastTurn: number, messages: TranscriptSession['messages']): string {
  const h = createHash('sha256').update(`lens-import/v${IMPORT_DOC_FORMAT}\u0000${source}\u0000${sessionId}\u0000${firstTurn}-${lastTurn}\u0000`)
  for (const m of messages) h.update(`${m.role}\u0000${m.ts}\u0000${normalizeText(m.text)}\u0001`)
  return h.digest('hex')
}

export function renderSession(s: TranscriptSession, home: string, opts: RenderOptions = {}): RenderedSession {
  const includeTools = opts.includeTools !== false
  const from = Math.max(0, Math.min(opts.from ?? 0, s.messages.length))
  let redactions = 0
  let droppedBlocks = 0
  const clean = (t: string): string => {
    const r = stripSecrets(scrubLocalPaths(t, home, { runtimeRoot: opts.runtimeRoot, storeRoot: opts.storeRoot }))
    redactions += r.redactions
    if (r.dropped) droppedBlocks++
    return r.text
  }

  const title = s.title ? clean(s.title) : null
  const project = s.project ? clean(displayPath(s.project, home) ?? s.project) : null
  const frontMatter = (part: number, parts: number, first: number, last: number): string =>
    [
      '---',
      `lens_import: ${IMPORT_DOC_FORMAT}`,
      `source: ${s.source}`,
      `session_key: ${sessionKey(s.source, s.sessionId)}`,
      `dedupe_key: ${dedupeKey(s.source, s.sessionId, first, last, s.messages.slice(first - 1, last))}`,
      `turns: ${first}-${last}`,
      `part: ${part}/${parts}`,
      '---',
      ''
    ].join('\n')
  const header = (part: number, parts: number): string =>
    [
      `# ${SOURCE_LABEL[s.source]} 会话：${title ?? s.sessionId}${parts > 1 ? `（第 ${part}/${parts} 部分）` : ''}`,
      '',
      `- 来源：${SOURCE_LABEL[s.source]}`,
      `- 会话 ID：${s.sessionId}`,
      `- 项目：${project ?? '—'}`,
      `- 时间：${iso(s.startTs)} — ${iso(s.endTs)}`,
      `- 消息数：${s.messages.length}`,
      ...(from > 0 ? [`- 本文档：第 ${from + 1}–${s.messages.length} 条消息（续，前 ${from} 条已在之前导入）`] : []),
      `- 工具调用摘要：${includeTools ? '已包含（仅工具名、命令首行、文件路径；不含工具输出）' : '未包含'}`,
      '- 说明：由 Navalia 从本机 transcript 导入；已脱敏（家目录写作 ~，Runtime / Navalia 数据目录路径已移除），工具输出与思考过程未导入。',
      '',
      '---',
      '',
      ''
    ].join('\n')

  const toolLine = (c: { name: string; command: string | null; paths: string[] }): string => {
    const parts = [`- 工具：${clean(c.name)}`]
    if (c.command && c.command.trim()) {
      // S1-R3-SEC M1: redact the WHOLE first line before cutting, so a secret straddling the cut
      // cannot survive as a fragment too short for the redactor to recognise.
      const first = clean(c.command.trim().split('\n')[0])
      const cut = first.length > TOOL_COMMAND_MAX ? `${first.slice(0, TOOL_COMMAND_MAX)}…` : first
      parts.push(`命令：\`${(cut + (c.command.trim().includes('\n') ? ' …' : '')).replace(/`/g, "'")}\``)
    }
    if (c.paths.length) parts.push(`路径：${[...new Set(c.paths)].slice(0, 20).map((p) => clean(displayPath(p, home) ?? p)).join(', ')}`)
    return parts.join(' · ')
  }

  const blocks = s.messages.slice(from).map((m) => {
    const lines = [`## ${ROLE_LABEL[m.role]} · ${iso(m.ts)}`, '']
    if (m.text.trim()) lines.push(clean(m.text), '')
    if (includeTools) {
      const calls = m.toolCalls?.length ? m.toolCalls : m.tools.map((name) => ({ name, command: null, paths: [] }))
      if (calls.length) lines.push('_工具调用摘要：_', ...calls.map(toolLine), '')
    } else if (!m.text.trim()) {
      lines.push('_（本条只有工具调用，未包含工具调用摘要）_', '')
    }
    return lines.join('\n')
  })

  // Pack blocks into parts under MAX_DOC_BYTES (a single oversized block is truncated).
  const budget = MAX_DOC_BYTES - 4096
  const parts: string[][] = [[]]
  /** 1-based session turn index of the first block of each part. */
  const firstTurn: number[] = [from + 1]
  let size = 0
  blocks.forEach((raw, i) => {
    let b = raw
    if (Buffer.byteLength(b) > budget) b = Buffer.from(b).subarray(0, budget).toString('utf8') + '\n\n[已截断]\n'
    const n = Buffer.byteLength(b)
    if (size + n > budget && parts[parts.length - 1].length) {
      parts.push([])
      firstTurn.push(from + i + 1)
      size = 0
    }
    parts[parts.length - 1].push(b)
    size += n
  })
  const base = `${s.source}/${fileStem(s.sessionId)}${from > 0 ? `.from-${from + 1}` : ''}`
  const documents = parts.map((p, i) => {
    const first = firstTurn[i]
    const last = first + p.length - 1
    const fm = frontMatter(i + 1, parts.length, first, last)
    return {
      file: parts.length === 1 ? `${base}.md` : `${base}.part-${i + 1}.md`,
      content: fm + header(i + 1, parts.length) + p.join('\n'),
      messages: p.length,
      dedupeKey: /^dedupe_key: ([0-9a-f]{64})$/m.exec(fm)![1],
      turns: [first, last] as [number, number]
    }
  })
  return { key: s.key, documents, messages: s.messages.length - from, redactions, droppedBlocks }
}
