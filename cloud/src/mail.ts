// Outgoing mail: transport (nodemailer SMTP or .eml outbox), message builders, header safety.
//
// Why nodemailer: hand-rolling SMTP (STARTTLS, AUTH, dot-stuffing) and MIME (RFC 2047 encoded
// words for UTF-8 subjects/names, multipart/alternative, line folding) is error-prone; nodemailer
// is the standard implementation and has zero runtime dependencies.
//
// Privacy: nothing in this module logs. Errors carry only a fixed code (never the address,
// subject, body or the server's SMTP reply text).

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import nodemailer from 'nodemailer'
import type { MailConfig } from './config.ts'
import { esc } from './html.ts'

export interface OutgoingMail {
  to: string
  fromName: string
  subject: string
  text: string
  html: string
  headers?: Record<string, string>
}

export class MailSendError extends Error {
  readonly code: string
  readonly permanent: boolean
  constructor(code: string, permanent: boolean) {
    super(code)
    this.code = code
    this.permanent = permanent
  }
}

export interface Mailer {
  send(m: OutgoingMail): Promise<void>
  close(): void
}

/** CR, LF, NUL or any other C0/DEL control character → unsafe in a header value. */
const UNSAFE_HEADER = /[\u0000-\u0008\u000a-\u001f\u007f]/

export function assertHeaderSafe(m: OutgoingMail, from: string): void {
  const values = [m.to, m.fromName, m.subject, from, ...Object.keys(m.headers ?? {}), ...Object.values(m.headers ?? {})]
  for (const v of values) if (UNSAFE_HEADER.test(v)) throw new MailSendError('header_unsafe', true)
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

function classify(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err
  const code = (err as { responseCode?: unknown } | null)?.responseCode
  if (typeof code === 'number' && code >= 500 && code < 600) return new MailSendError('smtp_rejected', true)
  if (typeof code === 'number' && code >= 400 && code < 500) return new MailSendError('smtp_temporary', false)
  return new MailSendError('smtp_unavailable', false)
}

type Transporter = ReturnType<typeof nodemailer.createTransport>

function wrap(transporter: Transporter, from: string, after?: (raw: Buffer) => void): Mailer {
  return {
    async send(m) {
      assertHeaderSafe(m, from)
      let info: unknown
      try {
        info = await transporter.sendMail({
          from: { name: m.fromName, address: from },
          to: m.to,
          subject: m.subject,
          text: m.text,
          html: m.html,
          headers: m.headers,
          disableFileAccess: true,
          disableUrlAccess: true
        })
      } catch (err) {
        throw classify(err)
      }
      if (after) after((info as { message: Buffer }).message)
    },
    close() {
      transporter.close()
    }
  }
}

/** null when mail is disabled. */
export function createMailer(cfg: MailConfig): Mailer | null {
  if (cfg.mode === 'smtp') {
    const s = cfg.smtp
    const transporter = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      // Plain connections must upgrade with STARTTLS, except to a loopback relay (dev / tests).
      requireTLS: !s.secure && !isLoopback(s.host),
      ignoreTLS: !s.secure && isLoopback(s.host),
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true
    })
    return wrap(transporter, cfg.from)
  }
  if (cfg.mode === 'outbox') {
    const dir = cfg.outboxDir
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    return wrap(transporter, cfg.from, (raw) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // File name carries no address or subject.
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.eml`)
      writeFileSync(file, raw, { mode: 0o600 })
      chmodSync(file, 0o600)
    })
  }
  return null
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***@${email.slice(at + 1).toLowerCase()}`
}

export const DEFAULT_FROM_NAME = 'Persome 周信'

/** Publisher display name for the From header; falls back when absent or not header-safe. */
export function fromNameFor(displayName: string | null): string {
  if (!displayName) return DEFAULT_FROM_NAME
  const t = displayName.trim()
  if (t === '' || UNSAFE_HEADER.test(t)) return DEFAULT_FROM_NAME
  return t
}

/** Escaped, paragraph-only rendering. No links are generated or rewritten; no images. */
export function simpleHtml(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '')
    .map((p) => `<p>${p.split('\n').map(esc).join('<br>')}</p>`)
    .join('\n')
}

export interface LetterMailInput {
  to: string
  fromName: string
  title: string
  markdown: string
  unsubscribeUrl: string
  origin: string
}

export function letterMail(i: LetterMailInput): OutgoingMail {
  const footerText =
    `你收到这封邮件，是因为你在 ${i.origin} 订阅了「${i.fromName}」的周信。\n` + `退订（一键，无需登录）：${i.unsubscribeUrl}\n`
  const text = `${i.markdown.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n\n-- \n${footerText}`
  const html =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(i.title)}</title></head><body>\n` +
    `${simpleHtml(i.markdown)}\n<hr>\n` +
    `<p>你收到这封邮件，是因为你在 ${esc(i.origin)} 订阅了「${esc(i.fromName)}」的周信。` +
    `<a href="${esc(i.unsubscribeUrl)}">退订</a></p>\n</body></html>\n`
  return {
    to: i.to,
    fromName: i.fromName,
    subject: i.title,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${i.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  }
}

export function confirmMail(to: string, publisherName: string, confirmUrl: string, origin: string): OutgoingMail {
  const text =
    `有人（希望是你）在 ${origin} 用这个地址订阅了「${publisherName}」的周信。\n\n` +
    `确认订阅（48 小时内有效）：${confirmUrl}\n\n` +
    `如果不是你本人操作，忽略这封邮件即可，你不会再收到任何邮件。\n`
  const html =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>请确认订阅</title></head><body>\n` +
    `<p>有人（希望是你）在 ${esc(origin)} 用这个地址订阅了「${esc(publisherName)}」的周信。</p>\n` +
    `<p><a href="${esc(confirmUrl)}">确认订阅</a>（48 小时内有效）</p>\n` +
    `<p>如果不是你本人操作，忽略这封邮件即可，你不会再收到任何邮件。</p>\n</body></html>\n`
  return { to, fromName: publisherName, subject: `请确认订阅「${publisherName}」的周信`, text, html }
}
