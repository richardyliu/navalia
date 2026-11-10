import type { Duplex } from 'node:stream'
import { redactForDisplay } from '../../import/redact'
import { encodeMailboxName } from './utf7'
import { tr } from '../../../shared/i18n'

/**
 * C19 minimal IMAP4rev1 client (RFC 3501), read-only subset, over any Duplex (production: the TLS
 * socket from `tls.ts`; tests: an in-memory pair or a loopback TLS server).
 *
 *   greeting → CAPABILITY → LOGIN (quoted or literal-safe arguments) → [ID, only when advertised:
 *   NetEase 163 / 126 refuse EXAMINE from clients that do not identify] → EXAMINE (read-only; a
 *   [READ-WRITE] answer aborts) → UID SEARCH SINCE → UID FETCH (UID RFC822.SIZE) → UID FETCH
 *   BODY.PEEK[] (never sets \Seen) → LOGOUT.
 *
 * Nothing else is ever sent (ID carries only the fixed client name): no SELECT, STORE, COPY, MOVE, EXPUNGE, APPEND, STARTTLS.
 * Strict response parsing: CRLF lines, `{n}` literals (bounded by `maxLiteralBytes`), one command
 * in flight, per-command timeout (the socket is destroyed on expiry). Error messages carry the
 * server's text only after every known secret (user, password) has been replaced and the generic
 * redactor has run; the command line itself is never part of an error. This module does not log.
 */

export type ImapErrorCode = 'tls' | 'timeout' | 'auth' | 'no' | 'bad' | 'bye' | 'protocol' | 'size' | 'readonly' | 'closed' | 'config'

export class ImapError extends Error {
  constructor(
    readonly code: ImapErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ImapError'
  }
}

export interface ImapResponse {
  /** Text pieces of the response; a literal follows every piece except the last. */
  segments: string[]
  literals: Buffer[]
}

interface Pending {
  tag: string
  untagged: ImapResponse[]
  resolve: (r: { status: 'OK' | 'NO' | 'BAD'; text: string; untagged: ImapResponse[] }) => void
  reject: (e: Error) => void
}

export interface SessionOptions {
  timeoutMs: number
  /** Largest literal accepted (bytes). A bigger one aborts the connection. */
  maxLiteralBytes: number
  /** Values that must never appear in an error (user, password). */
  secrets: string[]
  maxLineBytes?: number
}

export type CommandPart = string | { literal: Buffer }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** RFC 3501 `date` for SEARCH SINCE (day granularity, server time zone). */
export function imapDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

/**
 * astring argument: a quoted string when the value is printable ASCII, else a synchronizing
 * literal (UTF-8 bytes). CR / LF / NUL are refused outright (they can never be part of a valid
 * user name, password or mailbox, and would allow command injection in a quoted string).
 */
export function astring(value: string): CommandPart[] {
  if (/[\r\n\0]/.test(value)) throw new ImapError('config', tr('Account, password and mailbox name cannot contain line breaks or NUL characters.', '账号、密码或邮箱名里不能有换行或 NUL 字符。'))
  if (/^[\x20-\x7e]*$/.test(value)) return [`"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`]
  return [{ literal: Buffer.from(value, 'utf8') }]
}

const FLAG_RE = /^\* (OK|NO|BAD|BYE|PREAUTH)\b/i

export class ImapSession {
  private chunks: Buffer[] = []
  private len = 0
  private literalNeed = -1
  private partial: ImapResponse = { segments: [], literals: [] }
  private greetingWaiter: { resolve: (r: ImapResponse) => void; reject: (e: Error) => void } | null = null
  private greetingSeen: ImapResponse | null = null
  private continuation: { resolve: () => void; reject: (e: Error) => void } | null = null
  private current: Pending | null = null
  private failed: Error | null = null
  private n = 0
  private loggingOut = false
  readonly maxLine: number
  /** Every command text sent (tags stripped, literal and quoted arguments masked) — for tests / audits. */
  readonly sentVerbs: string[] = []

