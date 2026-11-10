// C10 Subscriptions service + IPC against an in-test fake server (node:http, contract from the
// brief): draft from the local Runtime, preview → confirm → sign → POST of exactly the previewed
// envelope, error mapping, letters / deliveries / subscribers, friends' letters with forged ones
// dropped and verified ones cached 0600/0700, cloud OFF / signed out ⇒ zero requests.
import fs from 'node:fs'
import path from 'node:path'
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { createSubsService, LETTER_CACHE_DIR, type SubsService } from '../../src/main/cloud/subs'
import { registerSubsHandlers } from '../../src/main/cloud/subs-ipc'
import { createCloudCardsService } from '../../src/main/cloud/cards'
import { SUBS_CHANNELS, CLOUD_CARDS_CHANNELS } from '../../src/main/cloud/subs-api'
import { letterSigningText, signLetter } from '../../src/main/cloud/letter-sign'
import { fakeBox, fakeIpc, LOOPBACK, startFakeServer, type FakeServer } from './helpers'
import { cleanupSubs, installSubsRoutes, person, type Person, type SubsServer } from './subs-helpers'

const roots: string[] = []
let server: FakeServer
let api: SubsServer
let me: Person
let cloud: CloudService
let confirms: Array<{ message: string; detail: string }>
let answer: boolean

const SECRET_ERR = '/Users/someone/.persome/index.db exploded with token abc'

function oss(entries: unknown[] | Error) {
  return async (name: string): Promise<string> => {
    if (entries instanceof Error) throw entries
    if (name !== 'recent_activity') throw new Error('unexpected tool')
    return JSON.stringify({ count: entries.length, entries })
  }
}

function makeSubs(over: Partial<Parameters<typeof createSubsService>[0]> = {}): SubsService {
  return createSubsService({
    storeRoot: me.root,
    cloud,
    getPublicIdentity: () => me.keys.getPublicIdentity(),
    sign: (m) => me.keys.sign(m),
    ossTool: oss([{ id: 'mem-1', content: '这周在写 Lens 订阅页', timestamp: new Date(Date.now() - 86_400_000).toISOString(), path: 'notes/lens.md' }]),
    nativeConfirm: async (_s, o) => {
      confirms.push(o)
      return answer
    },
    ...over
  })
}

