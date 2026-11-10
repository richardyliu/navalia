// Gate fixes for S1-FULL C3–C7:
//  1. disabling cloud / switching server revokes the session server-side (best effort, short
//     timeout) before forgetting it locally; `remoteRevoked` reports the outcome;
//  2. the token is bound to the identity fingerprint: identity reset / missing ⇒ signed out + dropped;
//  3. loopback http only with `allowInsecureLoopback` (production: !app.isPackaged); default https only.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { cloudPaths, normalizeBaseUrl, readCloudConfig, writeCloudConfig, CloudConfigError } from '../../src/main/cloud/config'
import { createCloudService } from '../../src/main/cloud/service'
import { createTokenStore } from '../../src/main/cloud/token'
import { fakeBox, LOOPBACK, startFakeServer, tempStore, testIdentity, type FakeServer } from './helpers'

const roots: string[] = []
const servers: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const r of roots.splice(0)) {
    if (!path.basename(r).startsWith('lens-cloud-')) throw new Error(`refusing to delete ${r}`)
    fs.rmSync(r, { recursive: true, force: true })
  }
})

async function signedIn(server: FakeServer, extra: Record<string, unknown> = {}) {
  const root = tempStore(roots)
  writeCloudConfig(cloudPaths(root).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
  const id = testIdentity()
  let identity: { public_key: string } | null = id.getPublicIdentity()
  const box = fakeBox()
  const svc = createCloudService({
    storeRoot: root,
    box,
    sign: id.sign,
    getPublicIdentity: () => identity,
    allowInsecureLoopback: true,
    nativeConfirm: async () => true,
    ...extra
  })
  await svc.signIn()
  return { root, svc, id, box, setIdentity: (v: { public_key: string } | null) => (identity = v) }
}

describe('fix 1: disable / switch revokes server-side', () => {
  it('turning OFF calls /v1/auth/logout with the bearer, server session dies, remoteRevoked true', async () => {
    const server = await startFakeServer()
    servers.push(server)
    const { svc, root } = await signedIn(server)
    const token = server.issued.at(-1)!
    const out = await svc.configure({ enabled: false, baseUrl: server.origin })
    expect(out).toMatchObject({ enabled: false, signedIn: false, remoteRevoked: true })
    expect(server.log).toContain('POST /v1/auth/logout')
    expect(server.auths.at(-1)).toBe(`Bearer ${token}`)
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)
    // Server-side the token no longer works.
    const r = await fetch(`${server.origin}/v1/auth/session`, { headers: { authorization: `Bearer ${token}` } })
    expect(r.status).toBe(401)
  })

  it('server hanging ⇒ short timeout, remoteRevoked false, token still forgotten locally', async () => {
    const server = await startFakeServer()
    servers.push(server)
    const { svc, root } = await signedIn(server, { revokeTimeoutMs: 150 })
    server.override = (req) => req.url === '/v1/auth/logout' // never answers
    const t0 = Date.now()
    const out = await svc.configure({ enabled: false, baseUrl: server.origin })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(out).toMatchObject({ enabled: false, signedIn: false, remoteRevoked: false })
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)
  })

  it('server down ⇒ remoteRevoked false; switching server revokes the old one first', async () => {
    const a = await startFakeServer()
    const b = await startFakeServer()
    servers.push(a, b)
    const { svc, root } = await signedIn(a)
    const out = await svc.configure({ enabled: true, baseUrl: b.origin, confirm: true })
    expect(out).toMatchObject({ baseUrl: b.origin, signedIn: false, remoteRevoked: true })
    expect(a.log).toContain('POST /v1/auth/logout')
    expect(b.log).toEqual([])
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)

    await svc.signIn()
    await b.close()
    servers.splice(servers.indexOf(b), 1)
    const off = await svc.configure({ enabled: false, baseUrl: b.origin })
    expect(off).toMatchObject({ enabled: false, remoteRevoked: false })
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)
  })

  it('no session ⇒ no request', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    const root = tempStore(roots)
    const id = testIdentity()
    const svc = createCloudService({ storeRoot: root, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, nativeConfirm: async () => true, fetch: f })
    await svc.configure({ enabled: true, baseUrl: 'https://a.example.com', confirm: true })
    expect(await svc.configure({ enabled: false, baseUrl: 'https://a.example.com' })).toMatchObject({ remoteRevoked: false })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('fix 2: identity reset invalidates the cloud token', () => {
  it('a different identity ⇒ signed out, token file deleted, authenticated calls fail locally', async () => {
    const server = await startFakeServer()
    servers.push(server)
    const { svc, root, setIdentity } = await signedIn(server)
    expect(svc.status().signedIn).toBe(true)
    setIdentity(testIdentity().getPublicIdentity())
    const before = server.log.length
    expect(svc.status()).toMatchObject({ signedIn: false, accountId: null })
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)
    await expect(svc.client.requestJson('GET', '/v1/usage', undefined, z.unknown())).rejects.toMatchObject({ code: 'unauthorized' })
    expect(server.log.length).toBe(before)
  })

  it('identity removed (null) ⇒ signed out; legacy envelope without fingerprint ⇒ signed out', async () => {
    const server = await startFakeServer()
    servers.push(server)
    const { svc, root, setIdentity, box, id } = await signedIn(server)
    setIdentity(null)
    expect(svc.status().signedIn).toBe(false)
    expect(fs.existsSync(cloudPaths(root).tokenFile)).toBe(false)

    setIdentity(id.getPublicIdentity())
    const file = cloudPaths(root).tokenFile
    createTokenStore(file, box).save('tok_abcdefghijklmnopqrstuvwxyz', { accountId: 'a', expiresAt: '2099-01-01T00:00:00Z', origin: server.origin, fingerprint: id.fingerprint })
    expect(svc.status().signedIn).toBe(true)
    const env = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    delete env.fingerprint
    fs.writeFileSync(file, JSON.stringify(env), { mode: 0o600 })
    expect(svc.status().signedIn).toBe(false)
  })

  it('the stored fingerprint is the signing identity', async () => {
    const server = await startFakeServer()
    servers.push(server)
    const { root, id } = await signedIn(server)
    const env = JSON.parse(fs.readFileSync(cloudPaths(root).tokenFile, 'utf8')) as Record<string, unknown>
    expect(env.fingerprint).toBe(id.fingerprint)
  })
})

