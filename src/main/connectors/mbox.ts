/**
 * mbox reader for the local email connector (S1-R4-07). Pure, no dependencies, no network.
 * Accepts mboxo / mboxrd / mboxcl (Apple Mail, Thunderbird, Gmail Takeout exports): a message starts
 * at a line beginning with `From ` (the envelope line, dropped) at the start of the file or after an
 * empty line; `>From ` quoting is undone (mboxrd: one `>` removed from `>+From `). Content-Length is
 * not trusted. Each message is then parsed by `parseEmail`; a malformed message is skipped with a
 * warning instead of failing the whole file.
 */
import { MailParseError, parseEmail, type ParsedEmail } from './eml'
import { tr } from '../../shared/i18n'

export const MAX_MBOX_MESSAGES = 5000

export interface MboxParseResult {
  messages: ParsedEmail[]
  /** Messages that could not be parsed (index is 1-based). */
  skipped: Array<{ index: number; reason: string }>
  warnings: string[]
}

/** True when the text looks like an mbox (first non-empty line is a `From ` envelope line). */
export function looksLikeMbox(raw: string): boolean {
  return /^(?:﻿|\xEF\xBB\xBF)?(?:\r?\n)*From \S/.test(raw)
}

/** Split into raw messages (envelope lines removed, `>From ` unquoted). */
export function splitMbox(raw: string): string[] {
  const lines = raw.replace(/^(?:﻿|\xEF\xBB\xBF)/, '').split(/\r?\n/)
  const out: string[] = []
  let cur: string[] | null = null
  let prevBlank = true
  for (const line of lines) {
    if (line.startsWith('From ') && prevBlank) {
      if (cur) out.push(cur.join('\n'))
      cur = []
      prevBlank = false
      continue
    }
    if (cur) cur.push(/^>+From /.test(line) ? line.slice(1) : line)
    prevBlank = line.trim() === ''
  }
  if (cur) out.push(cur.join('\n'))
  return out
}

export function parseMbox(raw: string): MboxParseResult {
  if (!raw.trim()) throw new MailParseError(tr('The file is empty', '文件是空的'))
  if (!looksLikeMbox(raw)) throw new MailParseError(tr('Not an mbox file: the first line is not a "From " envelope line', '不是 mbox 文件：第一行不是 “From ” 开头的信封行'))
  const chunks = splitMbox(raw)
  const warnings: string[] = []
  if (chunks.length > MAX_MBOX_MESSAGES) warnings.push(tr(`The mbox has ${chunks.length} messages; only the first ${MAX_MBOX_MESSAGES} were read`, `mbox 里有 ${chunks.length} 封邮件，只读取前 ${MAX_MBOX_MESSAGES} 封`))
  const messages: ParsedEmail[] = []
  const skipped: MboxParseResult['skipped'] = []
  chunks.slice(0, MAX_MBOX_MESSAGES).forEach((chunk, i) => {
    try {
      messages.push(parseEmail(chunk))
    } catch (e) {
      skipped.push({ index: i + 1, reason: e instanceof Error ? e.message : String(e) })
    }
  })
  if (skipped.length) warnings.push(
      tr(
        `Skipped ${skipped.length} unreadable messages (#${skipped.slice(0, 5).map((s) => s.index).join(', #')}${skipped.length > 5 ? ' and more' : ''})`,
        `${skipped.length} 封邮件无法解析，已跳过（第 ${skipped.slice(0, 5).map((s) => s.index).join('、')}${skipped.length > 5 ? ' 等' : ''} 封）`
      )
    )
  return { messages, skipped, warnings }
}