  constructor(
    private readonly sock: Duplex,
    private readonly opts: SessionOptions
  ) {
    this.maxLine = opts.maxLineBytes ?? 64 * 1024
    sock.on('data', (c: Buffer) => this.onData(typeof c === 'string' ? Buffer.from(c, 'latin1') : c))
    sock.on('error', () => this.fail(new ImapError('closed', tr('The connection to the mail server failed.', '与邮件服务器的连接出错。'))))
    sock.on('close', () => this.fail(new ImapError('closed', tr('The mail server closed the connection.', '邮件服务器关闭了连接。'))))
    sock.on('end', () => this.fail(new ImapError('closed', tr('The mail server closed the connection.', '邮件服务器关闭了连接。'))))
  }

  /** Replace known secrets, then run the generic redactor; bounded length. */
  scrub(s: string): string {
    let out = s
    for (const sec of this.opts.secrets) if (sec && sec.length >= 1) out = out.split(sec).join('[redacted]')
    return redactForDisplay(out).slice(0, 200)
  }

  private fail(e: Error): void {
    if (this.failed) return
    // A BYE + close after LOGOUT is the normal end.
    if (this.loggingOut && !this.current) return
    this.failed = e
    this.greetingWaiter?.reject(e)
    this.greetingWaiter = null
    this.continuation?.reject(e)
    this.continuation = null
    this.current?.reject(e)
    this.current = null
    this.sock.destroy()
  }

  private merged(): Buffer {
    if (this.chunks.length !== 1) this.chunks = [Buffer.concat(this.chunks, this.len)]
    return this.chunks[0]
  }

  private consume(n: number): Buffer {
    const b = this.merged()
    const out = b.subarray(0, n)
    this.chunks = n < b.length ? [b.subarray(n)] : []
    this.len -= n
    return out
  }

  private onData(c: Buffer): void {
    if (this.failed) return
    this.chunks.push(c)
    this.len += c.length
    try {
      this.parse()
    } catch (e) {
      this.fail(e instanceof Error ? e : new ImapError('protocol', String(e)))
    }
  }

  private parse(): void {
    for (;;) {
      if (this.literalNeed >= 0) {
        if (this.len < this.literalNeed) return
        this.partial.literals.push(Buffer.from(this.consume(this.literalNeed)))
        this.literalNeed = -1
        continue
      }
      if (!this.len) return
      const b = this.merged()
      const idx = b.indexOf('\r\n')
      if (idx < 0) {
        if (this.len > this.maxLine) throw new ImapError('protocol', tr('The server sent an abnormally long line. Disconnected.', '服务器返回了异常长的一行，已断开。'))
        return
      }
      if (idx > this.maxLine) throw new ImapError('protocol', tr('The server sent an abnormally long line. Disconnected.', '服务器返回了异常长的一行，已断开。'))
      const line = this.consume(idx + 2).subarray(0, idx).toString('latin1')
      this.partial.segments.push(line)
      const lit = /\{(\d{1,12})\+?\}$/.exec(line)
      if (lit) {
        const n = Number(lit[1])
        if (n > this.opts.maxLiteralBytes) throw new ImapError('size', tr(`The server wanted to send ${n} bytes, over the ${this.opts.maxLiteralBytes} limit. Disconnected.`, `服务器要发送 ${n} 字节的数据，超过上限 ${this.opts.maxLiteralBytes}，已断开。`))
        this.literalNeed = n
        continue
      }
      const r = this.partial
      this.partial = { segments: [], literals: [] }
      this.dispatch(r)
    }
  }

  private dispatch(r: ImapResponse): void {
    const first = r.segments[0]
    if (!this.greetingSeen) {
      this.greetingSeen = r
      this.greetingWaiter?.resolve(r)
      this.greetingWaiter = null
      return
    }
    if (first.startsWith('+')) {
      const c = this.continuation
      this.continuation = null
      if (!c) throw new ImapError('protocol', tr('The server sent an unexpected continuation request.', '服务器发送了意外的继续请求。'))
      c.resolve()
      return
    }
    if (first.startsWith('* ')) {
      if (/^\* BYE\b/i.test(first) && !this.loggingOut) {
        throw new ImapError('bye', tr(`Server disconnected: ${this.scrub(first.slice(6))}`, `服务器断开：${this.scrub(first.slice(6))}`))
      }
      this.current?.untagged.push(r)
      return
    }
    const m = /^(\S+) (OK|NO|BAD)\b ?(.*)$/i.exec(first)
    if (!m || !this.current || m[1] !== this.current.tag) throw new ImapError('protocol', tr('Unrecognized server response.', '服务器的回应无法识别。'))
    const cur = this.current
    this.current = null
    cur.resolve({ status: m[2].toUpperCase() as 'OK' | 'NO' | 'BAD', text: m[3], untagged: cur.untagged })
  }