describe('fix 3: loopback http only when allowed', () => {
  it('normalizeBaseUrl / writeCloudConfig refuse http loopback by default', () => {
    expect(() => normalizeBaseUrl('http://127.0.0.1:8787')).toThrow(CloudConfigError)
    expect(() => normalizeBaseUrl('http://localhost:3000')).toThrow(CloudConfigError)
    expect(normalizeBaseUrl('http://127.0.0.1:8787', LOOPBACK)).toBe('http://127.0.0.1:8787')
    expect(normalizeBaseUrl('https://a.example.com')).toBe('https://a.example.com')
    const root = tempStore(roots)
    expect(() => writeCloudConfig(cloudPaths(root).configFile, { enabled: true, baseUrl: 'http://127.0.0.1:1' })).toThrow(CloudConfigError)
  })

  it('a stored loopback config reads as OFF in a production (default) service; IPC configure refuses it', async () => {
    const root = tempStore(roots)
    const file = cloudPaths(root).configFile
    writeCloudConfig(file, { enabled: true, baseUrl: 'http://127.0.0.1:9' }, LOOPBACK)
    expect(readCloudConfig(file)).toMatchObject({ enabled: false, baseUrl: null })
    expect(readCloudConfig(file, LOOPBACK)).toMatchObject({ enabled: true })
    const f = vi.fn(async () => new Response('{}'))
    const id = testIdentity()
    const prod = createCloudService({ storeRoot: root, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, nativeConfirm: async () => true, fetch: f })
    expect(prod.status()).toMatchObject({ enabled: false })
    await expect(prod.signIn()).rejects.toMatchObject({ code: 'disabled' })
    await expect(prod.configure({ enabled: true, baseUrl: 'http://localhost:8080', confirm: true })).rejects.toMatchObject({ code: 'invalid_args' })
    expect(f).not.toHaveBeenCalled()
  })

  it('dev (allowInsecureLoopback) works against a loopback server', async () => {
    const srv = http.createServer((_q, s) => {
      s.writeHead(404)
      s.end()
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    servers.push({ close: () => new Promise((r) => srv.close(() => r())) })
    const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    const root = tempStore(roots)
    const id = testIdentity()
    const dev = createCloudService({ storeRoot: root, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, nativeConfirm: async () => true, allowInsecureLoopback: true })
    expect(await dev.configure({ enabled: true, baseUrl: origin, confirm: true })).toMatchObject({ enabled: true, baseUrl: origin })
    await expect(dev.signIn()).rejects.toMatchObject({ code: 'bad_response' }) // reached the server (404)
  })
})
