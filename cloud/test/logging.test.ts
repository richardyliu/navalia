import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearer, getChallenge, login, newKey, postJson, signChallenge, startHarness } from './helpers.ts'

test('request log carries only {req_id, method, route, status, ms} and no secrets', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const c = await getChallenge(h.base, key)
    const sig = signChallenge(key, c.audience, c.challenge_id, c.nonce)
    const v = (await (await postJson(h.base, '/v1/auth/verify', { challenge_id: c.challenge_id, public_key: key.publicKey, signature: sig })).json()) as { token: string }
    await fetch(h.base + '/v1/auth/session?leak=QUERYSECRET', { headers: bearer(v.token) })
    await fetch(h.base + '/v1/auth/session', { headers: bearer('GARBAGETOKEN_' + 'x'.repeat(40)) })
    const bodySecret = 'BODYSECRET-' + 'q'.repeat(20)
    await postJson(h.base, '/v1/auth/challenge', { public_key: bodySecret })
    await fetch(h.base + '/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'PLAINSECRET' })
    await fetch(h.base + '/no/such/PATHSECRET')
    const second = await login(h.base, key)
    await fetch(h.base + '/v1/auth/logout', { method: 'POST', headers: bearer(second.token) })
    await fetch(h.base + '/v1/account', { method: 'DELETE', headers: bearer(v.token) })

    assert.ok(h.logs.length >= 10, `got ${h.logs.length} lines`)
    const forbidden = [v.token, second.token, sig, c.nonce, c.challenge_id, key.publicKey, key.fingerprint, bodySecret, 'BODYSECRET', 'PLAINSECRET', 'QUERYSECRET', 'PATHSECRET', 'GARBAGETOKEN', 'Bearer', 'authorization']
    for (const line of h.logs) {
      const obj = JSON.parse(line) as Record<string, unknown>
      assert.deepEqual(Object.keys(obj).sort(), ['method', 'ms', 'req_id', 'route', 'status'])
      assert.equal(typeof obj.status, 'number')
      assert.equal(typeof obj.ms, 'number')
      for (const f of forbidden) assert.ok(!line.includes(f), `log line leaked ${f.slice(0, 12)}…: ${line}`)
    }
    const routes = new Set(h.logs.map((l) => (JSON.parse(l) as { route: string }).route))
    for (const r of ['/v1/auth/challenge', '/v1/auth/verify', '/v1/auth/session', '/v1/auth/logout', '/v1/account', 'unmatched']) assert.ok(routes.has(r), r)
  } finally {
    await h.close()
  }
})

test('500s are generic and do not leak internals', async () => {
  const h = await startHarness()
  try {
    const v = await login(h.base, newKey())
    h.app.db.exec('DROP TABLE sessions') // force an internal DB error
    const r = await fetch(h.base + '/v1/auth/session', { headers: bearer(v.token) })
    assert.equal(r.status, 500)
    const j = (await r.json()) as { error: { code: string; message: string } }
    assert.deepEqual(j, { error: { code: 'internal_error', message: 'Internal error' } })
    const last = JSON.parse(h.logs[h.logs.length - 1]) as Record<string, unknown>
    assert.equal(last.status, 500)
    assert.ok(!h.logs.join('\n').includes('sessions'))
  } finally {
    await h.close()
  }
})
