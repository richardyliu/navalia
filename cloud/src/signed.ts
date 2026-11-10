// Pure verifiers for Lens-signed documents. No DB, no HTTP: the lead imports these from
// vitest to cross-check against cards produced by Lens code.
//
// Card: re-implements src/main/identity/card.ts `verifyCardText` + card-schema.ts (zod 4,
// strict objects) without zod. Signature = Ed25519 over RFC 8785 canonical JSON of the
// `card` object exactly as parsed (no domain prefix; that is the Lens format).
//
// Letter: S1-FULL C9 envelope. Signature = Ed25519 over UTF-8 of
// "persome-letter-v1\n" + canonical JSON of the envelope without `signature`.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { canonicalBytes } from './canonical.ts'

export type VerifyFailure = 'parse' | 'schema' | 'fingerprint' | 'signature'

export const CARD_FORMAT = 'navalia.card'
/** Previous name (Grapple); still accepted. */
export const PREV_CARD_FORMAT = 'grapple.card'
/** Pre-rename (Persome Lens) card format; still accepted. */
export const LEGACY_CARD_FORMAT = 'persome-lens.card'
export const MAX_LABEL_UNITS = 560
export const MAX_HIGHLIGHTS = 5
export const MAX_MAP_NODES = 1 + 12 + 48
export const MAX_MAP_EDGES = 4096

export const LETTER_DOMAIN = 'persome-letter-v1\n'
export const LETTER_KIND = 'persome-letter'
export const MAX_LETTER_TITLE = 200
export const MAX_LETTER_MARKDOWN = 100_000

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/
const HEX64 = /^[0-9a-f]{64}$/
const CARD_ID = /^card_[0-9a-f]{32}$/
const MAP_KEY = /^[rvf]\d{1,3}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_WEEK = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/
// zod 4 `z.string().datetime({ offset: true })` (core/regexes.js datetime, precision unset).
const DATE_SRC =
  '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))'
const ISO_DATETIME = new RegExp(
  `^${DATE_SRC}T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$`
)

class SchemaError extends Error {}

type Obj = Record<string, unknown>

function fail(path: string, msg: string): never {
  throw new SchemaError(`${path}: ${msg}`)
}

/** zod `.strict()` object: plain object with exactly these keys. */
function strictObj(v: unknown, path: string, keys: readonly string[]): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected object')
  const o = v as Obj
  const want = new Set(keys)
  for (const k of Object.keys(o)) if (!want.has(k)) fail(path, `unrecognized key "${k}"`)
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(o, k)) fail(`${path}.${k}`, 'required')
  return o
}

function str(v: unknown, path: string, min = 0, max = Infinity): string {
  if (typeof v !== 'string') fail(path, 'expected string')
  if (v.length < min || v.length > max) fail(path, `length must be in [${min}, ${max}]`)
  return v
}

function re(v: unknown, path: string, rx: RegExp): string {
  const s = str(v, path)
  if (!rx.test(s)) fail(path, 'invalid format')
  return s
}

function literal(v: unknown, path: string, lit: string | number): void {
  if (v !== lit) fail(path, `expected ${JSON.stringify(lit)}`)
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected finite number')
  return v
}

function unit(v: unknown, path: string): void {
  const n = num(v, path)
  if (n < 0 || n > 1) fail(path, 'must be in [0, 1]')
}

function count(v: unknown, path: string): void {
  const n = num(v, path)
  if (!Number.isSafeInteger(n) || n < 0) fail(path, 'must be a non-negative integer')
}

function nullable<T>(v: unknown, f: (v: unknown) => T): T | null {
  return v === null ? null : f(v)
}

function oneOf(v: unknown, path: string, allowed: readonly string[]): void {
  if (typeof v !== 'string' || !allowed.includes(v)) fail(path, `expected one of ${allowed.join('|')}`)
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected array')
  if (v.length > max) fail(path, `at most ${max} items`)
  return v
}

