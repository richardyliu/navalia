import { verify } from 'node:crypto'
import { z } from 'zod'
import { fingerprintOf, publicKeyFromRaw, type KeyManager } from '../identity/keys'
import type { BackupTrust } from './api'
import { tr } from '../../shared/i18n'

/**
 * C21 (lead decision) — backup manifests are signed with the user's Lens identity key.
 *
 * Signed message = UTF-8 `navalia-backup-v1\n` + canonical JSON of the parsed manifest (object
 * keys sorted recursively, no whitespace). The manifest lists every file's sha256, so the signature
 * covers every byte of the backup. Stored next to the manifest as `manifest.sig.json` (plain dir) or
 * as the second container entry (encrypted archive).
 *
 * Only a manifest signed by the CURRENT identity or one of its retired keys (`previousIdentities()`)
 * may restore Workflows under their original ids with their original provenance. Encryption is not
 * authorship (anyone can encrypt a crafted archive with their own passphrase), so it is not a factor.
 */

export const SIG_FILE = 'manifest.sig.json'
export const SIG_DOMAIN = 'navalia-backup-v1\n'
export const SIG_FORMAT = 'navalia.backup-sig'
/** Previous name (Grapple): format and domain travel together. */
export const PREV_SIG_DOMAIN = 'grapple-backup-v1\n'
export const PREV_SIG_FORMAT = 'grapple.backup-sig'
/** Pre-rename (Persome Lens) signatures: format and domain travel together. */
export const LEGACY_SIG_DOMAIN = 'persome-lens-backup-v1\n'
export const LEGACY_SIG_FORMAT = 'persome-lens.backup-sig'
export const MAX_SIG_BYTES = 4096

export type BackupSigner = Pick<KeyManager, 'sign' | 'getPublicIdentity' | 'previousIdentities'>

export const SigFileSchema = z.strictObject({
  format: z.union([z.literal(SIG_FORMAT), z.literal(PREV_SIG_FORMAT), z.literal(LEGACY_SIG_FORMAT)]),
  version: z.literal(1),
  alg: z.literal('Ed25519'),
  public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
})
export type SigFile = z.infer<typeof SigFileSchema>

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

export const signedMessage = (manifest: unknown, domain: string = SIG_DOMAIN): Buffer => Buffer.from(domain + canonicalJson(manifest), 'utf8')

/** Sign a manifest; null (export stays unsigned) when there is no identity or signing fails. */
export function signManifest(signer: BackupSigner | undefined, manifest: unknown): { sig: SigFile | null; reason: string | null } {
  if (!signer) return { sig: null, reason: tr('No Navalia identity key in this environment', '当前环境没有 Navalia 身份密钥') }
  let id
  try {
    id = signer.getPublicIdentity()
  } catch {
    id = null
  }
  if (!id) return { sig: null, reason: tr('No Navalia identity (card signing key) has been created yet', '还没有创建 Navalia 身份（卡片签名密钥）') }
  try {
    const signature = signer.sign(signedMessage(manifest))
    return {
      sig: { format: SIG_FORMAT, version: 1, alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint, signature: signature.toString('base64url') },
      reason: null
    }
  } catch {
    return { sig: null, reason: tr('The identity key cannot sign (keychain unavailable)', '身份密钥无法签名（钥匙串不可用）') }
  }
}

/**
 * Trust of a validated manifest. `invalid` = a signature file is present but does not verify (the
 * manifest or signature was changed after signing) — callers REJECT the backup in that case.
 */
export function evaluateTrust(signer: BackupSigner | undefined, manifest: unknown, sigBytes: Buffer | null): BackupTrust {
  if (!sigBytes) return { mode: 'unsigned', fingerprint: null, reason: tr('The backup is not signed', '备份没有签名') }
  let sig: SigFile
  try {
    sig = SigFileSchema.parse(JSON.parse(sigBytes.toString('utf8')))
  } catch {
    return { mode: 'invalid', fingerprint: null, reason: tr('The signature file is malformed', '签名文件格式不正确') }
  }
  const raw = Buffer.from(sig.public_key, 'base64url')
  if (raw.length !== 32 || fingerprintOf(raw) !== sig.fingerprint) return { mode: 'invalid', fingerprint: null, reason: tr('The signing public key does not match its fingerprint', '签名的公钥与指纹不一致') }
  let ok = false
  try {
    ok = verify(null, signedMessage(manifest, sig.format === LEGACY_SIG_FORMAT ? LEGACY_SIG_DOMAIN : sig.format === PREV_SIG_FORMAT ? PREV_SIG_DOMAIN : SIG_DOMAIN), publicKeyFromRaw(raw), Buffer.from(sig.signature, 'base64url'))
  } catch {
    ok = false
  }
  if (!ok) return { mode: 'invalid', fingerprint: sig.fingerprint, reason: tr('Signature check failed (the manifest was changed after signing)', '签名校验失败（manifest 在签名后被改动）') }
  const mine = new Set<string>()
  try {
    const cur = signer?.getPublicIdentity()
    if (cur) mine.add(cur.fingerprint)
    for (const p of signer?.previousIdentities() ?? []) mine.add(p.fingerprint)
  } catch {
    /* no identity readable: nothing is "mine" */
  }
  if (mine.has(sig.fingerprint)) return { mode: 'mine', fingerprint: sig.fingerprint, reason: tr('Signed by your Navalia identity', '由你的 Navalia 身份签名') }
  return { mode: 'foreign', fingerprint: sig.fingerprint, reason: tr('Signed by someone other than your current or previous Navalia identity', '签名者不是你当前或以前的 Navalia 身份') }
}
