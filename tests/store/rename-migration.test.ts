import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LEGACY_SOURCES,
  decryptLegacySafeStorage,
  findLegacySource,
  legacyAppRunning,
  legacyStoreRoot,
  migrateLegacyStore,
  type RenameMigrationDeps
} from '../../src/main/store/rename-migration'

const PREFIX = 'navalia-rename-mig-'
const [GRAPPLE, PERSOME_LENS] = LEGACY_SOURCES
const MIGRATION_MARKER = PERSOME_LENS.marker
const migrateFromPersomeLens = (deps: Omit<RenameMigrationDeps, 'source'>) => migrateLegacyStore({ source: PERSOME_LENS, ...deps })
const roots: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  roots.push(d)
  return d
}
afterEach(() => {
  for (const d of roots.splice(0)) {
    // Guard: only ever delete dirs this file created.
    if (path.basename(d).startsWith(PREFIX) && path.dirname(d) === path.resolve(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true })
  }
})

/** Same algorithm Chromium OSCrypt uses on macOS (v10). */
function legacyEncrypt(plain: string, password: string): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), c.update(plain, 'utf8'), c.final()])
}
const newEncrypt = (plain: string): Buffer => Buffer.from(`NEW:${plain}`)

function seedLegacy(root: string, password: string): void {
  fs.mkdirSync(path.join(root, 'identity'), { recursive: true })
  fs.mkdirSync(path.join(root, 'cards'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'identity', 'ed25519.key.enc'),
    `${JSON.stringify({ version: 1, box: 'electron-safestorage', ciphertext: legacyEncrypt('REVSLUtFWQ==', password).toString('base64') }, null, 2)}\n`
  )
  fs.writeFileSync(path.join(root, 'identity', 'identity.json'), '{"public_key":"x"}\n')
  fs.writeFileSync(path.join(root, 'cards', 'card_00000000000000000000000000000000.persomecard'), '{}\n')
  fs.writeFileSync(path.join(root, 'het.db'), 'db')
  fs.writeFileSync(path.join(root, 'het.db-wal'), 'wal')
}

describe('decryptLegacySafeStorage', () => {
  it('round-trips the Chromium v10 format', () => {
    expect(decryptLegacySafeStorage(legacyEncrypt('héllo', 'pw'), 'pw')).toBe('héllo')
  })
  it('rejects a wrong password and non-v10 input', () => {
    expect(() => decryptLegacySafeStorage(legacyEncrypt('hello world', 'pw'), 'other')).toThrow()
    expect(() => decryptLegacySafeStorage(Buffer.from('v11xxxx'), 'pw')).toThrow(/v10/)
  })
})

describe('migrateLegacyStore (Persome Lens source)', () => {
  it('copies the store, re-seals secrets with the new key, keeps the old store intact', () => {
    const base = tmp()
    const legacy = path.join(base, 'Persome Lens')
    const next = path.join(base, 'Navalia', 'Store')
    seedLegacy(legacy, 'oldpw')
    const before = fs.readFileSync(path.join(legacy, 'identity', 'ed25519.key.enc'), 'utf8')
    let asked = 0
    const r = migrateFromPersomeLens({ legacyRoot: legacy, newRoot: next, readLegacyPassword: () => (asked++, 'oldpw'), encryptString: newEncrypt })
    expect(r).toEqual({ status: 'migrated', resealed: ['identity/ed25519.key.enc'] })
    expect(asked).toBe(1)
    const sealed = JSON.parse(fs.readFileSync(path.join(next, 'identity', 'ed25519.key.enc'), 'utf8'))
    expect(Buffer.from(sealed.ciphertext, 'base64').toString()).toBe('NEW:REVSLUtFWQ==')
    expect(sealed.box).toBe('electron-safestorage')
    expect(fs.statSync(path.join(next, 'identity', 'ed25519.key.enc')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(next).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(next, 'het.db-wal'), 'utf8')).toBe('wal')
    expect(fs.existsSync(path.join(next, 'cards', 'card_00000000000000000000000000000000.persomecard'))).toBe(true)
    expect(fs.existsSync(path.join(next, MIGRATION_MARKER))).toBe(true)
    expect(fs.readFileSync(path.join(legacy, 'identity', 'ed25519.key.enc'), 'utf8')).toBe(before)
    expect(fs.readdirSync(path.dirname(next))).toEqual(['Store'])
  })

  it('does nothing when the new store exists or there is no old store', () => {
    const base = tmp()
    const legacy = path.join(base, 'Persome Lens')
    const next = path.join(base, 'Store')
    const deps = { legacyRoot: legacy, newRoot: next, readLegacyPassword: () => 'pw', encryptString: newEncrypt }
    expect(migrateFromPersomeLens(deps)).toEqual({ status: 'not_needed', reason: 'no_legacy_store' })
    seedLegacy(legacy, 'pw')
    fs.mkdirSync(next)
    expect(migrateFromPersomeLens(deps)).toEqual({ status: 'not_needed', reason: 'new_store_exists' })
    expect(fs.readdirSync(next)).toEqual([])
  })

  it('keychain denied or wrong key → no new store, no staging left, retry possible', () => {
    const base = tmp()
    const legacy = path.join(base, 'Persome Lens')
    const next = path.join(base, 'Store')
    seedLegacy(legacy, 'pw')
    expect(migrateFromPersomeLens({ legacyRoot: legacy, newRoot: next, readLegacyPassword: () => null, encryptString: newEncrypt })).toMatchObject({
      status: 'failed',
      reason: 'keychain_denied'
    })
    expect(migrateFromPersomeLens({ legacyRoot: legacy, newRoot: next, readLegacyPassword: () => 'wrong', encryptString: newEncrypt })).toMatchObject({
      status: 'failed',
      reason: 'reseal_failed'
    })
    expect(fs.readdirSync(base)).toEqual(['Persome Lens'])
    expect(migrateFromPersomeLens({ legacyRoot: legacy, newRoot: next, readLegacyPassword: () => 'pw', encryptString: newEncrypt }).status).toBe('migrated')
  })

  it('never asks for the keychain when nothing is sealed', () => {
    const base = tmp()
    const legacy = path.join(base, 'Persome Lens')
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, 'onboarding.json'), '{}')
    const r = migrateFromPersomeLens({
      legacyRoot: legacy,
      newRoot: path.join(base, 'Store'),
      readLegacyPassword: () => {
        throw new Error('must not be called')
      },
      encryptString: newEncrypt
    })
    expect(r).toEqual({ status: 'migrated', resealed: [] })
  })
})