function checkCardContent(v: unknown, p: string): void {
  const c = strictObj(v, p, ['front', 'back'])
  const f = strictObj(c.front, `${p}.front`, ['display_name', 'summary', 'summary_confidence', 'summary_observations', 'highlights', 'as_of', 'model_status', 'degraded'])
  nullable(f.display_name, (x) => str(x, `${p}.front.display_name`, 1, 80))
  nullable(f.summary, (x) => str(x, `${p}.front.summary`, 1, MAX_LABEL_UNITS))
  nullable(f.summary_confidence, (x) => unit(x, `${p}.front.summary_confidence`))
  nullable(f.summary_observations, (x) => count(x, `${p}.front.summary_observations`))
  arr(f.highlights, `${p}.front.highlights`, MAX_HIGHLIGHTS).forEach((h, i) => {
    const hp = `${p}.front.highlights.${i}`
    const o = strictObj(h, hp, ['level', 'signature', 'observations', 'confidence'])
    oneOf(o.level, `${hp}.level`, ['volume', 'face'])
    str(o.signature, `${hp}.signature`, 1, MAX_LABEL_UNITS)
    count(o.observations, `${hp}.observations`)
    unit(o.confidence, `${hp}.confidence`)
  })
  re(f.as_of, `${p}.front.as_of`, ISO_DATETIME)
  str(f.model_status, `${p}.front.model_status`, 1, 32)
  if (typeof f.degraded !== 'boolean') fail(`${p}.front.degraded`, 'expected boolean')

  const b = strictObj(c.back, `${p}.back`, ['mini_map', 'stats'])
  const m = strictObj(b.mini_map, `${p}.back.mini_map`, ['nodes', 'edges'])
  arr(m.nodes, `${p}.back.mini_map.nodes`, MAX_MAP_NODES).forEach((n, i) => {
    const np = `${p}.back.mini_map.nodes.${i}`
    const o = strictObj(n, np, ['key', 'level', 'label', 'observations', 'confidence', 'member_count'])
    re(o.key, `${np}.key`, MAP_KEY)
    oneOf(o.level, `${np}.level`, ['root', 'volume', 'face'])
    str(o.label, `${np}.label`, 1, MAX_LABEL_UNITS)
    count(o.observations, `${np}.observations`)
    unit(o.confidence, `${np}.confidence`)
    count(o.member_count, `${np}.member_count`)
  })
  arr(m.edges, `${p}.back.mini_map.edges`, MAX_MAP_EDGES).forEach((e, i) => {
    const ep = `${p}.back.mini_map.edges.${i}`
    const o = strictObj(e, ep, ['from', 'to'])
    re(o.from, `${ep}.from`, MAP_KEY)
    re(o.to, `${ep}.to`, MAP_KEY)
  })
  const s = strictObj(b.stats, `${p}.back.stats`, ['points', 'evolution_lines', 'relation_lines', 'faces', 'volumes', 'roots'])
  for (const k of ['points', 'evolution_lines', 'relation_lines', 'faces', 'volumes', 'roots']) count(s[k], `${p}.back.stats.${k}`)
}

/** Mirrors SignedCardSchema (card-schema.ts). Throws SchemaError. */
function checkSignedCard(input: unknown): void {
  const top = strictObj(input, '', ['card', 'signature'])
  const card = strictObj(top.card, 'card', ['format', 'version', 'card_id', 'issued_at', 'issuer', 'content'])
  if (card.format !== LEGACY_CARD_FORMAT && card.format !== PREV_CARD_FORMAT) literal(card.format, 'card.format', CARD_FORMAT)
  literal(card.version, 'card.version', 1)
  re(card.card_id, 'card.card_id', CARD_ID)
  re(card.issued_at, 'card.issued_at', ISO_DATETIME)
  const issuer = strictObj(card.issuer, 'card.issuer', ['alg', 'public_key', 'fingerprint'])
  literal(issuer.alg, 'card.issuer.alg', 'Ed25519')
  re(issuer.public_key, 'card.issuer.public_key', B64URL_32)
  re(issuer.fingerprint, 'card.issuer.fingerprint', HEX64)
  checkCardContent(card.content, 'card.content')
  const sig = strictObj(top.signature, 'signature', ['alg', 'key_fingerprint', 'value'])
  literal(sig.alg, 'signature.alg', 'Ed25519')
  re(sig.key_fingerprint, 'signature.key_fingerprint', HEX64)
  re(sig.value, 'signature.value', B64URL_64)
}

function fingerprintOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

function ed25519Verify(message: Buffer, rawPub: Buffer, sig: Buffer): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawPub.toString('base64url') }, format: 'jwk' })
  return cryptoVerify(null, message, key, sig)
}

export interface VerifiedCard {
  /** The parsed file (as-is; nothing re-serialized). */
  signed: { card: Obj; signature: Obj }
  fingerprint: string
  displayName: string | null
}

