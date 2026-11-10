// S1-FULL Phase 0 gate: the Lens cloud client against the REAL `cloud/` server (spawned as a
// child process exactly like `npm start`), not the in-test fake. Temp DB, temp Lens Store,
// throwaway Ed25519 identity; no real ~/.persome, no real keys.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cloudPaths } from '../../src/main/cloud/config'
import { CloudError } from '../../src/main/cloud/errors'
import { createCloudService } from '../../src/main/cloud/service'
import { fakeBox, testIdentity } from './helpers'

let child: ChildProcess
let origin: string
let dir: string
let serverOut = ''

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-cloud-e2e-'))
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve('cloud'),
    env: { PATH: process.env.PATH, PORT: String(port), CLOUD_DB_PATH: path.join(dir, 'db', 'cloud.db'), CLOUD_PUBLIC_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b) => (serverOut += String(b)))
  child.stderr?.on('data', (b) => (serverOut += String(b)))
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const r = await fetch(`${origin}/health`)
      if (r.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`cloud server did not start:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}, 20_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 200))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('cloud e2e: Lens client ↔ real cloud server', () => {
  it('opt-in → challenge/verify → logout → re-sign-in → delete account; secrets never in server logs', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-cloud-e2e-store-'))
    try {
      const id = testIdentity()
      const secrets: string[] = []
      // Observe (not alter) traffic so we can assert the server never logs the token / signature.
      const observing = async (input: string, init: RequestInit): Promise<Response> => {
        if (typeof init.body === 'string' && init.body.includes('signature')) secrets.push(JSON.parse(init.body).signature)
        const res = await fetch(input, init)
        if (input.endsWith('/v1/auth/verify') && res.ok) secrets.push((await res.clone().json()).token)
        return res
      }
      let confirms = 0
      const svc = createCloudService({
        storeRoot: store,
        box: fakeBox(),
        sign: id.sign,
        getPublicIdentity: id.getPublicIdentity,
        allowInsecureLoopback: true,
        nativeConfirm: async () => (++confirms, true),
        fetch: observing
      })

      // Default OFF: sign-in refused before any request.
      expect(svc.status()).toMatchObject({ enabled: false, signedIn: false })
      await expect(svc.signIn()).rejects.toMatchObject({ code: 'disabled' })

      await svc.configure({ enabled: true, baseUrl: origin, confirm: true })
      expect(confirms).toBe(1)

      const st = await svc.signIn()
      expect(st).toMatchObject({ enabled: true, baseUrl: origin, signedIn: true, accountId: id.fingerprint })
      expect(fs.statSync(cloudPaths(store).tokenFile).mode & 0o777).toBe(0o600)
      const token = secrets.at(-1) as string
      expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/)

      // The live token works against the real server; logout revokes it server-side.
      const session = await fetch(`${origin}/v1/auth/session`, { headers: { authorization: `Bearer ${token}` } })
      expect(session.status).toBe(200)
      expect(await session.json()).toMatchObject({ account_id: id.fingerprint, fingerprint: id.fingerprint })
      const out = await svc.signOut()
      expect(out).toMatchObject({ signedIn: false, remoteRevoked: true })
      expect((await fetch(`${origin}/v1/auth/session`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)

      // Second sign-in, then right-to-deletion: the account and its sessions are gone.
      await svc.signIn()
      const token2 = secrets.at(-1) as string
      await svc.deleteAccount()
      expect(svc.status().signedIn).toBe(false)
      expect((await fetch(`${origin}/v1/auth/session`, { headers: { authorization: `Bearer ${token2}` } })).status).toBe(401)

      // Disabling makes the client refuse again without touching the network.
      await svc.configure({ enabled: false, baseUrl: origin })
      await expect(svc.signIn()).rejects.toBeInstanceOf(CloudError)

      await new Promise((r) => setTimeout(r, 100))
      expect(secrets.length).toBeGreaterThanOrEqual(4)
      expect(serverOut).toContain('/v1/auth/verify')
      for (const s of secrets) expect(serverOut.includes(s), 'secret leaked into server log').toBe(false)
      expect(serverOut.includes(id.getPublicIdentity()!.public_key)).toBe(false)
    } finally {
      fs.rmSync(store, { recursive: true, force: true })
    }
  })
})