describe('migrateLegacyStore (Grapple source)', () => {
  it('re-seals with the grapple keychain password and writes the grapple marker', () => {
    const base = tmp()
    const legacy = path.join(base, 'Grapple', 'Store')
    const next = path.join(base, 'Navalia', 'Store')
    seedLegacy(legacy, 'grapplepw')
    const r = migrateLegacyStore({ source: GRAPPLE, legacyRoot: legacy, newRoot: next, readLegacyPassword: () => 'grapplepw', encryptString: newEncrypt })
    expect(r).toEqual({ status: 'migrated', resealed: ['identity/ed25519.key.enc'] })
    const sealed = JSON.parse(fs.readFileSync(path.join(next, 'identity', 'ed25519.key.enc'), 'utf8'))
    expect(Buffer.from(sealed.ciphertext, 'base64').toString()).toBe('NEW:REVSLUtFWQ==')
    expect(fs.existsSync(path.join(next, '.migrated-from-grapple.json'))).toBe(true)
    expect(fs.existsSync(path.join(legacy, 'identity', 'ed25519.key.enc'))).toBe(true)
  })

  it('denied keychain names the grapple item', () => {
    const base = tmp()
    const legacy = path.join(base, 'Grapple', 'Store')
    seedLegacy(legacy, 'pw')
    const r = migrateLegacyStore({ source: GRAPPLE, legacyRoot: legacy, newRoot: path.join(base, 'Store'), readLegacyPassword: () => null, encryptString: newEncrypt })
    expect(r).toMatchObject({ status: 'failed', reason: 'keychain_denied' })
    expect(r.status === 'failed' && r.detail).toContain('grapple Safe Storage')
  })
})

describe('findLegacySource', () => {
  it('prefers the newest previous app (Grapple) over Persome Lens', () => {
    const home = tmp()
    expect(findLegacySource(home)).toBeNull()
    fs.mkdirSync(legacyStoreRoot(PERSOME_LENS, home), { recursive: true })
    expect(findLegacySource(home)?.label).toBe('Persome Lens')
    fs.mkdirSync(legacyStoreRoot(GRAPPLE, home), { recursive: true })
    expect(findLegacySource(home)?.label).toBe('Grapple')
    expect(legacyStoreRoot(GRAPPLE, home)).toBe(path.join(home, 'Library', 'Application Support', 'Grapple', 'Store'))
  })
})

describe('legacyAppRunning', () => {
  it('reads host-pid from SingletonLock', () => {
    const d = tmp()
    expect(legacyAppRunning(d)).toBe(false)
    fs.symlinkSync('My-Mac.local-4242', path.join(d, 'SingletonLock'))
    expect(legacyAppRunning(d, (pid) => pid === 4242)).toBe(true)
    expect(legacyAppRunning(d, () => false)).toBe(false)
  })
})