export type CardVerifyResult = { valid: true; card: VerifiedCard } | { valid: false; reason: VerifyFailure; detail: string }

/** Same acceptance as Lens `verifyCardText` (src/main/identity/card.ts). */
export function verifyCardText(text: string): CardVerifyResult {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    return { valid: false, reason: 'parse', detail: error instanceof Error ? error.message : String(error) }
  }
  try {
    checkSignedCard(input)
  } catch (error) {
    if (error instanceof SchemaError) return { valid: false, reason: 'schema', detail: error.message }
    throw error
  }
  const { card, signature } = input as { card: Obj; signature: Obj }
  const issuer = card.issuer as Obj
  const rawPub = Buffer.from(issuer.public_key as string, 'base64url')
  const fingerprint = fingerprintOf(rawPub)
  if (fingerprint !== issuer.fingerprint || fingerprint !== signature.key_fingerprint) {
    return { valid: false, reason: 'fingerprint', detail: 'public key fingerprint does not match' }
  }
  let ok = false
  try {
    ok = ed25519Verify(canonicalBytes(card), rawPub, Buffer.from(signature.value as string, 'base64url'))
  } catch (error) {
    return { valid: false, reason: 'signature', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!ok) return { valid: false, reason: 'signature', detail: 'Ed25519 signature does not verify' }
  const front = (card.content as Obj).front as Obj
  return { valid: true, card: { signed: { card, signature }, fingerprint, displayName: (front.display_name as string | null) ?? null } }
}

export interface Letter {
  version: 1
  kind: 'persome-letter'
  issue_id: string
  week: string
  title: string
  markdown: string
  created_at: string
  signer: { public_key: string; fingerprint: string }
  signature: string
}

export type LetterVerifyResult = { valid: true; letter: Letter } | { valid: false; reason: VerifyFailure; detail: string }

/** No C0 control characters except TAB (title becomes the mail Subject header). */
const HEADER_SAFE = /^[^\u0000-\u0008\u000a-\u001f\u007f]*$/

function checkLetter(input: unknown): void {
  const l = strictObj(input, '', ['version', 'kind', 'issue_id', 'week', 'title', 'markdown', 'created_at', 'signer', 'signature'])
  literal(l.version, 'version', 1)
  literal(l.kind, 'kind', LETTER_KIND)
  re(l.issue_id, 'issue_id', UUID)
  re(l.week, 'week', ISO_WEEK)
  const title = str(l.title, 'title', 1, MAX_LETTER_TITLE)
  if (!HEADER_SAFE.test(title) || title.trim() === '') fail('title', 'must be non-blank without control characters')
  str(l.markdown, 'markdown', 1, MAX_LETTER_MARKDOWN)
  re(l.created_at, 'created_at', ISO_DATETIME)
  const s = strictObj(l.signer, 'signer', ['public_key', 'fingerprint'])
  re(s.public_key, 'signer.public_key', B64URL_32)
  re(s.fingerprint, 'signer.fingerprint', HEX64)
  re(l.signature, 'signature', B64URL_64)
}

/** Bytes the publisher signs: domain prefix + RFC 8785 JSON of the envelope minus `signature`. */
export function letterSigningBytes(envelopeWithoutSignature: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from(LETTER_DOMAIN, 'utf8'), canonicalBytes(envelopeWithoutSignature)])
}

export function verifyLetterText(text: string): LetterVerifyResult {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    return { valid: false, reason: 'parse', detail: error instanceof Error ? error.message : String(error) }
  }
  try {
    checkLetter(input)
  } catch (error) {
    if (error instanceof SchemaError) return { valid: false, reason: 'schema', detail: error.message }
    throw error
  }
  const l = input as Letter
  const rawPub = Buffer.from(l.signer.public_key, 'base64url')
  if (fingerprintOf(rawPub) !== l.signer.fingerprint) {
    return { valid: false, reason: 'fingerprint', detail: 'public key fingerprint does not match' }
  }
  const { signature, ...unsigned } = input as Record<string, unknown>
  let ok = false
  try {
    ok = ed25519Verify(letterSigningBytes(unsigned), rawPub, Buffer.from(signature as string, 'base64url'))
  } catch (error) {
    return { valid: false, reason: 'signature', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!ok) return { valid: false, reason: 'signature', detail: 'Ed25519 signature does not verify' }
  return { valid: true, letter: l }
}

