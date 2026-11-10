// Full challenge/verify sign-in against an in-test node:http server that verifies the Ed25519
// signature for real, plus error mapping (401 / 429 / timeout / oversize / bad body) and
// "the token never escapes" checks.
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CLOUD_CHANNELS } from '../../src/main/cloud/api'
import { authMessage, parseRetryAfter } from '../../src/main/cloud/client'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { CloudError } from '../../src/main/cloud/errors'
import { registerCloudIpc } from '../../src/main/cloud/ipc'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { errBody, fakeBox, fakeIpc, startFakeServer, tempStore, testIdentity, type FakeServer, type TestIdentity, LOOPBACK } from './helpers'

const roots: string[] = []
let server: FakeServer
let id: TestIdentity
let root: string

beforeEach(async () => {
  server = await startFakeServer()
  id = testIdentity()
  root = tempStore(roots)
  writeCloudConfig(cloudPaths(root).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await server.close()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function service(extra: Partial<Parameters<typeof createCloudService>[0]> = {}): CloudService {
  return createCloudService({ storeRoot: root, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true, ...extra })
}

async function caught(p: Promise<unknown>): Promise<CloudError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(CloudError)
    return e as CloudError
  }
  throw new Error('expected a CloudError')
}

describe('cloud auth: happy path', () => {
  it('signs in with a real Ed25519 challenge, stores the token encrypted, session / logout work', async () => {
    const sign = vi.fn(id.sign)
    const svc = service({ sign })
    const st = await svc.signIn()
    expect(st).toMatchObject({ enabled: true, baseUrl: server.origin, signedIn: true })
    expect(st.accountId).toBe(`acct_${id.fingerprint.slice(0, 12)}`)
    expect(sign).toHaveBeenCalledTimes(1)
    // The exact signed bytes (contract): context, audience, challenge id, nonce, fingerprint.
    const signed = sign.mock.calls[0][0].toString('utf8').split('\n')
    expect(signed[0]).toBe('persome-cloud-auth-v1')
    expect(signed[1]).toBe(server.origin)
    expect(signed[4]).toBe(id.fingerprint)
    expect(signed).toHaveLength(5)
    expect(server.log.slice(0, 2)).toEqual(['POST /v1/auth/challenge', 'POST /v1/auth/verify'])
    expect(server.auths).toEqual([]) // no bearer on the auth exchange

    const token = server.issued[0]
    const tokFile = cloudPaths(root).tokenFile
    expect(fs.statSync(tokFile).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(tokFile, 'utf8')).not.toContain(token)
    expect(JSON.stringify(svc.status())).not.toContain(token)

    const sess = await svc.client.session()
    expect(sess).toEqual({ accountId: st.accountId, fingerprint: id.fingerprint, expiresAt: st.expiresAt })
    expect(server.auths).toEqual([`Bearer ${token}`])

    const out = await svc.signOut()
    expect(out).toMatchObject({ signedIn: false, remoteRevoked: true, accountId: null })
    expect(server.log).toContain('POST /v1/auth/logout')
    expect(fs.existsSync(tokFile)).toBe(false)
  })

  it('authMessage matches the contract byte-for-byte', () => {
    expect(authMessage('https://a.example.com', 'c1', 'n1', 'ff').toString('utf8')).toBe('persome-cloud-auth-v1\nhttps://a.example.com\nc1\nn1\nff')
  })

  it('deleteAccount needs a native confirm, calls DELETE /v1/account and forgets the token', async () => {
    const confirm = vi.fn(async () => false)
    const svc = service({ nativeConfirm: confirm })
    await svc.signIn()
    expect((await caught(svc.deleteAccount())).code).toBe('cancelled')
    expect(server.log).not.toContain('DELETE /v1/account')
    expect(svc.status().signedIn).toBe(true)
    confirm.mockResolvedValue(true)
    const st = await svc.deleteAccount({ id: 1 })
    expect(confirm).toHaveBeenLastCalledWith({ id: 1 }, expect.objectContaining({ confirmLabel: 'Delete account' }))
    expect(server.log).toContain('DELETE /v1/account')
    expect(st.signedIn).toBe(false)
  })

  it('no identity key ⇒ no_identity, and nothing is sent', async () => {
    const svc = service({ getPublicIdentity: () => null })
    expect((await caught(svc.signIn())).code).toBe('no_identity')
    expect(server.log).toEqual([])
  })
})

describe('cloud auth: refusals and error mapping', () => {
  it('audience mismatch ⇒ forbidden, signer never called, verify never sent', async () => {
    server.audience = 'https://evil.example.com'
    const sign = vi.fn(id.sign)
    const svc = service({ sign })
    const e = await caught(svc.signIn())
    expect(e.code).toBe('forbidden')
    expect(sign).not.toHaveBeenCalled()
    expect(server.log).toEqual(['POST /v1/auth/challenge'])
    expect(svc.status().signedIn).toBe(false)
  })

  it('a token the server already considers expired is not stored', async () => {
    server.ttlS = -10
    const svc = service()
    expect((await caught(svc.signIn())).code).toBe('bad_response')
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)
  })

  it('401 on an authenticated call ⇒ unauthorized and the stored token is dropped; body text never leaks', async () => {
    const svc = service()
    await svc.signIn()
    const token = server.issued[0]
    server.override = (req, res) => {
      if (req.url !== '/v1/auth/session') return false
      const s = JSON.stringify(errBody('expired', `token ${token} is expired, secret-body-text`))
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(s)
      return true
    }
    const e = await caught(svc.client.session())
    expect(e.code).toBe('unauthorized')
    expect(e.message).not.toContain(token)
    expect(e.message).not.toContain('secret-body-text')
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)
    expect(svc.status().signedIn).toBe(false)
    // Now signed out: the next authenticated call fails locally without a request.
    const before = server.log.length
    expect((await caught(svc.client.session())).code).toBe('unauthorized')
    expect(server.log.length).toBe(before)
  })

  it('429 ⇒ rate_limited with Retry-After seconds', async () => {
    server.override = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '42' })
      res.end(JSON.stringify(errBody('rate_limited', 'slow down')))
      return true
    }
    const e = await caught(service().signIn())
    expect(e.code).toBe('rate_limited')
    expect(e.retryAfterS).toBe(42)
    expect(e.toIpc()).toEqual({ code: 'rate_limited', message: e.message, retryAfterS: 42 })
  })

  it('parseRetryAfter handles seconds, HTTP-date, garbage and clamps', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('7', now)).toBe(7)
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60)
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('99999999', now)).toBe(86_400)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })

  it.each([
    [403, 'forbidden'],
    [413, 'too_large'],
    [404, 'bad_response'],
    [500, 'server'],
    [503, 'server']
  ])('HTTP %i ⇒ %s', async (status, expected) => {
    server.override = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(errBody('x', 'body-text-must-not-leak')))
      return true
    }
    const e = await caught(service().signIn())
    expect(e.code).toBe(expected)
    expect(e.status).toBe(status)
    expect(e.message).not.toContain('body-text-must-not-leak')
  })

  it('timeout ⇒ timeout (no retry)', async () => {
    server.override = () => true // never responds
    const e = await caught(service({ timeoutMs: 150 }).signIn())
    expect(e.code).toBe('timeout')
    expect(server.log).toEqual(['POST /v1/auth/challenge'])
  })

  it('connection refused ⇒ network', async () => {
    await server.close()
    const e = await caught(service().signIn())
    expect(e.code).toBe('network')
    server = await startFakeServer() // for afterEach
  })

  it('oversize response ⇒ too_large (declared content-length and chunked)', async () => {
    const big = JSON.stringify({ challenge_id: 'x', nonce: 'y'.repeat(5000), audience: server.origin, expires_at: '2099-01-01T00:00:00Z' })
    server.override = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) })
      res.end(big)
      return true
    }
    expect((await caught(service({ maxResponseBytes: 1024 }).signIn())).code).toBe('too_large')
    server.override = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }) // chunked, no length
      for (let i = 0; i < 10; i++) res.write(big.slice(i * 600, (i + 1) * 600))
      res.end(big.slice(6000))
      return true
    }
    expect((await caught(service({ maxResponseBytes: 1024 }).signIn())).code).toBe('too_large')
  })

  it.each([
    ['not JSON', 'application/json', 'nope'],
    ['wrong content-type', 'text/html', '{}'],
    ['schema mismatch', 'application/json', JSON.stringify({ challenge_id: 1 })]
  ])('%s ⇒ bad_response', async (_n, ct, body) => {
    server.override = (_req, res) => {
      res.writeHead(200, { 'content-type': ct })
      res.end(body)
      return true
    }
    expect((await caught(service().signIn())).code).toBe('bad_response')
  })

  it('redirects are refused (the bearer never follows to another origin)', async () => {
    const svc = service()
    await svc.signIn()
    server.override = (req, res) => {
      if (req.url !== '/v1/auth/session') return false
      res.writeHead(302, { location: 'https://evil.example.com/steal' })
      res.end()
      return true
    }
    expect((await caught(svc.client.session())).code).toBe('network')
  })

  it('requestJson rejects paths outside /v1 before sending', async () => {
    const svc = service()
    await svc.signIn()
    const before = server.log.length
    for (const p of ['/v2/x', 'v1/x', '/v1/../admin', '//evil.example.com/v1/x', '/v1/x?y=1']) {
      expect((await caught(svc.client.requestJson('GET', p, undefined, z.unknown()))).code).toBe('invalid_args')
    }
    expect(server.log.length).toBe(before)
  })
})

