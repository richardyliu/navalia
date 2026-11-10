import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createGrantStore, GrantError, hashToken, type GrantStore } from '../../src/main/identity/grants'
import { ensureStore, storePaths } from '../../src/main/store/paths'
import { mode, tempRoot } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function setup(start = Date.parse('2026-11-04T12:00:00.000Z')) {
  const root = tempRoot('grants')
  roots.push(root)
  const paths = ensureStore(storePaths(root))
  let t = start
  const store = createGrantStore(paths, () => new Date(t))
  return { root, paths, store, advance: (ms: number) => void (t += ms) }
}

function allFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name))
}

function expectGrantError(fn: () => unknown, code: string, status: number) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(GrantError)
    expect((e as GrantError).code).toBe(code)
    expect((e as GrantError).httpStatus).toBe(status)
    return
  }
  throw new Error(`expected GrantError ${code}`)
}

describe('grant store', () => {
  test('default is per-agent full access (original); token shown once, stored as SHA-256 only', () => {
    const { root, paths, store } = setup()
    const { grant, token } = store.create({ client: 'claude-code' })
    expect(grant.access).toEqual({ mode: 'full' })
    expect(grant.state).toBe('active')
    expect(token).toMatch(/^plg_[A-Za-z0-9_-]{43}$/)
    expect(mode(paths.grantsFile)).toBe('600')

    // grep the whole store for the plaintext token (and its secret part): 0 hits
    const secret = token.slice(4)
    let hits = 0
    for (const f of allFilesUnder(root)) {
      const buf = fs.readFileSync(f)
      if (buf.includes(token) || buf.includes(secret)) hits++
    }
    expect(hits).toBe(0)
    expect(fs.readFileSync(paths.grantsFile, 'utf8')).toContain(hashToken(token).toString('hex'))

    // views never carry the token or hash
    const listed = JSON.stringify(store.list())
    expect(listed).not.toContain(secret)
    expect(listed).not.toContain(hashToken(token).toString('hex'))
    expect(listed).not.toMatch(/token/i)
  })

  test('authorize: valid, malformed, unknown', () => {
    const { store } = setup()
    const { grant, token } = store.create({ client: 'codex' })
    expect(store.authorize(token).id).toBe(grant.id)
    expectGrantError(() => store.authorize('nope'), 'invalid_token', 401)
    expectGrantError(() => store.authorize(`plg_${'A'.repeat(43)}`), 'invalid_token', 401)
    expectGrantError(() => store.authorize(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), 'invalid_token', 401)
  })

  test('TTL: active before expiry, 403 expired at/after it', () => {
    const { store, advance } = setup()
    const { token } = store.create({ client: 'codex', ttlSeconds: 60 })
    advance(59_999)
    expect(store.authorize(token).state).toBe('active')
    advance(1)
    expectGrantError(() => store.authorize(token), 'expired', 403)
    expect(store.list()[0].state).toBe('expired')
  })

  test('max reads: exactly N consuming reads succeed, then 403 exhausted; non-consuming checks do not count', () => {
    const { store } = setup()
    const { token } = store.create({ client: 'codex', maxReads: 3 })
    store.authorize(token) // probe, not a read
    for (let i = 1; i <= 3; i++) expect(store.authorize(token, { consume: true }).reads).toBe(i)
    expectGrantError(() => store.authorize(token, { consume: true }), 'exhausted', 403)
    expectGrantError(() => store.authorize(token), 'exhausted', 403)
    expect(store.list()[0]).toMatchObject({ reads: 3, state: 'exhausted' })
  })

  test('reads persist across store instances (counter is on disk)', () => {
    const { paths, store } = setup()
    const { token } = store.create({ client: 'codex', maxReads: 2 })
    store.authorize(token, { consume: true })
    const again = createGrantStore(paths)
    again.authorize(token, { consume: true })
    expectGrantError(() => again.authorize(token, { consume: true }), 'exhausted', 403)
  })

  test('revoke takes effect immediately, including for another store instance (no cache)', () => {
    const { paths, store } = setup()
    const { grant, token } = store.create({ client: 'claude-code' })
    const broker: GrantStore = createGrantStore(paths)
    expect(broker.authorize(token).state).toBe('active')
    store.revoke(grant.id)
    expectGrantError(() => broker.authorize(token), 'revoked', 403)
    expect(store.get(grant.id).state).toBe('revoked')
    expectGrantError(() => store.revoke('grt_0000000000000000'), 'not_found', 404)
  })

  test('connecting the same agent again replaces (revokes) its previous grant; other agents untouched', () => {
    const { store } = setup()
    const a1 = store.create({ client: 'claude-code' })
    const b = store.create({ client: 'codex' })
    const a2 = store.create({ client: 'claude-code' })
    expectGrantError(() => store.authorize(a1.token), 'revoked', 403)
    expect(store.authorize(a2.token).state).toBe('active')
    expect(store.authorize(b.token).state).toBe('active')
    expect(store.revokeClient('claude-code')).toBe(1)
    expectGrantError(() => store.authorize(a2.token), 'revoked', 403)
  })

  test('scopes are a labelled Lens extension: full access satisfies any scope, scoped grants are filtered', () => {
    const { store } = setup()
    const full = store.create({ client: 'claude-code' })
    expect(store.authorize(full.token, { scope: 'evidence:read' }).access.mode).toBe('full')
    const scoped = store.create({ client: 'codex', scopes: ['card:read', 'identity:read', 'card:read'] })
    expect(scoped.grant.access).toEqual({ mode: 'scoped', extension: true, scopes: ['card:read', 'identity:read'] })
    expect(store.authorize(scoped.token, { scope: 'card:read' }).state).toBe('active')
    expectGrantError(() => store.authorize(scoped.token, { scope: 'evidence:read' }), 'scope_denied', 403)
  })

  test('input validation', () => {
    const { store } = setup()
    expect(() => store.create({ client: 'Bad Client!' })).toThrow()
    expect(() => store.create({ client: 'x', scopes: [] })).toThrow()
    expect(() => store.create({ client: 'x', scopes: ['root:all' as never] })).toThrow()
    expect(() => store.create({ client: 'x', ttlSeconds: 0 })).toThrow()
    expect(() => store.create({ client: 'x', extra: 1 } as never)).toThrow()
  })

  test('a corrupted grants.json fails closed (throws), never authorizes', () => {
    const { paths, store } = setup()
    const { token } = store.create({ client: 'codex' })
    fs.writeFileSync(paths.grantsFile, '{"version":1,"grants":[{"id":"x"}]}')
    expect(() => store.authorize(token)).toThrow()
  })
})
