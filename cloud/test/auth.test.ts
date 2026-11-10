import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUDIENCE, bearer, errorCode, getChallenge, login, newKey, postJson, signChallenge, startHarness } from './helpers.ts'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('happy path: challenge -> verify -> session -> logout -> 401', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const c = await getChallenge(h.base, key)
    assert.match(c.challenge_id, UUID)
    assert.match(c.nonce, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(c.nonce, 'base64url').length, 32)
    assert.equal(c.audience, AUDIENCE)
    assert.match(c.expires_at, ISO)
    assert.equal(Date.parse(c.expires_at) - h.clock.t, 300_000)

    const r = await postJson(h.base, '/v1/auth/verify', {
      challenge_id: c.challenge_id,
      public_key: key.publicKey,
      signature: signChallenge(key, c.audience, c.challenge_id, c.nonce)
    })
    assert.equal(r.status, 200)
    const v = (await r.json()) as { token: string; token_type: string; expires_at: string; account_id: string }
    assert.equal(v.token_type, 'Bearer')
    assert.match(v.token, /^[A-Za-z0-9_-]{43,}$/)
    assert.ok(Buffer.from(v.token, 'base64url').length >= 32)
    assert.equal(v.account_id, key.fingerprint)
    assert.match(v.account_id, /^[0-9a-f]{64}$/)
    assert.equal(Date.parse(v.expires_at) - h.clock.t, 3600_000)

    // token never stored in clear
    const rows = h.app.db.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0].token_hash, v.token)
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/)

    const s = await fetch(h.base + '/v1/auth/session', { headers: bearer(v.token) })
    assert.equal(s.status, 200)
    assert.deepEqual(await s.json(), { account_id: key.fingerprint, fingerprint: key.fingerprint, expires_at: v.expires_at })

    const out = await fetch(h.base + '/v1/auth/logout', { method: 'POST', headers: bearer(v.token) })
    assert.equal(out.status, 204)
    assert.equal(await out.text(), '')

    const after = await fetch(h.base + '/v1/auth/session', { headers: bearer(v.token) })
    assert.equal(after.status, 401)
    assert.equal(await errorCode(after), 'unauthorized')
    const out2 = await fetch(h.base + '/v1/auth/logout', { method: 'POST', headers: bearer(v.token) })
    assert.equal(out2.status, 401)
  } finally {
    await h.close()
  }
})

test('second login with same key reuses the account, new token', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const a = await login(h.base, key)
    const b = await login(h.base, key)
    assert.equal(a.account_id, b.account_id)
    assert.notEqual(a.token, b.token)
    const n = h.app.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
    assert.equal(n.n, 1)
  } finally {
    await h.close()
  }
})

test('401 without token, with garbage token, with malformed header', async () => {
  const h = await startHarness()
  try {
    const cases: Array<Record<string, string>> = [
      {},
      bearer('A'.repeat(43)),
      bearer('garbage'),
      { authorization: 'Basic dXNlcjpwYXNz' },
      { authorization: 'Bearer ' }
    ]
    for (const headers of cases) {
      const r = await fetch(h.base + '/v1/auth/session', { headers })
      assert.equal(r.status, 401, JSON.stringify(headers))
      assert.equal(await errorCode(r), 'unauthorized')
      assert.equal(r.headers.get('www-authenticate'), 'Bearer')
    }
    const d = await fetch(h.base + '/v1/account', { method: 'DELETE' })
    assert.equal(d.status, 401)
  } finally {
    await h.close()
  }
})

test('expired token -> 401', async () => {
  const h = await startHarness()
  try {
    const v = await login(h.base, newKey())
    h.clock.t += 3600_000
    const r = await fetch(h.base + '/v1/auth/session', { headers: bearer(v.token) })
    assert.equal(r.status, 401)
  } finally {
    await h.close()
  }
})

test('challenge: 400 on bad public key', async () => {
  const h = await startHarness()
  try {
    const bad = [undefined, 42, '', 'abc', 'A'.repeat(42), 'A'.repeat(44), '+'.repeat(43), Buffer.alloc(32).toString('base64')]
    for (const public_key of bad) {
      const r = await postJson(h.base, '/v1/auth/challenge', { public_key })
      assert.equal(r.status, 400, String(public_key))
      assert.equal(await errorCode(r), 'invalid_public_key')
    }
    // non-canonical base64url (last char carries non-zero padding bits)
    const r = await postJson(h.base, '/v1/auth/challenge', { public_key: 'A'.repeat(42) + 'B' })
    assert.equal(r.status, 400)
  } finally {
    await h.close()
  }
})

test('403 on wrong signature; challenge is then consumed (replay -> 401)', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const other = newKey()
    const c = await getChallenge(h.base, key)
    const wrong = signChallenge(other, c.audience, c.challenge_id, c.nonce, key.fingerprint)
    const r = await postJson(h.base, '/v1/auth/verify', { challenge_id: c.challenge_id, public_key: key.publicKey, signature: wrong })
    assert.equal(r.status, 403)
    assert.equal(await errorCode(r), 'signature_invalid')
    const good = signChallenge(key, c.audience, c.challenge_id, c.nonce)
    const r2 = await postJson(h.base, '/v1/auth/verify', { challenge_id: c.challenge_id, public_key: key.publicKey, signature: good })
    assert.equal(r2.status, 401)
    assert.equal(await errorCode(r2), 'challenge_invalid')
  } finally {
    await h.close()
  }
})

