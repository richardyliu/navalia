// `lens:cloud:*`: zod strictObject rejection, consent rules for configure / deleteAccount,
// sanitized errors.
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_CHANNELS } from '../../src/main/cloud/api'
import { cloudPaths, readCloudConfig } from '../../src/main/cloud/config'
import { registerCloudIpc, toCloudIpcError } from '../../src/main/cloud/ipc'
import { createTokenStore } from '../../src/main/cloud/token'
import { fakeBox, fakeIpc, tempStore, testIdentity } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function setup(confirmAnswer: boolean | null = true) {
  const fetchSpy = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchSpy)
  const root = tempStore(roots)
  const id = testIdentity()
  const confirm = vi.fn(async () => confirmAnswer === true)
  const box = fakeBox()
  const ipc = fakeIpc()
  registerCloudIpc(ipc, {
    storeRoot: root,
    box,
    sign: id.sign,
    getPublicIdentity: id.getPublicIdentity,
    ...(confirmAnswer === null ? {} : { nativeConfirm: confirm })
  })
  return { root, ipc, confirm, fetchSpy, box, id }
}

describe('cloud IPC', () => {
  it('registers exactly the five lens:cloud:* channels', () => {
    const { ipc } = setup()
    expect(ipc.channels().sort()).toEqual(Object.values(CLOUD_CHANNELS).sort())
    expect(ipc.channels().every((c) => c.startsWith('lens:cloud:'))).toBe(true)
  })

  it('status defaults to OFF', async () => {
    const { ipc } = setup()
    expect(await ipc.invoke(CLOUD_CHANNELS.status)).toEqual({
      ok: true,
      data: { enabled: false, baseUrl: null, signedIn: false, accountId: null, expiresAt: null }
    })
  })

  it.each([
    [CLOUD_CHANNELS.status, { extra: 1 }],
    [CLOUD_CHANNELS.signIn, 'x'],
    [CLOUD_CHANNELS.signOut, { token: 'x' }],
    [CLOUD_CHANNELS.configure, undefined],
    [CLOUD_CHANNELS.configure, { enabled: 'yes', baseUrl: null }],
    [CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com', confirm: false }],
    [CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com', confirm: true, extra: 1 }],
    [CLOUD_CHANNELS.configure, { enabled: true }],
    [CLOUD_CHANNELS.deleteAccount, undefined],
    [CLOUD_CHANNELS.deleteAccount, { confirm: false }],
    [CLOUD_CHANNELS.deleteAccount, { confirm: true, now: 1 }]
  ])('%s rejects %j with invalid_args', async (ch, raw) => {
    const { ipc, fetchSpy, confirm } = setup()
    expect(await ipc.invoke(ch, raw)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('enabling needs confirm:true AND the native confirm; bad URL is invalid_args', async () => {
    const { ipc, confirm, root } = setup(false)
    const file = cloudPaths(root).configFile
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com' })).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(confirm).not.toHaveBeenCalled()
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'http://a.example.com', confirm: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid_args' }
    })
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: null, confirm: true })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com', confirm: true })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toEqual({ id: 1 }) // parented to the sender
    expect(readCloudConfig(file).enabled).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('without a nativeConfirm dep, enabling is refused (fail closed)', async () => {
    const { ipc } = setup(null)
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com', confirm: true })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
  })

  it('enable → normalized origin persisted; OFF revokes server-side (best effort) then forgets the token', async () => {
    const { ipc, root, fetchSpy, box, id } = setup(true)
    const r = await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://A.example.com/', confirm: true })
    expect(r).toMatchObject({ ok: true, data: { enabled: true, baseUrl: 'https://a.example.com', signedIn: false } })
    // Pretend a sign-in happened.
    const p = cloudPaths(root)
    createTokenStore(p.tokenFile, box).save('tok_abcdefghijklmnopqrstuvwxyz', { accountId: 'acct', expiresAt: '2099-01-01T00:00:00Z', origin: 'https://a.example.com', fingerprint: id.fingerprint })
    expect(await ipc.invoke(CLOUD_CHANNELS.status)).toMatchObject({ ok: true, data: { signedIn: true, accountId: 'acct' } })
    const off = await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: false, baseUrl: 'https://a.example.com' })
    expect(off).toMatchObject({ ok: true, data: { enabled: false, baseUrl: 'https://a.example.com', signedIn: false, accountId: null, remoteRevoked: true } })
    expect(fs.existsSync(p.tokenFile)).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect((fetchSpy.mock.calls[0] as unknown[])[0]).toBe('https://a.example.com/v1/auth/logout')
    // Already OFF and no token: no request at all.
    await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: false, baseUrl: null })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('switching server while ON re-confirms and drops the old token; same server is a no-op', async () => {
    const { ipc, root, confirm, box, id } = setup(true)
    await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com', confirm: true })
    const p = cloudPaths(root)
    createTokenStore(p.tokenFile, box).save('tok_abcdefghijklmnopqrstuvwxyz', { accountId: 'acct', expiresAt: '2099-01-01T00:00:00Z', origin: 'https://a.example.com', fingerprint: id.fingerprint })
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com' })).toMatchObject({ ok: true, data: { signedIn: true } })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://b.example.com' })).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://b.example.com', confirm: true })).toMatchObject({
      ok: true,
      data: { baseUrl: 'https://b.example.com', signedIn: false }
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(p.tokenFile)).toBe(false)
  })

  it('a token issued for another origin never shows as signed in', async () => {
    const { ipc, root, box, id } = setup(true)
    await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: true, baseUrl: 'https://a.example.com', confirm: true })
    createTokenStore(cloudPaths(root).tokenFile, box).save('tok_abcdefghijklmnopqrstuvwxyz', {
      accountId: 'acct',
      expiresAt: '2099-01-01T00:00:00Z',
      origin: 'https://other.example.com',
      fingerprint: id.fingerprint
    })
    expect(await ipc.invoke(CLOUD_CHANNELS.status)).toMatchObject({ ok: true, data: { signedIn: false, accountId: null } })
  })

  it('unknown errors are replaced by a fixed message', () => {
    expect(toCloudIpcError(new Error('/Users/ryl/secret path and Bearer abc'))).toEqual({ code: 'unknown', message: 'Cloud operation failed' })
  })
})
