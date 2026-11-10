import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** Owner-only permissions for everything under the Lens Store. */
export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

export const STORE_ROOT_ENV = 'LENS_STORE_ROOT'

export interface StorePaths {
  root: string
  identityDir: string
  /** safeStorage-encrypted Ed25519 private key (PKCS#8 DER inside the ciphertext). */
  privateKeyFile: string
  /** Public identity metadata (public key, fingerprint, created_at, backend id). */
  identityFile: string
  /** Public records of keys retired by "Reset identity" (no private material). */
  previousIdentitiesFile: string
  settingsFile: string
  cardsDir: string
  grantsFile: string
  /** Access log database. Schema is created by E2.7, not here. */
  auditDb: string
  /** HET ledger. Owned by lens-het: path helper only, never create a schema here. */
  hetDb: string
}

export function resolveStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STORE_ROOT_ENV]?.trim()
  if (override) return path.resolve(override)
  // A subdirectory: on case-insensitive APFS `Navalia` is the same directory as Electron's own
  // userData (`navalia`, from package.json name), and the Store must not mix with Chromium files.
  return path.join(os.homedir(), 'Library', 'Application Support', 'Navalia', 'Store')
}

export function storePaths(root: string = resolveStoreRoot()): StorePaths {
  const identityDir = path.join(root, 'identity')
  return {
    root,
    identityDir,
    privateKeyFile: path.join(identityDir, 'ed25519.key.enc'),
    identityFile: path.join(identityDir, 'identity.json'),
    previousIdentitiesFile: path.join(identityDir, 'previous.json'),
    settingsFile: path.join(root, 'settings.json'),
    cardsDir: path.join(root, 'cards'),
    grantsFile: path.join(root, 'grants.json'),
    auditDb: path.join(root, 'audit.db'),
    hetDb: path.join(root, 'het.db')
  }
}

/** Create a directory (recursively) and force 0700 regardless of umask or prior mode. */
export function ensureSecureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory()) throw new Error(`Navalia Store path is not a directory: ${dir}`)
  if ((stat.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE)
}

/** Create the store root and its fixed subdirectories with 0700. Idempotent. */
export function ensureStore(paths: StorePaths): StorePaths {
  ensureSecureDir(paths.root)
  ensureSecureDir(paths.identityDir)
  ensureSecureDir(paths.cardsDir)
  return paths
}

/**
 * Atomic owner-only write: temp file opened with 0600 in the same directory,
 * fsync, rename over the target, then re-assert 0600 on the result.
 */
export function writeFileSecure(file: string, data: string | Uint8Array): void {
  ensureSecureDir(path.dirname(file))
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE)
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.chmodSync(tmp, FILE_MODE)
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  fs.chmodSync(file, FILE_MODE)
}

export function readFileIfExists(file: string): Buffer | null {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Real path when it exists, else the lexically resolved path. */
export function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** True when `child` is `parent` or inside it (both should already be resolved). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
