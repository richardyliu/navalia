import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearer, getChallenge, login, newKey, startHarness } from './helpers.ts'

const count = (h: { app: { db: { prepare(s: string): { get(...a: unknown[]): unknown } } } }, sql: string, ...args: unknown[]): number =>
  (h.app.db.prepare(sql).get(...args) as { n: number }).n

test('DELETE /v1/account removes account, all its sessions and challenges; others untouched', async () => {
  const h = await startHarness()
  try {
    const me = newKey()
    const other = newKey()
    const t1 = await login(h.base, me)
    const t2 = await login(h.base, me)
    await getChallenge(h.base, me) // outstanding challenge for my key
    const o = await login(h.base, other)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', me.fingerprint), 2)

    const r = await fetch(h.base + '/v1/account', { method: 'DELETE', headers: bearer(t1.token) })
    assert.equal(r.status, 204)

    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM accounts WHERE id = ?', me.fingerprint), 0)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', me.fingerprint), 0)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM auth_challenges WHERE public_key = ?', me.publicKey), 0)
    for (const t of [t1, t2]) assert.equal((await fetch(h.base + '/v1/auth/session', { headers: bearer(t.token) })).status, 401)

    // other account intact
    assert.equal((await fetch(h.base + '/v1/auth/session', { headers: bearer(o.token) })).status, 200)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM accounts'), 1)

    // signing in again creates a fresh account
    const again = await login(h.base, me)
    assert.equal(again.account_id, me.fingerprint)
  } finally {
    await h.close()
  }
})

test('FK cascade is enforced at the schema level', async () => {
  const h = await startHarness()
  try {
    const me = newKey()
    await login(h.base, me)
    h.app.db.prepare('DELETE FROM accounts WHERE id = ?').run(me.fingerprint)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM sessions'), 0)
    assert.throws(() =>
      h.app.db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, 0, 1)').run('x', 'no-such-account')
    )
    const fks = h.app.db.prepare("SELECT \"table\" AS t, on_delete FROM pragma_foreign_key_list('sessions')").all() as Array<{ t: string; on_delete: string }>
    assert.deepEqual(fks.map((f) => ({ ...f })), [{ t: 'accounts', on_delete: 'CASCADE' }])
  } finally {
    await h.close()
  }
})
