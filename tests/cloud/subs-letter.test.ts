// C10 letter envelope: canonicalization + Ed25519 round trip checked independently with
// node:crypto (hand-rolled sorted JSON, not identity/canonical.ts), tamper / signer swap / wrong
// fingerprint rejection, domain separation, ISO weeks, and the broadcast re-addressing of the
// deterministic peers/letter.ts draft.
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalize } from '../../src/main/identity/canonical'
import { fingerprintOf, rawPublicKey } from '../../src/main/identity/keys'
import { LETTER_CONTEXT, isoWeek, letterSigningText, signLetter, verifyLetterText } from '../../src/main/cloud/letter-sign'
import { broadcastLetter } from '../../src/main/cloud/subs'
import type { LetterEnvelopeUnsigned } from '../../src/main/cloud/subs-api'
import { buildLetter } from '../../src/main/peers/letter'

function key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = rawPublicKey(publicKey)
  return { raw, pub: raw.toString('base64url'), fp: fingerprintOf(raw), sign: (m: Buffer) => cryptoSign(null, m, privateKey), publicKey }
}

function unsignedFor(k: ReturnType<typeof key>, over: Partial<LetterEnvelopeUnsigned> = {}): LetterEnvelopeUnsigned {
  return {
    version: 1,
    kind: 'persome-letter',
    issue_id: '0b7f2c1e-4a5d-4c3b-9e8f-1a2b3c4d5e6f',
    week: '2026-W45',
    title: '每周信 · 2026-W45',
    markdown: '各位朋友，你好：\n\n这周在写 Lens 的订阅页。"引号" 和 \\ 反斜杠。',
    created_at: '2026-11-05T10:00:00.000Z',
    signer: { public_key: k.pub, fingerprint: k.fp },
    ...over
  }
}

/** Independent canonical JSON: recursive key sort + JSON.stringify (equal to JCS for these strings). */
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

describe('letter envelope signing', () => {
  it('signs persome-letter-v1\\n + canonical JSON without signature (verified independently)', () => {
    const k = key()
    const u = unsignedFor(k)
    const { text, envelope } = signLetter(u, k.sign)
    const expected = `persome-letter-v1\n${sortedJson(u)}`
    expect(letterSigningText(u)).toBe(expected)
    expect(LETTER_CONTEXT).toBe('persome-letter-v1')
    // Independent node:crypto verification over the hand-built bytes.
    const ok = cryptoVerify(null, Buffer.from(expected, 'utf8'), createPublicKey(k.publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(envelope.signature, 'base64url'))
    expect(ok).toBe(true)
    // The wire text is canonical JSON including the signature.
    expect(text).toBe(sortedJson({ ...u, signature: envelope.signature }))
    expect(verifyLetterText(text, k.fp)).toMatchObject({ valid: true })
    // Domain separation: the bare canonical JSON (what a card signature covers) does not verify.
    expect(cryptoVerify(null, Buffer.from(sortedJson(u), 'utf8'), k.publicKey, Buffer.from(envelope.signature, 'base64url'))).toBe(false)
  })

  it('accepts whitespace / key-order variations of the same envelope (canonical form is what is verified)', () => {
    const k = key()
    const { envelope } = signLetter(unsignedFor(k), k.sign)
    const reordered = JSON.stringify({ signature: envelope.signature, signer: envelope.signer, ...envelope }, null, 2)
    expect(verifyLetterText(reordered, k.fp).valid).toBe(true)
  })

  it('rejects tampered markdown, swapped signer, inconsistent fingerprint, wrong expected signer, schema and parse errors', () => {
    const a = key()
    const b = key()
    const { envelope } = signLetter(unsignedFor(a), a.sign)
    const t = (o: unknown): string => JSON.stringify(o)
    expect(verifyLetterText(t({ ...envelope, markdown: `${envelope.markdown}!` }), a.fp)).toMatchObject({ valid: false, reason: 'signature', issueId: envelope.issue_id })
    // Swap in b's key (self-consistent) but keep a's signature: does not verify under b.
    expect(verifyLetterText(t({ ...envelope, signer: { public_key: b.pub, fingerprint: b.fp } }), b.fp)).toMatchObject({ valid: false, reason: 'signature' })
    // Fingerprint not derived from the public key.
    expect(verifyLetterText(t({ ...envelope, signer: { public_key: a.pub, fingerprint: b.fp } }), b.fp)).toMatchObject({ valid: false, reason: 'fingerprint' })
    // Validly signed by a, served as b's letter.
    expect(verifyLetterText(t(envelope), b.fp)).toMatchObject({ valid: false, reason: 'wrong_signer' })
    expect(verifyLetterText(t({ ...envelope, extra: 1 }), a.fp)).toMatchObject({ valid: false, reason: 'schema' })
    expect(verifyLetterText(t({ ...envelope, kind: 'persome-card' }), a.fp)).toMatchObject({ valid: false, reason: 'schema' })
    expect(verifyLetterText('{not json', a.fp)).toMatchObject({ valid: false, reason: 'parse', issueId: null })
    // A letter re-signed by b with b as signer is valid for b only.
    const byB = signLetter(unsignedFor(b), b.sign).text
    expect(verifyLetterText(byB, b.fp).valid).toBe(true)
    expect(verifyLetterText(byB, a.fp)).toMatchObject({ valid: false, reason: 'wrong_signer' })
  })

  it('canonicalization matches identity/canonical.ts (same scheme as cards)', () => {
    const k = key()
    const u = unsignedFor(k)
    expect(letterSigningText(u)).toBe(`${LETTER_CONTEXT}\n${canonicalize(u)}`)
  })
})

describe('isoWeek', () => {
  it.each([
    ['2026-01-01', '2026-W01'],
    ['2026-11-05', '2026-W45'],
    ['2027-01-01', '2026-W53'],
    ['2024-12-30', '2025-W01'],
    ['2021-01-03', '2020-W53'],
    ['2026-12-28', '2026-W53']
  ])('%s → %s', (d, w) => expect(isoWeek(d)).toBe(w))
})

describe('broadcastLetter', () => {
  it('re-addresses the deterministic per-friend draft to subscribers', () => {
    const draft = buildLetter({
      now: Date.parse('2026-11-05T10:00:00Z'),
      timezone: 'UTC',
      peer: { fingerprint: 'a'.repeat(64), displayName: '各位朋友', cardId: '—', cardIssuedAt: '—' },
      recent: [{ id: 'e1', content: '写订阅页', timestamp: '2026-11-04T09:00:00Z', path: 'notes/a.md' } as never],
      related: null,
      shared: []
    })
    const md = broadcastLetter(draft.markdown)
    expect(md).not.toMatch(/^# /m)
    expect(md).not.toContain('致 ')
    expect(md).not.toContain('和你的卡片有关的')
    expect(md).not.toContain('对方卡片')
    expect(md).not.toContain('不会发送到任何地方')
    expect(md).toContain('各位朋友，你好：')
    expect(md).toContain('写订阅页')
    expect(md).toContain('## 我想说的')
    expect(broadcastLetter(draft.markdown)).toBe(md) // deterministic
  })
})
