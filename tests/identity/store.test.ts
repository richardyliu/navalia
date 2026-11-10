import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ensureStore, resolveStoreRoot, storePaths, writeFileSecure } from '../../src/main/store/paths'
import { DEFAULT_SETTINGS, readSettings, SettingsSchema, type LensSettings } from '../../src/main/store/settings'
import type { StorePaths } from '../../src/main/store/paths'
import { mode, tempRoot } from './helpers'

function writeSettings(paths: StorePaths, settings: LensSettings): LensSettings {
  const parsed = SettingsSchema.parse(settings)
  writeFileSecure(paths.settingsFile, `${JSON.stringify(parsed, null, 2)}\n`)
  return parsed
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

describe('Lens Store paths', () => {
  test('default root is ~/Library/Application Support/Navalia/Store', () => {
    expect(resolveStoreRoot({})).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'Navalia', 'Store'))
  })

  test('LENS_STORE_ROOT overrides and is resolved to an absolute path', () => {
    expect(resolveStoreRoot({ LENS_STORE_ROOT: '  /tmp/x/lens ' })).toBe('/tmp/x/lens')
    expect(path.isAbsolute(resolveStoreRoot({ LENS_STORE_ROOT: 'rel/dir' }))).toBe(true)
  })

  test('layout: identity/, settings.json, cards/, grants.json, audit.db, het.db', () => {
    const p = storePaths('/r')
    expect(p).toMatchObject({
      identityDir: '/r/identity',
      privateKeyFile: '/r/identity/ed25519.key.enc',
      identityFile: '/r/identity/identity.json',
      settingsFile: '/r/settings.json',
      cardsDir: '/r/cards',
      grantsFile: '/r/grants.json',
      auditDb: '/r/audit.db',
      hetDb: '/r/het.db'
    })
  })

  test('ensureStore creates dirs 0700 even under a permissive umask, and tightens existing dirs', () => {
    const base = tempRoot('store')
    roots.push(base)
    const root = path.join(base, 'Navalia')
    fs.mkdirSync(path.join(root, 'cards'), { recursive: true, mode: 0o755 })
    fs.chmodSync(path.join(root, 'cards'), 0o755)
    const prev = process.umask(0)
    try {
      ensureStore(storePaths(root))
    } finally {
      process.umask(prev)
    }
    expect(mode(root)).toBe('700')
    expect(mode(path.join(root, 'identity'))).toBe('700')
    expect(mode(path.join(root, 'cards'))).toBe('700')
    // het.db / audit.db are not created here
    expect(fs.existsSync(path.join(root, 'het.db'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'audit.db'))).toBe(false)
  })

  test('writeFileSecure writes 0600 atomically and keeps 0600 on overwrite', () => {
    const root = tempRoot('write')
    roots.push(root)
    const file = path.join(root, 'sub', 'f.json')
    const prev = process.umask(0)
    try {
      writeFileSecure(file, 'one')
      fs.chmodSync(file, 0o644)
      writeFileSecure(file, 'two')
    } finally {
      process.umask(prev)
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('two')
    expect(mode(file)).toBe('600')
    expect(mode(path.dirname(file))).toBe('700')
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('settings.json', () => {
  test('defaults when missing, round-trips, 0600, rejects unknown keys', () => {
    const root = tempRoot('settings')
    roots.push(root)
    const p = ensureStore(storePaths(root))
    expect(readSettings(p)).toEqual(DEFAULT_SETTINGS)
    writeSettings(p, { version: 1, displayName: 'Ryl' })
    expect(readSettings(p)).toEqual({ version: 1, displayName: 'Ryl' })
    expect(mode(p.settingsFile)).toBe('600')
    fs.writeFileSync(p.settingsFile, JSON.stringify({ version: 1, displayName: null, extra: 1 }))
    expect(() => readSettings(p)).toThrow()
  })
})
