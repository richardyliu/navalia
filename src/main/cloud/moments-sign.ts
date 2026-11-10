// S1-FULL C18 — signed shared-moment objects (main only; pure apart from node:crypto).
//
// Moment: Ed25519 by the proposer over UTF-8 `persome-moment-v1\n` + RFC 8785 canonical JSON
// (identity/canonical.ts) of the object WITHOUT `signature`. Wire text = canonical JSON incl.
// `signature`.
// Acceptance: Ed25519 by the other participant over `persome-moment-accept-v1\n` + canonical JSON
// of the acceptance WITHOUT `signature`; it names the moment by `moment_sha256` = hex sha256 of the
// canonical JSON of the full signed moment, so an acceptance can never be moved onto edited text.
// Domain prefixes keep these signatures distinct from cards, letters and cloud auth.
// Signing goes through the injected signer (KeyManager.sign); the private key never leaves keys.ts.
import { createHash, verify as cryptoVerify } from 'node:crypto'
import { z } from 'zod'
import { canonicalize } from '../identity/canonical'
import { fingerprintOf, publicKeyFromRaw } from '../identity/keys'
import { DATE_RE, MOMENT_ID_RE, MOMENT_LIMITS, type AcceptanceUnsigned, type MomentRejectReason, type MomentUnsigned } from './moments-api'

export const MOMENT_CONTEXT = 'persome-moment-v1'
export const ACCEPT_CONTEXT = 'persome-moment-accept-v1'

const FP_RE = /^[0-9a-f]{64}$/
const B64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const Sig = z.string().regex(/^[A-Za-z0-9_-]{86}$/)
const Party = z.strictObject({ public_key: B64Url32, fingerprint: z.string().regex(FP_RE) })
const Iso = z.string().datetime({ offset: true })

/** A real calendar date `YYYY-MM-DD`. */
export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s
}
const CalDate = z.string().refine(isCalendarDate)
const SingleLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n\u2028\u2029]/.test(s))

export const MomentSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('persome-moment'),
    moment_id: z.string().regex(MOMENT_ID_RE),
    title: SingleLine(MOMENT_LIMITS.maxTitleChars),
    note: z.string().max(MOMENT_LIMITS.maxNoteChars),
    occurred_on: z.strictObject({ start: CalDate, end: CalDate }),
    place: z.string().max(MOMENT_LIMITS.maxPlaceChars).nullable(),
    participants: z.tuple([z.string().regex(FP_RE), z.string().regex(FP_RE)]),
    visibility: z.enum(['private', 'letters']),
    proposer: Party,
    created_at: Iso,
    signature: Sig
  })
  .superRefine((m, ctx) => {
    if (m.occurred_on.start > m.occurred_on.end) ctx.addIssue({ code: 'custom', message: 'start after end' })
    if (!(m.participants[0] < m.participants[1])) ctx.addIssue({ code: 'custom', message: 'participants must be distinct and sorted' })
  })
export type SignedMoment = z.infer<typeof MomentSchema>

export const AcceptanceSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('persome-moment-accept'),
  moment_id: z.string().regex(MOMENT_ID_RE),
  moment_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  accepter: Party,
  accepted_at: Iso,
  signature: Sig
})
export type SignedAcceptance = z.infer<typeof AcceptanceSchema>

export function momentSigningText(unsigned: MomentUnsigned | Record<string, unknown>): string {
  return `${MOMENT_CONTEXT}\n${canonicalize(unsigned)}`
}

export function acceptanceSigningText(unsigned: AcceptanceUnsigned | Record<string, unknown>): string {
  return `${ACCEPT_CONTEXT}\n${canonicalize(unsigned)}`
}

/** hex sha256 of the canonical JSON text of the FULL signed moment (incl. signature). */
export function momentSha256(moment: SignedMoment | Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(moment), 'utf8').digest('hex')
}

export function signMoment(unsigned: MomentUnsigned, sign: (message: Buffer) => Buffer): { moment: SignedMoment; text: string } {
  const signature = sign(Buffer.from(momentSigningText(unsigned), 'utf8')).toString('base64url')
  const moment = MomentSchema.parse({ ...unsigned, signature })
  return { moment, text: canonicalize(moment) }
}

export function signAcceptance(unsigned: AcceptanceUnsigned, sign: (message: Buffer) => Buffer): { acceptance: SignedAcceptance; text: string } {
  const signature = sign(Buffer.from(acceptanceSigningText(unsigned), 'utf8')).toString('base64url')
  const acceptance = AcceptanceSchema.parse({ ...unsigned, signature })
  return { acceptance, text: canonicalize(acceptance) }
}

