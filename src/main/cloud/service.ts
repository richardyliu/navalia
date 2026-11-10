// Cloud opt-in service: config + consent + session state. No direct network access: everything
// that leaves the machine goes through client.ts, which refuses while cloud is OFF.
import { fingerprintOf } from '../identity/keys'
import { tr } from '../../shared/i18n'
import type { SecretBox } from '../identity/secret-box'
import type { CloudStatus } from './api'
import { createCloudClient, type CloudClient, type FetchLike } from './client'
import { CloudConfigError, cloudPaths, normalizeBaseUrl, readCloudConfig, writeCloudConfig } from './config'
import { CloudError } from './errors'
import { createTokenStore, type TokenStore } from './token'

export type CloudConfirm = (sender: unknown, opts: { message: string; detail: string; confirmLabel: string }) => Promise<boolean>

export interface CloudDeps {
  /** Lens Store root (LENS_STORE_ROOT in tests). Files: `cloud.json`, `cloud-token.enc`. */
  storeRoot: string
  /** Encrypts the token at rest (production: the safeStorage box used for the identity key). */
  box: SecretBox
  /** KeyManager.sign. */
  sign: (message: Buffer) => Buffer
  /** KeyManager.getPublicIdentity. */
  getPublicIdentity: () => { public_key: string } | null
  /** Main-owned native confirm (security.ts nativeConfirm). Absent ⇒ enabling / deleting is refused. */
  nativeConfirm?: CloudConfirm
  fetch?: FetchLike
  timeoutMs?: number
  maxResponseBytes?: number
  now?: () => Date
  /**
   * Allow `http://127.0.0.1:<port>` / `http://localhost:<port>` servers. Production wires
   * `!app.isPackaged`; absent ⇒ false (https only).
   */
  allowInsecureLoopback?: boolean
  /** Timeout of the best-effort server logout when turning cloud OFF / switching server. Default 3 s. */
  revokeTimeoutMs?: number
}

export const DEFAULT_REVOKE_TIMEOUT_MS = 3_000

/** Fingerprint of the current local identity (sha256 of the raw public key), or null. */
export function identityFingerprint(getPublicIdentity: () => { public_key: string } | null): string | null {
  try {
    const id = getPublicIdentity()
    if (!id) return null
    const raw = Buffer.from(id.public_key, 'base64url')
    if (raw.length !== 32 || raw.toString('base64url') !== id.public_key) return null
    return fingerprintOf(raw)
  } catch {
    return null
  }
}

export interface CloudService {
  client: CloudClient
  status(): CloudStatus
  configure(args: { enabled: boolean; baseUrl: string | null; confirm?: true }, sender?: unknown): Promise<CloudStatus & { remoteRevoked: boolean }>
  signIn(): Promise<CloudStatus>
  signOut(): Promise<CloudStatus & { remoteRevoked: boolean }>
  deleteAccount(sender?: unknown): Promise<CloudStatus>
}

