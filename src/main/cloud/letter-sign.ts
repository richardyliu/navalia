// S1-FULL C10 — signed weekly-letter envelope (main only, pure apart from node:crypto).
//
// Envelope: {version:1, kind:"persome-letter", issue_id, week, title, markdown, created_at,
// signer:{public_key, fingerprint}, signature}. The signature is Ed25519 over the UTF-8 bytes of
// `persome-letter-v1\n` + RFC 8785 canonical JSON (identity/canonical.ts, the same canonicalization
// as cards) of the envelope WITHOUT `signature`. The domain prefix keeps a letter signature from
// ever being a valid card signature (card bytes start with `{`) or a cloud auth signature.
// Signing goes through the injected signer (KeyManager.sign); the private key never leaves keys.ts.
import { verify as cryptoVerify } from 'node:crypto'
import { z } from 'zod'
import { canonicalize } from '../identity/canonical'
import { fingerprintOf, publicKeyFromRaw } from '../identity/keys'
import { FINGERPRINT_RE, WEEK_RE, type LetterEnvelopeUnsigned, type LetterRejectReason } from './subs-api'

export const LETTER_CONTEXT = 'persome-letter-v1'
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Verification is more lenient than creation (another client may allow longer letters). */
const VERIFY_MAX_MARKDOWN = 60_000
const VERIFY_MAX_TITLE = 400

const B64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const SignerSchema = z.strictObject({ public_key: B64Url32, fingerprint: z.string().regex(FINGERPRINT_RE) })

export const LetterEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('persome-letter'),
  issue_id: z.string().regex(UUID_RE),
  week: z.string().regex(WEEK_RE),
  title: z.string().min(1).max(VERIFY_MAX_TITLE),
  markdown: z.string().min(1).max(VERIFY_MAX_MARKDOWN),
  created_at: z.string().datetime({ offset: true }),
  signer: SignerSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
})
export type LetterEnvelope = z.infer<typeof LetterEnvelopeSchema>

/** `persome-letter-v1\n` + canonical JSON of the unsigned envelope, as a string. */
export function letterSigningText(unsigned: LetterEnvelopeUnsigned | Record<string, unknown>): string {
  return `${LETTER_CONTEXT}\n${canonicalize(unsigned)}`
}

export function letterSigningBytes(unsigned: LetterEnvelopeUnsigned | Record<string, unknown>): Buffer {
  return Buffer.from(letterSigningText(unsigned), 'utf8')
}

/** Sign and return the envelope text sent to the server (canonical JSON incl. `signature`). */
export function signLetter(unsigned: LetterEnvelopeUnsigned, sign: (message: Buffer) => Buffer): { envelope: LetterEnvelope; text: string } {
  const signature = sign(letterSigningBytes(unsigned)).toString('base64url')
  const envelope = LetterEnvelopeSchema.parse({ ...unsigned, signature })
  return { envelope, text: canonicalize(envelope) }
}

export type LetterVerifyResult = { valid: true; envelope: LetterEnvelope } | { valid: false; reason: LetterRejectReason; issueId: string | null }

/**
 * Offline verification of an envelope text. The signature is checked over the canonical form of
 * the envelope exactly as parsed (minus `signature`), not over a re-serialized schema output.
 * `expectedFingerprint`, when given, must equal the signer (a server cannot pass off someone
 * else's — validly signed — letter as this friend's).
 */
export function verifyLetterText(text: string, expectedFingerprint?: string): LetterVerifyResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { valid: false, reason: 'parse', issueId: null }
  }
  const issueOf = (): string | null => {
    const id = (raw as { issue_id?: unknown } | null)?.issue_id
    return typeof id === 'string' && UUID_RE.test(id) ? id : null
  }
  const parsed = LetterEnvelopeSchema.safeParse(raw)
  if (!parsed.success) return { valid: false, reason: 'schema', issueId: issueOf() }
  const env = parsed.data
  const rawPub = Buffer.from(env.signer.public_key, 'base64url')
  if (rawPub.length !== 32 || fingerprintOf(rawPub) !== env.signer.fingerprint) return { valid: false, reason: 'fingerprint', issueId: env.issue_id }
  if (expectedFingerprint !== undefined && env.signer.fingerprint !== expectedFingerprint) return { valid: false, reason: 'wrong_signer', issueId: env.issue_id }
  const { signature: _sig, ...unsigned } = raw as Record<string, unknown>
  let ok = false
  try {
    ok = cryptoVerify(null, letterSigningBytes(unsigned), publicKeyFromRaw(rawPub), Buffer.from(env.signature, 'base64url'))
  } catch {
    // CanonicalJsonError (lone surrogate, …) or a malformed key: never a valid signature.
    ok = false
  }
  if (!ok) return { valid: false, reason: 'signature', issueId: env.issue_id }
  return { valid: true, envelope: env }
}

/** ISO 8601 week label (`YYYY-Www`) of a calendar date `YYYY-MM-DD`. */
export function isoWeek(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(t)) throw new RangeError('invalid date')
  const d = new Date(t)
  const day = d.getUTCDay() || 7 // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day) // Thursday of this week decides the year
  const year = d.getUTCFullYear()
  const jan1 = Date.UTC(year, 0, 1)
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}
