// C19 IMAP: protocol layer over an in-memory duplex (fake server), TLS-only transport against a
// loopback tls.Server with a self-signed certificate generated at test time by the `openssl` CLI
// (node:crypto cannot mint X.509; the TLS block is skipped when openssl is missing), and the
// service / IPC layer (consent, SecretBox storage, nothing secret in renderer-visible results).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fetchImapMessages, type ImapTransport } from '../../src/main/connectors/imap/fetch'
import { astring, ImapError, imapDate } from '../../src/main/connectors/imap/protocol'
import { connectImapTls } from '../../src/main/connectors/imap/tls'
import { encodeMailboxName } from '../../src/main/connectors/imap/utf7'
import { registerConnectorHandlers } from '../../src/main/connectors/ipc'
import { createConnectorService } from '../../src/main/connectors/service'
import { grantAll } from './consent-helper'
import { duplexPair, FakeImapServer, mail, testSecretBox, type FakeImapOptions } from './fake-imap'
import { rmTmp, tmpDir } from './tmp-helper'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const PASS = 'p"a\\ss-SECRET-7731'
const USER = 'owner@example.test'
const CRED = { host: 'imap.example.test', port: 993, user: USER, password: PASS, mailbox: 'INBOX' }

function fake(o: Partial<FakeImapOptions> = {}): { transport: ImapTransport; server: () => FakeImapServer } {
  let srv: FakeImapServer | null = null
  return {
    transport: async () => {
      const [client, server] = duplexPair()
      srv = new FakeImapServer(server, {
        user: USER,
        pass: PASS,
        mailboxes: {
          INBOX: [
            { uid: 101, raw: mail({ id: 'm1', subject: 'Quarterly Zephyr plan' }) },
            { uid: 102, raw: mail({ id: 'm2', subject: '第二封 邮件', body: 'token sk-ant-api03-FIXTUREFIXTUREFIXTURE here' }) },
            { uid: 103, raw: mail({ id: 'm3', subject: 'Third' }) }
          ],
          已发送: [{ uid: 7, raw: mail({ id: 's1', subject: 'Sent one' }) }]
        },
        ...o
      })
      return client
    },
    server: () => srv!
  }
}

const READ_ONLY_VERBS = new Set(['CAPABILITY', 'LOGIN', 'ID', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'LOGOUT'])

