// S1-FULL Phase 4 gate: shared moments between two Lens identities through the REAL `cloud/`
// server (child process), cross-verified with the server's own verifiers, and the C11 weekly-letter
// filter (only accepted + `letters` + in-window moments appear; `private` never).
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyAcceptanceText, verifyMomentText } from '../../cloud/src/signed.ts'
import { createMomentsService, type MomentsService } from '../../src/main/cloud/moments'
import { createCloudService } from '../../src/main/cloud/service'
import { createSubsService } from '../../src/main/cloud/subs'
import { writeCardFile } from '../../src/main/identity/card'
import { createPeerStore } from '../../src/main/peers/store'
import { storePaths } from '../../src/main/store/paths'
import { fakeBox } from './helpers'
import { cardTextOf, cleanupSubs, person, subsTemp, type Person } from './subs-helpers'

const roots: string[] = []
let child: ChildProcess
let origin: string
let serverOut = ''

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
  const dir = subsTemp(roots, 'moments-server')
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve('cloud'),
    env: { PATH: process.env.PATH, PORT: String(port), CLOUD_DB_PATH: path.join(dir, 'db', 'cloud.db'), CLOUD_PUBLIC_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b) => (serverOut += String(b)))
  child.stderr?.on('data', (b) => (serverOut += String(b)))
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`cloud server did not start:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}, 40_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  cleanupSubs(roots)
})

async function setup(p: Person, published: string[] = []) {
  const cloud = createCloudService({
    storeRoot: p.root,
    box: fakeBox(),
    sign: (m) => p.keys.sign(m),
    getPublicIdentity: () => p.keys.getPublicIdentity(),
    allowInsecureLoopback: true,
    nativeConfirm: async () => true
  })
  await cloud.configure({ enabled: true, baseUrl: origin, confirm: true })
  await cloud.signIn()
  const moments: MomentsService = createMomentsService({ storeRoot: p.root, cloud, getPublicIdentity: () => p.keys.getPublicIdentity(), sign: (m) => p.keys.sign(m), nativeConfirm: async () => true, onMomentAccepted: (id, items) => published.push(`${id}|${items.length}`) })
  return { cloud, moments }
}

const today = new Date().toISOString().slice(0, 10)

describe('Phase 4 gate: shared moments, real server', () => {
  it('propose → offline-verified incoming → accept → both stores verified; letter lists only letters-visible; delete removes for both', { timeout: 90_000 }, async () => {
    const alice = person(roots, 'm-alice')
    const bob = person(roots, 'm-bob')
    const mallory = person(roots, 'm-mallory')
    // Friends exchanged cards (local Peers), Mallory is a stranger to Bob.
    const aCard = alice.card({ name: 'Alice' })
    const bCard = bob.card({ name: 'Bob' })
    writeCardFile(storePaths(alice.root), aCard)
    createPeerStore({ storeRoot: alice.root }).importText(cardTextOf(bCard))
    createPeerStore({ storeRoot: bob.root }).importText(cardTextOf(aCard))
    const aPublished: string[] = []
    const bPublished: string[] = []
    const A = await setup(alice, aPublished)
    const B = await setup(bob, bPublished)
    const M = await setup(mallory)
    createPeerStore({ storeRoot: mallory.root }).importText(cardTextOf(bCard))

    // Alice proposes two moments to Bob: one for letters, one private.
    const p1 = A.moments.proposePreview({ friendFingerprint: bob.fingerprint, title: '一起爬了香山', start: today, end: today, place: '香山', note: '天气很好', visibility: 'letters' })
    const m1 = await A.moments.propose(p1.previewId, null)
    const p2 = A.moments.proposePreview({ friendFingerprint: bob.fingerprint, title: '私下聊了换工作', start: today, end: today, place: null, note: '', visibility: 'private' })
    const m2 = await A.moments.propose(p2.previewId, null)
    // A stranger (not in Bob's Peers) proposes too.
    const pm = M.moments.proposePreview({ friendFingerprint: bob.fingerprint, title: '陌生人的共同经历', start: today, end: today, place: null, note: '', visibility: 'letters' })
    await M.moments.propose(pm.previewId, null)

    const bs = await B.moments.sync()
    expect(bs.dropped).toHaveLength(0)
    const byTitle = Object.fromEntries(bs.incoming.map((i) => [i.title, i]))
    expect(byTitle['一起爬了香山'].canAccept).toBe(true)
    expect(byTitle['陌生人的共同经历'].canAccept).toBe(false)
    expect(() => B.moments.acceptPreview(byTitle['陌生人的共同经历'].momentId)).toThrow()

    // Bob accepts both of Alice's moments (sha over canonical signed moment — must match the server).
    for (const id of [m1.momentId, m2.momentId]) {
      const ap = B.moments.acceptPreview(id)
      await B.moments.accept(ap.previewId, null)
    }
    const as = await A.moments.sync()
    // C17 publisher: Alice (proposer) is told once per newly accepted moment; Bob (who accepted) is not.
    expect(aPublished.sort()).toEqual([`${m1.momentId}|1`, `${m2.momentId}|1`].sort())
    await A.moments.sync()
    expect(aPublished).toHaveLength(2)
    expect(bPublished).toHaveLength(0)
    expect(as.accepted.map((m) => m.title).sort()).toEqual(['一起爬了香山', '私下聊了换工作'].sort())
    expect(B.moments.local().moments).toHaveLength(2)

    // Cross-verify the stored Lens objects with the server's own verifiers.
    const file = JSON.parse(fs.readFileSync(path.join(bob.root, 'moments', `${m1.momentId}.json`), 'utf8')) as { moment: string; acceptance: string }
    expect(fs.statSync(path.join(bob.root, 'moments', `${m1.momentId}.json`)).mode & 0o777).toBe(0o600)
    expect(verifyMomentText(file.moment).valid).toBe(true)
    expect(verifyAcceptanceText(file.acceptance, file.moment).valid).toBe(true)
    expect(verifyAcceptanceText(file.acceptance, file.moment.replace('天气很好', '天气很差')).valid).toBe(false)

    // C11: Alice's subscriber letter draft lists only the letters-visible moment, naming Bob.
    const subs = createSubsService({ storeRoot: alice.root, cloud: A.cloud, getPublicIdentity: () => alice.keys.getPublicIdentity(), sign: (m) => alice.keys.sign(m) })
    const draft = await subs.letterDraft({ timezone: 'UTC' })
    expect(draft.markdown).toContain('一起爬了香山')
    expect(draft.markdown).toContain('Bob')
    expect(draft.markdown).not.toContain('私下聊了换工作')
    expect(draft.markdown).not.toContain('陌生人的共同经历')

    // Bob deletes the letters moment: gone on the server for both.
    await B.moments.remove(m1.momentId, null)
    const after = await A.moments.sync()
    expect(after.remoteMissing).toContain(m1.momentId)
    expect((await B.moments.sync()).accepted.map((m) => m.momentId)).not.toContain(m1.momentId)

    // Server never logged titles / notes / places.
    await new Promise((r) => setTimeout(r, 200))
    for (const s of ['香山', '天气很好', '换工作', '陌生人']) expect(serverOut.includes(s), `server output contains ${s}`).toBe(false)
  })
})
