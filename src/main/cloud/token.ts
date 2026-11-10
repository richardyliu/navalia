// Cloud session token at rest: `cloud-token.enc` (0600). The bearer token is encrypted with the
// SecretBox (production: Electron safeStorage); account id, expiry and the origin the token was
// issued for sit in the clear envelope so `status` never needs to decrypt. Never logged.
import fs from 'node:fs'
import { z } from 'zod'
import type { SecretBox } from '../identity/secret-box'
import { readFileIfExists, writeFileSecure } from '../store/paths'
import { CloudError } from './errors'

export interface TokenMeta {
  accountId: string
  expiresAt: string
  /** Origin that issued the token; it is only ever sent back to this origin. */
  origin: string
  /**
   * SHA-256 fingerprint (hex) of the identity key that signed in. If the local identity changes
   * (reset) or disappears, the token is treated as signed out and deleted on the next use.
   */
  fingerprint: string
}

export interface TokenStore {
  /** Clear metadata of a stored, non-expired token; null when absent / expired / unreadable. */
  meta(): TokenMeta | null
  /** Decrypt the bearer for `origin`; null when absent / expired / issued for another origin. */
  bearer(origin: string): string | null
  save(token: string, meta: TokenMeta): void
  clear(): void
}

const EnvelopeSchema = z.strictObject({
  version: z.literal(1),
  key_backend: z.string().min(1).max(64),
  account_id: z.string().min(1).max(256),
  expires_at: z.string().min(1).max(64),
  origin: z.string().min(1).max(2048),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  ciphertext: z.string().min(1).max(65536)
})
type Envelope = z.infer<typeof EnvelopeSchema>

/** Printable ASCII without spaces: safe as an HTTP header value. */
export const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/

/**
 * `currentFingerprint` (production: derived from KeyManager.getPublicIdentity) binds the token to
 * the identity that signed in: a mismatch or a missing identity ⇒ signed out and the file is
 * deleted (identity reset invalidates the cloud session locally). Envelopes written before the
 * fingerprint field existed fail the strict schema and read as signed out.
 */
export function createTokenStore(
  file: string,
  box: SecretBox,
  now: () => Date = () => new Date(),
  currentFingerprint?: () => string | null
): TokenStore {
  function read(): Envelope | null {
    const buf = readFileIfExists(file)
    if (!buf) return null
    let env: Envelope
    try {
      env = EnvelopeSchema.parse(JSON.parse(buf.toString('utf8')))
    } catch {
      return null
    }
    if (env.key_backend !== box.id) return null
    const exp = Date.parse(env.expires_at)
    if (!Number.isFinite(exp) || exp <= now().getTime()) return null
    if (currentFingerprint) {
      let fp: string | null
      try {
        fp = currentFingerprint()
      } catch {
        fp = null
      }
      if (fp === null || fp !== env.fingerprint) {
        fs.rmSync(file, { force: true })
        return null
      }
    }
    return env
  }
  return {
    meta() {
      const env = read()
      return env ? { accountId: env.account_id, expiresAt: env.expires_at, origin: env.origin, fingerprint: env.fingerprint } : null
    },
    bearer(origin) {
      const env = read()
      if (!env || env.origin !== origin) return null
      try {
        const token = box.decrypt(Buffer.from(env.ciphertext, 'base64')).toString('utf8')
        return TOKEN_RE.test(token) ? token : null
      } catch {
        return null
      }
    },
    save(token, meta) {
      if (!TOKEN_RE.test(token)) throw new CloudError('bad_response')
      if (!/^[0-9a-f]{64}$/.test(meta.fingerprint)) throw new CloudError('no_identity')
      if (!box.isAvailable()) throw new CloudError('storage')
      let ciphertext: Buffer
      try {
        ciphertext = box.encrypt(Buffer.from(token, 'utf8'))
      } catch {
        throw new CloudError('storage')
      }
      const env: Envelope = {
        version: 1,
        key_backend: box.id,
        account_id: meta.accountId,
        expires_at: meta.expiresAt,
        origin: meta.origin,
        fingerprint: meta.fingerprint,
        ciphertext: ciphertext.toString('base64')
      }
      writeFileSecure(file, `${JSON.stringify(env)}\n`)
    },
    clear() {
      fs.rmSync(file, { force: true })
    }
  }
}
