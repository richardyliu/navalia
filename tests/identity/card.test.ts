import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { canonicalize } from '../../src/main/identity/canonical'
import {
  CARD_FORMAT,
  latestCard,
  newCardId,
  readCardFile,
  signCard,
  verifyCardText,
  writeCardFile,
  type Card,
  type SignedCard
} from '../../src/main/identity/card'
import { buildCardContent } from '../../src/main/identity/card-content'
import { createKeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { sources } from './fixtures'
import { createTestBox, mode, tempRoot } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function issue(issuedAt = '2026-11-04T18:00:00.000Z') {
  const root = tempRoot('card')
  roots.push(root)
  const paths = storePaths(root)
  const keys = createKeyManager(paths, createTestBox())
  const id = keys.ensureIdentity()
  const card: Card = {
    format: CARD_FORMAT,
    version: 1,
    card_id: newCardId(),
    issued_at: issuedAt,
    issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint },
    content: buildCardContent(sources(), { displayName: 'Ryl' })
  }
  return { paths, keys, signed: signCard(card, keys) }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

describe('sign / verify', () => {
  test('a freshly signed card verifies', () => {
    const { signed } = issue()
    const r = verifyCardText(JSON.stringify(signed))
    expect(r.valid).toBe(true)
  })

  test('offline: the file alone verifies after the key store is deleted', () => {
    const { paths, signed } = issue()
    const file = writeCardFile(paths, signed)
    expect(mode(file)).toBe('600')
    expect(path.extname(file)).toBe('.navaliacard')
    const exported = path.join(tempRoot('export'), 'copy.navaliacard')
    roots.push(path.dirname(exported))
    fs.copyFileSync(file, exported)
    fs.rmSync(paths.root, { recursive: true, force: true })
    expect(readCardFile(exported).valid).toBe(true)
  })

  test('formatting and key order do not matter (canonical JSON)', () => {
    const { signed } = issue()
    const reordered = JSON.parse(canonicalize(signed)) as SignedCard
    const text = JSON.stringify({ signature: reordered.signature, card: reordered.card }, null, 7)
    expect(verifyCardText(text).valid).toBe(true)
  })

  test('the file never contains private material', () => {
    const { signed } = issue()
    const text = JSON.stringify(signed)
    expect(text).not.toMatch(/ciphertext|PRIVATE|pkcs8/i)
  })
})

describe('tamper detection', () => {
  const cases: Array<[string, (s: SignedCard) => void, string]> = [
    ['summary text edited', (s) => void (s.card.content.front.summary = 'Someone else entirely'), 'signature'],
    ['confidence nudged', (s) => void (s.card.content.front.highlights[0].confidence += 0.01), 'signature'],
    ['as_of moved', (s) => void (s.card.content.front.as_of = '2030-01-01T00:00:00.000Z'), 'signature'],
    ['mini map edge removed', (s) => void s.card.content.back.mini_map.edges.pop(), 'signature'],
    ['display name changed', (s) => void (s.card.content.front.display_name = 'Mallory'), 'signature'],
    ['card_id changed', (s) => void (s.card.card_id = `card_${'0'.repeat(32)}`), 'signature'],
    [
      'signature bit flipped',
      (s) => {
        const b = Buffer.from(s.signature.value, 'base64url')
        b[10] ^= 1
        s.signature.value = b.toString('base64url')
      },
      'signature'
    ],
    ['extra unsigned field in card', (s) => void ((s.card as Record<string, unknown>).evil = 1), 'schema'],
    ['extra unsigned field in envelope', (s) => void ((s as Record<string, unknown>).note = 'trust me'), 'schema'],
    ['fingerprint does not match key', (s) => void (s.card.issuer.fingerprint = 'f'.repeat(64)), 'fingerprint'],
    ['signature fingerprint mismatch', (s) => void (s.signature.key_fingerprint = 'a'.repeat(64)), 'fingerprint'],
    ['wrong format tag', (s) => void ((s.card as Record<string, unknown>).format = 'other'), 'schema']
  ]
  test.each(cases)('%s → invalid (%s)', (_name, mutate, reason) => {
    const { signed } = issue()
    const t = clone(signed)
    mutate(t)
    const r = verifyCardText(JSON.stringify(t))
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toBe(reason === 'signature' ? 'signature' : reason)
  })

  test('public key swapped for another valid key → signature fails', () => {
    const a = issue()
    const b = issue()
    const t = clone(a.signed)
    t.card.issuer = clone(b.signed.card.issuer)
    t.signature.key_fingerprint = b.signed.card.issuer.fingerprint
    const r = verifyCardText(JSON.stringify(t))
    expect(r).toMatchObject({ valid: false, reason: 'signature' })
  })

  test('self-signed limit: an attacker re-signing with their own key verifies, but the fingerprint differs', () => {
    const a = issue()
    const b = issue()
    const forged = clone(a.signed.card)
    forged.issuer = clone(b.signed.card.issuer)
    const reSigned = signCard(forged, b.keys)
    expect(verifyCardText(JSON.stringify(reSigned)).valid).toBe(true)
    expect(reSigned.card.issuer.fingerprint).not.toBe(a.signed.card.issuer.fingerprint)
  })

  test('truncated / non-JSON file → parse failure', () => {
    const { signed } = issue()
    const text = JSON.stringify(signed)
    expect(verifyCardText(text.slice(0, text.length - 5))).toMatchObject({ valid: false, reason: 'parse' })
  })

  test('signCard refuses a card whose issuer is not the local identity', () => {
    const a = issue()
    const b = issue()
    const foreign = clone(a.signed.card)
    expect(() => signCard(foreign, b.keys)).toThrow(/issuer does not match/)
  })
})

describe('card files in the store', () => {
  test('latestCard returns the newest verifying card and skips tampered ones', () => {
    const { paths, keys, signed } = issue('2026-11-04T18:00:00.000Z')
    writeCardFile(paths, signed)
    const newer = clone(signed.card)
    newer.card_id = newCardId()
    newer.issued_at = '2026-11-05T18:00:00.000Z'
    const newerSigned = signCard(newer, keys)
    const newerFile = writeCardFile(paths, newerSigned)
    expect(latestCard(paths)?.card.card_id).toBe(newer.card_id)
    const tampered = clone(newerSigned)
    tampered.card.content.front.summary = 'x'
    fs.writeFileSync(newerFile, JSON.stringify(tampered))
    expect(latestCard(paths)?.card.card_id).toBe(signed.card.card_id)
  })
})