function checkKey(party: { public_key: string; fingerprint: string }): Buffer | null {
  const raw = Buffer.from(party.public_key, 'base64url')
  if (raw.length !== 32 || raw.toString('base64url') !== party.public_key || fingerprintOf(raw) !== party.fingerprint) return null
  return raw
}

function sigOk(text: string, raw: Buffer, signature: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(text, 'utf8'), publicKeyFromRaw(raw), Buffer.from(signature, 'base64url'))
  } catch {
    // CanonicalJsonError or malformed key: never valid.
    return false
  }
}

export type MomentVerify = { valid: true; moment: SignedMoment; sha256: string } | { valid: false; reason: MomentRejectReason; momentId: string | null }

function idOf(raw: unknown): string | null {
  const id = (raw as { moment_id?: unknown } | null)?.moment_id
  return typeof id === 'string' && MOMENT_ID_RE.test(id) ? id : null
}

/**
 * Offline verification of a moment text. `me`, when given, must be one of the two participants.
 * The signature is checked over the canonical form of the object exactly as parsed (minus
 * `signature`), never over a re-serialized schema output.
 */
export function verifyMomentText(text: string, me?: string): MomentVerify {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { valid: false, reason: 'parse', momentId: null }
  }
  const parsed = MomentSchema.safeParse(raw)
  if (!parsed.success) return { valid: false, reason: 'schema', momentId: idOf(raw) }
  const m = parsed.data
  const key = checkKey(m.proposer)
  if (!key) return { valid: false, reason: 'fingerprint', momentId: m.moment_id }
  if (!m.participants.includes(m.proposer.fingerprint)) return { valid: false, reason: 'not_participant', momentId: m.moment_id }
  if (me !== undefined && !m.participants.includes(me)) return { valid: false, reason: 'not_participant', momentId: m.moment_id }
  const { signature: _sig, ...unsigned } = raw as Record<string, unknown>
  let signing: string
  try {
    signing = momentSigningText(unsigned)
  } catch {
    return { valid: false, reason: 'signature', momentId: m.moment_id }
  }
  if (!sigOk(signing, key, m.signature)) return { valid: false, reason: 'signature', momentId: m.moment_id }
  return { valid: true, moment: m, sha256: momentSha256(raw as Record<string, unknown>) }
}

export type AcceptanceVerify = { valid: true; acceptance: SignedAcceptance } | { valid: false; reason: MomentRejectReason }

/** Verify an acceptance against an already verified moment (same id, same sha256, other participant). */
export function verifyAcceptanceText(text: string, moment: { moment: SignedMoment; sha256: string }): AcceptanceVerify {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { valid: false, reason: 'parse' }
  }
  const parsed = AcceptanceSchema.safeParse(raw)
  if (!parsed.success) return { valid: false, reason: 'schema' }
  const a = parsed.data
  const key = checkKey(a.accepter)
  if (!key) return { valid: false, reason: 'fingerprint' }
  if (a.moment_id !== moment.moment.moment_id || a.moment_sha256 !== moment.sha256) return { valid: false, reason: 'mismatch' }
  if (!moment.moment.participants.includes(a.accepter.fingerprint)) return { valid: false, reason: 'not_participant' }
  if (a.accepter.fingerprint === moment.moment.proposer.fingerprint) return { valid: false, reason: 'self_accept' }
  const { signature: _sig, ...unsigned } = raw as Record<string, unknown>
  let signing: string
  try {
    signing = acceptanceSigningText(unsigned)
  } catch {
    return { valid: false, reason: 'signature' }
  }
  if (!sigOk(signing, key, a.signature)) return { valid: false, reason: 'signature' }
  return { valid: true, acceptance: a }
}

/** Both texts verified, `me` a participant. */
export function verifyAcceptedPair(
  momentText: string,
  acceptanceText: string,
  me?: string
): { valid: true; moment: SignedMoment; acceptance: SignedAcceptance; sha256: string } | { valid: false; reason: MomentRejectReason; momentId: string | null } {
  const m = verifyMomentText(momentText, me)
  if (!m.valid) return m
  const a = verifyAcceptanceText(acceptanceText, m)
  if (!a.valid) return { valid: false, reason: a.reason, momentId: m.moment.moment_id }
  return { valid: true, moment: m.moment, acceptance: a.acceptance, sha256: m.sha256 }
}
