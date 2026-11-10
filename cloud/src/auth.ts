import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from 'node:crypto'
import type { Db } from './db.ts'
import { HttpError } from './http.ts'

export const AUTH_DOMAIN = 'persome-cloud-auth-v1'

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Strict base64url decode of an exact-length value; null when not canonical. */
function decodeExact(s: string, re: RegExp, bytes: number): Buffer | null {
  if (!re.test(s)) return null
  const buf = Buffer.from(s, 'base64url')
  if (buf.length !== bytes || buf.toString('base64url') !== s) return null
  return buf
}

/**
 * Small-order Ed25519 points (orders 1, 2, 4, 8). With such a public key, R = identity, S = 0
 * verifies for a large fraction of messages under OpenSSL (verified empirically: 100% for the
 * identity point), i.e. anyone could "sign in" to that keyless account. Compared after clearing
 * the sign bit, which also catches the non-canonical sign-bit variants.
 */
const SMALL_ORDER_Y = new Set([
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'
])

/** True for small-order points and for non-canonical encodings (y >= p = 2^255 - 19). */
export function isWeakPublicKey(raw: Buffer): boolean {
  const y = Buffer.from(raw)
  y[31] &= 0x7f
  if (SMALL_ORDER_Y.has(y.toString('hex'))) return true
  // y >= p: low byte >= 0xed, middle bytes all 0xff, high byte 0x7f (after clearing the sign bit).
  if (y[31] === 0x7f && y[0] >= 0xed && y.subarray(1, 31).every((b) => b === 0xff)) return true
  return false
}

export function decodePublicKey(s: unknown): Buffer | null {
  if (typeof s !== 'string') return null
  const raw = decodeExact(s, B64URL_32, 32)
  return raw && !isWeakPublicKey(raw) ? raw : null
}

export function fingerprintOf(rawKey: Buffer): string {
  return sha256Hex(rawKey)
}

export function authMessage(audience: string, challengeId: string, nonce: string, fingerprint: string): Buffer {
  return Buffer.from(`${AUTH_DOMAIN}\n${audience}\n${challengeId}\n${nonce}\n${fingerprint}`, 'utf8')
}

function importEd25519(raw: Buffer) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

export interface AuthDeps {
  db: Db
  now: () => number
  audience: string
  challengeTtlS: number
  tokenTtlS: number
}

export interface ChallengeResponse {
  challenge_id: string
  nonce: string
  audience: string
  expires_at: string
}

export function issueChallenge(d: AuthDeps, body: Record<string, unknown>): ChallengeResponse {
  const raw = decodePublicKey(body.public_key)
  if (!raw) throw new HttpError(400, 'invalid_public_key', 'public_key must be a base64url raw 32-byte Ed25519 key')
  try {
    importEd25519(raw)
  } catch {
    throw new HttpError(400, 'invalid_public_key', 'public_key is not a valid Ed25519 key')
  }
  const now = d.now()
  const id = randomUUID()
  const nonce = randomBytes(32).toString('base64url')
  const expiresAt = now + d.challengeTtlS * 1000
  // Opportunistic GC: expired or consumed challenges have no further use.
  d.db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(now)
  d.db
    .prepare('INSERT INTO auth_challenges (id, public_key, nonce, audience, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, body.public_key as string, nonce, d.audience, now, expiresAt)
  return { challenge_id: id, nonce, audience: d.audience, expires_at: new Date(expiresAt).toISOString() }
}

export interface VerifyResponse {
  token: string
  token_type: 'Bearer'
  expires_at: string
  account_id: string
}

const CHALLENGE_INVALID = (): HttpError => new HttpError(401, 'challenge_invalid', 'Challenge is unknown, expired, already used, or not for this key')
const SIGNATURE_INVALID = (): HttpError => new HttpError(403, 'signature_invalid', 'Signature verification failed')

export function verifyChallenge(d: AuthDeps, body: Record<string, unknown>): { response: VerifyResponse; accountId: string } {
  const challengeId = body.challenge_id
  if (typeof challengeId !== 'string' || !UUID.test(challengeId)) throw CHALLENGE_INVALID()
  const now = d.now()
  // Consume first, atomically: a challenge is single-use regardless of outcome.
  const row = d.db
    .prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING public_key, nonce, audience, expires_at')
    .get(now, challengeId) as { public_key: string; nonce: string; audience: string; expires_at: number } | undefined
  if (!row || row.expires_at <= now) throw CHALLENGE_INVALID()
  const raw = decodePublicKey(body.public_key)
  if (!raw || body.public_key !== row.public_key) throw CHALLENGE_INVALID()
  const sig = typeof body.signature === 'string' ? decodeExact(body.signature, B64URL_64, 64) : null
  if (!sig) throw SIGNATURE_INVALID()
  const fingerprint = fingerprintOf(raw)
  const msg = authMessage(row.audience, challengeId, row.nonce, fingerprint)
  let ok = false
  try {
    ok = cryptoVerify(null, msg, importEd25519(raw), sig)
  } catch {
    ok = false
  }
  if (!ok) throw SIGNATURE_INVALID()

  const token = randomBytes(32).toString('base64url')
  const expiresAt = now + d.tokenTtlS * 1000
  d.db.exec('BEGIN IMMEDIATE')
  try {
    d.db.prepare('INSERT INTO accounts (id, public_key, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(fingerprint, row.public_key, now)
    d.db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256Hex(token), fingerprint, now, expiresAt)
    d.db.exec('COMMIT')
  } catch (err) {
    d.db.exec('ROLLBACK')
    throw err
  }
  return {
    response: { token, token_type: 'Bearer', expires_at: new Date(expiresAt).toISOString(), account_id: fingerprint },
    accountId: fingerprint
  }
}

export interface Session {
  tokenHash: string
  accountId: string
  expiresAt: number
}

const UNAUTHORIZED = (): HttpError => new HttpError(401, 'unauthorized', 'Missing, invalid, expired or revoked token', { 'www-authenticate': 'Bearer' })

export function authenticate(d: AuthDeps, token: string | null): Session {
  if (!token) throw UNAUTHORIZED()
  const hash = sha256Hex(token)
  const row = d.db
    .prepare('SELECT s.account_id AS account_id, s.expires_at AS expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?')
    .get(hash) as { account_id: string; expires_at: number } | undefined
  if (!row || row.expires_at <= d.now()) throw UNAUTHORIZED()
  return { tokenHash: hash, accountId: row.account_id, expiresAt: row.expires_at }
}

export function revokeSession(d: AuthDeps, s: Session): void {
  d.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.tokenHash)
}

export function deleteAccount(d: AuthDeps, s: Session): void {
  d.db.exec('BEGIN IMMEDIATE')
  try {
    const acc = d.db.prepare('SELECT public_key FROM accounts WHERE id = ?').get(s.accountId) as { public_key: string } | undefined
    if (acc) d.db.prepare('DELETE FROM auth_challenges WHERE public_key = ?').run(acc.public_key)
    // ON DELETE CASCADE removes sessions and every later per-account table.
    d.db.prepare('DELETE FROM accounts WHERE id = ?').run(s.accountId)
    d.db.exec('COMMIT')
  } catch (err) {
    d.db.exec('ROLLBACK')
    throw err
  }
}

/** Periodic GC of expired rows. Returns rows removed. */
export function purgeExpired(d: AuthDeps): number {
  const now = d.now()
  const a = d.db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(now)
  const b = d.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
  return Number(a.changes) + Number(b.changes)
}