describe('IMAP protocol (in-memory fake server)', () => {
  it('logs in with quoted-escaped args, EXAMINEs (never SELECT), searches, fetches literals, logs out', async () => {
    const f = fake({ pieceBytes: 7 })
    const r = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 10, now: () => Date.parse('2026-11-06T00:00:00Z') }, f.transport)
    const srv = f.server()
    expect(r.messages.map((m) => m.uid)).toEqual([101, 102, 103])
    expect(r.messages[1].raw.toString('utf8')).toContain('Subject: 第二封 邮件')
    expect(r.found).toBe(3)
    // The server parsed the exact credentials from the quoted (escaped) strings.
    expect(srv.commands.find((c) => c.includes('LOGIN'))).toBe(`L0002 LOGIN "${USER}" "p\\"a\\\\ss-SECRET-7731"`)
    expect(srv.verbs).toContain('EXAMINE')
    expect(srv.verbs).not.toContain('SELECT')
    expect(srv.verbs.every((v) => READ_ONLY_VERBS.has(v))).toBe(true)
    expect(srv.commands.some((c) => /UID SEARCH SINCE 30-Oct-2026$/.test(c))).toBe(true)
    expect(srv.commands.filter((c) => /BODY\.PEEK\[\]/.test(c))).toHaveLength(3)
    expect(srv.commands.some((c) => /BODY\[\]/.test(c.replace('BODY.PEEK[]', '')))).toBe(false)
    expect(srv.verbs[srv.verbs.length - 1]).toBe('LOGOUT')
    // Command log returned to callers masks quoted arguments.
    expect(r.commands.join('\n')).not.toContain(PASS)
    expect(r.commands.join('\n')).not.toContain(USER)
  })

  it('non-ASCII password and mailbox: synchronizing literal + modified UTF-7', async () => {
    const pass = '密码-ünïcode'
    const f = fake({ pass, mailboxes: { 已发送: [{ uid: 7, raw: mail({ id: 's1', subject: 'Sent one' }) }] } })
    const r = await fetchImapMessages({ ...CRED, password: pass, mailbox: '已发送' }, { sinceDays: 30, maxMessages: 5 }, f.transport)
    expect(r.messages.map((m) => m.uid)).toEqual([7])
    expect(f.server().literals.map((l) => l.toString('utf8'))).toContain(pass)
    expect(f.server().commands.find((c) => c.includes('EXAMINE'))).toContain(`"${encodeMailboxName('已发送')}"`)
    expect(encodeMailboxName('已发送')).toBe('&XfJT0ZAB-')
    expect(encodeMailboxName('A&B')).toBe('A&-B')
  })

  it('newest N only; size cap skips big messages before fetching them; total budget', async () => {
    const big = mail({ id: 'big', subject: 'Big', body: 'x'.repeat(5000) })
    const f = fake({ mailboxes: { INBOX: [1, 2, 3, 4].map((uid) => ({ uid, raw: uid === 3 ? big : mail({ id: `u${uid}`, subject: `S${uid}` }) })) } })
    const r = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 3, maxMessageBytes: 2000 }, f.transport)
    expect(r.messages.map((m) => m.uid)).toEqual([2, 4])
    expect(r.skippedTooLarge).toBe(1)
    expect(f.server().commands.filter((c) => /BODY\.PEEK/.test(c)).map((c) => c.split(' ')[3])).toEqual(['4', '2'])
    expect(r.warnings.join()).toMatch(/只读取最新的 3 封/)
    const g = fake()
    const r2 = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 10, maxTotalBytes: 300 }, g.transport)
    expect(r2.messages.length).toBeLessThan(3)
    expect(r2.skippedBudget).toBeGreaterThan(0)
  })

  it('a server lying about RFC822.SIZE cannot push a literal over the cap', async () => {
    const f = fake({ lieSize: true, mailboxes: { INBOX: [{ uid: 1, raw: mail({ id: 'l', subject: 'L', body: 'y'.repeat(200_000) }) }] } })
    const err = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 5, maxMessageBytes: 1000 }, f.transport).catch((e) => e)
    expect(err).toBeInstanceOf(ImapError)
    expect(err.code).toBe('size')
  })

  it('NO on LOGIN → auth error; the password never appears even when the server echoes it', async () => {
    const f = fake({ pass: 'other', loginNo: '[AUTHENTICATIONFAILED] bad password {pass} for user' })
    const err = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 5 }, f.transport).catch((e) => e)
    expect(err).toBeInstanceOf(ImapError)
    expect(err.code).toBe('auth')
    expect(err.message).toMatch(/登录失败/)
    expect(err.message).not.toContain('SECRET-7731')
    expect(err.message).not.toContain(PASS)
    expect(err.message).not.toContain(USER)
    expect(JSON.stringify(err)).not.toContain('SECRET-7731')
    expect(String(err.stack)).not.toContain('SECRET-7731')
  })

  it('BAD → bad; READ-WRITE answer to EXAMINE → refused; LOGINDISABLED → refused; BYE greeting', async () => {
    const bad = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 5 }, fake({ badOn: 'UID SEARCH' }).transport).catch((e) => e)
    expect(bad.code).toBe('bad')
    const rw = fake({ examineCode: 'READ-WRITE' })
    const e2 = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 5 }, rw.transport).catch((e) => e)
    expect(e2.code).toBe('readonly')
    expect(rw.server().verbs).not.toContain('UID FETCH')
    const ld = fake({ caps: 'LOGINDISABLED AUTH=XOAUTH2' })
    const e3 = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 5 }, ld.transport).catch((e) => e)
    expect(e3.code).toBe('auth')
    expect(ld.server().verbs).not.toContain('LOGIN')
    const e4 = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 5 }, fake({ greeting: '* BYE Too many connections' }).transport).catch((e) => e)
    expect(e4.code).toBe('bye')
  })

  it('missing [READ-ONLY] code is tolerated with a warning; NetEase-style ID requirement is met', async () => {
    const r = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 1 }, fake({ examineCode: '' }).transport)
    expect(r.warnings.join()).toMatch(/只读/)
    const f = fake({ idRequired: true })
    const r2 = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 1 }, f.transport)
    expect(r2.messages).toHaveLength(1)
    expect(f.server().commands.find((c) => c.includes(' ID '))).toBe('L0003 ID ("name" "Navalia")')
  })

  it('timeout: a silent server is abandoned after timeoutMs', async () => {
    const t0 = Date.now()
    const err = await fetchImapMessages(CRED, { sinceDays: 7, maxMessages: 5, timeoutMs: 150 }, fake({ silentOn: 'EXAMINE' }).transport).catch((e) => e)
    expect(err.code).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('CR / LF / NUL in credentials are refused before anything is sent', () => {
    expect(() => astring('a\r\nL0003 DELETE INBOX')).toThrow(ImapError)
    expect(() => astring('x\0y')).toThrow(/换行或 NUL/)
    expect(astring('plain')).toEqual(['"plain"'])
    expect(astring('中文')).toEqual([{ literal: Buffer.from('中文', 'utf8') }])
    expect(imapDate(new Date('2026-02-01T05:00:00Z'))).toBe('1-Feb-2026')
  })

  it('only read-only commands exist in the protocol module (static)', () => {
    const src = fs.readFileSync(path.resolve('src/main/connectors/imap/protocol.ts'), 'utf8')
    const sent = [...src.matchAll(/this\.command\(\[\s*[`'"]([A-Z]+(?: [A-Z]+)?)/g)].map((m) => m[1])
    expect(new Set(sent)).toEqual(new Set(['CAPABILITY', 'LOGIN', 'ID', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'LOGOUT']))
    for (const f of fs.readdirSync(path.resolve('src/main/connectors/imap'))) {
      const s = fs.readFileSync(path.resolve('src/main/connectors/imap', f), 'utf8')
      expect(s, f).not.toMatch(/rejectUnauthorized:\s*false/)
      expect(s, f).not.toMatch(/['"`](?:STARTTLS|SELECT |STORE |EXPUNGE|APPEND |COPY |MOVE |DELETE )/)
      expect(s, f).not.toMatch(/console\.(log|error|warn|info|debug)/)
    }
  })
})

// ─── TLS only ────────────────────────────────────────────────────────────

const HAVE_OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0

describe.skipIf(!HAVE_OPENSSL)('IMAP transport: implicit TLS only (loopback, self-signed cert from openssl)', () => {
  let dir: string
  let key: Buffer
  let cert: Buffer
  let server: tls.Server
  let port: number
  let last: FakeImapServer | null = null

  beforeAll(async () => {
    dir = tmpDir('tls')
    const r = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { encoding: 'utf8' }
    )
    expect(r.status, r.stderr).toBe(0)
    key = fs.readFileSync(path.join(dir, 'key.pem'))
    cert = fs.readFileSync(path.join(dir, 'cert.pem'))
    server = tls.createServer({ key, cert }, (sock) => {
      last = new FakeImapServer(sock, { user: USER, pass: PASS, mailboxes: { INBOX: [{ uid: 1, raw: mail({ id: 't1', subject: 'Over TLS' }) }] } })
    })
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
    port = (server.address() as net.AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()))
    rmTmp(dir)
  })

  it('works over TLS when the certificate verifies (test CA injected; verification on)', async () => {
    const r = await fetchImapMessages({ ...CRED, host: '127.0.0.1', port }, { sinceDays: 7, maxMessages: 5 }, connectImapTls, cert)
    expect(r.messages.map((m) => m.raw.toString('utf8'))[0]).toContain('Subject: Over TLS')
    expect(last?.verbs).toContain('EXAMINE')
  })

  it('an untrusted certificate fails the handshake; no IMAP command is sent', async () => {
    last = null
    const err = await fetchImapMessages({ ...CRED, host: '127.0.0.1', port }, { sinceDays: 7, maxMessages: 5 }, connectImapTls).catch((e) => e)
    expect(err).toBeInstanceOf(ImapError)
    expect(err.code).toBe('tls')
    expect(last === null || (last as FakeImapServer).verbs.length === 0).toBe(true)
  })

  it('a plaintext IMAP server (no TLS, e.g. port 143) is refused: it never receives LOGIN or the password', async () => {
    const received: Buffer[] = []
    const plain = net.createServer((s) => {
      s.on('data', (c) => received.push(c))
      s.on('error', () => undefined)
      s.write('* OK [CAPABILITY IMAP4rev1 STARTTLS] plaintext server\r\n')
    })
    await new Promise<void>((res) => plain.listen(0, '127.0.0.1', () => res()))
    try {
      const p = (plain.address() as net.AddressInfo).port
      const err = await fetchImapMessages({ ...CRED, host: '127.0.0.1', port: p }, { sinceDays: 7, maxMessages: 5, timeoutMs: 3000 }, connectImapTls, cert).catch((e) => e)
      expect(err).toBeInstanceOf(ImapError)
      expect(['tls', 'timeout']).toContain(err.code)
      const all = Buffer.concat(received).toString('latin1')
      expect(all).not.toContain('LOGIN')
      expect(all).not.toContain('STARTTLS')
      expect(all).not.toContain('SECRET-7731')
    } finally {
      await new Promise<void>((res) => plain.close(() => res()))
    }
  })
})

