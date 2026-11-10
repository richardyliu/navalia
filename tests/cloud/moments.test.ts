// C18 shared moments service + IPC against an in-test fake server (node:http; validates with the
// server's own verifiers). Two (or three) real Lens identities with separate temp stores.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { createCloudService } from '../../src/main/cloud/service'
import { createMomentsService, type MomentsService } from '../../src/main/cloud/moments'
import { registerMomentsHandlers } from '../../src/main/cloud/moments-ipc'
import { MOMENTS_CHANNELS, type MomentProposeArgs } from '../../src/main/cloud/moments-api'
import { momentSigningText, verifyMomentText } from '../../src/main/cloud/moments-sign'
import { MOMENTS_DIR } from '../../src/main/cloud/moments-store'
import { verifyMomentText as serverMoment } from '../../cloud/src/signed.ts'
import { fakeBox, fakeIpc, startFakeServer, type FakeServer } from './helpers'
import { befriend, cleanupMoments, installMomentsRoutes, person, signIn, type MomentsServer, type Person } from './moments-helpers'

const roots: string[] = []
let server: FakeServer
let api: MomentsServer
let a: Person
let b: Person
let confirms: Array<{ message: string; detail: string }>
let answer: boolean

function svc(p: Person, over: Partial<Parameters<typeof createMomentsService>[0]> = {}): MomentsService {
  return createMomentsService({
    storeRoot: p.root,
    cloud: p.cloud!,
    getPublicIdentity: () => p.keys.getPublicIdentity(),
    sign: (m) => p.keys.sign(m),
    nativeConfirm: async (_s, o) => {
      confirms.push(o)
      return answer
    },
    ...over
  })
}

const args = (friend: Person, over: Partial<MomentProposeArgs> = {}): MomentProposeArgs => ({
  friendFingerprint: friend.fingerprint,
  title: '一起去爬了香山',
  start: '2026-11-01',
  end: '2026-11-01',
  place: '北京',
  note: '',
  visibility: 'letters',
  ...over
})

/** A proposes to B; B syncs and accepts. Returns the moment id. */
async function acceptedMoment(sa: MomentsService, sb: MomentsService, over: Partial<MomentProposeArgs> = {}): Promise<string> {
  const p = sa.proposePreview(args(b, over))
  await sa.propose(p.previewId, null)
  await sb.sync()
  const ap = sb.acceptPreview(p.moment.moment_id)
  await sb.accept(ap.previewId, null)
  return p.moment.moment_id
}

beforeEach(async () => {
  confirms = []
  answer = true
  server = await startFakeServer()
  api = installMomentsRoutes(server)
  a = person(roots, 'a')
  b = person(roots, 'b')
  befriend(a, b)
  befriend(b, a)
  await signIn(a, server, api)
  await signIn(b, server, api)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await server.close()
  cleanupMoments(roots)
})

