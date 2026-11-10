import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudPaths, CloudConfigError, normalizeBaseUrl, readCloudConfig, writeCloudConfig } from '../../src/main/cloud/config'
import { createTokenStore } from '../../src/main/cloud/token'
import { fakeBox, tempStore } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const FP = 'a'.repeat(64)

describe('cloud config: normalizeBaseUrl', () => {
  it.each([
    ['https://cloud.example.com', 'https://cloud.example.com'],
    ['https://cloud.example.com/', 'https://cloud.example.com'],
    ['  https://Cloud.Example.com:8443/ ', 'https://cloud.example.com:8443'],
    ['https://cloud.example.com:443', 'https://cloud.example.com'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
    ['http://localhost:3000/', 'http://localhost:3000']
  ])('accepts %s → %s', (input, out) => {
    expect(normalizeBaseUrl(input, { allowInsecureLoopback: true })).toBe(out)
  })

  it.each([
    '',
    'cloud.example.com',
    'ftp://cloud.example.com',
    'http://cloud.example.com',
    'http://127.0.0.1',
    'http://localhost',
    'http://10.0.0.1:80',
    'http://127.0.0.2:8080',
    'https://user:pw@cloud.example.com',
    'https://user@cloud.example.com',
    'https://@cloud.example.com',
    'https://cloud.example.com/api',
    'https://cloud.example.com/v1/',
    'https://cloud.example.com/?x=1',
    'https://cloud.example.com?',
    'https://cloud.example.com#frag',
    'https://cloud.example.com/ x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    `https://${'a'.repeat(2050)}.com`
  ])('rejects %s', (input) => {
    expect(() => normalizeBaseUrl(input, { allowInsecureLoopback: true })).toThrow(CloudConfigError)
  })

  it('error messages never echo the input (could be a pasted secret)', () => {
    try {
      normalizeBaseUrl('https://user:SUPERSECRET@cloud.example.com')
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).not.toContain('SUPERSECRET')
    }
  })
})

describe('cloud config: file', () => {
  it('defaults to OFF with no server when the file is missing', () => {
    const root = tempStore(roots)
    expect(readCloudConfig(cloudPaths(root).configFile)).toEqual({ version: 1, enabled: false, baseUrl: null })
    expect(fs.existsSync(root)).toBe(false) // reading never creates anything
  })

  it('writes cloud.json with 0600 in a 0700 store dir, normalized', () => {
    const root = tempStore(roots)
    const file = cloudPaths(root).configFile
    expect(path.basename(file)).toBe('cloud.json')
    const out = writeCloudConfig(file, { enabled: true, baseUrl: 'https://Cloud.Example.com/' })
    expect(out).toEqual({ version: 1, enabled: true, baseUrl: 'https://cloud.example.com' })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, enabled: true, baseUrl: 'https://cloud.example.com' })
    expect(readCloudConfig(file)).toEqual(out)
  })

  it('refuses enabled without a server and invalid servers', () => {
    const file = cloudPaths(tempStore(roots)).configFile
    expect(() => writeCloudConfig(file, { enabled: true, baseUrl: null })).toThrow(CloudConfigError)
    expect(() => writeCloudConfig(file, { enabled: false, baseUrl: 'http://evil.example.com' })).toThrow(CloudConfigError)
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each([
    ['not json', '{'],
    ['extra key', JSON.stringify({ version: 1, enabled: true, baseUrl: 'https://a.example.com', token: 'x' })],
    ['wrong version', JSON.stringify({ version: 2, enabled: true, baseUrl: 'https://a.example.com' })],
    ['http public host', JSON.stringify({ version: 1, enabled: true, baseUrl: 'http://a.example.com' })],
    ['non-normalized', JSON.stringify({ version: 1, enabled: true, baseUrl: 'https://a.example.com/' })],
    ['enabled without server', JSON.stringify({ version: 1, enabled: true, baseUrl: null })]
  ])('fails closed to OFF on a bad file (%s)', (_name, content) => {
    const root = tempStore(roots)
    fs.mkdirSync(root, { recursive: true })
    const file = cloudPaths(root).configFile
    fs.writeFileSync(file, content)
    expect(readCloudConfig(file).enabled).toBe(false)
  })
})

describe('cloud token store', () => {
  it('encrypts the token at rest (0600), exposes only metadata, forgets on clear', () => {
    const root = tempStore(roots)
    const file = cloudPaths(root).tokenFile
    const store = createTokenStore(file, fakeBox())
    const token = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
    const exp = new Date(Date.now() + 3600_000).toISOString()
    store.save(token, { accountId: 'acct_1', expiresAt: exp, origin: 'https://a.example.com', fingerprint: FP })
    expect(path.basename(file)).toBe('cloud-token.enc')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token)
    expect(store.meta()).toEqual({ accountId: 'acct_1', expiresAt: exp, origin: 'https://a.example.com', fingerprint: FP })
    expect(store.bearer('https://a.example.com')).toBe(token)
    expect(store.bearer('https://b.example.com')).toBeNull() // bound to the issuing origin
    store.clear()
    expect(fs.existsSync(file)).toBe(false)
    expect(store.meta()).toBeNull()
  })

  it('treats an expired token as signed out', () => {
    const file = cloudPaths(tempStore(roots)).tokenFile
    let now = new Date('2026-01-01T00:00:00Z')
    const store = createTokenStore(file, fakeBox(), () => now)
    store.save('tok_abcdefghijklmnopqrstuvwxyz', { accountId: 'a', expiresAt: '2026-01-01T01:00:00Z', origin: 'https://a.example.com', fingerprint: FP })
    expect(store.meta()).not.toBeNull()
    now = new Date('2026-01-01T01:00:01Z')
    expect(store.meta()).toBeNull()
    expect(store.bearer('https://a.example.com')).toBeNull()
  })

  it('refuses to save when the encryption backend is unavailable', () => {
    const file = cloudPaths(tempStore(roots)).tokenFile
    const store = createTokenStore(file, fakeBox(false))
    expect(() => store.save('tok_abcdefghijklmnopqrstuvwxyz', { accountId: 'a', expiresAt: '2099-01-01T00:00:00Z', origin: 'https://a.example.com', fingerprint: FP })).toThrow(
      expect.objectContaining({ code: 'storage' })
    )
    expect(fs.existsSync(file)).toBe(false)
  })

  it('ignores a token written by another backend', () => {
    const file = cloudPaths(tempStore(roots)).tokenFile
    createTokenStore(file, fakeBox()).save('tok_abcdefghijklmnopqrstuvwxyz', { accountId: 'a', expiresAt: '2099-01-01T00:00:00Z', origin: 'https://a.example.com', fingerprint: FP })
    const other = { ...fakeBox(), id: 'other' }
    expect(createTokenStore(file, other).meta()).toBeNull()
  })
})
