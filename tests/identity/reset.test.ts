import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { IDENTITY_CHANNELS, RESET_CONFIRM } from '../../src/main/identity/api'
import { readCardFile } from '../../src/main/identity/card'
import { registerIdentityIpc } from '../../src/main/identity/ipc'
import { createKeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { sampleGraph, shareFor } from './fixtures'
import { createTestBox, mode, tempRoot } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const confirmAnswer = { value: true }

type Handler = (event: unknown, arg?: unknown) => unknown

function setup(boxOverride?: ReturnType<typeof createTestBox>, confirm?: () => Promise<boolean>) {
  const root = tempRoot('reset')
  roots.push(root)
  const paths = storePaths(root)
  const box = boxOverride ?? createTestBox()
  const keys = createKeyManager(paths, box)
  const handlers = new Map<string, Handler>()
  registerIdentityIpc({ handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) } as never, {
    paths,
    keys,
    box,
    getShareCard: async () => shareFor(sampleGraph()),
    getGraph: async () => sampleGraph(),
    confirmReset: confirm ?? (async () => confirmAnswer.value)
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (ch: string, arg?: unknown) => Promise.resolve(handlers.get(ch)!({}, arg)) as Promise<any>
  return { paths, keys, box, call }
}

describe('Reset identity', () => {
  test('native dialog Cancel (main-side) → nothing changes; Confirm → reset', async () => {
    const { paths, call } = setup()
    const before = (await call(IDENTITY_CHANNELS.init)).data.identity.fingerprint
    const keyBefore = fs.readFileSync(paths.privateKeyFile)
    confirmAnswer.value = false
    const cancelled = await call(IDENTITY_CHANNELS.reset, { confirm: RESET_CONFIRM })
    expect(cancelled.data).toMatchObject({ reset: false, status: { identity: { fingerprint: before }, previous: [] } })
    expect(fs.readFileSync(paths.privateKeyFile).equals(keyBefore)).toBe(true)
    confirmAnswer.value = true
    const done = await call(IDENTITY_CHANNELS.reset, { confirm: RESET_CONFIRM })
    expect(done.data.reset).toBe(true)
    expect(done.data.status.identity.fingerprint).not.toBe(before)
  })

  test('without the literal the native dialog is never even shown', async () => {
    let shown = 0
    const { call } = setup(undefined, async () => (shown++, true))
    await call(IDENTITY_CHANNELS.init)
    expect((await call(IDENTITY_CHANNELS.reset, {})).ok).toBe(false)
    expect(shown).toBe(0)
  })

  test('requires the explicit confirm literal', async () => {
    const { call } = setup()
    await call(IDENTITY_CHANNELS.init)
    for (const arg of [undefined, {}, { confirm: 'yes' }, { confirm: RESET_CONFIRM, extra: 1 }]) {
      expect((await call(IDENTITY_CHANNELS.reset, arg)).ok).toBe(false)
    }
  })

  test('new key; old key retired with public record only; old card shows as previous key and still verifies', async () => {
    const { paths, call } = setup()
    const created = await call(IDENTITY_CHANNELS.cardCreate)
    const oldFp = created.data.signed.card.issuer.fingerprint
    const oldKeyFile = fs.readFileSync(paths.privateKeyFile, 'utf8')
    expect(created.data.issuer).toBe('current')

    const r0 = await call(IDENTITY_CHANNELS.reset, { confirm: RESET_CONFIRM })
    expect(r0.data.reset).toBe(true)
    const r = { ok: r0.ok, data: r0.data.status }
    expect(r.ok).toBe(true)
    expect(r.data.identity.fingerprint).not.toBe(oldFp)
    expect(r.data.previous).toEqual([expect.objectContaining({ fingerprint: oldFp })])

    // old private key is gone from disk; previous.json holds no ciphertext
    expect(fs.readFileSync(paths.privateKeyFile, 'utf8')).not.toBe(oldKeyFile)
    const prev = fs.readFileSync(paths.previousIdentitiesFile, 'utf8')
    expect(prev).not.toMatch(/ciphertext/)
    expect(mode(paths.previousIdentitiesFile)).toBe('600')

    // the old card still verifies cryptographically, and is labelled as signed by a previous key
    expect(readCardFile(created.data.file).valid).toBe(true)
    const latest = await call(IDENTITY_CHANNELS.cardLatest)
    expect(latest.data.issuer).toBe('previous')
    const verified = await call(IDENTITY_CHANNELS.cardVerify, { text: fs.readFileSync(created.data.file, 'utf8') })
    expect(verified.data).toMatchObject({ valid: true, issuer: 'previous' })

    // new cards are signed by the new key
    const fresh = await call(IDENTITY_CHANNELS.cardCreate)
    expect(fresh.data.signed.card.issuer.fingerprint).toBe(r.data.identity.fingerprint)
    expect((await call(IDENTITY_CHANNELS.cardLatest)).data.issuer).toBe('current')
  })

  test('a card from an unrelated key is "foreign"', async () => {
    const a = setup()
    const b = setup()
    const card = await a.call(IDENTITY_CHANNELS.cardCreate)
    await b.call(IDENTITY_CHANNELS.init)
    const v = await b.call(IDENTITY_CHANNELS.cardVerify, { text: fs.readFileSync(card.data.file, 'utf8') })
    expect(v.data).toMatchObject({ valid: true, issuer: 'foreign' })
  })

  test('reset recovers an identity whose key can no longer be decrypted (e.g. dev vs packaged keychain)', async () => {
    const { paths, call } = setup()
    await call(IDENTITY_CHANNELS.init)
    // a different backend key = the old ciphertext is undecryptable
    const other = setup(createTestBox())
    fs.cpSync(paths.root, other.paths.root, { recursive: true })
    expect((await other.call(IDENTITY_CHANNELS.cardCreate)).ok).toBe(false)
    const r = await other.call(IDENTITY_CHANNELS.reset, { confirm: RESET_CONFIRM })
    expect(r.ok && r.data.reset).toBe(true)
    expect((await other.call(IDENTITY_CHANNELS.cardCreate)).ok).toBe(true)
  })

  test('reset fails closed with encryption unavailable and leaves the current key untouched', async () => {
    const box = createTestBox()
    const { paths, keys } = setup(box)
    const before = keys.ensureIdentity()
    const keyBefore = fs.readFileSync(paths.privateKeyFile)
    ;(box as unknown as { setAvailable: (v: boolean) => void }).setAvailable(false)
    expect(() => keys.resetIdentity()).toThrow(/not available/)
    expect(keys.getPublicIdentity()).toEqual(before)
    expect(fs.readFileSync(paths.privateKeyFile).equals(keyBefore)).toBe(true)
    expect(fs.existsSync(paths.previousIdentitiesFile)).toBe(false)
  })
})
