import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { bearer, errorCode, login, newKey, postJson, startHarness } from './helpers.ts'
import { FixedWindowLimiter } from '../src/ratelimit.ts'

/** Raw request so we control framing (fetch can't send a lying or chunked body easily). */
function raw(base: string, opts: { method: string; path: string; headers: Record<string, string>; body?: Buffer; chunked?: boolean }): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    if (opts.body) req.end(opts.body)
    else req.end()
  })
}

test('413 when body exceeds 64 KiB (declared length)', async () => {
  const h = await startHarness()
  try {
    const big = JSON.stringify({ public_key: 'x'.repeat(70 * 1024) })
    const r = await postJson(h.base, '/v1/auth/challenge', JSON.parse(big))
    assert.equal(r.status, 413)
    assert.equal(await errorCode(r), 'payload_too_large')
    // server still healthy
    assert.equal((await fetch(h.base + '/health')).status, 200)
  } finally {
    await h.close()
  }
})

test('413 when chunked body exceeds the cap (no content-length)', async () => {
  const h = await startHarness()
  try {
    const body = Buffer.from(JSON.stringify({ pad: 'y'.repeat(65 * 1024) }))
    const r = await raw(h.base, {
      method: 'POST',
      path: '/v1/auth/challenge',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body
    })
    assert.equal(r.status, 413)
    assert.equal(JSON.parse(r.body).error.code, 'payload_too_large')
  } finally {
    await h.close()
  }
})

test('body exactly at the cap is accepted (then validated)', async () => {
  const h = await startHarness({ bodyLimitBytes: 2048 })
  try {
    const prefix = '{"public_key":"'
    const suffix = '"}'
    const body = prefix + 'z'.repeat(2048 - prefix.length - suffix.length) + suffix
    assert.equal(Buffer.byteLength(body), 2048)
    const r = await fetch(h.base + '/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    assert.equal(r.status, 400)
  } finally {
    await h.close()
  }
})

test('415 when content-type is not JSON', async () => {
  const h = await startHarness()
  try {
    const key = newKey()
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=latin1', 'application/jsonp']) {
      const r = await fetch(h.base + '/v1/auth/challenge', { method: 'POST', headers: { 'content-type': ct }, body: JSON.stringify({ public_key: key.publicKey }) })
      assert.equal(r.status, 415, ct)
      assert.equal(await errorCode(r), 'unsupported_media_type')
    }
    // missing content-type on a body-required route
    const r = await raw(h.base, { method: 'POST', path: '/v1/auth/challenge', headers: { 'content-length': '2' }, body: Buffer.from('{}') })
    assert.equal(r.status, 415)
    // accepted variants
    const ok = await fetch(h.base + '/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'Application/JSON; charset=UTF-8' }, body: JSON.stringify({ public_key: key.publicKey }) })
    assert.equal(ok.status, 200)
  } finally {
    await h.close()
  }
})

test('400 invalid_json / invalid_request on malformed bodies', async () => {
  const h = await startHarness()
  try {
    const send = (body: string) => fetch(h.base + '/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    let r = await send('{not json')
    assert.equal(r.status, 400)
    assert.equal(await errorCode(r), 'invalid_json')
    r = await send('[1,2]')
    assert.equal(r.status, 400)
    assert.equal(await errorCode(r), 'invalid_request')
    r = await send('')
    assert.equal(r.status, 400)
  } finally {
    await h.close()
  }
})

test('logout with a non-JSON body -> 415; empty body fine', async () => {
  const h = await startHarness()
  try {
    const v = await login(h.base, newKey())
    const r = await fetch(h.base + '/v1/auth/logout', { method: 'POST', headers: { ...bearer(v.token), 'content-type': 'text/plain' }, body: 'hi' })
    assert.equal(r.status, 415)
    const ok = await fetch(h.base + '/v1/auth/logout', { method: 'POST', headers: bearer(v.token) })
    assert.equal(ok.status, 204)
  } finally {
    await h.close()
  }
})

test('429 + Retry-After after per-IP limit; resets next window', async () => {
  const h = await startHarness({ rateIpMax: 3, rateWindowS: 60 })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(h.base + '/health')).status, 200)
    const r = await fetch(h.base + '/health')
    assert.equal(r.status, 429)
    assert.equal(await errorCode(r), 'rate_limited')
    const ra = Number(r.headers.get('retry-after'))
    assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, `retry-after ${ra}`)
    // 404s count too (no free probing)
    assert.equal((await fetch(h.base + '/nope')).status, 429)
    h.clock.t += 60_000
    assert.equal((await fetch(h.base + '/health')).status, 200)
  } finally {
    await h.close()
  }
})

test('429 after per-account limit (independent of IP limit)', async () => {
  const h = await startHarness({ rateAccountMax: 4, rateIpMax: 1000 })
  try {
    const key = newKey()
    const v = await login(h.base, key) // challenge + verify = 2 account hits
    assert.equal((await fetch(h.base + '/v1/auth/session', { headers: bearer(v.token) })).status, 200) // 3
    assert.equal((await fetch(h.base + '/v1/auth/session', { headers: bearer(v.token) })).status, 200) // 4
    const r = await fetch(h.base + '/v1/auth/session', { headers: bearer(v.token) })
    assert.equal(r.status, 429)
    assert.ok(Number(r.headers.get('retry-after')) >= 1)
    // a different account on the same IP is unaffected
    const other = await login(h.base, newKey())
    assert.equal((await fetch(h.base + '/v1/auth/session', { headers: bearer(other.token) })).status, 200)
  } finally {
    await h.close()
  }
})

test('trustProxy uses right-most X-Forwarded-For entry', async () => {
  const h = await startHarness({ rateIpMax: 1, trustProxy: true })
  try {
    const a = await fetch(h.base + '/health', { headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' } })
    assert.equal(a.status, 200)
    // spoofed left-most entry does not give a fresh bucket
    const b = await fetch(h.base + '/health', { headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' } })
    assert.equal(b.status, 429)
    const c = await fetch(h.base + '/health', { headers: { 'x-forwarded-for': '2.2.2.2' } })
    assert.equal(c.status, 200)
  } finally {
    await h.close()
  }
})

test('FixedWindowLimiter bounds memory', () => {
  const l = new FixedWindowLimiter(60, 1, 10)
  for (let i = 0; i < 25; i++) l.hit('k' + i, 1000)
  assert.ok(l.size <= 10)
  assert.equal(l.hit('a', 0).ok, true)
  assert.equal(l.hit('a', 59_999).ok, false)
  assert.equal(l.hit('a', 60_000).ok, true)
})
