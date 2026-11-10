// S1-FULL Phase 2 gate: Lens (two people, real identity keys + Lens card / letter signing) against the
// REAL `cloud/` server (child process, CLOUD_MAIL_MODE=outbox → .eml files = the "test mailbox").
// Also the cross-package check: cards / letters produced by Lens code verify with the server's
// verifier and vice versa, and tampering is rejected by both.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { verifyCardText as serverVerifyCard, verifyLetterText as serverVerifyLetter } from '../../cloud/src/signed.ts'
import { createCloudCardsService } from '../../src/main/cloud/cards'
import { signLetter, verifyLetterText as lensVerifyLetter } from '../../src/main/cloud/letter-sign'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { createSubsService } from '../../src/main/cloud/subs'
import { verifyCardText as lensVerifyCard, writeCardFile } from '../../src/main/identity/card'
import { createPeerStore } from '../../src/main/peers/store'
import { storePaths } from '../../src/main/store/paths'
import { fakeBox } from './helpers'
import { cardTextOf, cleanupSubs, person, subsTemp, type Person } from './subs-helpers'

const roots: string[] = []
let child: ChildProcess
let origin: string
let outbox: string
let serverOut = ''
const READER = 'reader.gate@example.test'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

beforeAll(async () => {
  const dir = subsTemp(roots, 'gate-server')
  outbox = path.join(dir, 'outbox')
  fs.mkdirSync(outbox)
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve('cloud'),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      CLOUD_DB_PATH: path.join(dir, 'db', 'cloud.db'),
      CLOUD_PUBLIC_ORIGIN: origin,
      CLOUD_MAIL_MODE: 'outbox',
      CLOUD_MAIL_FROM: 'letters@example.test',
      CLOUD_MAIL_OUTBOX_DIR: outbox,
      CLOUD_EMAIL_PEPPER: 'gate-pepper-'.padEnd(40, 'x')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b) => (serverOut += String(b)))
  child.stderr?.on('data', (b) => (serverOut += String(b)))
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`cloud server did not start:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}, 30_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  cleanupSubs(roots)
})

async function cloudFor(p: Person): Promise<CloudService> {
  const svc = createCloudService({
    storeRoot: p.root,
    box: fakeBox(),
    sign: (m) => p.keys.sign(m),
    getPublicIdentity: () => p.keys.getPublicIdentity(),
    allowInsecureLoopback: true,
    nativeConfirm: async () => true
  })
  await svc.configure({ enabled: true, baseUrl: origin, confirm: true })
  await svc.signIn()
  return svc
}

/** Mails (decoded .eml text) addressed to `to`, oldest first. */
function mailsTo(to: string): string[] {
  return fs
    .readdirSync(outbox)
    .filter((f) => f.endsWith('.eml'))
    .sort()
    .map((f) => fs.readFileSync(path.join(outbox, f), 'utf8'))
    .filter((m) => new RegExp(`^To: .*${to.replace(/[.]/g, '\\.')}`, 'mi').test(m))
}

async function waitFor<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out; server output:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Undo quoted-printable soft breaks / =XX so URLs and text can be matched. */
function qp(s: string): string {
  // Bytes are UTF-8: map =XX to %XX and let decodeURIComponent assemble multi-byte characters.
  const soft = s.replace(/=\r?\n/g, '').replace(/%/g, '%25').replace(/=([0-9A-F]{2})/g, '%$1')
  try {
    return decodeURIComponent(soft)
  } catch {
    return soft
  }
}

describe('cross-package signatures (Lens ↔ cloud verifier)', () => {
  it('Lens-signed card and letter verify on the server; tampering rejected by both sides', () => {
    const a = person(roots, 'xa')
    const text = cardTextOf(a.card({ name: 'Alice' }))
    expect(lensVerifyCard(text).valid).toBe(true)
    expect(serverVerifyCard(text).valid).toBe(true)
    const tampered = text.replace('独立开发者，专注于个人知识管理。', '独立开发者，专注于个人知识管理！')
    expect(tampered).not.toBe(text)
    expect(lensVerifyCard(tampered).valid).toBe(false)
    expect(serverVerifyCard(tampered).valid).toBe(false)

    const { text: letter } = signLetter(
      {
        version: 1,
        kind: 'persome-letter',
        issue_id: '7b0e7a52-6c1d-4c37-9a51-2f0c3f6f1e01',
        week: '2026-W45',
        title: '本周小记',
        markdown: '# 本周\n\n- 做了云端对话\n- 中文、emoji 🙂 与 "引号"',
        created_at: '2026-11-05T12:00:00.000Z',
        signer: { public_key: a.publicKey, fingerprint: a.fingerprint }
      },
      (m) => a.keys.sign(m)
    )
    expect(lensVerifyLetter(letter, a.fingerprint).valid).toBe(true)
    expect(serverVerifyLetter(letter).valid).toBe(true)
    const forged = letter.replace('做了云端对话', '什么都没做')
    expect(lensVerifyLetter(forged, a.fingerprint).valid).toBe(false)
    expect(serverVerifyLetter(forged).valid).toBe(false)
  })
})

describe('Phase 2 gate: cards + weekly letter by email + unsubscribe, real server', () => {
  it('publish/fetch card, double opt-in, letter delivered, unsubscribe stops mail, forgeries refused', async () => {
    const alice = person(roots, 'alice')
    const bob = person(roots, 'bob')
    writeCardFile(storePaths(alice.root), alice.card({ name: 'Alice' }))
    const aCloud = await cloudFor(alice)
    const bCloud = await cloudFor(bob)

    // C8: Alice publishes her card (exact previewed text), Bob fetches + verifies offline → Peers.
    const aCards = createCloudCardsService({ storeRoot: alice.root, cloud: aCloud, getPublicIdentity: () => alice.keys.getPublicIdentity(), nativeConfirm: async () => true })
    const pv = aCards.publishPreview()
    await aCards.publish(pv.previewId, null)
    const bCards = createCloudCardsService({ storeRoot: bob.root, cloud: bCloud, getPublicIdentity: () => bob.keys.getPublicIdentity(), nativeConfirm: async () => true })
    await bCards.fetchFriend(alice.fingerprint)
    expect(JSON.stringify(createPeerStore({ storeRoot: bob.root }).list())).toContain(alice.fingerprint)
    // Bob cannot fetch "himself", and the server refuses forged / foreign cards outright.
    await expect(bCards.fetchFriend(bob.fingerprint)).rejects.toBeTruthy()
    const Pub = z.object({ fingerprint: z.string() }).passthrough()
    const forgedCard = cardTextOf(alice.card({ name: 'Alice' })).replace('"Alice"', '"Mallory"')
    await expect(aCloud.client.requestJson('PUT', '/v1/cards', { card: forgedCard }, Pub)).rejects.toBeTruthy()
    await expect(bCloud.client.requestJson('PUT', '/v1/cards', { card: cardTextOf(alice.card({ name: 'Alice' })) }, Pub)).rejects.toBeTruthy()

    // C9: a reader subscribes by email (double opt-in; GET does not confirm, POST does).
    const sub = await fetch(`${origin}/v1/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher: alice.fingerprint, email: READER }) })
    expect(sub.status).toBe(202)
    const confirmMail = qp(await waitFor(() => mailsTo(READER)[0]))
    const confirmUrl = confirmMail.match(/https?:\/\/[^\s"<>]+\/v1\/subscribe\/confirm\?token=[A-Za-z0-9_-]+/)?.[0]
    expect(confirmUrl).toBeTruthy()
    const token = new URL(confirmUrl as string).searchParams.get('token') as string
    expect((await fetch(confirmUrl as string)).status).toBe(200)
    const aSubs = createSubsService({ storeRoot: alice.root, cloud: aCloud, getPublicIdentity: () => alice.keys.getPublicIdentity(), sign: (m) => alice.keys.sign(m), nativeConfirm: async () => true })
    expect((await aSubs.subscribers()).every((s) => s.status === 'pending')).toBe(true)
    const conf = await fetch(`${origin}/v1/subscribe/confirm`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` })
    expect(conf.status).toBe(200)
    const subs = await aSubs.subscribers()
    expect(subs).toHaveLength(1)
    expect(subs[0].status).toBe('confirmed')
    expect(JSON.stringify(subs)).not.toContain(READER)

    // Alice signs + sends a weekly letter through Lens; the reader's mailbox receives it.
    const l1 = aSubs.letterPreview({ title: '本周周信 Gate-1', markdown: '# 这周\n\n做了 Phase 2 的订阅。', week: '2026-W45' })
    const sent1 = await aSubs.letterPublish(l1.previewId, null)
    expect(sent1.recipients).toBe(1)
    // Mail #1 was the confirmation; mail #2 is the letter.
    // Unfold RFC 5322 folded lines in the HEADER block only (nodemailer folds long List-Unsubscribe
    // values). Unfolding the body too would merge quoted-printable soft breaks ("=\n" + leading
    // space) and break UTF-8 decoding — that was the intermittent failure seen at the Phase 3/4 gates.
    const rawLetter = await waitFor(() => mailsTo(READER)[1])
    const split = rawLetter.search(/\r?\n\r?\n/)
    const letterMail = rawLetter.slice(0, split).replace(/\r?\n[ \t]+/g, ' ') + rawLetter.slice(split)
    expect(qp(rawLetter.slice(split))).toContain('做了 Phase 2 的订阅。')
    expect(letterMail).toMatch(/^List-Unsubscribe: <http/m)
    expect(letterMail).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m)
    expect(letterMail).not.toMatch(/<img/i)
    // The .eml exists; the delivery row flips to `sent` right after the transport returns.
    let d = await aSubs.deliveries(sent1.letterId)
    for (let i = 0; i < 50 && d[0]?.status !== 'sent'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      d = await aSubs.deliveries(sent1.letterId)
    }
    expect(d).toHaveLength(1)
    expect(d[0].status).toBe('sent')
    expect(JSON.stringify(d)).not.toContain(READER)

    // Unsubscribe (RFC 8058 one-click POST). A GET must not unsubscribe.
    const unsubUrl = (letterMail.match(/^List-Unsubscribe: <([^>]+)>/m) as RegExpMatchArray)[1]
    expect((await fetch(unsubUrl)).status).toBe(200)
    expect((await aSubs.subscribers())[0].status).toBe('confirmed')
    const one = await fetch(unsubUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    expect(one.status).toBeLessThan(300)
    expect(await aSubs.subscribers()).toHaveLength(0)

    // Second letter: zero recipients, no new mail to the reader.
    const before = mailsTo(READER).length
    const l2 = aSubs.letterPreview({ title: '本周周信 Gate-2', markdown: '退订之后不应收到。', week: '2026-W46' })
    const sent2 = await aSubs.letterPublish(l2.previewId, null)
    expect(sent2.recipients).toBe(0)
    // Re-subscribing via the normal endpoint sends nothing to a suppressed address.
    await fetch(`${origin}/v1/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher: alice.fingerprint, email: READER }) })
    await new Promise((r) => setTimeout(r, 1500))
    expect(mailsTo(READER).length).toBe(before)

    // Lens-to-Lens: Bob reads Alice's letters, each verified offline.
    const bSubs = createSubsService({ storeRoot: bob.root, cloud: bCloud, getPublicIdentity: () => bob.keys.getPublicIdentity(), sign: (m) => bob.keys.sign(m) })
    const fl = await bSubs.friendLetters(alice.fingerprint)
    expect(fl.letters.length).toBe(2)
    expect(fl.dropped).toHaveLength(0)
    // A forged letter (tampered after signing) is refused by the server.
    const forgedLetter = sent1.envelopeText.replace('做了 Phase 2 的订阅。', '伪造内容')
    await expect(aCloud.client.requestJson('POST', '/v1/letters', { letter: forgedLetter }, z.unknown())).rejects.toBeTruthy()

    // Server output never contains the reader's address, letter text or tokens.
    await new Promise((r) => setTimeout(r, 200))
    for (const s of [READER, '做了 Phase 2 的订阅', token]) expect(serverOut.includes(s), `server output contains ${s}`).toBe(false)
  }, 60_000)
})
