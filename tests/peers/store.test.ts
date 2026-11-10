import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_FORMAT, newCardId, signCard } from '../../src/main/identity/card'
import { createKeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { createPeerStore, MAX_HISTORY } from '../../src/main/peers/store'
import { createTestBox } from '../identity/helpers'
import { friend, tempDir, text, type Friend } from './fixtures'

const roots: string[] = []
function setup(clock = ['2026-11-05T10:00:00.000Z']) {
  const storeRoot = tempDir('store')
  roots.push(storeRoot)
  let i = 0
  const store = createPeerStore({ storeRoot, now: () => new Date(clock[Math.min(i++, clock.length - 1)]) })
  return { storeRoot, store }
}
function mkFriend(label: string): Friend {
  const f = friend(label)
  roots.push(f.root)
  return f
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const mode = (p: string): number => fs.statSync(p).mode & 0o777

describe('peer store: import + verify', () => {
  it('imports a valid card with fingerprint, importedAt and owner-only perms', () => {
    const { store } = setup()
    const alice = mkFriend('a')
    const r = store.importText(text(alice.card()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.outcome).toBe('added')
    expect(r.peer.fingerprint).toBe(alice.fingerprint)
    expect(r.peer.importedAt).toBe('2026-11-05T10:00:00.000Z')
    expect(r.peer.verification).toBe('valid')
    expect(r.peer.displayName).toBe('Alice')
    expect(r.peer.headline).toBe('独立开发者，专注于个人知识管理。')
    expect(r.peer.topics.map((t) => t.source)).toEqual(['summary', 'highlight', 'highlight', 'map'])
    expect(r.peer.events).toEqual([{ at: '2026-11-05T10:00:00.000Z', kind: 'imported', cardId: r.peer.cardId, cardIssuedAt: '2026-11-01T09:00:00.000Z' }])

    expect(mode(store.dir)).toBe(0o700)
    const file = path.join(store.dir, `${alice.fingerprint}.json`)
    expect(mode(file)).toBe(0o600)
    const list = store.list()
    expect(list.unreadable).toBe(0)
    expect(list.peers.map((p) => p.fingerprint)).toEqual([alice.fingerprint])
  })

  it('rejects a tampered card and writes nothing', () => {
    const { store } = setup()
    const card = mkFriend('t').card()
    const tampered = JSON.parse(text(card))
    tampered.card.content.front.summary = '我是另一个人'
    const r = store.importText(JSON.stringify(tampered))
    expect(r).toMatchObject({ ok: false, reason: 'tampered' })
    expect(store.list().peers).toEqual([])
    expect(fs.existsSync(store.dir)).toBe(false)
  })

  it('rejects a card whose public key was swapped (fingerprint mismatch) as tampered', () => {
    const { store } = setup()
    const a = mkFriend('a').card()
    const b = mkFriend('b').card()
    const forged = JSON.parse(text(a))
    forged.card.issuer.public_key = b.card.issuer.public_key
    expect(store.importText(JSON.stringify(forged))).toMatchObject({ ok: false, reason: 'tampered' })
  })

  it('rejects non-cards as invalid', () => {
    const { store } = setup()
    expect(store.importText('not json')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(store.importText('{"card":{}}')).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it("rejects the user's own card (current and retired key)", () => {
    const { storeRoot, store } = setup()
    const keys = createKeyManager(storePaths(storeRoot), createTestBox())
    const sign = () => {
      const id = keys.getPublicIdentity() ?? keys.ensureIdentity()
      const own = friend('tmp')
      roots.push(own.root)
      const base = own.card()
      return signCard({ ...base.card, card_id: newCardId(), format: CARD_FORMAT, issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint } }, keys)
    }
    keys.ensureIdentity()
    const mine = sign()
    expect(store.importText(text(mine))).toMatchObject({ ok: false, reason: 'self' })
    keys.resetIdentity()
    expect(store.importText(text(mine))).toMatchObject({ ok: false, reason: 'self' })
  })
})

describe('peer store: re-import keeps history', () => {
  it('same fingerprint updates in place; newer card becomes current; older goes to history', () => {
    const { store } = setup(['2026-11-05T10:00:00.000Z', '2026-11-06T10:00:00.000Z', '2026-11-07T10:00:00.000Z', '2026-11-08T10:00:00.000Z'])
    const alice = mkFriend('a')
    const v1 = alice.card({ issuedAt: '2026-11-01T09:00:00.000Z' })
    const v2 = alice.card({ issuedAt: '2026-11-04T09:00:00.000Z', summary: '新的概述' })
    const v0 = alice.card({ issuedAt: '2026-10-01T09:00:00.000Z', summary: '更早的概述' })
    expect(store.importText(text(v1))).toMatchObject({ ok: true, outcome: 'added' })
    const r2 = store.importText(text(v2))
    expect(r2).toMatchObject({ ok: true, outcome: 'updated' })
    const r3 = store.importText(text(v2))
    expect(r3).toMatchObject({ ok: true, outcome: 'unchanged' })
    const r4 = store.importText(text(v0))
    expect(r4).toMatchObject({ ok: true, outcome: 'older_version' })

    const list = store.list()
    expect(list.peers).toHaveLength(1)
    const d = store.get(alice.fingerprint)!
    expect(d.headline).toBe('新的概述')
    expect(d.cardId).toBe(v2.card.card_id)
    expect(d.versions).toBe(3)
    expect(d.history.map((h) => h.issuedAt)).toEqual(['2026-11-04T09:00:00.000Z', '2026-11-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'])
    expect(d.importedAt).toBe('2026-11-05T10:00:00.000Z')
    expect(d.updatedAt).toBe('2026-11-06T10:00:00.000Z')
    expect(d.events.map((e) => e.kind)).toEqual(['older_version', 'reimported_same', 'updated', 'imported'])
  })

  it(`caps history at ${MAX_HISTORY} versions`, () => {
    const { store } = setup()
    const alice = mkFriend('a')
    for (let i = 0; i < MAX_HISTORY + 3; i++) {
      store.importText(text(alice.card({ issuedAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() })))
    }
    expect(store.get(alice.fingerprint)!.versions).toBe(MAX_HISTORY)
  })

  it('marks the older key of a same-name friend as old_key (heuristic)', () => {
    const { store } = setup()
    const oldKey = mkFriend('old')
    const newKey = mkFriend('new')
    store.importText(text(oldKey.card({ issuedAt: '2026-10-01T00:00:00.000Z' })))
    store.importText(text(newKey.card({ issuedAt: '2026-11-01T00:00:00.000Z' })))
    const byFp = Object.fromEntries(store.list().peers.map((p) => [p.fingerprint, p]))
    expect(byFp[oldKey.fingerprint].verification).toBe('old_key')
    expect(byFp[oldKey.fingerprint].supersededBy).toBe(newKey.fingerprint)
    expect(byFp[newKey.fingerprint].verification).toBe('valid')
  })
})

describe('peer store: on-disk tamper + remove', () => {
  it('a stored file edited on disk is not listed and is counted as unreadable', () => {
    const { store } = setup()
    const alice = mkFriend('a')
    store.importText(text(alice.card()))
    const file = path.join(store.dir, `${alice.fingerprint}.json`)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    stored.history[0].card.card.content.front.display_name = 'Mallory'
    fs.writeFileSync(file, JSON.stringify(stored))
    expect(store.list()).toEqual({ peers: [], unreadable: 1 })
    expect(store.get(alice.fingerprint)).toBeNull()
    // Re-importing the genuine card replaces the broken file.
    expect(store.importText(text(alice.card()))).toMatchObject({ ok: true, outcome: 'added' })
    expect(store.list().unreadable).toBe(0)
  })

  it('removes a peer; invalid fingerprints are refused', () => {
    const { store } = setup()
    const alice = mkFriend('a')
    store.importText(text(alice.card()))
    expect(store.remove(alice.fingerprint)).toBe(true)
    expect(store.remove(alice.fingerprint)).toBe(false)
    expect(store.list().peers).toEqual([])
    expect(() => store.remove('../../etc/passwd')).toThrow(/invalid fingerprint/)
    expect(store.get('../x')).toBeNull()
  })
})