describe('cloud auth: token never escapes via IPC', () => {
  it('status / signIn / signOut results and errors never contain the token', async () => {
    const ipc = fakeIpc()
    registerCloudIpc(ipc, { storeRoot: root, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true, nativeConfirm: async () => true })
    const results: unknown[] = []
    results.push(await ipc.invoke(CLOUD_CHANNELS.signIn))
    const token = server.issued[0]
    expect(token).toBeTruthy()
    results.push(await ipc.invoke(CLOUD_CHANNELS.status))
    server.override = (req, res) => {
      if (req.url !== '/v1/auth/logout') return false
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify(errBody('boom', `failed for ${token}`)))
      return true
    }
    results.push(await ipc.invoke(CLOUD_CHANNELS.signOut))
    results.push(await ipc.invoke(CLOUD_CHANNELS.signIn))
    server.override = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(errBody('x', `bad ${server.issued[1]}`)))
      return true
    }
    results.push(await ipc.invoke(CLOUD_CHANNELS.deleteAccount, { confirm: true }))
    const dump = JSON.stringify(results)
    for (const t of server.issued) expect(dump).not.toContain(t)
    expect(dump).not.toMatch(/tok_/)
    expect(results[0]).toMatchObject({ ok: true, data: { signedIn: true } })
    expect(results[2]).toMatchObject({ ok: true, data: { signedIn: false, remoteRevoked: false } })
    expect(results[4]).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })
})