// ---------------------------------------------------------------- C18 shared moments
//
// Moment: signed by the proposer. Signature = Ed25519 over UTF-8 "persome-moment-v1\n" +
// canonical JSON of the moment without `signature`.
// Acceptance: signed by the other participant over "persome-moment-accept-v1\n" + canonical JSON
// of the acceptance without `signature`; binds to the moment by moment_id AND moment_sha256 =
// hex sha256 of the canonical JSON of the full signed moment (incl. the proposer signature).

export const MOMENT_DOMAIN = 'persome-moment-v1\n'
export const MOMENT_KIND = 'persome-moment'
export const MOMENT_ACCEPT_DOMAIN = 'persome-moment-accept-v1\n'
export const MOMENT_ACCEPT_KIND = 'persome-moment-accept'
export const MAX_MOMENT_TITLE = 200
export const MAX_MOMENT_NOTE = 4000
export const MAX_MOMENT_PLACE = 200

const ISO_DATE = new RegExp(`^${DATE_SRC}$`)

export interface Moment {
  version: 1
  kind: 'persome-moment'
  moment_id: string
  title: string
  note: string
  occurred_on: { start: string; end: string }
  place: string | null
  participants: [string, string]
  visibility: 'private' | 'letters'
  proposer: { public_key: string; fingerprint: string }
  created_at: string
  signature: string
}

export interface MomentAcceptance {
  version: 1
  kind: 'persome-moment-accept'
  moment_id: string
  moment_sha256: string
  accepter: { public_key: string; fingerprint: string }
  accepted_at: string
  signature: string
}

/** `not_participant`: signed correctly, but the signer is not a participant the object allows. */
export type MomentVerifyFailure = VerifyFailure | 'not_participant'
/** Extra acceptance failures: the moment itself is invalid, or the acceptance does not bind to it. */
export type AcceptanceVerifyFailure = MomentVerifyFailure | 'moment_invalid' | 'mismatch'

export type MomentVerifyResult =
  | { valid: true; moment: Moment; sha256: string; other: string }
  | { valid: false; reason: MomentVerifyFailure; detail: string }
export type AcceptanceVerifyResult =
  | { valid: true; acceptance: MomentAcceptance; moment: Moment }
  | { valid: false; reason: AcceptanceVerifyFailure; detail: string }

function checkMoment(input: unknown): void {
  const m = strictObj(input, '', ['version', 'kind', 'moment_id', 'title', 'note', 'occurred_on', 'place', 'participants', 'visibility', 'proposer', 'created_at', 'signature'])
  literal(m.version, 'version', 1)
  literal(m.kind, 'kind', MOMENT_KIND)
  re(m.moment_id, 'moment_id', UUID)
  const title = str(m.title, 'title', 1, MAX_MOMENT_TITLE)
  if (!HEADER_SAFE.test(title) || title.trim() === '') fail('title', 'must be a non-blank single line without control characters')
  str(m.note, 'note', 0, MAX_MOMENT_NOTE)
  const on = strictObj(m.occurred_on, 'occurred_on', ['start', 'end'])
  const start = re(on.start, 'occurred_on.start', ISO_DATE)
  const end = re(on.end, 'occurred_on.end', ISO_DATE)
  if (start > end) fail('occurred_on', 'start must not be after end')
  nullable(m.place, (x) => str(x, 'place', 0, MAX_MOMENT_PLACE))
  const ps = arr(m.participants, 'participants', 2)
  if (ps.length !== 2) fail('participants', 'exactly 2 fingerprints required')
  const a = re(ps[0], 'participants.0', HEX64)
  const b = re(ps[1], 'participants.1', HEX64)
  if (!(a < b)) fail('participants', 'must be distinct and sorted ascending')
  oneOf(m.visibility, 'visibility', ['private', 'letters'])
  const p = strictObj(m.proposer, 'proposer', ['public_key', 'fingerprint'])
  re(p.public_key, 'proposer.public_key', B64URL_32)
  re(p.fingerprint, 'proposer.fingerprint', HEX64)
  re(m.created_at, 'created_at', ISO_DATETIME)
  re(m.signature, 'signature', B64URL_64)
}

