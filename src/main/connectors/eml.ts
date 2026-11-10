import { tr } from '../../shared/i18n'
/**
 * Minimal RFC 5322 / MIME reader for the local email connector (S1-R4-07). Pure, no dependencies,
 * no network. Input is the file's raw bytes as a `latin1` string (one char per byte), so 8-bit
 * bodies in any charset survive until the part's own charset is known.
 *
 * Scope:
 *   - headers: unfolding, RFC 2047 encoded words (B / Q, any charset TextDecoder knows), raw UTF-8
 *     headers (RFC 6532); From / To / Cc / Subject / Date / Message-ID;
 *   - bodies: 7bit / 8bit / binary / quoted-printable / base64;
 *   - multipart/*: recursive (depth ≤ 8, ≤ 200 parts). multipart/alternative prefers text/plain,
 *     falls back to a tag-stripped text/html (reported as a warning);
 *   - attachments (Content-Disposition: attachment, a filename / name parameter, or any non-text
 *     leaf such as image/*, application/*, message/rfc822): never decoded — only the file NAME is
 *     kept, and only for counting / listing.
 * Not supported (stated in the UI): S/MIME / PGP decryption, TNEF (winmail.dat), uuencode, calendar
 * invitations inside mail (import the .ics instead).
 */

export interface ParsedEmail {
  messageId: string | null
  from: string | null
  to: string | null
  /** Number of Cc addresses (names / addresses are not written). */
  ccCount: number
  subject: string | null
  /** ISO 8601 UTC, or null when the Date header is missing / unparseable. */
  date: string | null
  /** Plain-text body (already decoded). Empty when the message has no readable text part. */
  body: string
  bodySource: 'plain' | 'html' | 'none'
  /** Attachment file names (decoded); unnamed attachments appear as `（未命名 <type>）`. */
  attachments: string[]
  warnings: string[]
}

export class MailParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailParseError'
  }
}

export const MAX_MIME_DEPTH = 8
export const MAX_MIME_PARTS = 200
/** Decoded text kept per message before the connector truncates it further. */
const MAX_BODY_CHARS = 200_000

interface Header {
  name: string
  value: string
}

interface Part {
  headers: Header[]
  body: string
}

// ── bytes / charsets ─────────────────────────────────────────────────────────

const latin1Bytes = (s: string): Buffer => Buffer.from(s, 'latin1')

const CHARSET_ALIAS: Record<string, string> = {
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
  utf8: 'utf-8',
  'x-unknown': 'utf-8',
  unknown: 'utf-8',
  'unknown-8bit': 'utf-8',
  'x-user-defined': 'utf-8',
  gb2312: 'gbk',
  'ks_c_5601-1987': 'euc-kr',
  cp1252: 'windows-1252'
}

/** Decode bytes in a declared charset. Unknown labels fall back to UTF-8, invalid UTF-8 to latin1. */
export function decodeBytes(bytes: Buffer, charset: string | null | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  const norm = CHARSET_ALIAS[label] ?? label
  if (norm === 'utf-8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return bytes.toString('latin1')
    }
  }
  try {
    return new TextDecoder(norm).decode(bytes)
  } catch {
    return decodeBytes(bytes, 'utf-8')
  }
}

/** Quoted-printable (RFC 2045 §6.7) → bytes. Soft line breaks removed; bad escapes kept literally. */
export function decodeQuotedPrintable(s: string): Buffer {
  const text = s.replace(/=[ \t]*\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x3d && i + 2 < text.length && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else out.push(c & 0xff)
  }
  return Buffer.from(out)
}

export function decodeBase64(s: string): Buffer {
  return Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
}

/** Q encoding of RFC 2047 §4.2: like QP, plus `_` = space. */
function decodeQWord(s: string): Buffer {
  return decodeQuotedPrintable(s.replace(/_/g, ' '))
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g

/**
 * Header value → text: raw bytes as UTF-8 (RFC 6532; latin1 when invalid), then RFC 2047 encoded
 * words. Whitespace between two adjacent encoded words is dropped (§6.2). RFC 2231 language tags
 * (`utf-8*en`) are ignored.
 */
export function decodeHeaderValue(raw: string): string {
  const base = decodeBytes(latin1Bytes(raw), 'utf-8')
  const joined = base.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1')
  return joined.replace(ENCODED_WORD, (_m, cs: string, enc: string, text: string) => {
    const charset = cs.split('*')[0]
    const bytes = enc.toUpperCase() === 'B' ? decodeBase64(text) : decodeQWord(text)
    return decodeBytes(bytes, charset)
  })
}

// ── headers ──────────────────────────────────────────────────────────────────

/** Split at the first empty line. Lines are kept with their original content (CRLF / LF tolerant). */
function splitHeadBody(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw)
  if (!m) return { head: raw, body: '' }
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) }
}

const HEADER_LINE = /^([!-9;-~]+)[ \t]*:(.*)$/

