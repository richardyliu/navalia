// Helpers for C8 (cards) and C9 (letters / subscriptions) tests.
// Signing is re-implemented here with node:crypto and an independent sorted-keys serializer
// (not src/canonical.ts), so the server verifier is checked against a second implementation.

import { randomBytes, randomUUID, sign } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import type { Mailer, OutgoingMail } from '../src/mail.ts'
import { MailSendError } from '../src/mail.ts'
import { bearer, postJson, type TestKey } from './helpers.ts'

/** RFC 8785 for the value shapes used here (ASCII/BMP strings, finite numbers). */
export function sortedJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`)
    .join(',')}}`
}

export interface CardOpts {
  displayName?: string | null
  summary?: string | null
  issuedAt?: string
}

export function cardBody(key: TestKey, o: CardOpts = {}): Record<string, unknown> {
  return {
    format: 'navalia.card',
    version: 1,
    card_id: `card_${randomBytes(16).toString('hex')}`,
    issued_at: o.issuedAt ?? '2026-11-05T05:10:23.852Z',
    issuer: { alg: 'Ed25519', public_key: key.publicKey, fingerprint: key.fingerprint },
    content: {
      front: {
        display_name: o.displayName === undefined ? '小明' : o.displayName,
        summary: o.summary === undefined ? '喜欢写代码' : o.summary,
        summary_confidence: 0.75,
        summary_observations: 12,
        highlights: [{ level: 'volume', signature: '工程', observations: 3, confidence: 0.5 }],
        as_of: '2026-11-05T05:10:19.002Z',
        model_status: 'ok',
        degraded: false
      },
      back: {
        mini_map: {
          nodes: [
            { key: 'r0', level: 'root', label: '根', observations: 12, confidence: 0.75, member_count: 1 },
            { key: 'v1', level: 'volume', label: '工程', observations: 3, confidence: 0.5, member_count: 2 }
          ],
          edges: [{ from: 'r0', to: 'v1' }]
        },
        stats: { points: 10, evolution_lines: 1, relation_lines: 2, faces: 0, volumes: 1, roots: 1 }
      }
    }
  }
}

/** Signs like Lens signCard and serializes like writeCardFile (pretty JSON + newline). */
export function signedCardText(key: TestKey, card: Record<string, unknown> = cardBody(key), signer: TestKey = key): string {
  const value = sign(null, Buffer.from(sortedJson(card), 'utf8'), signer.privateKey).toString('base64url')
  return `${JSON.stringify({ card, signature: { alg: 'Ed25519', key_fingerprint: key.fingerprint, value } }, null, 2)}\n`
}

export interface LetterOpts {
  issueId?: string
  week?: string
  title?: string
  markdown?: string
  createdAt?: string
}

export function letterUnsigned(key: TestKey, o: LetterOpts = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: 'persome-letter',
    issue_id: o.issueId ?? randomUUID(),
    week: o.week ?? '2026-W45',
    title: o.title ?? '第 45 周：本周小结',
    markdown: o.markdown ?? '# 本周\n\n做了很多事。\n\n链接：https://example.org/a?b=1',
    created_at: o.createdAt ?? '2026-11-05T08:00:00.000Z',
    signer: { public_key: key.publicKey, fingerprint: key.fingerprint }
  }
}

export function signLetter(unsigned: Record<string, unknown>, signer: TestKey): string {
  const msg = Buffer.from(`persome-letter-v1\n${sortedJson(unsigned)}`, 'utf8')
  const signature = sign(null, msg, signer.privateKey).toString('base64url')
  return sortedJson({ ...unsigned, signature })
}

export function letterText(key: TestKey, o: LetterOpts = {}, signer: TestKey = key): string {
  return signLetter(letterUnsigned(key, o), signer)
}

export async function putCard(base: string, token: string, card: string): Promise<Response> {
  return fetch(base + '/v1/cards', { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(token) }, body: JSON.stringify({ card }) })
}

export async function postLetter(base: string, token: string, letter: string): Promise<Response> {
  return postJson(base, '/v1/letters', { letter }, bearer(token))
}

export async function subscribeJson(base: string, publisher: string, email: string): Promise<Response> {
  return postJson(base, '/v1/subscribe', { publisher, email })
}

export async function postForm(base: string, path: string, form: Record<string, string>): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
}

// ───────────── in-memory mailer ─────────────

export interface RecordingMailer {
  mailer: Mailer
  sent: OutgoingMail[]
  attempts: number
  /** Return an error to make the next send(s) fail. */
  failWith: ((m: OutgoingMail) => MailSendError | null) | null
}

export function recordingMailer(): RecordingMailer {
  const r: RecordingMailer = {
    sent: [],
    attempts: 0,
    failWith: null,
    mailer: {
      async send(m) {
        r.attempts++
        const e = r.failWith?.(m) ?? null
        if (e) throw e
        r.sent.push(m)
      },
      close() {}
    }
  }
  return r
}