  private withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    return Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const e = new ImapError('timeout', tr(`${what} timed out (${Math.round(this.opts.timeoutMs / 1000)} s). Disconnected.`, `${what}超时（${Math.round(this.opts.timeoutMs / 1000)} 秒），已断开。`))
          this.fail(e)
          reject(e)
        }, this.opts.timeoutMs)
      })
    ]).finally(() => clearTimeout(timer))
  }

  async greeting(): Promise<'OK' | 'PREAUTH'> {
    if (this.failed) throw this.failed
    const r = this.greetingSeen ?? (await this.withTimeout(new Promise<ImapResponse>((resolve, reject) => (this.greetingWaiter = { resolve, reject })), tr('Waiting for the server greeting', '等待服务器问候')))
    const m = FLAG_RE.exec(r.segments[0])
    if (!m) throw new ImapError('protocol', tr('This does not look like an IMAP server (unrecognized greeting).', '这不像 IMAP 服务器（问候语无法识别）。'))
    const s = m[1].toUpperCase()
    if (s === 'BYE') throw new ImapError('bye', tr(`Server refused the connection: ${this.scrub(r.segments[0].slice(6))}`, `服务器拒绝连接：${this.scrub(r.segments[0].slice(6))}`))
    if (s !== 'OK' && s !== 'PREAUTH') throw new ImapError('protocol', tr('Unexpected server greeting.', '服务器问候语异常。'))
    return s
  }

  /** Send one command and wait for its tagged completion. NO / BAD → ImapError. */
  async command(parts: CommandPart[], what: string, opts: { noCode?: ImapErrorCode } = {}): Promise<{ text: string; untagged: ImapResponse[] }> {
    if (this.failed) throw this.failed
    if (this.current) throw new ImapError('protocol', 'internal: command already in flight')
    const tag = `L${String(++this.n).padStart(4, '0')}`
    const done = new Promise<{ status: 'OK' | 'NO' | 'BAD'; text: string; untagged: ImapResponse[] }>((resolve, reject) => {
      this.current = { tag, untagged: [], resolve, reject }
    })
    done.catch(() => undefined)
    this.sentVerbs.push(parts.map((p) => (typeof p === 'string' ? (p.startsWith('"') ? '"…"' : p) : '{literal}')).join(''))
    const run = async (): Promise<{ status: 'OK' | 'NO' | 'BAD'; text: string; untagged: ImapResponse[] }> => {
      let line = `${tag} `
      for (const p of parts) {
        if (typeof p === 'string') {
          line += p
          continue
        }
        line += `{${p.literal.length}}\r\n`
        const cont = new Promise<void>((resolve, reject) => (this.continuation = { resolve, reject }))
        this.sock.write(Buffer.from(line, 'latin1'))
        await cont
        this.sock.write(p.literal)
        line = ''
      }
      this.sock.write(Buffer.from(`${line}\r\n`, 'latin1'))
      return done
    }
    const r = await this.withTimeout(run(), what)
    if (r.status === 'OK') return { text: r.text, untagged: r.untagged }
    const msg = tr(
      `${what} failed (${r.status}): ${this.scrub(r.text) || 'no reason given by the server'}`,
      `${what}失败（${r.status}）：${this.scrub(r.text) || '服务器没有说明'}`
    )
    throw new ImapError(r.status === 'BAD' ? 'bad' : (opts.noCode ?? 'no'), msg)
  }

  async capability(): Promise<Set<string>> {
    const r = await this.command(['CAPABILITY'], tr('Query server capabilities', '查询服务器能力'))
    const caps = new Set<string>()
    for (const u of r.untagged) {
      const m = /^\* CAPABILITY (.*)$/i.exec(u.segments[0])
      if (m) for (const c of m[1].trim().split(/\s+/)) caps.add(c.toUpperCase())
    }
    if (!caps.has('IMAP4REV1') && !caps.has('IMAP4REV2')) throw new ImapError('protocol', tr('The server does not support IMAP4rev1.', '服务器不支持 IMAP4rev1。'))
    return caps
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(['LOGIN ', ...astring(user), ' ', ...astring(password)], tr('Sign-in', '登录'), { noCode: 'auth' })
  }

  /** RFC 2971 ID with a fixed client name only (no OS / version details). Failures are ignored. */
  async id(): Promise<void> {
    try {
      await this.command(['ID ("name" "Navalia")'], tr('Send client ID', '发送客户端标识'))
    } catch (e) {
      if (e instanceof ImapError && (e.code === 'timeout' || e.code === 'closed' || e.code === 'protocol' || e.code === 'size' || e.code === 'bye')) throw e
    }
  }

  /** EXAMINE = read-only SELECT. A server that answers [READ-WRITE] is refused. */
  async examine(mailbox: string): Promise<{ exists: number | null; uidValidity: string | null; readOnlyCode: boolean }> {
    const r = await this.command(['EXAMINE ', ...astring(encodeMailboxName(mailbox))], tr('Open mailbox (read-only)', `打开邮箱（只读）`))
    if (/\[READ-WRITE\]/i.test(r.text)) {
      throw new ImapError('readonly', tr('The server opened the mailbox as writable (it should be read-only). Stopped.', '服务器以可写方式打开了邮箱（应为只读），已停止。'))
    }
    let exists: number | null = null
    let uidValidity: string | null = null
    for (const u of r.untagged) {
      const e = /^\* (\d+) EXISTS$/i.exec(u.segments[0])
      if (e) exists = Number(e[1])
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(u.segments[0])
      if (v) uidValidity = v[1]
    }
    return { exists, uidValidity, readOnlyCode: /\[READ-ONLY\]/i.test(r.text) }
  }

  async uidSearchSince(since: Date): Promise<number[]> {
    const r = await this.command([`UID SEARCH SINCE ${imapDate(since)}`], tr('Search messages', '搜索邮件'))
    const out: number[] = []
    for (const u of r.untagged) {
      const m = /^\* SEARCH((?: \d+)*)\s*$/i.exec(u.segments[0])
      if (m) for (const x of m[1].trim().split(/\s+/).filter(Boolean)) out.push(Number(x))
    }
    return [...new Set(out)].filter((n) => Number.isSafeInteger(n) && n > 0).sort((a, b) => a - b)
  }

  async uidFetchSizes(uids: number[]): Promise<Map<number, number>> {
    const sizes = new Map<number, number>()
    for (let i = 0; i < uids.length; i += 200) {
      const set = uids.slice(i, i + 200).join(',')
      const r = await this.command([`UID FETCH ${set} (UID RFC822.SIZE)`], tr('Read message sizes', '读取邮件大小'))
      for (const u of r.untagged) {
        const t = u.segments.join(' ')
        if (!/^\* \d+ FETCH \(/i.test(t)) continue
        const uid = /\bUID (\d+)/i.exec(t)
        const size = /\bRFC822\.SIZE (\d+)/i.exec(t)
        if (uid && size) sizes.set(Number(uid[1]), Number(size[1]))
      }
    }
    return sizes
  }

  /** Whole message, without setting \Seen. Null when the server sent no body for this UID. */
  async uidFetchBody(uid: number): Promise<Buffer | null> {
    const r = await this.command([`UID FETCH ${uid} (UID BODY.PEEK[])`], tr('Read message', '读取邮件'))
    for (const u of r.untagged) {
      if (!/^\* \d+ FETCH \(/i.test(u.segments[0])) continue
      const all = u.segments.join(' ')
      const m = /\bUID (\d+)/i.exec(all)
      if (!m || Number(m[1]) !== uid) continue
      for (let i = 0; i < u.literals.length; i++) {
        if (/BODY\[\]\s*\{\d+\+?\}$/i.test(u.segments[i])) return u.literals[i]
      }
      const q = /BODY\[\] "((?:[^"\\]|\\.)*)"/i.exec(all)
      if (q) return Buffer.from(q[1].replace(/\\(.)/g, '$1'), 'latin1')
    }
    return null
  }

  async logout(): Promise<void> {
    if (this.failed) return
    this.loggingOut = true
    try {
      await this.command(['LOGOUT'], tr('Sign-out', '退出登录'))
    } catch {
      /* best effort */
    } finally {
      this.sock.end()
    }
  }
}
