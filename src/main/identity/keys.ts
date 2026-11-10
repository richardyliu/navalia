import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject
} from 'node:crypto'
import { z } from 'zod'
import { ensureStore, readFileIfExists, writeFileSecure, type StorePaths } from '../store/paths'
import type { SecretBox } from './secret-box'

/** Raw 32-byte Ed25519 public keys are carried as unpadded base64url. */
export function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) throw new Error('not an Ed25519 public key')
  return Buffer.from(jwk.x, 'base64url')
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

/** Fingerprint = lowercase hex SHA-256 of the raw 32-byte public key. */
export function fingerprintOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

export const PublicIdentitySchema = z
  .object({
    version: z.literal(1),
    alg: z.literal('Ed25519'),
    public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.string().datetime({ offset: true }),
    /** Id of the SecretBox that encrypted the private key file. */
    key_backend: z.string().min(1).max(64)
  })
  .strict()

/** Everything here is safe to show the renderer or put in a Card. */
export type PublicIdentity = z.infer<typeof PublicIdentitySchema>

/** On-disk envelope of the encrypted private key. Ciphertext only; never logged. */
const KeyFileSchema = z
  .object({
    version: z.literal(1),
    alg: z.literal('Ed25519'),
    key_backend: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    ciphertext: z.string().min(1)
  })
  .strict()

export const RetiredIdentitySchema = PublicIdentitySchema.extend({
  retired_at: z.string().datetime({ offset: true })
}).strict()
export type RetiredIdentity = z.infer<typeof RetiredIdentitySchema>
const PreviousFileSchema = z.object({ version: z.literal(1), identities: z.array(RetiredIdentitySchema) }).strict()

export class IdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityError'
  }
}

export interface KeyManager {
  /** Public metadata if a keypair exists; null otherwise. Does not decrypt anything. */
  getPublicIdentity(): PublicIdentity | null
  /** Create the keypair if missing; return public metadata. Fails closed if encryption is unavailable. */
  ensureIdentity(): PublicIdentity
  /** Sign bytes with the private key: decrypt → sign → drop. The key never leaves this closure. */
  sign(message: Buffer): Buffer
  /** Public records of keys retired by resetIdentity, oldest first. */
  previousIdentities(): RetiredIdentity[]
  /**
   * Retire the current key and generate a new one. The old private key is deleted;
   * its public record is kept so old cards can be shown as "signed by a previous key".
   */
  resetIdentity(): PublicIdentity
  /** No-op: no decrypted key is cached (kept for API stability). */
  lock(): void
}

export function createKeyManager(paths: StorePaths, box: SecretBox, now: () => Date = () => new Date()): KeyManager {
  /*
   * No decrypted key is cached (security review #10). Every sign() decrypts, uses, and drops
   * the KeyObject. Residual risk that cannot be removed in JS: safeStorage takes and returns
   * strings, so the base64 PKCS#8 passes through immutable V8 strings that cannot be wiped and
   * live until GC. The DER Buffer itself is zeroed right after import.
   */

  function readPublic(): PublicIdentity | null {
    const raw = readFileIfExists(paths.identityFile)
    if (!raw) return null
    return PublicIdentitySchema.parse(JSON.parse(raw.toString('utf8')))
  }

  function loadPrivate(identity: PublicIdentity): KeyObject {
    const raw = readFileIfExists(paths.privateKeyFile)
    if (!raw) throw new IdentityError('identity private key file is missing')
    const file = KeyFileSchema.parse(JSON.parse(raw.toString('utf8')))
    if (file.key_backend !== box.id) {
      throw new IdentityError(`private key was encrypted with "${file.key_backend}", current backend is "${box.id}"`)
    }
    if (!box.isAvailable()) throw new IdentityError('key encryption backend is not available')
    let der: Buffer
    try {
      der = box.decrypt(Buffer.from(file.ciphertext, 'base64'))
    } catch {
      throw new IdentityError('could not decrypt identity private key')
    }
    let key: KeyObject
    try {
      key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    } finally {
      der.fill(0)
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new IdentityError('identity private key is not Ed25519')
    const derived = rawPublicKey(createPublicKey(key))
    if (fingerprintOf(derived) !== identity.fingerprint || file.fingerprint !== identity.fingerprint) {
      throw new IdentityError('identity private key does not match the stored public key')
    }
    return key
  }

  function readPrevious(): RetiredIdentity[] {
    const raw = readFileIfExists(paths.previousIdentitiesFile)
    if (!raw) return []
    return PreviousFileSchema.parse(JSON.parse(raw.toString('utf8'))).identities
  }

  interface Generated {
    identity: PublicIdentity
    keyFile: string
  }

  function generate(): Generated {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const rawPub = rawPublicKey(publicKey)
    const fingerprint = fingerprintOf(rawPub)
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
    let ciphertext: Buffer
    try {
      ciphertext = box.encrypt(der)
    } finally {
      der.fill(0)
    }
    return {
      keyFile: `${JSON.stringify({ version: 1, alg: 'Ed25519', key_backend: box.id, fingerprint, ciphertext: ciphertext.toString('base64') })}\n`,
      identity: {
        version: 1,
        alg: 'Ed25519',
        public_key: rawPub.toString('base64url'),
        fingerprint,
        created_at: now().toISOString(),
        key_backend: box.id
      }
    }
  }

  function persist(next: Generated): PublicIdentity {
    // Private key first: identity.json is the "exists" marker. A crash in between leaves a
    // key/identity fingerprint mismatch, which unlock detects and reports instead of signing.
    writeFileSecure(paths.privateKeyFile, next.keyFile)
    writeFileSecure(paths.identityFile, `${JSON.stringify(next.identity, null, 2)}\n`)
    return next.identity
  }

  return {
    getPublicIdentity: readPublic,

    previousIdentities: readPrevious,

    resetIdentity() {
      if (!box.isAvailable()) {
        throw new IdentityError('key encryption backend is not available; refusing to reset identity')
      }
      ensureStore(paths)
      const current = readPublic()
      // Generate and encrypt first: if this fails, nothing on disk has changed.
      const next = generate()
      if (current) {
        const previous = readPrevious().filter((p) => p.fingerprint !== current.fingerprint)
        previous.push({ ...current, retired_at: now().toISOString() })
        writeFileSecure(paths.previousIdentitiesFile, `${JSON.stringify({ version: 1, identities: previous }, null, 2)}\n`)
      }
      return persist(next)
    },

    ensureIdentity() {
      const existing = readPublic()
      if (existing) {
        if (!readFileIfExists(paths.privateKeyFile)) {
          throw new IdentityError('identity.json exists but the private key file is missing')
        }
        return existing
      }
      if (readFileIfExists(paths.privateKeyFile)) {
        throw new IdentityError('private key file exists without identity.json; refusing to overwrite')
      }
      if (!box.isAvailable()) {
        throw new IdentityError('key encryption backend is not available; refusing to store a plaintext key')
      }
      ensureStore(paths)
      return persist(generate())
    },

    sign(message) {
      const identity = readPublic()
      if (!identity) throw new IdentityError('no identity keypair; create one first')
      return cryptoSign(null, message, loadPrivate(identity))
    },

    lock() {
      // Nothing cached since review #10; kept so callers (will-quit) need no change.
    }
  }
}