export function tokenFrom(text: string, path: string): string {
  const m = new RegExp(`${path.replace(/[/?]/g, (c) => `\\${c}`)}\\?token=([^\\s"<>&]+)`).exec(text)
  if (!m) throw new Error(`no ${path} link in mail`)
  return decodeURIComponent(m[1])
}

// ───────────── fake SMTP server (node:net, loopback only) ─────────────

export interface SmtpMessage {
  from: string
  to: string[]
  data: string
}

export interface FakeSmtp {
  port: number
  messages: SmtpMessage[]
  connections: number
  /** Reply to RCPT TO (default 250). */
  rcptReply: () => string
  close(): Promise<void>
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const sockets = new Set<Socket>()
  const st: FakeSmtp = {
    port: 0,
    messages: [],
    connections: 0,
    rcptReply: () => '250 2.1.5 OK',
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }
  const server: Server = createServer((sock) => {
    st.connections++
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => undefined)
    sock.setEncoding('utf8')
    let buf = ''
    let inData = false
    let cur: SmtpMessage = { from: '', to: [], data: '' }
    const w = (s: string): void => {
      if (!sock.destroyed) sock.write(`${s}\r\n`)
    }
    w('220 fake.smtp.test ESMTP')
    sock.on('data', (chunk: string) => {
      buf += chunk
      for (;;) {
        if (inData) {
          const i = buf.indexOf('\r\n.\r\n')
          if (i === -1) return
          cur.data = buf
            .slice(0, i)
            .split('\r\n')
            .map((l) => (l.startsWith('..') ? l.slice(1) : l))
            .join('\r\n')
          buf = buf.slice(i + 5)
          inData = false
          st.messages.push(cur)
          cur = { from: '', to: [], data: '' }
          w('250 2.0.0 queued')
          continue
        }
        const i = buf.indexOf('\r\n')
        if (i === -1) return
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO') {
          w('250-fake.smtp.test')
          w('250-8BITMIME')
          w('250 SMTPUTF8')
        } else if (cmd === 'HELO') w('250 fake.smtp.test')
        else if (cmd === 'MAIL') {
          cur.from = /<([^>]*)>/.exec(line)?.[1] ?? ''
          w('250 2.1.0 OK')
        } else if (cmd === 'RCPT') {
          const reply = st.rcptReply()
          if (reply.startsWith('250')) cur.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
          w(reply)
        } else if (cmd === 'DATA') {
          if (cur.to.length === 0) w('554 5.5.1 no valid recipients')
          else {
            inData = true
            w('354 go ahead')
          }
        } else if (cmd === 'RSET') {
          cur = { from: '', to: [], data: '' }
          w('250 OK')
        } else if (cmd === 'QUIT') {
          w('221 bye')
          sock.end()
        } else w('250 OK')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  st.port = typeof addr === 'object' && addr ? addr.port : 0
  return st
}

/** Decodes a quoted-printable or base64 MIME body part (enough for assertions). */
export function decodePart(raw: string, encoding: string): string {
  if (/base64/i.test(encoding)) return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (/quoted-printable/i.test(encoding)) {
    const bytes = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    return Buffer.from(bytes, 'latin1').toString('utf8')
  }
  return raw
}

/** Decodes RFC 2047 encoded words (B and Q). */
export function decodeWords(v: string): string {
  return v.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, enc: string, t: string) =>
    enc.toUpperCase() === 'B' ? Buffer.from(t, 'base64').toString('utf8') : decodePart(t.replace(/_/g, ' '), 'quoted-printable')
  )
}

export interface ParsedMail {
  headers: string
  text: string
  html: string
}

/** Splits a multipart/alternative message into its decoded text and html parts. */
export function parseMime(data: string): ParsedMail {
  const sep = data.indexOf('\r\n\r\n')
  const headers = data.slice(0, sep).replace(/\r\n[ \t]+/g, ' ') // unfold
  const b = /boundary="?([^"\r\n;]+)"?/.exec(headers)?.[1]
  const out: ParsedMail = { headers, text: '', html: '' }
  if (!b) return out
  for (const part of data.slice(sep + 4).split(`--${b}`)) {
    const ps = part.indexOf('\r\n\r\n')
    if (ps === -1) continue
    const ph = part.slice(0, ps)
    const body = part.slice(ps + 4).replace(/\r\n$/, '')
    const enc = /Content-Transfer-Encoding:\s*(\S+)/i.exec(ph)?.[1] ?? '7bit'
    if (/text\/plain/i.test(ph)) out.text = decodePart(body, enc)
    if (/text\/html/i.test(ph)) out.html = decodePart(body, enc)
  }
  return out
}