export function createCloudService(deps: CloudDeps): CloudService {
  const paths = cloudPaths(deps.storeRoot)
  const now = deps.now ?? (() => new Date())
  const policy = { allowInsecureLoopback: deps.allowInsecureLoopback === true }
  // Fix (C3–C7 gate): the token is bound to the identity fingerprint; identity reset ⇒ signed out.
  const tokens: TokenStore = createTokenStore(paths.tokenFile, deps.box, now, () => identityFingerprint(deps.getPublicIdentity))
  const client = createCloudClient({
    configFile: paths.configFile,
    tokens,
    sign: deps.sign,
    getPublicIdentity: deps.getPublicIdentity,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs,
    maxResponseBytes: deps.maxResponseBytes,
    now,
    allowInsecureLoopback: policy.allowInsecureLoopback
  })

  function status(): CloudStatus {
    const cfg = readCloudConfig(paths.configFile, policy)
    const meta = cfg.enabled ? tokens.meta() : null
    const live = meta !== null && meta.origin === cfg.baseUrl
    return {
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      signedIn: live,
      accountId: live ? meta.accountId : null,
      expiresAt: live ? meta.expiresAt : null
    }
  }

  /** Server logout for a live session on the configured server; never throws. */
  async function revoke(): Promise<boolean> {
    const cfg = readCloudConfig(paths.configFile, policy)
    const meta = cfg.enabled ? tokens.meta() : null
    if (!meta || meta.origin !== cfg.baseUrl) return false
    try {
      await client.signOut({ timeoutMs: deps.revokeTimeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS })
      return true
    } catch {
      return false
    }
  }

  async function confirm(sender: unknown, opts: { message: string; detail: string; confirmLabel: string }): Promise<void> {
    if (!deps.nativeConfirm) throw new CloudError('cancelled')
    if (!(await deps.nativeConfirm(sender, opts))) throw new CloudError('cancelled')
  }

  return {
    client,
    status,

    async configure(args, sender) {
      let baseUrl: string | null
      try {
        baseUrl = args.baseUrl === null ? null : normalizeBaseUrl(args.baseUrl, policy)
      } catch (e) {
        throw new CloudError('invalid_args', { detail: e instanceof CloudConfigError ? e.message : undefined })
      }
      const cur = readCloudConfig(paths.configFile, policy)
      if (!args.enabled) {
        // OFF: best-effort server revoke of a live session (short timeout), then always forget locally.
        const remoteRevoked = await revoke()
        tokens.clear()
        writeCloudConfig(paths.configFile, { enabled: false, baseUrl }, policy)
        return { ...status(), remoteRevoked }
      }
      if (baseUrl === null) throw new CloudError('invalid_args', { detail: tr('Enter a server address before turning on Cloud', '开启云端需要先填写服务器地址') })
      if (cur.enabled && cur.baseUrl === baseUrl) return { ...status(), remoteRevoked: false }
      if (args.confirm !== true) throw new CloudError('cancelled', { detail: tr('Turning on Cloud needs confirmation', '开启云端需要确认') })
      await confirm(sender, {
        message: tr('Turn on Cloud features?', '开启云端功能？'),
        detail: tr(
          `Navalia will connect to ${baseUrl}. Only cloud features you use send data. You can turn it off at any time, and then it stays offline.`,
          `Navalia 将连接 ${baseUrl}。只有你主动使用的云端功能会发送数据；随时可以关闭，关闭后不再联网。`
        ),
        confirmLabel: tr('Turn on', '开启')
      })
      // A token is bound to the server that issued it; a new server starts signed out. The old
      // server's session is revoked best-effort first (it is still the configured origin here).
      let remoteRevoked = false
      if (cur.baseUrl !== baseUrl) {
        remoteRevoked = await revoke()
        tokens.clear()
      }
      writeCloudConfig(paths.configFile, { enabled: true, baseUrl }, policy)
      return { ...status(), remoteRevoked }
    },

    async signIn() {
      await client.signIn()
      return status()
    },

    async signOut() {
      const cfg = readCloudConfig(paths.configFile, policy)
      let remoteRevoked = false
      if (cfg.enabled && tokens.meta()) {
        try {
          await client.signOut()
          remoteRevoked = true
        } catch {
          // Local forget below happens regardless; the server token then lapses at expiry.
        }
      }
      tokens.clear()
      return { ...status(), remoteRevoked }
    },

    async deleteAccount(sender) {
      client.origin() // throws `disabled` before any dialog / network
      if (!tokens.meta()) throw new CloudError('unauthorized')
      await confirm(sender, {
        message: tr('Delete your cloud account?', '删除云端账号？'),
        detail: tr('Data on the server linked to this account will be deleted and cannot be recovered. Data on this Mac is not affected.', '服务器上与这个账号关联的数据会被删除，无法恢复。本机数据不受影响。'),
        confirmLabel: tr('Delete account', '删除账号')
      })
      await client.deleteAccount()
      return status()
    }
  }
}
