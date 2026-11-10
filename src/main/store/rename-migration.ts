/**
 * One-time migration from a pre-rename app (Grapple, or the older Persome Lens) to Navalia.
 *
 * What changes with a rename:
 *   - Lens Store root: the old app's store → `resolveStoreRoot()`.
 *   - Electron safeStorage key: the Keychain item is named after package.json `name`
 *     ("<name> Safe Storage"). Everything sealed with the old key (identity private key, cloud
 *     token, IMAP settings) must be decrypted with the old key and re-sealed with the new one, or it
 *     is unreadable after the rename.
 *
 * Shape: copy the old store into a private staging dir next to the new root, re-seal the sealed
 * files inside staging, then rename staging onto the new root. Any failure removes staging and
 * leaves the new root absent, so the next launch retries from scratch. The old store is never
 * modified or deleted.
 *
 * Electron-free (deps injected) so it is unit-testable.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { DIR_MODE, FILE_MODE } from './paths'
import { tr } from '../../shared/i18n'

export interface LegacySource {
  /** Product name shown to the user. */
  label: string
  /** Store root relative to `~/Library/Application Support`. */
  storeDir: string[]
  /** Chromium/Electron userData dir of the old app (holds its SingletonLock). */
  userDataDirname: string
  keychainService: string
  keychainAccount: string
  /** Written into the new store after a successful migration. */
  marker: string
}

/** Previous names, newest first: the first one whose store exists is migrated. */
export const LEGACY_SOURCES: readonly LegacySource[] = [
  {
    label: 'Grapple',
    storeDir: ['Grapple', 'Store'],
    userDataDirname: 'grapple',
    keychainService: 'grapple Safe Storage',
    keychainAccount: 'grapple Key',
    marker: '.migrated-from-grapple.json'
  },
  {
    label: 'Persome Lens',
    storeDir: ['Persome Lens'],
    userDataDirname: 'persome-lens',
    keychainService: 'persome-lens Safe Storage',
    keychainAccount: 'persome-lens Key',
    marker: '.migrated-from-persome-lens.json'
  }
]

/** Store-relative files whose JSON `ciphertext` field is safeStorage output. */
export const SEALED_FILES = ['identity/ed25519.key.enc', 'cloud-token.enc', 'connectors/imap.secret.json']

export function legacyStoreRoot(source: LegacySource, home: string = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', ...source.storeDir)
}

export function legacyUserDataDir(source: LegacySource, home: string = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', source.userDataDirname)
}

/** The newest previous app whose store exists, or null. */
export function findLegacySource(home: string = os.homedir()): LegacySource | null {
  return LEGACY_SOURCES.find((s) => fs.existsSync(legacyStoreRoot(s, home))) ?? null
}

/**
 * Chromium OSCrypt on macOS ("v10"): AES-128-CBC, key = PBKDF2-HMAC-SHA1(keychain password,
 * "saltysalt", 1003 iterations, 16 bytes), IV = 16 spaces, PKCS#7 padding. Returns the string that
 * was passed to safeStorage.encryptString.
 */
export function decryptLegacySafeStorage(ciphertext: Buffer, keychainPassword: string): string {
  if (ciphertext.length < 3 || ciphertext.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('not a v10 safeStorage ciphertext')
  const key = pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([decipher.update(ciphertext.subarray(3)), decipher.final()]).toString('utf8')
}

/** True when the old app's single-instance lock points at a live process on this host. */
export function legacyAppRunning(userDataDir: string, isAlive: (pid: number) => boolean = pidAlive): boolean {
  let target: string
  try {
    target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'))
  } catch {
    return false
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  return Number.isInteger(pid) && pid > 0 && isAlive(pid)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface RenameMigrationDeps {
  source: LegacySource
  legacyRoot: string
  newRoot: string
  /** Old Keychain password; null when unavailable or the user denied access. Called at most once, and only if a sealed file exists. */
  readLegacyPassword(): string | null
  /** New safeStorage.encryptString. */
  encryptString(plain: string): Buffer
  now?: () => Date
}

export type RenameMigrationResult =
  | { status: 'not_needed'; reason: 'no_legacy_store' | 'new_store_exists' }
  | { status: 'migrated'; resealed: string[] }
  | { status: 'failed'; reason: 'keychain_denied' | 'reseal_failed' | 'copy_failed'; detail: string }

export function migrateLegacyStore(deps: RenameMigrationDeps): RenameMigrationResult {
  const { legacyRoot, newRoot } = deps
  if (fs.existsSync(newRoot)) return { status: 'not_needed', reason: 'new_store_exists' }
  let legacyStat: fs.Stats
  try {
    legacyStat = fs.lstatSync(legacyRoot)
  } catch {
    return { status: 'not_needed', reason: 'no_legacy_store' }
  }
  if (!legacyStat.isDirectory()) return { status: 'not_needed', reason: 'no_legacy_store' }

  fs.mkdirSync(path.dirname(newRoot), { recursive: true, mode: DIR_MODE })
  const staging = `${newRoot}.migrating-${randomBytes(6).toString('hex')}`
  const cleanup = (): void => {
    // Only ever remove the staging dir this call created.
    if (path.basename(staging).startsWith(`${path.basename(newRoot)}.migrating-`)) fs.rmSync(staging, { recursive: true, force: true })
  }

  try {
    fs.cpSync(legacyRoot, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    fs.chmodSync(staging, DIR_MODE)
  } catch (e) {
    cleanup()
    return { status: 'failed', reason: 'copy_failed', detail: e instanceof Error ? e.message : String(e) }
  }

  const present = SEALED_FILES.filter((rel) => fs.existsSync(path.join(staging, rel)))
  if (present.length) {
    const password = deps.readLegacyPassword()
    if (!password) {
      cleanup()
      return { status: 'failed', reason: 'keychain_denied', detail: tr(`Cannot read keychain item “${deps.source.keychainService}”`, `无法读取钥匙串项 “${deps.source.keychainService}”`) }
    }
    for (const rel of present) {
      const file = path.join(staging, rel)
      try {
        const sealed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
        if (typeof sealed.ciphertext !== 'string') throw new Error('missing ciphertext')
        const plain = decryptLegacySafeStorage(Buffer.from(sealed.ciphertext, 'base64'), password)
        sealed.ciphertext = deps.encryptString(plain).toString('base64')
        const original = fs.readFileSync(file, 'utf8')
        const pretty = /^\{\n/.test(original)
        fs.writeFileSync(file, `${pretty ? JSON.stringify(sealed, null, 2) : JSON.stringify(sealed)}\n`, { mode: FILE_MODE })
        fs.chmodSync(file, FILE_MODE)
      } catch (e) {
        cleanup()
        return { status: 'failed', reason: 'reseal_failed', detail: `${rel}: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
  }

  try {
    fs.writeFileSync(
      path.join(staging, deps.source.marker),
      `${JSON.stringify({ from: legacyRoot, at: (deps.now?.() ?? new Date()).toISOString(), resealed: present }, null, 2)}\n`,
      { mode: FILE_MODE }
    )
    fs.renameSync(staging, newRoot)
  } catch (e) {
    cleanup()
    return { status: 'failed', reason: 'copy_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  return { status: 'migrated', resealed: present }
}