beforeEach(async () => {
  confirms = []
  answer = true
  server = await startFakeServer()
  me = person(roots, 'me')
  api = installSubsRoutes(server, () => me.fingerprint)
  writeCloudConfig(cloudPaths(me.root).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
  cloud = createCloudService({ storeRoot: me.root, box: fakeBox(), sign: (m) => me.keys.sign(m), getPublicIdentity: () => me.keys.getPublicIdentity(), allowInsecureLoopback: true })
  await cloud.signIn()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await server.close()
  cleanupSubs(roots)
})

describe('letter draft (deterministic, local Runtime only)', () => {
  it('uses the peers/letter.ts template, addressed to subscribers, with week + title', async () => {
    const d = await makeSubs().letterDraft({ timezone: 'UTC' })
    expect(d.week).toMatch(/^\d{4}-W\d{2}$/)
    expect(d.title).toBe(`每周信 · ${d.week}`)
    expect(d.markdown).toContain('这周在写 Lens 订阅页')
    expect(d.markdown).toContain('各位朋友，你好：')
    expect(d.markdown).not.toContain('对方卡片')
    expect(d.counts.inWindow).toBe(1)
    expect(d.warnings.join()).toContain('Check every line')
    expect(api.calls).toHaveLength(0) // drafting never touches the cloud
  })

  it('Runtime failure: fixed text in the draft, raw error never included', async () => {
    const d = await makeSubs({ ossTool: oss(new Error(SECRET_ERR)) }).letterDraft({ timezone: 'UTC' })
    expect(d.markdown).toContain('本机 Persome Runtime 不可用')
    expect(d.markdown).not.toContain('.persome')
    expect(JSON.stringify(d)).not.toContain('token abc')
    expect(d.warnings.join()).toContain('nothing was made up')
  })

  it('invalid timezone ⇒ invalid_args', async () => {
    await expect(makeSubs().letterDraft({ timezone: 'Mars/Base' })).rejects.toMatchObject({ code: 'invalid_args' })
  })
})

describe('letter preview → publish', () => {
  it('requires the native confirm and sends exactly the previewed envelope, signed', async () => {
    const subs = makeSubs()
    const pv = subs.letterPreview({ title: '第一期', markdown: '你好，订阅者。', week: '2026-W45' })
    expect(pv.signingText.startsWith('persome-letter-v1\n{')).toBe(true)
    expect(pv.envelope.signer.fingerprint).toBe(me.fingerprint)

    answer = false
    await expect(subs.letterPublish(pv.previewId, null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(confirms).toHaveLength(1)
    expect(confirms[0].detail).toContain('No open/read tracking')

    answer = true
    const out = await subs.letterPublish(pv.previewId, null)
    const posts = api.calls.filter((c) => c.method === 'POST' && c.url === '/v1/letters')
    expect(posts).toHaveLength(1)
    const body = posts[0].body as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['letter'])
    const text = body.letter as string
    expect(text).toBe(out.envelopeText)
    const raw = JSON.parse(text) as Record<string, unknown>
    const { signature, ...unsigned } = raw
    // Exactly the previewed bytes were signed.
    expect(letterSigningText(unsigned)).toBe(pv.signingText)
    expect(unsigned).toEqual(pv.envelope)
    // Independent verification with node:crypto + the identity's public key.
    const pubRaw = Buffer.from(me.publicKey, 'base64url')
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw.toString('base64url') }, format: 'jwk' })
    expect(cryptoVerify(null, Buffer.from(pv.signingText, 'utf8'), pub, Buffer.from(signature as string, 'base64url'))).toBe(true)
    expect(out).toMatchObject({ issueId: pv.envelope.issue_id, recipients: 0 })
    // Single use.
    await expect(subs.letterPublish(pv.previewId, null)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('no nativeConfirm dep ⇒ cancelled, nothing sent', async () => {
    const subs = makeSubs({ nativeConfirm: undefined })
    const pv = subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W45' })
    await expect(subs.letterPublish(pv.previewId, null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls).toHaveLength(0)
  })

  it('maps 409 / 403 / 400 and keeps the preview after a retryable 5xx (same issue_id on retry)', async () => {
    const subs = makeSubs()
    const pv = subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W45' })
    api.failNext = { status: 500, code: 'internal_error' }
    await expect(subs.letterPublish(pv.previewId, null)).rejects.toMatchObject({ code: 'server' })
    const first = (api.calls.at(-1)!.body as { letter: string }).letter
    await subs.letterPublish(pv.previewId, null)
    expect((api.calls.at(-1)!.body as { letter: string }).letter).toBe(first) // deterministic Ed25519, same envelope

    for (const [status, code, want] of [
      [409, 'duplicate_issue', 'duplicate_issue'],
      [403, 'letter_not_owner', 'letter_not_owner'],
      [400, 'letter_invalid', 'letter_invalid']
    ] as const) {
      const p = subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W45' })
      api.failNext = { status, code }
      const r = await subs.letterPublish(p.previewId, null).catch((e: { code: string; message: string }) => e)
      expect(r).toMatchObject({ code: want })
      expect((r as { message: string }).message).not.toContain('server text')
      await expect(subs.letterPublish(p.previewId, null)).rejects.toMatchObject({ code: 'not_found' })
    }
  })

  it('preview validation: empty / too long / bad week; preview is local (works while OFF)', () => {
    const subs = makeSubs()
    expect(() => subs.letterPreview({ title: ' ', markdown: 'm', week: '2026-W45' })).toThrow()
    expect(() => subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W60' })).toThrow()
    expect(() => subs.letterPreview({ title: 't', markdown: 'x'.repeat(30_001), week: '2026-W45' })).toThrow()
    writeCloudConfig(cloudPaths(me.root).configFile, { enabled: false, baseUrl: server.origin }, LOOPBACK)
    expect(subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W45' }).previewId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('identity changed after preview ⇒ refused before any confirm / request', async () => {
    const other = person(roots, 'other')
    let current = me
    const subs = makeSubs({ getPublicIdentity: () => current.keys.getPublicIdentity(), sign: (m) => current.keys.sign(m) })
    const pv = subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W45' })
    current = other
    await expect(subs.letterPublish(pv.previewId, null)).rejects.toMatchObject({ code: 'no_identity' })
    expect(confirms).toHaveLength(0)
    expect(api.calls).toHaveLength(0)
  })
})

describe('letters, deliveries, subscribers', () => {
  it('lists letters with counts and maps deliveries; unknown letter ⇒ not_found', async () => {
    api.subscribers.push(
      { subscriber_id: 's1', email_masked: 'a***@x.com', status: 'confirmed', created_at: '2026-11-01T00:00:00Z', confirmed_at: '2026-11-01T01:00:00Z' },
      { subscriber_id: 's2', email_masked: 'b***@y.com', status: 'pending', created_at: '2026-11-02T00:00:00Z', confirmed_at: null }
    )
    const subs = makeSubs()
    const pv = subs.letterPreview({ title: '第二期', markdown: 'm', week: '2026-W45' })
    const out = await subs.letterPublish(pv.previewId, null)
    expect(out.recipients).toBe(1)
    const list = await subs.letters()
    expect(list).toEqual([{ letterId: out.letterId, issueId: pv.envelope.issue_id, week: '2026-W45', title: '第二期', createdAt: pv.envelope.created_at, counts: { queued: 1, sent: 0, failed: 0, suppressed: 0 } }])
    const d = await subs.deliveries(out.letterId)
    expect(d).toEqual([{ subscriberId: 's1', emailMasked: 'a***@x.com', status: 'queued', attempts: 0, updatedAt: expect.any(String), errorCode: null }])
    await expect(subs.deliveries('nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('subscribers list, remove with confirm, subscribe link', async () => {
    api.subscribers.push({ subscriber_id: 's1', email_masked: 'a***@x.com', status: 'pending', created_at: '2026-11-01T00:00:00Z', confirmed_at: null })
    const subs = makeSubs()
    expect(await subs.subscribers()).toEqual([{ subscriberId: 's1', emailMasked: 'a***@x.com', status: 'pending', createdAt: '2026-11-01T00:00:00Z', confirmedAt: null }])
    answer = false
    await expect(subs.removeSubscriber('s1', null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    answer = true
    expect(await subs.removeSubscriber('s1', null)).toBe(true)
    expect(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/v1/subscribers/s1'])
    expect(api.subscribers).toHaveLength(0)
    await expect(subs.removeSubscriber('s1', null)).rejects.toMatchObject({ code: 'not_found' })
    expect(subs.subscribeLink()).toEqual({ url: `${server.origin}/s/${me.fingerprint}`, fingerprint: me.fingerprint })
  })
})

describe("friends' letters", () => {
  it('verifies each letter offline, drops forged ones, caches verified ones 0600 / 0700', async () => {
    const friend = person(roots, 'friend')
    const mallory = person(roots, 'mallory')
    const mk = (who: Person, i: number, over: Record<string, unknown> = {}) =>
      signLetter(
        {
          version: 1,
          kind: 'persome-letter',
          issue_id: `0b7f2c1e-4a5d-4c3b-9e8f-1a2b3c4d5e6${i}`,
          week: '2026-W45',
          title: `第 ${i} 期`,
          markdown: `正文 ${i}`,
          created_at: `2026-11-0${i}T10:00:00.000Z`,
          signer: { public_key: who.publicKey, fingerprint: who.fingerprint },
          ...over
        },
        (m) => who.keys.sign(m)
      )
    const good1 = mk(friend, 1).text
    const good2 = mk(friend, 2).text
    const tampered = JSON.stringify({ ...(JSON.parse(mk(friend, 3).text) as object), markdown: '被改过的正文' })
    const byMallory = mk(mallory, 4).text // validly signed, wrong signer
    api.byFp.set(friend.fingerprint, [
      { letter: good1, published_at: '2026-11-01T11:00:00Z' },
      { letter: tampered, published_at: '2026-11-03T11:00:00Z' },
      { letter: byMallory, published_at: '2026-11-04T11:00:00Z' },
      { letter: 'garbage', published_at: '2026-11-04T11:00:00Z' },
      { letter: good2, published_at: '2026-11-02T11:00:00Z' }
    ])
    const subs = makeSubs()
    const r = await subs.friendLetters(friend.fingerprint)
    expect(r.letters.map((l) => l.title)).toEqual(['第 2 期', '第 1 期'])
    expect(r.letters.every((l) => l.signerFingerprint === friend.fingerprint)).toBe(true)
    expect(r.dropped).toEqual([
      { index: 1, reason: 'signature', issueId: '0b7f2c1e-4a5d-4c3b-9e8f-1a2b3c4d5e63' },
      { index: 2, reason: 'wrong_signer', issueId: '0b7f2c1e-4a5d-4c3b-9e8f-1a2b3c4d5e64' },
      { index: 3, reason: 'parse', issueId: null }
    ])
    expect(r.cached).toBe(2)

    const dir = path.join(me.root, LETTER_CACHE_DIR, friend.fingerprint)
    expect(fs.statSync(path.join(me.root, LETTER_CACHE_DIR)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['0b7f2c1e-4a5d-4c3b-9e8f-1a2b3c4d5e61.json', '0b7f2c1e-4a5d-4c3b-9e8f-1a2b3c4d5e62.json'])
    for (const f of files) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600)

    // Cache read works with cloud OFF (no network) and re-verifies.
    writeCloudConfig(cloudPaths(me.root).configFile, { enabled: false, baseUrl: server.origin }, LOOPBACK)
    const n = api.calls.length
    expect(subs.cachedLetters(friend.fingerprint)).toMatchObject({ unreadable: 0, letters: [{ title: '第 2 期' }, { title: '第 1 期' }] })
    const f1 = path.join(dir, files[0])
    const body = JSON.parse(fs.readFileSync(f1, 'utf8')) as { letter: string }
    fs.writeFileSync(f1, JSON.stringify({ ...body, letter: body.letter.replace('正文 1', '正文 X') }))
    expect(subs.cachedLetters(friend.fingerprint)).toMatchObject({ unreadable: 1, letters: [{ title: '第 2 期' }] })
    expect(api.calls.length).toBe(n)
  })
})

describe('cloud OFF / signed out ⇒ zero requests', () => {
  it('OFF: every network method fails `disabled` with no fetch and no confirm', async () => {
    writeCloudConfig(cloudPaths(me.root).configFile, { enabled: false, baseUrl: server.origin }, LOOPBACK)
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const subs = makeSubs()
    const cards = createCloudCardsService({ storeRoot: me.root, cloud, getPublicIdentity: () => me.keys.getPublicIdentity(), nativeConfirm: async () => true })
    const pv = subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W45' })
    const fp = 'a'.repeat(64)
    for (const p of [
      subs.letterPublish(pv.previewId, null),
      subs.letters(),
      subs.deliveries('L1'),
      subs.subscribers(),
      subs.removeSubscriber('s1', null),
      subs.friendLetters(fp),
      cards.status(),
      cards.unpublish(null),
      cards.fetchFriend(fp)
    ]) {
      await expect(p).rejects.toMatchObject({ code: 'disabled' })
    }
    expect(() => subs.subscribeLink()).toThrow(expect.objectContaining({ code: 'disabled' }))
    expect(spy).not.toHaveBeenCalled()
    expect(confirms).toHaveLength(0)
    expect(api.calls).toHaveLength(0)
  })

  it('signed out: unauthorized with no request', async () => {
    await cloud.signOut()
    const before = server.log.length
    const subs = makeSubs()
    await expect(subs.letters()).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(subs.friendLetters('b'.repeat(64))).rejects.toMatchObject({ code: 'unauthorized' })
    const pv = subs.letterPreview({ title: 't', markdown: 'm', week: '2026-W45' })
    await expect(subs.letterPublish(pv.previewId, null)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(server.log.length).toBe(before)
    expect(confirms).toHaveLength(0)
  })
})

describe('IPC', () => {
  function wire() {
    const ipc = fakeIpc()
    const subs = makeSubs()
    const cards = createCloudCardsService({ storeRoot: me.root, cloud, getPublicIdentity: () => me.keys.getPublicIdentity(), nativeConfirm: async () => true })
    registerSubsHandlers(ipc, subs, cards)
    return ipc
  }

  it('registers exactly the subs + cloud-cards channels', () => {
    expect(wire().channels().sort()).toEqual([...Object.values(SUBS_CHANNELS), ...Object.values(CLOUD_CARDS_CHANNELS)].sort())
  })

  it('rejects renderer-supplied signatures / envelopes / card text and bad ids (zod strictObject)', async () => {
    const ipc = wire()
    const bad: Array<[string, unknown]> = [
      [SUBS_CHANNELS.letterPreview, { title: 't', markdown: 'm', week: '2026-W45', signature: 'x'.repeat(86) }],
      [SUBS_CHANNELS.letterPreview, { title: 't', markdown: 'm', week: '2026-W45', issue_id: 'x' }],
      [SUBS_CHANNELS.letterPreview, { title: 't', markdown: 'm', week: 'W45' }],
      [SUBS_CHANNELS.letterPublish, { previewId: 'a'.repeat(32), letter: '{}' }],
      [SUBS_CHANNELS.letterPublish, { previewId: '../x' }],
      [SUBS_CHANNELS.deliveries, { letterId: '../../v1/account' }],
      [SUBS_CHANNELS.removeSubscriber, { subscriberId: 'a/b' }],
      [SUBS_CHANNELS.friendLetters, { fingerprint: 'ABC' }],
      [SUBS_CHANNELS.letters, { x: 1 }],
      [SUBS_CHANNELS.letterDraft, { timezone: '../../etc' }],
      [CLOUD_CARDS_CHANNELS.publish, { previewId: 'a'.repeat(32), card: '{}' }],
      [CLOUD_CARDS_CHANNELS.publishPreview, { card: '{}' }],
      [CLOUD_CARDS_CHANNELS.fetchFriend, { fingerprint: 'z'.repeat(64) }]
    ]
    for (const [ch, args] of bad) expect(await ipc.invoke(ch, args), ch).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(api.calls).toHaveLength(0)
  })

  it('happy path through IPC; errors are sanitized', async () => {
    const ipc = wire()
    const pv = (await ipc.invoke(SUBS_CHANNELS.letterPreview, { title: 't', markdown: 'm', week: '2026-W45' })) as { ok: true; data: { previewId: string } }
    expect(pv.ok).toBe(true)
    expect(await ipc.invoke(SUBS_CHANNELS.letterPublish, { previewId: pv.data.previewId })).toMatchObject({ ok: true, data: { recipients: 0 } })
    api.failNext = { status: 500, code: 'internal_error' }
    const r = (await ipc.invoke(SUBS_CHANNELS.letters)) as { ok: false; error: { code: string; message: string } }
    expect(r).toMatchObject({ ok: false, error: { code: 'server' } })
    expect(r.error.message).not.toMatch(/server text|tok_/)
  })
})


describe('letter draft redaction (Phase 2 gate finding)', () => {
  it('scrubs Runtime token, emails, Runtime/screenshot paths, image data, phone / ID numbers before the user sees the draft', async () => {
    const TOKEN = 'rt_LOCAL_9f8e7d6c5b4a3210'
    const content = [
      `这周修了订阅页 token=${TOKEN}`,
      '联系 alice@example.com 或 13812345678，证件 11010519491231002X',
      '截图 /Users/bob/.persome/screenshots/2026/11/04/a.png 库 /Users/bob/.persome/index.db',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    ].join('\n')
    const d = await makeSubs({
      ossTool: oss([{ id: 'mem-9', content, timestamp: new Date(Date.now() - 86_400_000).toISOString(), path: 'notes/x.md' }]),
      knownSecrets: () => [TOKEN]
    }).letterDraft({ timezone: 'UTC' })
    expect(d.markdown).toContain('这周修了订阅页')
    for (const leak of [TOKEN, 'alice@example.com', '13812345678', '11010519491231002X', '.persome', 'index.db', 'a.png', 'iVBORw0KGgo']) {
      expect(d.markdown.includes(leak), `draft leaks ${leak}`).toBe(false)
    }
    expect(d.warnings.join()).toMatch(/Automatically redacted \d+ item/)
    expect(d.warnings.join()).toContain('Names and ordinary text are not redacted')
  })
})
