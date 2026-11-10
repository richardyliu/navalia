import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { IDENTITY_CHANNELS } from '../../src/main/identity/api'
import { registerIdentityIpc } from '../../src/main/identity/ipc'
import { createKeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { sampleGraph, shareFor } from './fixtures'
import { createTestBox, tempRoot } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const confirmAnswer = { value: true }

type Handler = (event: unknown, arg?: unknown) => unknown

function setup(available = true) {
  const root = tempRoot('ipc')
  roots.push(root)
  const paths = storePaths(root)
  const box = createTestBox({ available })
  const keys = createKeyManager(paths, box)
  const handlers = new Map<string, Handler>()
  registerIdentityIpc({ handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) } as never, {
    paths,
    keys,
    box,
    getShareCard: async () => shareFor(sampleGraph()),
    getGraph: async () => sampleGraph(),
    confirmReset: async () => confirmAnswer.value
  })
  const call = (ch: string, arg?: unknown) => Promise.resolve(handlers.get(ch)!({}, arg)) as Promise<any>
  return { paths, box, handlers, call }
}

describe('identity IPC', () => {
  test('registers exactly the allowlisted channels', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(IDENTITY_CHANNELS).sort())
  })

  test('status → init → create → latest → verify; no private material in any response', async () => {
    const { paths, box, call } = setup()
    const s0 = await call(IDENTITY_CHANNELS.status)
    expect(s0).toMatchObject({ ok: true, data: { identity: null, encryptionAvailable: true } })
    const s1 = await call(IDENTITY_CHANNELS.init)
    expect(s1.ok).toBe(true)
    expect(s1.data.identity.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const created = await call(IDENTITY_CHANNELS.cardCreate)
    expect(created.ok).toBe(true)
    expect(fs.existsSync(created.data.file)).toBe(true)
    const latest = await call(IDENTITY_CHANNELS.cardLatest)
    expect(latest.data.signed.card.card_id).toBe(created.data.signed.card.card_id)
    const verified = await call(IDENTITY_CHANNELS.cardVerify, { text: fs.readFileSync(created.data.file, 'utf8') })
    expect(verified).toMatchObject({ ok: true, data: { valid: true } })

    const keyFile = JSON.parse(fs.readFileSync(paths.privateKeyFile, 'utf8'))
    const der = box.decrypt(Buffer.from(keyFile.ciphertext, 'base64'))
    const all = JSON.stringify([s0, s1, created, latest, verified])
    for (const needle of [keyFile.ciphertext, der.toString('base64'), der.subarray(16).toString('base64url'), der.subarray(16).toString('hex')]) {
      expect(all.includes(needle)).toBe(false)
    }
  })

  test('verify reports tampering without throwing', async () => {
    const { call } = setup()
    const created = await call(IDENTITY_CHANNELS.cardCreate)
    const t = created.data.signed
    t.card.content.front.summary = 'edited'
    const r = await call(IDENTITY_CHANNELS.cardVerify, { text: JSON.stringify(t) })
    expect(r).toMatchObject({ ok: true, data: { valid: false, reason: 'signature' } })
  })

  test('zod rejects unexpected arguments', async () => {
    const { call } = setup()
    expect((await call(IDENTITY_CHANNELS.init, { force: true })).ok).toBe(false)
    expect((await call(IDENTITY_CHANNELS.cardVerify, { text: '' })).ok).toBe(false)
    expect((await call(IDENTITY_CHANNELS.cardVerify, { text: 'x', extra: 1 })).ok).toBe(false)
  })

  test('encryption unavailable → init fails closed as an error result', async () => {
    const { paths, call } = setup(false)
    const r = await call(IDENTITY_CHANNELS.init)
    expect(r.ok).toBe(false)
    expect(r.error.message).toMatch(/refusing to store a plaintext key/)
    expect(fs.existsSync(paths.privateKeyFile)).toBe(false)
  })
})
