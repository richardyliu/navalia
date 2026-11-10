import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'
import type { SecretBox } from '../../src/main/identity/secret-box'
import { encodeMailboxName } from '../../src/main/connectors/imap/utf7'

/**
 * TEST DOUBLES for C19 IMAP: an in-memory duplex pair, a scripted IMAP4rev1 server that records
 * every command it receives, and an AES-GCM SecretBox with a per-test random key (stands in for
 * Electron safeStorage). No network here — the TLS tests wrap the same server in a loopback
 * tls.Server.
 */

export function duplexPair(): [Duplex, Duplex] {
  // eslint-disable-next-line prefer-const
  let b: Duplex
  const a: Duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      b.push(chunk)
      cb()
    },
    final(cb) {
      b.push(null)
      cb()
    }
  })
  b = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      a.push(chunk)
      cb()
    },
    final(cb) {
      a.push(null)
      cb()
    }
  })
  return [a, b]
}

export interface FakeMessage {
  uid: number
  raw: string | Buffer
}

export interface FakeImapOptions {
  user: string
  pass: string
  mailboxes: Record<string, FakeMessage[]>
  greeting?: string
  caps?: string
  /** NO text for a failed login; `{pass}` is replaced with the password the client sent (hostile server). */
  loginNo?: string
  examineCode?: 'READ-ONLY' | 'READ-WRITE' | ''
  /** Stop answering after receiving this verb (timeout tests). */
  silentOn?: string
  /** Report RFC822.SIZE smaller than the real message (lying server). */
  lieSize?: boolean
  /** Write responses in pieces of this many bytes (literal / line boundary tests). */
  pieceBytes?: number
  /** NetEase-style: EXAMINE refused until ID was sent. */
  idRequired?: boolean
  /** BAD for this verb. */
  badOn?: string
}

export class FakeImapServer {
  /** Complete commands as received (literal bytes inlined as `{literal:<utf8>}`). */
  readonly commands: string[] = []
  readonly verbs: string[] = []
  readonly literals: Buffer[] = []
  private buf = Buffer.alloc(0)
  private pendingText = ''
  private pendingLits: Buffer[] = []
  private need = -1
  private idSent = false
  private silent = false

  constructor(
    private readonly sock: Duplex,
    private readonly o: FakeImapOptions
  ) {
    sock.on('data', (c: Buffer) => this.onData(c))
    sock.on('error', () => undefined)
    this.send(`${o.greeting ?? '* OK [CAPABILITY IMAP4rev1] Fake ready'}\r\n`)
  }

  private send(s: string | Buffer): void {
    if (this.sock.destroyed) return
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s
    const n = this.o.pieceBytes
    if (!n) {
      this.sock.write(b)
      return
    }
    for (let i = 0; i < b.length; i += n) this.sock.write(b.subarray(i, i + n))
  }

  private onData(c: Buffer): void {
    this.buf = Buffer.concat([this.buf, c])
    for (;;) {
      if (this.need >= 0) {
        if (this.buf.length < this.need) return
        const lit = this.buf.subarray(0, this.need)
        this.buf = this.buf.subarray(this.need)
        this.pendingLits.push(Buffer.from(lit))
        this.literals.push(Buffer.from(lit))
        this.pendingText += `\u0001${this.pendingLits.length - 1}\u0001`
        this.need = -1
        continue
      }
      const i = this.buf.indexOf('\r\n')
      if (i < 0) return
      const line = this.buf.subarray(0, i).toString('latin1')
      this.buf = this.buf.subarray(i + 2)
      const m = /\{(\d+)\}$/.exec(line)
      if (m) {
        this.pendingText += line.slice(0, -m[0].length)
        this.need = Number(m[1])
        this.send('+ Ready for literal\r\n')
        continue
      }
      const full = this.pendingText + line
      const lits = this.pendingLits
      this.pendingText = ''
      this.pendingLits = []
      this.handle(full, lits)
    }
  }

