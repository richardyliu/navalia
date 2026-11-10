import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { LLM_DISABLED, MAIL_DISABLED, STT_DISABLED, type CloudConfig } from '../src/config.ts'
import { createServer, type CloudServer, type ServerDeps } from '../src/server.ts'
import { authMessage, fingerprintOf } from '../src/auth.ts'

export const AUDIENCE = 'https://cloud.test.invalid'

export interface Harness {
  app: CloudServer
  base: string
  logs: string[]
  clock: { t: number }
  dir: string
  dbPath: string
  close(): Promise<void>
}

export function testConfig(dbPath: string, over: Partial<CloudConfig> = {}): CloudConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath,
    publicOrigin: AUDIENCE,
    tokenTtlS: 3600,
    challengeTtlS: 300,
    bodyLimitBytes: 64 * 1024,
    rateWindowS: 60,
    rateIpMax: 10_000,
    rateAccountMax: 10_000,
    trustProxy: false,
    llm: LLM_DISABLED,
    chatDailyTokens: 200_000,
    mail: MAIL_DISABLED,
    emailPepper: 'test-pepper-'.padEnd(40, 'p'),
    cardFetchMax: 10_000,
    subscribeIpPerHour: 10_000,
    subscribePublisherPerHour: 10_000,
    stt: STT_DISABLED,
    sttDailySeconds: 7200,
    // A sibling of the DB file inside the test's own temp dir (never a parent directory).
    audioDir: dbPath + '.audio',
    meetingChunkRateMax: 10_000,
    ...over
  }
}

export const TMP_PREFIX = 'persome-cloud-test-'

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), TMP_PREFIX))
}

/** Deletes ONLY a directory this test run created with makeTempDir(). Never a parent. */
export function removeTempDir(d: string): void {
  if (!basename(d).startsWith(TMP_PREFIX)) throw new Error(`refusing to delete ${d}: not a ${TMP_PREFIX}* temp dir`)
  rmSync(d, { recursive: true, force: true })
}

export async function startHarness(over: Partial<CloudConfig> = {}, extra: Partial<ServerDeps> = {}): Promise<Harness> {
  const dir = makeTempDir()
  const dbPath = join(dir, 'cloud.db')
  const logs: string[] = []
  // Fixed start well inside a rate window so tests are deterministic.
  const clock = { t: Date.UTC(2026, 0, 1, 0, 0, 1) }
  const app = createServer(testConfig(dbPath, over), { now: () => clock.t, log: (l) => logs.push(l), startOutbox: false, startStt: false, ...extra })
  const port = await app.listen(0, '127.0.0.1')
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    logs,
    clock,
    dir,
    dbPath,
    async close() {
      await app.close()
      removeTempDir(dir)
    }
  }
}

export interface TestKey {
  publicKey: string
  privateKey: KeyObject
  fingerprint: string
}

export function newKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const x = publicKey.export({ format: 'jwk' }).x as string
  return { publicKey: x, privateKey, fingerprint: fingerprintOf(Buffer.from(x, 'base64url')) }
}

export function signChallenge(key: TestKey, audience: string, challengeId: string, nonce: string, fingerprint = key.fingerprint): string {
  return sign(null, authMessage(audience, challengeId, nonce, fingerprint), key.privateKey).toString('base64url')
}

export async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

export interface Challenge {
  challenge_id: string
  nonce: string
  audience: string
  expires_at: string
}

export async function getChallenge(base: string, key: TestKey): Promise<Challenge> {
  const r = await postJson(base, '/v1/auth/challenge', { public_key: key.publicKey })
  if (r.status !== 200) throw new Error(`challenge failed: ${r.status}`)
  return (await r.json()) as Challenge
}

export interface Login {
  token: string
  token_type: string
  expires_at: string
  account_id: string
}

export async function login(base: string, key: TestKey): Promise<Login> {
  const c = await getChallenge(base, key)
  const r = await postJson(base, '/v1/auth/verify', {
    challenge_id: c.challenge_id,
    public_key: key.publicKey,
    signature: signChallenge(key, c.audience, c.challenge_id, c.nonce)
  })
  if (r.status !== 200) throw new Error(`verify failed: ${r.status}`)
  return (await r.json()) as Login
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export async function errorCode(r: Response): Promise<string> {
  const j = (await r.json()) as { error?: { code?: string; message?: string } }
  if (!j.error || typeof j.error.message !== 'string') throw new Error('error envelope missing')
  return j.error.code ?? ''
}