// ─── Service / IPC ───────────────────────────────────────────────────────

function setup(opts: { box?: ReturnType<typeof testSecretBox> | null; transport?: ImapTransport; consent?: boolean } = {}) {
  const storeRoot = tmpDir('imap-store')
  const remembered: Array<{ content: string; tags: string }> = []
  const box = opts.box === undefined ? testSecretBox() : opts.box
  const transport = opts.transport ?? fake().transport
  const svc = createConnectorService({
    storeRoot,
    runtimeRoot: () => storeRoot,
    persomeBin: () => null,
    ossTool: async (_n, a) => {
      remembered.push(a as { content: string; tags: string })
      return JSON.stringify({ entry_id: `e-${remembered.length}` })
    },
    postRuntime: async () => ({}),
    secretBox: box,
    imapFetch: (cred, req) => fetchImapMessages(cred, req, transport)
  })
  if (opts.consent !== false) grantAll(svc)
  return { svc, storeRoot, remembered }
}

describe('IMAP service + IPC', () => {
  it('settings are sealed with the SecretBox; status never carries the password; preview + commit use connector:imap', async () => {
    const { svc, storeRoot, remembered } = setup()
    const v = svc.imapSave(CRED)
    expect(v).toEqual({ configured: true, encryptionAvailable: true, host: 'imap.example.test', port: 993, userMasked: 'ow***@example.test', mailbox: 'INBOX', hasPassword: true })
    const onDisk = fs.readFileSync(svc.paths.imapPath, 'utf8')
    expect(fs.statSync(svc.paths.imapPath).mode & 0o777).toBe(0o600)
    for (const s of [PASS, 'SECRET-7731', USER, 'imap.example.test']) expect(onDisk).not.toContain(s)
    // Empty password on re-save keeps the stored one.
    svc.imapSave({ ...CRED, password: '', mailbox: 'INBOX' })
    const p = await svc.imapFetch({ sinceDays: 7, maxMessages: 10 })
    expect(p.kind).toBe('imap')
    expect(p.items).toHaveLength(3)
    const visible = JSON.stringify([p, svc.imapStatus(), svc.ledger()])
    expect(visible).not.toContain('SECRET-7731')
    expect(visible).not.toContain('sk-ant-api03-FIXTURE')
    expect(p.items.map((i) => i.text).join('\n')).toContain('来源：IMAP 邮箱（只读）INBOX @ imap.example.test')
    const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(r).toMatchObject({ kind: 'imap', target: 'imap', written: 3 })
    expect(remembered.every((x) => x.tags === 'lens-connector,connector:imap')).toBe(true)
    expect(svc.ledger().connectors).toEqual([expect.objectContaining({ kind: 'imap', memoryEntries: 3 })])
    rmTmp(storeRoot)
  })

  it('no SecretBox (or unavailable) → nothing is saved in plaintext', () => {
    const a = setup({ box: null })
    expect(() => a.svc.imapSave(CRED)).toThrow(/不会以明文保存/)
    expect(fs.existsSync(a.svc.paths.imapPath)).toBe(false)
    const b = setup({ box: testSecretBox(false) })
    expect(() => b.svc.imapSave(CRED)).toThrow(/钥匙串/)
    expect(b.svc.imapStatus().encryptionAvailable).toBe(false)
    rmTmp(a.storeRoot)
    rmTmp(b.storeRoot)
  })

  it('fetch errors reaching the renderer never contain the password or user', async () => {
    const { svc, storeRoot } = setup({ transport: fake({ pass: 'different', loginNo: 'NO way {pass} / owner@example.test' }).transport })
    svc.imapSave(CRED)
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<any>>()
    registerConnectorHandlers({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, svc, async () => null, async () => true, {})
    const res = await handlers.get('lens:connectors:imap-fetch')!({}, { opts: { sinceDays: 7, maxMessages: 5 } })
    expect(res.ok).toBe(false)
    expect(res.error.message).toMatch(/IMAP/)
    expect(JSON.stringify(res)).not.toContain('SECRET-7731')
    expect(JSON.stringify(res)).not.toContain('owner@example.test')
    // Status over IPC: no password field at all.
    const st = await handlers.get('lens:connectors:imap-status')!({})
    expect(Object.keys(st.data)).not.toContain('password')
    expect(JSON.stringify(st)).not.toContain('SECRET-7731')
    // IPC validation: CR/LF in fields, bad host, out-of-range limits.
    expect((await handlers.get('lens:connectors:imap-save')!({}, { config: { ...CRED, password: 'a\r\nb' } })).ok).toBe(false)
    expect((await handlers.get('lens:connectors:imap-save')!({}, { config: { ...CRED, host: 'imap://x.test' } })).ok).toBe(false)
    expect((await handlers.get('lens:connectors:imap-fetch')!({}, { opts: { sinceDays: 9999, maxMessages: 5 } })).ok).toBe(false)
    rmTmp(storeRoot)
  })

  it('IMAP requires its own consent; revoking it blocks fetch and deletes the stored credentials', async () => {
    const { svc, storeRoot } = setup({ consent: false })
    expect(() => svc.imapSave(CRED)).toThrow(/同意/)
    svc.consent.grant('calendar')
    expect(() => svc.imapSave(CRED)).toThrow(/同意/)
    svc.consent.grant('imap')
    svc.imapSave(CRED)
    expect(fs.existsSync(svc.paths.imapPath)).toBe(true)
    svc.consent.revoke('imap')
    expect(fs.existsSync(svc.paths.imapPath)).toBe(false)
    await expect(svc.imapFetch({ sinceDays: 7, maxMessages: 5 })).rejects.toThrow(/同意/)
    rmTmp(storeRoot)
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('protocol errors default to English', () => {
    expect(() => astring('x\0y')).toThrow(/cannot contain line breaks or NUL/)
  })
})
