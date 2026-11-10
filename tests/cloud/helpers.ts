// Test helpers for the cloud client: temp Lens Store, an AES-GCM fake SecretBox, a real Ed25519
// identity, and a tiny node:http server implementing the fixed auth contract with real signature
// verification. Nothing here touches ~/.persome or the real Lens Store.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { SecretBox } from '../../src/main/identity/secret-box'
import { fingerprintOf, publicKeyFromRaw, rawPublicKey } from '../../src/main/identity/keys'
import { authMessage } from '../../src/main/cloud/client'

/** Tests run against node:http on 127.0.0.1: loopback http must be allowed explicitly (fix 3). */
export const LOOPBACK = { allowInsecureLoopback: true } as const

export function tempStore(roots: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-cloud-'))
  roots.push(dir)
  return path.join(dir, 'store')
}

export function fakeBox(available = true): SecretBox {
  const key = randomBytes(32)
  return {
    id: 'test-aes-gcm',
    isAvailable: () => available,
    encrypt(plain) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([c.update(plain), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), body])
    },
    decrypt(blob) {
      const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
      d.setAuthTag(blob.subarray(12, 28))
      return Buffer.concat([d.update(blob.subarray(28)), d.final()])
    }
  }
}

export interface TestIdentity {
  publicKey: string
  fingerprint: string
  sign: (msg: Buffer) => Buffer
  getPublicIdentity: () => { public_key: string }
}

export function testIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = rawPublicKey(publicKey)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintOf(raw),
    sign: (msg) => cryptoSign(null, msg, privateKey),
    getPublicIdentity: () => ({ public_key: raw.toString('base64url') })
  }
}

export interface FakeServer {
  origin: string
  /** Requests seen, as `METHOD /path`. */
  log: string[]
  /** Authorization headers seen. */
  auths: string[]
  /** Tokens issued (to assert they never leak). */
  issued: string[]
  /** Per-route override: return true when handled. */
  override: ((req: http.IncomingMessage, res: http.ServerResponse, body: string) => boolean) | null
  /** Audience the server puts in challenges (default: its own origin). */
  audience: string | null
  /** Token lifetime in seconds (negative ⇒ already expired). */
  ttlS: number
  close(): Promise<void>
}

const sendJson = (res: http.ServerResponse, status: number, obj: unknown): void => {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
export const errBody = (code: string, message: string) => ({ error: { code, message } })

export async function startFakeServer(): Promise<FakeServer> {
  const challenges = new Map<string, { nonce: string; publicKey: string }>()
  const sessions = new Map<string, { account: string; fingerprint: string; exp: string }>()
  const sockets = new Set<import('node:net').Socket>()
  const state: FakeServer = {
    origin: '',
    log: [],
    auths: [],
    issued: [],
    override: null,
    audience: null,
    ttlS: 3600,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      })
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      state.log.push(`${req.method} ${req.url}`)
      if (req.headers.authorization) state.auths.push(req.headers.authorization)
      if (state.override?.(req, res, body)) return
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null
      const sess = bearer ? sessions.get(bearer) : undefined
      if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
        const { public_key } = JSON.parse(body) as { public_key: string }
        const id = randomBytes(8).toString('hex')
        const nonce = randomBytes(16).toString('base64url')
        challenges.set(id, { nonce, publicKey: public_key })
        return sendJson(res, 200, {
          challenge_id: id,
          nonce,
          audience: state.audience ?? state.origin,
          expires_at: new Date(Date.now() + 60_000).toISOString()
        })
      }
      if (req.method === 'POST' && req.url === '/v1/auth/verify') {
        const { challenge_id, public_key, signature } = JSON.parse(body) as Record<string, string>
        const ch = challenges.get(challenge_id)
        challenges.delete(challenge_id)
        if (!ch || ch.publicKey !== public_key) return sendJson(res, 401, errBody('bad_challenge', 'no'))
        const raw = Buffer.from(public_key, 'base64url')
        const fp = fingerprintOf(raw)
        const msg = authMessage(state.audience ?? state.origin, challenge_id, ch.nonce, fp)
        const ok = cryptoVerify(null, msg, publicKeyFromRaw(raw), Buffer.from(signature, 'base64url'))
        if (!ok) return sendJson(res, 401, errBody('bad_signature', 'signature did not verify'))
        const token = `tok_${randomBytes(24).toString('base64url')}`
        const exp = new Date(Date.now() + state.ttlS * 1000).toISOString()
        sessions.set(token, { account: `acct_${fp.slice(0, 12)}`, fingerprint: fp, exp })
        state.issued.push(token)
        return sendJson(res, 200, { token, token_type: 'Bearer', expires_at: exp, account_id: `acct_${fp.slice(0, 12)}` })
      }
      if (!sess) return sendJson(res, 401, errBody('unauthorized', `token ${bearer ?? ''} rejected`))
      if (req.method === 'GET' && req.url === '/v1/auth/session') {
        return sendJson(res, 200, { account_id: sess.account, fingerprint: sess.fingerprint, expires_at: sess.exp })
      }
      if (req.method === 'POST' && req.url === '/v1/auth/logout') {
        sessions.delete(bearer!)
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'DELETE' && req.url === '/v1/account') {
        for (const [t, s] of sessions) if (s.account === sess.account) sessions.delete(t)
        res.writeHead(204)
        return res.end()
      }
      sendJson(res, 404, errBody('not_found', 'no route'))
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return state
}

/** Minimal ipcMain double: records handlers; `invoke` calls one with a fake event. */
export function fakeIpc() {
  const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
  return {
    handle(channel: string, fn: (e: unknown, raw: unknown) => unknown) {
      handlers.set(channel, fn)
    },
    invoke(channel: string, raw?: unknown): Promise<unknown> {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`no handler for ${channel}`)
      return Promise.resolve(fn({ sender: { id: 1 } }, raw))
    },
    channels: () => [...handlers.keys()]
  }
}