function parseHeaders(head: string): { headers: Header[]; bad: number } {
  const headers: Header[] = []
  let bad = 0
  for (const line of head.split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length) {
      headers[headers.length - 1].value += ` ${line.trim()}`
      continue
    }
    if (!line.trim()) continue
    const m = HEADER_LINE.exec(line)
    if (!m) {
      bad++
      continue
    }
    headers.push({ name: m[1].toLowerCase(), value: m[2].trim() })
  }
  return { headers, bad }
}

const header = (hs: Header[], name: string): string | null => hs.find((h) => h.name === name)?.value ?? null

/**
 * `type/sub; a=b; c="d; e"` → {value, params}. Parameter names lower-cased; values decoded (RFC 2231
 * `x*=` / `x*0*=` joined with their charset; plain values via RFC 2047 / raw UTF-8, as Outlook writes them).
 */
export function parseParams(v: string | null): { value: string; params: Record<string, string> } {
  if (!v) return { value: '', params: {} }
  const parts: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c === '\\' && q && i + 1 < v.length) {
      cur += v[++i]
      continue
    }
    if (c === '"') q = !q
    if (c === ';' && !q) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  const value = parts[0].trim().toLowerCase()
  const params: Record<string, string> = {}
  const continued: Record<string, Array<{ n: number; v: string; enc: boolean }>> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    const name = p.slice(0, eq).trim().toLowerCase()
    const val = p.slice(eq + 1).trim().replace(/^"([\s\S]*)"$/, '$1')
    const m = /^([^*]+)\*(?:(\d+)\*?)?$/.exec(name)
    if (m) {
      ;(continued[m[1]] ??= []).push({ n: m[2] === undefined ? 0 : Number(m[2]), v: val, enc: name.endsWith('*') })
    } else params[name] = decodeHeaderValue(val)
  }
  for (const [name, list] of Object.entries(continued)) {
    list.sort((a, b) => a.n - b.n)
    let charset = 'utf-8'
    const bytes: Buffer[] = []
    list.forEach((seg, i) => {
      let s = seg.v
      if (seg.enc && i === 0) {
        const m2 = /^([^']*)'[^']*'([\s\S]*)$/.exec(s)
        if (m2) {
          charset = m2[1] || charset
          s = m2[2]
        }
      }
      bytes.push(seg.enc ? Buffer.from(s.replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1') : latin1Bytes(s))
    })
    params[name] = decodeBytes(Buffer.concat(bytes), charset)
  }
  return { value, params }
}

// ── bodies ───────────────────────────────────────────────────────────────────

function decodeTransfer(body: string, cte: string | null): Buffer {
  const enc = (cte ?? '7bit').trim().toLowerCase()
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body)
  if (enc === 'base64') return decodeBase64(body)
  return latin1Bytes(body)
}

function partText(p: Part): string {
  const ct = parseParams(header(p.headers, 'content-type'))
  return decodeBytes(decodeTransfer(p.body, header(p.headers, 'content-transfer-encoding')), ct.params.charset)
}

/** Crude but safe HTML → text: drop script / style / head, tags → spaces / newlines, decode common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]{0,2000}>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_m, d: string) => {
      const n = Number(d)
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '
    })
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
}

function splitMultipart(body: string, boundary: string): string[] {
  const out: string[] = []
  const delim = `--${boundary}`
  const lines = body.split(/\r?\n/)
  let cur: string[] | null = null
  for (const line of lines) {
    const t = line.replace(/[ \t]+$/, '')
    if (t === delim || t === `${delim}--`) {
      if (cur) out.push(cur.join('\n'))
      if (t === `${delim}--`) return out
      cur = []
      continue
    }
    if (cur) cur.push(line)
  }
  if (cur && cur.length) out.push(cur.join('\n'))
  return out
}

interface Walk {
  plain: string[]
  html: string[]
  attachments: string[]
  parts: number
  warnings: Set<string>
}

function attachmentName(p: Part, type: string): string | null {
  const disp = parseParams(header(p.headers, 'content-disposition'))
  const ct = parseParams(header(p.headers, 'content-type'))
  const named = disp.params.filename ?? ct.params.name
  const isAttachment = disp.value === 'attachment' || named !== undefined || !(type.startsWith('text/') || type === '' || type.startsWith('multipart/'))
  if (!isAttachment) return null
  return named?.trim() || `（未命名 ${type || '附件'}）`
}

function walk(p: Part, w: Walk, depth: number, inAlternative = false): void {
  if (++w.parts > MAX_MIME_PARTS) {
    w.warnings.add(tr(`More than ${MAX_MIME_PARTS} MIME parts; the rest were not read`, `MIME 分段超过 ${MAX_MIME_PARTS} 个，其余部分未读取`))
    return
  }
  const ct = parseParams(header(p.headers, 'content-type'))
  const type = ct.value || 'text/plain'
  if (type.startsWith('multipart/')) {
    if (depth >= MAX_MIME_DEPTH) {
      w.warnings.add(tr(`MIME nesting deeper than ${MAX_MIME_DEPTH} levels; inner parts were not read`, `MIME 嵌套超过 ${MAX_MIME_DEPTH} 层，内层未读取`))
      return
    }
    const boundary = ct.params.boundary
    if (!boundary) {
      w.warnings.add(tr('multipart without a boundary; treated as plain text', 'multipart 缺少 boundary，按纯文本处理'))
      w.plain.push(partText(p))
      return
    }
    const children: Part[] = splitMultipart(p.body, boundary).map((raw) => {
      const { head, body } = splitHeadBody(raw)
      // A part whose very first line is empty has no headers at all.
      return /^\r?\n/.test(raw) ? { headers: [], body: raw.replace(/^\r?\n/, '') } : { headers: parseHeaders(head).headers, body }
    })
    if (type === 'multipart/alternative') {
      // Prefer text/plain; otherwise the richest other alternative. Attachments inside are still counted.
      const typed = children.map((c) => ({ c, t: parseParams(header(c.headers, 'content-type')).value || 'text/plain' }))
      const plain = typed.find((x) => x.t === 'text/plain' && !attachmentName(x.c, x.t))
      const chosen = plain ?? typed.find((x) => x.t.startsWith('multipart/')) ?? typed.find((x) => x.t === 'text/html') ?? typed[0]
      if (chosen) walk(chosen.c, w, depth + 1, true)
      return
    }
    for (const c of children) walk(c, w, depth + 1, inAlternative)
    return
  }
  const name = attachmentName(p, type)
  if (name !== null) {
    w.attachments.push(name)
    return
  }
  if (type === 'text/html') w.html.push(htmlToText(partText(p)))
  else if (type === 'text/plain' || type === 'text/enriched' || !type.includes('/')) w.plain.push(partText(p))
  else w.attachments.push(`（未命名 ${type}）`)
}

function parseDate(v: string | null): string | null {
  if (!v) return null
  // Drop a trailing comment like `(CST)`, which Date.parse may reject.
  const ms = Date.parse(v.replace(/\([^)]*\)\s*$/, '').trim())
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Count addresses in an address-list header (commas outside quotes / angle brackets). */
export function countAddresses(v: string | null): number {
  if (!v || !v.trim()) return 0
  let n = 1
  let q = false
  let angle = 0
  for (const c of v) {
    if (c === '"') q = !q
    else if (!q && c === '<') angle++
    else if (!q && c === '>') angle = Math.max(0, angle - 1)
    else if (!q && angle === 0 && c === ',') n++
  }
  return n
}

const cleanBody = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * Parse one message. Throws MailParseError when the input does not look like an email at all
 * (empty, or no header block with at least one of From / Subject / Date / Message-ID).
 */
export function parseEmail(raw: string): ParsedEmail {
  if (!raw.trim()) throw new MailParseError(tr('The file is empty', '文件是空的'))
  const text = raw.replace(/^﻿/, '').replace(/^\xEF\xBB\xBF/, '')
  const { head, body } = splitHeadBody(text)
  const { headers, bad } = parseHeaders(head)
  const known = ['from', 'subject', 'date', 'message-id'].filter((n) => header(headers, n) !== null)
  if (!headers.length || !known.length || bad > headers.length) {
    throw new MailParseError(tr('Does not look like an email: no From / Subject / Date / Message-ID headers found', '不像一封邮件：没有找到 From / Subject / Date / Message-ID 等邮件头'))
  }
  const w: Walk = { plain: [], html: [], attachments: [], parts: 0, warnings: new Set() }
  if (bad) w.warnings.add(tr(`${bad} header lines could not be read and were ignored`, `有 ${bad} 行邮件头无法识别，已忽略`))
  walk({ headers, body }, w, 0)
  let bodyText = ''
  let bodySource: ParsedEmail['bodySource'] = 'none'
  if (w.plain.some((t) => t.trim())) {
    bodyText = cleanBody(w.plain.join('\n\n'))
    bodySource = 'plain'
  } else if (w.html.some((t) => t.trim())) {
    bodyText = cleanBody(w.html.join('\n\n'))
    bodySource = 'html'
    w.warnings.add(tr('Some messages have only an HTML body: imported with tags stripped, so formatting may be lost', '部分邮件只有 HTML 正文：已去掉标签后导入，排版可能丢失'))
  }
  if (bodyText.length > MAX_BODY_CHARS) bodyText = bodyText.slice(0, MAX_BODY_CHARS)
  const rawDate = header(headers, 'date')
  const date = parseDate(rawDate)
  if (rawDate && !date) w.warnings.add(tr('Some messages have an unreadable Date; their time shows as unknown', '部分邮件的 Date 无法解析，时间显示为未知'))
  const decode = (n: string): string | null => {
    const v = header(headers, n)
    return v === null ? null : decodeHeaderValue(v).replace(/\s+/g, ' ').trim() || null
  }
  const mid = header(headers, 'message-id')
  const messageId = mid ? (/<([^<>\s]{1,998})>/.exec(mid)?.[1] ?? (mid.trim().split(/\s+/)[0] || null)) : null
  return {
    messageId,
    from: decode('from'),
    to: decode('to'),
    ccCount: countAddresses(decode('cc')),
    subject: decode('subject'),
    date,
    body: bodyText,
    bodySource,
    attachments: w.attachments,
    warnings: [...w.warnings]
  }
}