describe('propose', () => {
  it('declined confirm ⇒ 0 POST; accepted ⇒ POST body is exactly the previewed object, signed', async () => {
    const sa = svc(a)
    const p = sa.proposePreview(args(b))
    expect(p.signingText).toBe(momentSigningText(p.moment))
    expect(p.moment.participants).toEqual([a.fingerprint, b.fingerprint].sort())
    expect(p.moment.proposer.fingerprint).toBe(a.fingerprint)
    expect(p.friendName).toBe('Name-b')
    answer = false
    await expect(sa.propose(p.previewId, null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls).toHaveLength(0)
    // the cancelled preview is consumed? no: confirmOrCancel throws before the POST; preview stays
    answer = true
    const r = await sa.propose(p.previewId, null)
    expect(confirms.at(-1)!.detail).toContain('一起去爬了香山')
    const posts = api.calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    const body = posts[0].body as { moment: string }
    expect(Object.keys(body)).toEqual(['moment'])
    expect(body.moment).toBe(r.momentText)
    const { signature: _s, ...unsigned } = JSON.parse(body.moment)
    expect(unsigned).toEqual(p.moment)
    expect(verifyMomentText(body.moment, b.fingerprint).valid).toBe(true)
    expect(serverMoment(body.moment).valid).toBe(true)
    await expect(sa.propose(p.previewId, null)).rejects.toMatchObject({ code: 'not_found' }) // single use
  })

  it('only to a friend in Peers, never to self, fields validated; zero requests', async () => {
    const c = person(roots, 'c')
    const sa = svc(a)
    expect(() => sa.proposePreview(args(c))).toThrow(expect.objectContaining({ code: 'not_friend' }))
    expect(() => sa.proposePreview(args(a))).toThrow(expect.objectContaining({ code: 'invalid_args' }))
    expect(() => sa.proposePreview(args(b, { title: 'a\nb' }))).toThrow(expect.objectContaining({ code: 'invalid_args' }))
    expect(() => sa.proposePreview(args(b, { start: '2026-11-02', end: '2026-11-01' }))).toThrow(expect.objectContaining({ code: 'invalid_args' }))
    expect(() => sa.proposePreview(args(b, { start: '2026-02-30', end: '2026-02-30' }))).toThrow(expect.objectContaining({ code: 'invalid_args' }))
    expect(api.calls).toHaveLength(0)
  })

  it('server status mapping: 409 / 403 / 400 sanitized; 500 keeps the preview for a byte-identical retry', async () => {
    const sa = svc(a)
    const p = sa.proposePreview(args(b))
    api.failNext = { status: 500, code: 'server' }
    await expect(sa.propose(p.previewId, null)).rejects.toMatchObject({ code: 'server' })
    const first = (api.calls.at(-1)!.body as { moment: string }).moment
    await sa.propose(p.previewId, null)
    expect((api.calls.at(-1)!.body as { moment: string }).moment).toBe(first)
    for (const [status, code] of [
      [409, 'moment_conflict'],
      [403, 'moment_not_owner'],
      [400, 'moment_invalid']
    ] as const) {
      const q = sa.proposePreview(args(b))
      api.failNext = { status, code: 'x' }
      const err = await sa.propose(q.previewId, null).catch((e) => e)
      expect(err.code).toBe(code)
      expect(err.message).not.toContain('server text')
    }
  })
})

describe('incoming / accept / decline / delete', () => {
  it('accept: proposer verified + known; acceptance over the exact sha; both store 0600/0700 after sync', async () => {
    const sa = svc(a)
    const sb = svc(b)
    const id = await acceptedMoment(sa, sb)
    const acc = api.calls.find((c) => c.url.endsWith('/accept'))!
    expect(Object.keys(acc.body as object)).toEqual(['acceptance'])
    expect(api.moments.get(id)!.status).toBe('accepted')
    const fileB = path.join(b.root, MOMENTS_DIR, `${id}.json`)
    expect(fs.statSync(fileB).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(fileB)).mode & 0o777).toBe(0o700)
    const local = sb.local()
    expect(local.moments.map((m) => [m.momentId, m.friendName, m.iAmProposer, m.verified])).toEqual([[id, 'Name-a', false, true]])
    // A gets it on its next sync
    const s = await sa.sync()
    expect(s.accepted.map((m) => m.momentId)).toEqual([id])
    expect(fs.existsSync(path.join(a.root, MOMENTS_DIR, `${id}.json`))).toBe(true)
    expect(sa.local().moments[0]).toMatchObject({ friendFingerprint: b.fingerprint, friendName: 'Name-b', iAmProposer: true })
  })

  it('unknown proposer: listed as 签名者不在朋友列表, cannot be accepted, zero accept requests', async () => {
    const c = person(roots, 'c')
    befriend(c, b) // C knows B, but B does not know C
    await signIn(c, server, api)
    const sc = svc(c)
    const p = sc.proposePreview(args(b))
    await sc.propose(p.previewId, null)
    const sb = svc(b)
    const s = await sb.sync()
    expect(s.incoming).toHaveLength(1)
    expect(s.incoming[0]).toMatchObject({ canAccept: false, blocked: 'unknown_signer', friendKnown: false })
    expect(() => sb.acceptPreview(p.moment.moment_id)).toThrow(expect.objectContaining({ code: 'unknown_signer' }))
    expect(api.calls.filter((x) => x.url.endsWith('/accept'))).toHaveLength(0)
    // After importing C's card it becomes acceptable.
    befriend(b, c)
    const s2 = await sb.sync()
    expect(s2.incoming[0].canAccept).toBe(true)
  })

  it('forged / foreign rows are dropped with a reason and never stored', async () => {
    const c = person(roots, 'c')
    const sa = svc(a)
    const p = sa.proposePreview(args(b))
    await sa.propose(p.previewId, null)
    const row = api.moments.get(p.moment.moment_id)!
    const tampered = JSON.stringify({ ...JSON.parse(row.text), title: '被服务器改过' })
    // A validly signed moment between A and C, served to B.
    befriend(a, c)
    const foreign = sa.proposePreview(args(c))
    await sa.propose(foreign.previewId, null)
    const foreignText = api.moments.get(foreign.moment.moment_id)!.text
    api.extra.set(b.fingerprint, [
      { moment_id: p.moment.moment_id, status: 'pending', moment: tampered, acceptance: null },
      { moment_id: foreign.moment.moment_id, status: 'pending', moment: foreignText, acceptance: null },
      { moment_id: p.moment.moment_id, status: 'accepted', moment: row.text, acceptance: '{"bad":1}' }
    ])
    const s = await svc(b).sync()
    expect(s.dropped.map((d) => d.reason).sort()).toEqual(['not_participant', 'schema', 'signature'])
    expect(s.incoming.map((m) => m.title)).toEqual(['一起去爬了香山'])
    expect(svc(b).local().moments).toEqual([])
  })

  it('decline: confirm, then the proposer sees it declined', async () => {
    const sa = svc(a)
    const sb = svc(b)
    const p = sa.proposePreview(args(b))
    await sa.propose(p.previewId, null)
    await sb.sync()
    answer = false
    await expect(sb.decline(p.moment.moment_id, null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls.filter((c) => c.url.endsWith('/decline'))).toHaveLength(0)
    answer = true
    expect(await sb.decline(p.moment.moment_id, null)).toEqual({ status: 'declined' })
    const s = await sa.sync()
    expect(s.outgoing).toEqual([expect.objectContaining({ momentId: p.moment.moment_id, status: 'declined' })])
    // once declined it is no longer an incoming proposal on this device
    expect(() => sb.acceptPreview(p.moment.moment_id)).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('delete: copy says it disappears for both; DELETE + local removal; the other side sees remoteMissing and can forget locally', async () => {
    const sa = svc(a)
    const sb = svc(b)
    const id = await acceptedMoment(sa, sb)
    await sa.sync()
    answer = false
    await expect(sa.remove(id, null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    answer = true
    expect(await sa.remove(id, null)).toEqual({ remote: true, local: true })
    expect(confirms.at(-1)!.detail).toContain('neither of you can see it')
    expect(api.moments.has(id)).toBe(false)
    expect(sa.local().moments).toEqual([])
    const s = await sb.sync()
    expect(s.remoteMissing).toEqual([id])
    expect(sb.local().moments).toHaveLength(1) // a courier cannot wipe local copies
    expect(await sb.forgetLocal(id, null)).toEqual({ local: true })
    expect(sb.local().moments).toEqual([])
    // deleting something already gone server-side still cleans up locally
    expect(await sa.remove(id, null)).toEqual({ remote: false, local: false })
  })
})

describe('local store: both signatures re-verified on every load', () => {
  it('tampered file ignored and reported; renamed file rejected; note stays local', async () => {
    const sa = svc(a)
    const sb = svc(b)
    const id = await acceptedMoment(sa, sb)
    const id2 = await acceptedMoment(sa, sb, { title: '第二次' })
    const before = api.calls.length
    const noted = sb.setNote(id2, '「那天最记得的一个细节是？」\n风很大')
    expect(noted.myNote).toContain('风很大')
    expect(api.calls.length).toBe(before) // note is local only
    const dir = path.join(b.root, MOMENTS_DIR)
    const file = path.join(dir, `${id}.json`)
    const f = JSON.parse(fs.readFileSync(file, 'utf8'))
    f.moment = JSON.stringify({ ...JSON.parse(f.moment), title: '本地被改过' })
    fs.writeFileSync(file, JSON.stringify(f))
    const l = sb.local()
    expect(l.moments.map((m) => m.momentId)).toEqual([id2])
    expect(l.rejected).toEqual([{ file: `${id}.json`, reason: 'signature' }])
    // a valid file under another id's name
    fs.copyFileSync(path.join(dir, `${id2}.json`), path.join(dir, '11111111-1111-4111-8111-111111111111.json'))
    expect(sb.local().rejected).toContainEqual({ file: '11111111-1111-4111-8111-111111111111.json', reason: 'file_name' })
    // a genuine acceptance moved onto another genuine moment ⇒ mismatch
    const f2 = JSON.parse(fs.readFileSync(path.join(dir, `${id2}.json`), 'utf8'))
    const orig = JSON.parse(fs.readFileSync(file, 'utf8'))
    orig.moment = api.moments.get(id)!.text
    orig.acceptance = f2.acceptance
    fs.writeFileSync(file, JSON.stringify(orig))
    expect(sb.local().rejected).toContainEqual({ file: `${id}.json`, reason: 'mismatch' })
    expect(sb.local().moments.find((m) => m.momentId === id2)?.myNote).toContain('风很大')
  })
})

describe('cloud OFF / signed out ⇒ zero network', () => {
  it('every network method fails before fetch / dialog; local + notes still work', async () => {
    const sa = svc(a)
    const sb = svc(b)
    const id = await acceptedMoment(sa, sb)
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    writeCloudConfig(cloudPaths(b.root).configFile, { enabled: false, baseUrl: server.origin }, { allowInsecureLoopback: true })
    const off = createCloudService({ storeRoot: b.root, box: fakeBox(), sign: (m) => b.keys.sign(m), getPublicIdentity: () => b.keys.getPublicIdentity(), allowInsecureLoopback: true })
    const s = svc(b, { cloud: off })
    const before = api.calls.length
    confirms = []
    const p = s.proposePreview(args(a)) // preview is local
    for (const fn of [() => s.sync(), () => s.propose(p.previewId, null), () => s.decline(id, null), () => s.remove(id, null)]) {
      await expect(fn()).rejects.toMatchObject({ code: 'disabled' })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(api.calls.length).toBe(before)
    expect(confirms).toHaveLength(0)
    expect(s.local().moments).toHaveLength(1)
    expect(s.setNote(id, '本机的话').myNote).toBe('本机的话')
  })
})

describe('IPC', () => {
  it('exact channels; strictObject rejects renderer-supplied signatures / texts / participants; sanitized errors', async () => {
    const ipc = fakeIpc()
    const s = svc(a)
    registerMomentsHandlers(ipc, s)
    expect(ipc.channels().sort()).toEqual(Object.values(MOMENTS_CHANNELS).sort())
    const base = args(b)
    const bad: Array<[string, unknown]> = [
      [MOMENTS_CHANNELS.proposePreview, { ...base, signature: 'x' }],
      [MOMENTS_CHANNELS.proposePreview, { ...base, participants: [a.fingerprint, b.fingerprint] }],
      [MOMENTS_CHANNELS.proposePreview, { ...base, proposer: {} }],
      [MOMENTS_CHANNELS.proposePreview, { ...base, visibility: 'public' }],
      [MOMENTS_CHANNELS.proposePreview, { ...base, start: '1/2/2026' }],
      [MOMENTS_CHANNELS.propose, { previewId: 'x', moment: '{}' }],
      [MOMENTS_CHANNELS.accept, { previewId: '0'.repeat(32), acceptance: '{}' }],
      [MOMENTS_CHANNELS.acceptPreview, { momentId: '../../etc' }],
      [MOMENTS_CHANNELS.remove, { momentId: 'ABC' }],
      [MOMENTS_CHANNELS.setNote, { momentId: '0f8fad5b-d9cb-469f-a165-70867728950e', text: 'x'.repeat(5000) }],
      [MOMENTS_CHANNELS.local, { x: 1 }]
    ]
    for (const [ch, raw] of bad) expect(await ipc.invoke(ch, raw), ch).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    const ok = (await ipc.invoke(MOMENTS_CHANNELS.proposePreview, base)) as { ok: true; data: { previewId: string } }
    expect(ok.ok).toBe(true)
    api.failNext = { status: 403, code: 'moment_not_owner' }
    const r = (await ipc.invoke(MOMENTS_CHANNELS.propose, { previewId: ok.data.previewId })) as { ok: false; error: { code: string; message: string } }
    expect(r.error.code).toBe('moment_not_owner')
    expect(r.error.message).not.toMatch(/server text|tok_/)
    expect(await ipc.invoke(MOMENTS_CHANNELS.local)).toMatchObject({ ok: true, data: { moments: [], rejected: [] } })
  })
})
