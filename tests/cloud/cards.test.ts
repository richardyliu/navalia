// C8 cloud cards against an in-test fake server: publish preview → native confirm → PUT exactly the
// previewed card text; unpublish; fetch a friend's card → offline verify → refuse forged / wrong
// signer / self → land in the Peers store (temp Lens Store) with fingerprint dedupe + versions.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCloudCardsService, type CloudCardsService } from '../../src/main/cloud/cards'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { writeCardFile } from '../../src/main/identity/card'
import { createPeerStore } from '../../src/main/peers/store'
import { storePaths } from '../../src/main/store/paths'
import { fakeBox, LOOPBACK, startFakeServer, type FakeServer } from './helpers'
import { cardTextOf, cleanupSubs, installSubsRoutes, person, type Person, type SubsServer } from './subs-helpers'

const roots: string[] = []
let server: FakeServer
let api: SubsServer
let me: Person
let cloud: CloudService
let answer: boolean
let confirms: Array<{ message: string; detail: string }>

function cards(over: Partial<Parameters<typeof createCloudCardsService>[0]> = {}): CloudCardsService {
  return createCloudCardsService({
    storeRoot: me.root,
    cloud,
    getPublicIdentity: () => me.keys.getPublicIdentity(),
    nativeConfirm: async (_s, o) => {
      confirms.push(o)
      return answer
    },
    ...over
  })
}