test('malformed signature -> 403 signature_invalid', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    for (const signature of [undefined, 'short', 'A'.repeat(86) + 'A', 7]) {
      const c = await getChallenge(h.base, key)
      const r = await postJson(h.base, '/v1/auth/verify', { challenge_id: c.challenge_id, public_key: key.publicKey, signature })
      assert.equal(r.status, 403, String(signature))
      assert.equal(await errorCode(r), 'signature_invalid')
    }
  } finally {
    await h.close()
  }
})

test('replay of a successfully used challenge -> 401', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const c = await getChallenge(h.base, key)
    const body = { challenge_id: c.challenge_id, public_key: key.publicKey, signature: signChallenge(key, c.audience, c.challenge_id, c.nonce) }
    assert.equal((await postJson(h.base, '/v1/auth/verify', body)).status, 200)
    const r = await postJson(h.base, '/v1/auth/verify', body)
    assert.equal(r.status, 401)
    assert.equal(await errorCode(r), 'challenge_invalid')
  } finally {
    await h.close()
  }
})

test('expired challenge -> 401 (injected clock)', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const c = await getChallenge(h.base, key)
    h.clock.t += 300_000
    const r = await postJson(h.base, '/v1/auth/verify', {
      challenge_id: c.challenge_id,
      public_key: key.publicKey,
      signature: signChallenge(key, c.audience, c.challenge_id, c.nonce)
    })
    assert.equal(r.status, 401)
    assert.equal(await errorCode(r), 'challenge_invalid')
  } finally {
    await h.close()
  }
})

test('just-before-expiry challenge still works', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const c = await getChallenge(h.base, key)
    h.clock.t += 299_999
    const r = await postJson(h.base, '/v1/auth/verify', {
      challenge_id: c.challenge_id,
      public_key: key.publicKey,
      signature: signChallenge(key, c.audience, c.challenge_id, c.nonce)
    })
    assert.equal(r.status, 200)
  } finally {
    await h.close()
  }
})

test('unknown challenge id -> 401', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    for (const challenge_id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', undefined]) {
      const r = await postJson(h.base, '/v1/auth/verify', { challenge_id, public_key: key.publicKey, signature: 'A'.repeat(86) })
      assert.equal(r.status, 401)
      assert.equal(await errorCode(r), 'challenge_invalid')
    }
  } finally {
    await h.close()
  }
})

test('signature for a different audience -> 403', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const c = await getChallenge(h.base, key)
    const sig = signChallenge(key, 'https://evil.example', c.challenge_id, c.nonce)
    const r = await postJson(h.base, '/v1/auth/verify', { challenge_id: c.challenge_id, public_key: key.publicKey, signature: sig })
    assert.equal(r.status, 403)
    assert.equal(await errorCode(r), 'signature_invalid')
  } finally {
    await h.close()
  }
})

test('signature over a different nonce / wrong fingerprint -> 403', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    const c1 = await getChallenge(h.base, key)
    const sig1 = signChallenge(key, c1.audience, c1.challenge_id, 'A'.repeat(43))
    assert.equal((await postJson(h.base, '/v1/auth/verify', { challenge_id: c1.challenge_id, public_key: key.publicKey, signature: sig1 })).status, 403)
    const c2 = await getChallenge(h.base, key)
    const sig2 = signChallenge(key, c2.audience, c2.challenge_id, c2.nonce, '0'.repeat(64))
    assert.equal((await postJson(h.base, '/v1/auth/verify', { challenge_id: c2.challenge_id, public_key: key.publicKey, signature: sig2 })).status, 403)
  } finally {
    await h.close()
  }
})

test('key substitution: challenge for A, verify as B (validly signed by B) -> 401', async () => {
  const h = await startHarness()
  try {
    const a = newKey()
    const b = newKey()
    const c = await getChallenge(h.base, a)
    const sig = signChallenge(b, c.audience, c.challenge_id, c.nonce)
    const r = await postJson(h.base, '/v1/auth/verify', { challenge_id: c.challenge_id, public_key: b.publicKey, signature: sig })
    assert.equal(r.status, 401)
    assert.equal(await errorCode(r), 'challenge_invalid')
    // and A can no longer use it either (consumed)
    const r2 = await postJson(h.base, '/v1/auth/verify', {
      challenge_id: c.challenge_id,
      public_key: a.publicKey,
      signature: signChallenge(a, c.audience, c.challenge_id, c.nonce)
    })
    assert.equal(r2.status, 401)
    const n = h.app.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
    assert.equal(n.n, 0)
  } finally {
    await h.close()
  }
})

test('challenge: 400 on small-order / non-canonical keys (forgeable: R=identity, S=0)', async () => {
  const h = await startHarness()
  try {
    const weak = [
      '0100000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000080',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000080',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p (non-canonical)
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
    ]
    for (const hex of weak) {
      const r = await postJson(h.base, '/v1/auth/challenge', { public_key: Buffer.from(hex, 'hex').toString('base64url') })
      assert.equal(r.status, 400, hex)
      assert.equal(await errorCode(r), 'invalid_public_key')
    }
    // Sanity: an ordinary key still gets a challenge.
    const ok = await postJson(h.base, '/v1/auth/challenge', { public_key: newKey().publicKey })
    assert.equal(ok.status, 200)
  } finally {
    await h.close()
  }
})