  /** Tokenize arguments: atoms, quoted strings (with \" \\), literal placeholders. */
  private args(s: string, lits: Buffer[]): string[] {
    const out: string[] = []
    let i = 0
    while (i < s.length) {
      if (s[i] === ' ') {
        i++
        continue
      }
      if (s[i] === '"') {
        let v = ''
        i++
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\') i++
          v += s[i++]
        }
        i++
        out.push(v)
      } else if (s[i] === '\u0001') {
        const e = s.indexOf('\u0001', i + 1)
        out.push(lits[Number(s.slice(i + 1, e))].toString('utf8'))
        i = e + 1
      } else {
        const e = s.indexOf(' ', i)
        out.push(s.slice(i, e < 0 ? s.length : e))
        i = e < 0 ? s.length : e
      }
    }
    return out
  }

  private handle(line: string, lits: Buffer[]): void {
    const sp = line.indexOf(' ')
    const tag = line.slice(0, sp)
    let rest = line.slice(sp + 1)
    let verb = rest.split(' ')[0].toUpperCase()
    if (verb === 'UID') {
      verb = `UID ${rest.split(' ')[1].toUpperCase()}`
    }
    this.commands.push(line.replace(/\u0001(\d+)\u0001/g, (_m, n: string) => `{literal:${lits[Number(n)].toString('utf8')}}`))
    this.verbs.push(verb)
    if (this.silent) return
    if (this.o.silentOn === verb) {
      this.silent = true
      return
    }
    if (this.o.badOn === verb) {
      this.send(`${tag} BAD Command not understood\r\n`)
      return
    }
    rest = rest.slice(verb.length).trim()
    const box = (name: string): FakeMessage[] | null => {
      for (const [k, v] of Object.entries(this.o.mailboxes)) if (encodeMailboxName(k) === name) return v
      return null
    }
    switch (verb) {
      case 'CAPABILITY':
        this.send(`* CAPABILITY IMAP4rev1 ${this.o.caps ?? 'LITERAL+ ID'}\r\n${tag} OK CAPABILITY completed\r\n`)
        return
      case 'LOGIN': {
        const [u, p] = this.args(rest, lits)
        if (u === this.o.user && p === this.o.pass) this.send(`${tag} OK LOGIN completed\r\n`)
        else this.send(`${tag} NO ${(this.o.loginNo ?? '[AUTHENTICATIONFAILED] Invalid credentials').replace('{pass}', p ?? '')}\r\n`)
        return
      }
      case 'ID':
        this.idSent = true
        this.send(`* ID NIL\r\n${tag} OK ID completed\r\n`)
        return
      case 'EXAMINE':
      case 'SELECT': {
        const [name] = this.args(rest, lits)
        const msgs = box(name)
        if (!msgs) {
          this.send(`${tag} NO [NONEXISTENT] Unknown mailbox\r\n`)
          return
        }
        if (this.o.idRequired && !this.idSent) {
          this.send(`${tag} NO ${verb} Unsafe Login. Please contact kefu@188.com for help\r\n`)
          return
        }
        const code = verb === 'SELECT' ? 'READ-WRITE' : (this.o.examineCode ?? 'READ-ONLY')
        this.send(`* ${msgs.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 42] UIDs valid\r\n* FLAGS (\\Seen \\Answered)\r\n${tag} OK ${code ? `[${code}] ` : ''}${verb} completed\r\n`)
        this.current = msgs
        return
      }
      case 'UID SEARCH':
        this.send(`* SEARCH ${(this.current ?? []).map((m) => m.uid).join(' ')}\r\n${tag} OK SEARCH completed\r\n`)
        return
      case 'UID FETCH': {
        const [set, ...what] = rest.split(' ')
        const uids = set.split(',').map(Number)
        const msgs = (this.current ?? []).filter((m) => uids.includes(m.uid))
        const items = what.join(' ')
        for (const m of msgs) {
          const seq = (this.current ?? []).indexOf(m) + 1
          const raw = typeof m.raw === 'string' ? Buffer.from(m.raw, 'utf8') : m.raw
          if (/RFC822\.SIZE/i.test(items)) this.send(`* ${seq} FETCH (UID ${m.uid} RFC822.SIZE ${this.o.lieSize ? 10 : raw.length})\r\n`)
          else if (/BODY\.PEEK\[\]/i.test(items)) {
            // Unsolicited flag update first (must be ignored), then the body literal.
            this.send(`* ${seq} FETCH (FLAGS (\\Seen))\r\n`)
            this.send(Buffer.concat([Buffer.from(`* ${seq} FETCH (UID ${m.uid} BODY[] {${raw.length}}\r\n`, 'latin1'), raw, Buffer.from(')\r\n', 'latin1')]))
          }
        }
        this.send(`${tag} OK FETCH completed\r\n`)
        return
      }
      case 'LOGOUT':
        this.send(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`)
        this.sock.end()
        return
      default:
        this.send(`${tag} BAD Unknown command\r\n`)
    }
  }

  private current: FakeMessage[] | null = null
}

/** AES-256-GCM box with a random per-instance key — a test stand-in for Electron safeStorage. */
export function testSecretBox(available = true): SecretBox {
  const key = randomBytes(32)
  return {
    id: 'test-aes-gcm',
    isAvailable: () => available,
    encrypt(plain) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([c.update(plain), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), body])
    },
    decrypt(buf) {
      const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
      d.setAuthTag(buf.subarray(12, 28))
      return Buffer.concat([d.update(buf.subarray(28)), d.final()])
    }
  }
}

export function mail(opts: { id: string; subject: string; from?: string; body?: string; date?: string }): string {
  return [
    `From: ${opts.from ?? 'Alice <alice@example.test>'}`,
    'To: Bob <bob@example.test>',
    `Subject: ${opts.subject}`,
    `Date: ${opts.date ?? 'Tue, 03 Nov 2026 10:00:00 +0800'}`,
    `Message-ID: <${opts.id}@example.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body ?? 'Hello\r\nLine two'
  ].join('\r\n')
}
