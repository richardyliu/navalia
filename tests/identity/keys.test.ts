import fs from 'node:fs'
import { verify } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { createKeyManager, IdentityError, publicKeyFromRaw } from '../../src/main/identity/keys'
import { createSafeStorageBox } from '../../src/main/identity/secret-box'
import { storePaths } from '../../src/main/store/paths'
import { createTestBox, mode, tempRoot } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function setup() {
  const root = tempRoot('keys')
  roots.push(root)
  const paths = storePaths(root)
  const box = createTestBox()
  return { root, paths, box, keys: createKeyManager(paths, box) }
}

describe('Ed25519 key manager', () => {
  test('creates keypair: files 0600, dirs 0700, identity.json holds only public data', () => {
    const { paths, keys } = setup()
    expect(keys.getPublicIdentity()).toBeNull()
    const id = keys.ensureIdentity()
    expect(id.alg).toBe('Ed25519')
    expect(id.key_backend).toBe('test-aes-gcm')
    expect(mode(paths.privateKeyFile)).toBe('600')
    expect(mode(paths.identityFile)).toBe('600')
    expect(mode(paths.identityDir)).toBe('700')
    expect(mode(paths.root)).toBe('700')
    const pub = JSON.parse(fs.readFileSync(paths.identityFile, 'utf8'))
    expect(Object.keys(pub).sort()).toEqual(['alg', 'created_at', 'fingerprint', 'key_backend', 'public_key', 'version'])
  })

  test('private key file contains only ciphertext: the PKCS#8 DER is not present in any encoding', () => {
    const { paths, box, keys } = setup()
    keys.ensureIdentity()
    const file = JSON.parse(fs.readFileSync(paths.privateKeyFile, 'utf8'))
    const der = box.decrypt(Buffer.from(file.ciphertext, 'base64'))
    expect(der.length).toBe(48) // Ed25519 PKCS#8 DER
    const onDisk = fs.readFileSync(paths.privateKeyFile)
    const seed = der.subarray(16)
    for (const needle of [der.toString('base64'), der.toString('hex'), seed.toString('base64'), seed.toString('base64url'), seed.toString('hex')]) {
      expect(onDisk.includes(needle)).toBe(false)
    }
    expect(onDisk.includes(seed)).toBe(false)
  })

  test('ensureIdentity is idempotent', () => {
    const { keys } = setup()
    const a = keys.ensureIdentity()
    expect(keys.ensureIdentity()).toEqual(a)
  })

  test('restart: a fresh manager decrypts the stored key and signs verifiably with the stored public key', () => {
    const { paths, box, keys } = setup()
    const id = keys.ensureIdentity()
    const restarted = createKeyManager(paths, box)
    const msg = Buffer.from('hello card')
    const sig = restarted.sign(msg)
    expect(verify(null, msg, publicKeyFromRaw(Buffer.from(id.public_key, 'base64url')), sig)).toBe(true)
  })

  test('fails closed when the encryption backend is unavailable: nothing is written', () => {
    const root = tempRoot('keys-unavail')
    roots.push(root)
    const paths = storePaths(root)
    const keys = createKeyManager(paths, createTestBox({ available: false }))
    expect(() => keys.ensureIdentity()).toThrow(/refusing to store a plaintext key/)
    expect(fs.existsSync(paths.privateKeyFile)).toBe(false)
    expect(fs.existsSync(paths.identityFile)).toBe(false)
  })

  test('safeStorage adapter refuses when encryption is unavailable', () => {
    const box = createSafeStorageBox({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    })
    expect(() => box.encrypt(Buffer.from('x'))).toThrow(/not available/)
  })

  test('backend mismatch and wrong backend key are rejected', () => {
    const { paths, keys } = setup()
    keys.ensureIdentity()
    expect(() => createKeyManager(paths, createTestBox({ id: 'other' })).sign(Buffer.from('m'))).toThrow(/encrypted with "test-aes-gcm"/)
    expect(() => createKeyManager(paths, createTestBox()).sign(Buffer.from('m'))).toThrow(/could not decrypt/)
  })

  test('swapped public key in identity.json is detected on unlock', () => {
    const { paths, box, keys } = setup()
    keys.ensureIdentity()
    const other = setup()
    const otherId = other.keys.ensureIdentity()
    const mine = JSON.parse(fs.readFileSync(paths.identityFile, 'utf8'))
    fs.writeFileSync(paths.identityFile, JSON.stringify({ ...mine, public_key: otherId.public_key, fingerprint: otherId.fingerprint }))
    expect(() => createKeyManager(paths, box).sign(Buffer.from('m'))).toThrow(IdentityError)
  })

  test('orphan private key without identity.json is never overwritten', () => {
    const { paths, keys } = setup()
    keys.ensureIdentity()
    const before = fs.readFileSync(paths.privateKeyFile)
    fs.rmSync(paths.identityFile)
    expect(() => keys.ensureIdentity()).toThrow(/refusing to overwrite/)
    expect(fs.readFileSync(paths.privateKeyFile).equals(before)).toBe(true)
  })

  test('no decrypted key is cached: every sign() decrypts again (review #10)', () => {
    const { paths, box } = setup()
    let decrypts = 0
    const counting = { ...box, decrypt: (c: Buffer) => (decrypts++, box.decrypt(c)) }
    const keys = createKeyManager(paths, counting)
    keys.ensureIdentity()
    keys.sign(Buffer.from('a'))
    keys.sign(Buffer.from('b'))
    keys.sign(Buffer.from('c'))
    expect(decrypts).toBe(3)
  })

  test('KeyManager exposes no private key accessor', () => {
    const { keys } = setup()
    keys.ensureIdentity()
    expect(Object.keys(keys).sort()).toEqual(['ensureIdentity', 'getPublicIdentity', 'lock', 'previousIdentities', 'resetIdentity', 'sign'])
    expect(JSON.stringify(keys.getPublicIdentity())).not.toMatch(/PRIVATE|BEGIN/)
  })
})