beforeEach(async () => {
  answer = true
  confirms = []
  server = await startFakeServer()
  me = person(roots, 'me')
  api = installSubsRoutes(server, () => me.fingerprint)
  writeCloudConfig(cloudPaths(me.root).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
  cloud = createCloudService({ storeRoot: me.root, box: fakeBox(), sign: (m) => me.keys.sign(m), getPublicIdentity: () => me.keys.getPublicIdentity(), allowInsecureLoopback: true })
  await cloud.signIn()
})

afterEach(async () => {
  await server.close()
  cleanupSubs(roots)
})

describe('publish my card', () => {
  it('no local card ⇒ no_card (nothing sent)', () => {
    expect(() => cards().publishPreview()).toThrow(expect.objectContaining({ code: 'no_card' }))
    expect(api.calls).toHaveLength(0)
  })

  it('preview shows readable fields + exact text; confirm required; PUT sends exactly that text', async () => {
    const older = me.card({ name: '旧名字', issuedAt: '2026-10-01T09:00:00.000Z' })
    const latest = me.card({ name: '我', issuedAt: '2026-11-02T09:00:00.000Z' })
    writeCardFile(storePaths(me.root), older)
    writeCardFile(storePaths(me.root), latest)
    const svc = cards()
    const pv = svc.publishPreview()
    expect(pv).toMatchObject({ fingerprint: me.fingerprint, cardId: latest.card.card_id, displayName: '我', highlights: ['在做本地优先的工具'], stats: { points: 40, faces: 2, volumes: 1 } })
    expect(pv.audienceNote).toContain('Public to anyone with your fingerprint')
    expect(pv.cardText).toBe(cardTextOf(latest))

    answer = false
    await expect(svc.publish(pv.previewId, null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls).toHaveLength(0)
    expect(confirms[0].detail).toContain('Public to anyone with your fingerprint')

    answer = true
    const out = await svc.publish(pv.previewId, null)
    expect(out).toMatchObject({ fingerprint: me.fingerprint, version: 1, unchanged: false })
    const put = api.calls.filter((c) => c.method === 'PUT')
    expect(put).toHaveLength(1)
    expect(put[0].body).toEqual({ card: pv.cardText })
    await expect(svc.publish(pv.previewId, null)).rejects.toMatchObject({ code: 'not_found' }) // single use

    expect(await svc.status()).toMatchObject({ published: true, version: 1, cardId: latest.card.card_id, verified: true, matchesLatest: true })
    const again = await svc.publish(svc.publishPreview().previewId, null)
    expect(again).toMatchObject({ version: 1, unchanged: true })
  })

  it('a card signed by a previous / other key is never offered', () => {
    const other = person(roots, 'other')
    writeCardFile(storePaths(me.root), other.card())
    expect(() => cards().publishPreview()).toThrow(expect.objectContaining({ code: 'no_card' }))
  })

  it('maps 403 card_not_owner / 400 card_invalid without server text', async () => {
    writeCardFile(storePaths(me.root), me.card())
    const svc = cards()
    for (const [status, code] of [
      [403, 'card_not_owner'],
      [400, 'card_invalid']
    ] as const) {
      api.failNext = { status, code }
      const e = await svc.publish(svc.publishPreview().previewId, null).catch((x: { code: string; message: string }) => x)
      expect(e).toMatchObject({ code })
      expect((e as { message: string }).message).not.toContain('server text')
    }
  })

  it('status when not published; unpublish requires confirm and sends DELETE', async () => {
    const svc = cards()
    expect(await svc.status()).toMatchObject({ published: false, verified: false })
    writeCardFile(storePaths(me.root), me.card())
    await svc.publish(svc.publishPreview().previewId, null)
    answer = false
    await expect(svc.unpublish(null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    answer = true
    expect(await svc.unpublish(null)).toBe(true)
    expect(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/v1/cards'])
    expect(await svc.status()).toMatchObject({ published: false })
  })

  it('no nativeConfirm ⇒ cancelled', async () => {
    writeCardFile(storePaths(me.root), me.card())
    const svc = cards({ nativeConfirm: undefined })
    await expect(svc.publish(svc.publishPreview().previewId, null)).rejects.toMatchObject({ code: 'cancelled' })
    await expect(svc.unpublish(null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.calls).toHaveLength(0)
  })
})

describe("fetch a friend's card", () => {
  it('valid card lands in the Peers store; re-fetch dedupes; newer version updates', async () => {
    const friend = person(roots, 'friend')
    const v1 = friend.card({ name: 'Alice', issuedAt: '2026-11-01T09:00:00.000Z' })
    api.cards.set(friend.fingerprint, { card: cardTextOf(v1), version: 1, published_at: '2026-11-01T10:00:00Z' })
    const svc = cards()
    expect(await svc.fetchFriend(friend.fingerprint)).toMatchObject({ outcome: 'added', fingerprint: friend.fingerprint, displayName: 'Alice', versions: 1, cloudVersion: 1 })
    expect(await svc.fetchFriend(friend.fingerprint)).toMatchObject({ outcome: 'unchanged', versions: 1 })
    const v2 = friend.card({ name: 'Alice', issuedAt: '2026-11-03T09:00:00.000Z' })
    api.cards.set(friend.fingerprint, { card: cardTextOf(v2), version: 2, published_at: '2026-11-03T10:00:00Z' })
    expect(await svc.fetchFriend(friend.fingerprint)).toMatchObject({ outcome: 'updated', versions: 2, cloudVersion: 2 })
    const store = createPeerStore({ storeRoot: me.root })
    const list = store.list()
    expect(list.peers.map((p) => p.fingerprint)).toEqual([friend.fingerprint])
    expect(store.get(friend.fingerprint)?.cardId).toBe(v2.card.card_id)
  })

  it('forged card (edited after signing) is refused and not stored', async () => {
    const friend = person(roots, 'friend')
    const c = friend.card()
    const forged = JSON.parse(cardTextOf(c)) as { card: { content: { front: { display_name: string } } } }
    forged.card.content.front.display_name = 'Mallory'
    api.cards.set(friend.fingerprint, { card: JSON.stringify(forged), version: 1, published_at: '2026-11-01T10:00:00Z' })
    await expect(cards().fetchFriend(friend.fingerprint)).rejects.toMatchObject({ code: 'signature_invalid' })
    expect(createPeerStore({ storeRoot: me.root }).list().peers).toHaveLength(0)
  })

  it("a valid card whose signer ≠ the requested fingerprint is refused", async () => {
    const a = person(roots, 'a')
    const b = person(roots, 'b')
    api.cards.set(a.fingerprint, { card: cardTextOf(b.card()), version: 1, published_at: '2026-11-01T10:00:00Z' })
    await expect(cards().fetchFriend(a.fingerprint)).rejects.toMatchObject({ code: 'wrong_signer' })
    expect(createPeerStore({ storeRoot: me.root }).list().peers).toHaveLength(0)
  })

  it('self is refused before any request; a card by a previous own key is refused by the Peers path', async () => {
    await expect(cards().fetchFriend(me.fingerprint)).rejects.toMatchObject({ code: 'self_card' })
    expect(api.calls).toHaveLength(0)
    // Previous key: retire `me`'s key; the old fingerprint is no longer "current" but still ours.
    const oldFp = me.fingerprint
    const oldCard = me.card()
    me.keys.resetIdentity()
    await cloud.signIn() // token is bound to the identity fingerprint
    api.cards.set(oldFp, { card: cardTextOf(oldCard), version: 1, published_at: '2026-11-01T10:00:00Z' })
    await expect(cards().fetchFriend(oldFp)).rejects.toMatchObject({ code: 'self_card' })
  })

  it('404 ⇒ not_found; malformed / garbage card ⇒ card_invalid', async () => {
    const svc = cards()
    await expect(svc.fetchFriend('c'.repeat(64))).rejects.toMatchObject({ code: 'not_found' })
    api.cards.set('d'.repeat(64), { card: '{"hello":1}', version: 1, published_at: '2026-11-01T10:00:00Z' })
    await expect(svc.fetchFriend('d'.repeat(64))).rejects.toMatchObject({ code: 'card_invalid' })
  })
})