function checkAcceptance(input: unknown): void {
  const a = strictObj(input, '', ['version', 'kind', 'moment_id', 'moment_sha256', 'accepter', 'accepted_at', 'signature'])
  literal(a.version, 'version', 1)
  literal(a.kind, 'kind', MOMENT_ACCEPT_KIND)
  re(a.moment_id, 'moment_id', UUID)
  re(a.moment_sha256, 'moment_sha256', HEX64)
  const s = strictObj(a.accepter, 'accepter', ['public_key', 'fingerprint'])
  re(s.public_key, 'accepter.public_key', B64URL_32)
  re(s.fingerprint, 'accepter.fingerprint', HEX64)
  re(a.accepted_at, 'accepted_at', ISO_DATETIME)
  re(a.signature, 'signature', B64URL_64)
}

export function momentSigningBytes(momentWithoutSignature: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from(MOMENT_DOMAIN, 'utf8'), canonicalBytes(momentWithoutSignature)])
}

export function acceptanceSigningBytes(acceptanceWithoutSignature: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from(MOMENT_ACCEPT_DOMAIN, 'utf8'), canonicalBytes(acceptanceWithoutSignature)])
}

/** hex sha256 of the canonical JSON of the full signed moment (incl. signature). */
export function momentSha256(signedMoment: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalBytes(signedMoment)).digest('hex')
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: VerifyFailure; detail: string }

/** Parse + strict schema + public-key fingerprint + Ed25519 over domain + canonical(without signature). */
function verifySignedObject<T>(
  text: string,
  check: (v: unknown) => void,
  signer: (v: T) => { public_key: string; fingerprint: string },
  bytes: (unsigned: Record<string, unknown>) => Buffer
): Parsed<T> {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: 'parse', detail: error instanceof Error ? error.message : String(error) }
  }
  try {
    check(input)
  } catch (error) {
    if (error instanceof SchemaError) return { ok: false, reason: 'schema', detail: error.message }
    throw error
  }
  const s = signer(input as T)
  const rawPub = Buffer.from(s.public_key, 'base64url')
  if (fingerprintOf(rawPub) !== s.fingerprint) return { ok: false, reason: 'fingerprint', detail: 'public key fingerprint does not match' }
  const { signature, ...unsigned } = input as Record<string, unknown>
  let ok = false
  try {
    ok = ed25519Verify(bytes(unsigned), rawPub, Buffer.from(signature as string, 'base64url'))
  } catch (error) {
    return { ok: false, reason: 'signature', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!ok) return { ok: false, reason: 'signature', detail: 'Ed25519 signature does not verify' }
  return { ok: true, value: input as T }
}

/**
 * Verifies a proposer-signed moment. On success also returns `sha256` (what an acceptance must
 * reference) and `other` (the participant who must accept).
 */
export function verifyMomentText(text: string): MomentVerifyResult {
  const r = verifySignedObject<Moment>(text, checkMoment, (m) => m.proposer, momentSigningBytes)
  if (!r.ok) return { valid: false, reason: r.reason, detail: r.detail }
  const m = r.value
  const i = m.participants.indexOf(m.proposer.fingerprint)
  if (i === -1) return { valid: false, reason: 'not_participant', detail: 'proposer is not one of the participants' }
  return { valid: true, moment: m, sha256: momentSha256(m as unknown as Record<string, unknown>), other: m.participants[1 - i] }
}

/**
 * Verifies an acceptance against the moment it accepts: the moment must verify, the acceptance
 * must verify, reference the same moment_id and exact moment_sha256, and be signed by the
 * participant who is NOT the proposer.
 */
export function verifyAcceptanceText(text: string, momentText: string): AcceptanceVerifyResult {
  const mv = verifyMomentText(momentText)
  if (!mv.valid) return { valid: false, reason: 'moment_invalid', detail: `moment: ${mv.reason}: ${mv.detail}` }
  const r = verifySignedObject<MomentAcceptance>(text, checkAcceptance, (a) => a.accepter, acceptanceSigningBytes)
  if (!r.ok) return { valid: false, reason: r.reason, detail: r.detail }
  const a = r.value
  if (a.moment_id !== mv.moment.moment_id) return { valid: false, reason: 'mismatch', detail: 'moment_id does not match the moment' }
  if (a.moment_sha256 !== mv.sha256) return { valid: false, reason: 'mismatch', detail: 'moment_sha256 does not match the signed moment' }
  if (a.accepter.fingerprint !== mv.other) return { valid: false, reason: 'not_participant', detail: 'accepter is not the non-proposing participant' }
  return { valid: true, acceptance: a, moment: mv.moment }
}
