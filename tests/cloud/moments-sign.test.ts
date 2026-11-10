// C18 signed objects: round trip verified independently (hand-sorted JSON + node:crypto with an
// SPKI key built from the raw public key), sha256 over the canonical signed moment, cross-check with
// the server's own verifiers, and every rejection path (tamper / wrong signer / third party).
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcceptanceUnsigned, MomentUnsigned } from '../../src/main/cloud/moments-api'
import {
  momentSha256,
  momentSigningText,
  signAcceptance,
  signMoment,
  verifyAcceptanceText,
  verifyAcceptedPair,
  verifyMomentText
} from '../../src/main/cloud/moments-sign'
import { verifyAcceptanceText as serverAcceptance, verifyMomentText as serverMoment } from '../../cloud/src/signed.ts'
import { cleanupMoments, person, type Person } from './moments-helpers'

const roots: string[] = []
afterEach(() => cleanupMoments(roots))

/** Independent canonicalization for these plain values: recursively sorted keys + JSON.stringify. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
  return v
}
const canon = (v: unknown): string => JSON.stringify(sorted(v))
const spki = (rawB64: string) =>
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(rawB64, 'base64url')]), format: 'der', type: 'spki' })

function unsignedMoment(a: Person, b: Person, over: Partial<MomentUnsigned> = {}): MomentUnsigned {
  return {
    version: 1,
    kind: 'persome-moment',
    moment_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    title: '一起去爬了香山',
    note: '天气很好',
    occurred_on: { start: '2026-11-01', end: '2026-11-01' },
    place: '北京',
    participants: [a.fingerprint, b.fingerprint].sort() as [string, string],
    visibility: 'letters',
    proposer: { public_key: a.publicKey, fingerprint: a.fingerprint },
    created_at: '2026-11-05T02:00:00.000Z',
    ...over
  }
}
function unsignedAcceptance(b: Person, momentId: string, sha: string): AcceptanceUnsigned {
  return {
    version: 1,
    kind: 'persome-moment-accept',
    moment_id: momentId,
    moment_sha256: sha,
    accepter: { public_key: b.publicKey, fingerprint: b.fingerprint },
    accepted_at: '2026-11-05T03:00:00.000Z'
  }
}

describe('moment signing', () => {
  it('round trip verifies independently; wire text is canonical JSON incl. signature', () => {
    const a = person(roots, 'a')
    const b = person(roots, 'b')
    const u = unsignedMoment(a, b)
    const { moment, text } = signMoment(u, (m) => a.keys.sign(m))
    expect(text).toBe(canon(moment))
    const ok = cryptoVerify(null, Buffer.from(`persome-moment-v1\n${canon(u)}`, 'utf8'), spki(a.publicKey), Buffer.from(moment.signature, 'base64url'))
    expect(ok).toBe(true)
    expect(momentSigningText(u)).toBe(`persome-moment-v1\n${canon(u)}`)
    // Domain separation: a bare canonical signature is not valid.
    expect(cryptoVerify(null, Buffer.from(canon(u)), spki(a.publicKey), Buffer.from(moment.signature, 'base64url'))).toBe(false)
    const v = verifyMomentText(text, b.fingerprint)
    expect(v.valid).toBe(true)
  })

  it('sha256 = hex sha256 of the canonical signed moment; pretty-printed text yields the same sha; server agrees', () => {
    const a = person(roots, 'a')
    const b = person(roots, 'b')
    const { moment, text } = signMoment(unsignedMoment(a, b), (m) => a.keys.sign(m))
    const expected = createHash('sha256').update(canon(moment), 'utf8').digest('hex')
    expect(momentSha256(moment)).toBe(expected)
    const pretty = JSON.stringify(moment, null, 2)
    const v = verifyMomentText(pretty)
    expect(v.valid && v.sha256).toBe(expected)
    const sv = serverMoment(text)
    expect(sv.valid && sv.sha256).toBe(expected)
    const { text: acc } = signAcceptance(unsignedAcceptance(b, moment.moment_id, expected), (m) => b.keys.sign(m))
    expect(serverAcceptance(acc, text).valid).toBe(true)
    expect(verifyAcceptedPair(text, acc, a.fingerprint).valid).toBe(true)
    expect(verifyAcceptedPair(text, acc, b.fingerprint).valid).toBe(true)
    const accIndependent = cryptoVerify(
      null,
      Buffer.from(`persome-moment-accept-v1\n${canon(unsignedAcceptance(b, moment.moment_id, expected))}`, 'utf8'),
      spki(b.publicKey),
      Buffer.from(JSON.parse(acc).signature, 'base64url')
    )
    expect(accIndependent).toBe(true)
  })

  it('rejects tamper, wrong signer, third party, bad shape', () => {
    const a = person(roots, 'a')
    const b = person(roots, 'b')
    const c = person(roots, 'c')
    const { moment, text } = signMoment(unsignedMoment(a, b), (m) => a.keys.sign(m))
    expect(verifyMomentText(JSON.stringify({ ...moment, title: '改过的标题' }))).toMatchObject({ valid: false, reason: 'signature' })
    expect(verifyMomentText(JSON.stringify({ ...moment, visibility: 'private' }))).toMatchObject({ valid: false, reason: 'signature' })
    // proposer key swapped for someone else's (consistent fp) ⇒ signature fails
    expect(verifyMomentText(JSON.stringify({ ...moment, proposer: { public_key: c.publicKey, fingerprint: c.fingerprint } }))).toMatchObject({ valid: false })
    // claimed fingerprint does not match the key
    expect(verifyMomentText(JSON.stringify({ ...moment, proposer: { public_key: a.publicKey, fingerprint: c.fingerprint } }))).toMatchObject({ valid: false, reason: 'fingerprint' })
    // third party: valid moment, but "me" is not a participant
    expect(verifyMomentText(text, c.fingerprint)).toMatchObject({ valid: false, reason: 'not_participant' })
    // a moment signed by A about B and C (A not a participant)
    const foreign = signMoment(unsignedMoment(a, b, { participants: [b.fingerprint, c.fingerprint].sort() as [string, string] }), (m) => a.keys.sign(m))
    expect(verifyMomentText(foreign.text)).toMatchObject({ valid: false, reason: 'not_participant' })
    // unsorted / duplicate participants, extra field, bad date ⇒ schema
    expect(verifyMomentText(JSON.stringify({ ...moment, participants: [...moment.participants].reverse() }))).toMatchObject({ reason: 'schema' })
    expect(verifyMomentText(JSON.stringify({ ...moment, extra: 1 }))).toMatchObject({ reason: 'schema' })
    expect(verifyMomentText(JSON.stringify({ ...moment, occurred_on: { start: '2026-11-02', end: '2026-11-01' } }))).toMatchObject({ reason: 'schema' })
    expect(verifyMomentText(JSON.stringify({ ...moment, title: 'two\nlines' }))).toMatchObject({ reason: 'schema' })
    expect(verifyMomentText('{nope')).toMatchObject({ reason: 'parse' })
  })

  it('acceptance: wrong sha / wrong id / by proposer / by third party / tampered / domain-confused are rejected', () => {
    const a = person(roots, 'a')
    const b = person(roots, 'b')
    const c = person(roots, 'c')
    const signed = signMoment(unsignedMoment(a, b), (m) => a.keys.sign(m))
    const v = verifyMomentText(signed.text)
    if (!v.valid) throw new Error('setup')
    const ok = signAcceptance(unsignedAcceptance(b, v.moment.moment_id, v.sha256), (m) => b.keys.sign(m))
    expect(verifyAcceptanceText(ok.text, v).valid).toBe(true)
    const wrongSha = signAcceptance(unsignedAcceptance(b, v.moment.moment_id, 'f'.repeat(64)), (m) => b.keys.sign(m))
    expect(verifyAcceptanceText(wrongSha.text, v)).toMatchObject({ valid: false, reason: 'mismatch' })
    const byProposer = signAcceptance(unsignedAcceptance(a, v.moment.moment_id, v.sha256), (m) => a.keys.sign(m))
    expect(verifyAcceptanceText(byProposer.text, v)).toMatchObject({ valid: false, reason: 'self_accept' })
    const byThird = signAcceptance(unsignedAcceptance(c, v.moment.moment_id, v.sha256), (m) => c.keys.sign(m))
    expect(verifyAcceptanceText(byThird.text, v)).toMatchObject({ valid: false, reason: 'not_participant' })
    expect(verifyAcceptanceText(JSON.stringify({ ...ok.acceptance, accepted_at: '2027-01-01T00:00:00.000Z' }), v)).toMatchObject({ valid: false, reason: 'signature' })
    // B's moment-domain signature over the same fields is not an acceptance signature
    const confused = { ...ok.acceptance, signature: b.keys.sign(Buffer.from(`persome-moment-v1\n${canon(unsignedAcceptance(b, v.moment.moment_id, v.sha256))}`)).toString('base64url') }
    expect(verifyAcceptanceText(JSON.stringify(confused), v)).toMatchObject({ valid: false, reason: 'signature' })
    // The acceptance does not transfer to an edited moment (different sha).
    const edited = signMoment(unsignedMoment(a, b, { title: '另一个标题' }), (m) => a.keys.sign(m))
    expect(verifyAcceptedPair(edited.text, ok.text)).toMatchObject({ valid: false, reason: 'mismatch' })
  })
})
