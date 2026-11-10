import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { verifyCardText } from '../src/signed.ts'
import { bearer, errorCode, login, newKey, startHarness } from './helpers.ts'
import { cardBody, putCard, signedCardText } from './c89-helpers.ts'

const LENS_FIXTURE = readFileSync(new URL('./fixtures/lens-exported.persomecard', import.meta.url), 'utf8')

test('verifyCardText: accepts a card exported by Lens and in-test signed cards; formatting-independent', () => {
  const lens = verifyCardText(LENS_FIXTURE)
  assert.equal(lens.valid, true)
  if (lens.valid) assert.equal(lens.card.fingerprint, 'db2e460bc81124103d8697c614d6de248d181302bfa3c3c9ed7084f176845b07')

  const key = newKey()
  const text = signedCardText(key)
  const v = verifyCardText(text)
  assert.equal(v.valid, true)
  if (v.valid) {
    assert.equal(v.card.fingerprint, key.fingerprint)
    assert.equal(v.card.displayName, '小明')
  }
  // Same content, compact and with reordered keys: still valid (signature is over canonical JSON).
  const parsed = JSON.parse(text) as { card: Record<string, unknown>; signature: unknown }
  const reordered = JSON.stringify({ signature: parsed.signature, card: Object.fromEntries(Object.entries(parsed.card).reverse()) })
  assert.equal(verifyCardText(reordered).valid, true)
})

test('verifyCardText: rejects tampered, forged, wrong-fingerprint, extra-key and non-JSON input', () => {
  const key = newKey()
  const other = newKey()
  const text = signedCardText(key)

  const tampered = text.replace('喜欢写代码', '喜欢写小说')
  assert.notEqual(tampered, text)
  assert.deepEqual(pick(verifyCardText(tampered)), { valid: false, reason: 'signature' })

  const lensTampered = LENS_FIXTURE.replace('"points": ', '"points": 1')
  assert.notEqual(lensTampered, LENS_FIXTURE)
  assert.equal(verifyCardText(lensTampered).valid, false)

  // Signed by another key while claiming to be `key`.
  assert.deepEqual(pick(verifyCardText(signedCardText(key, cardBody(key), other))), { valid: false, reason: 'signature' })

  const wrongFp = JSON.parse(text) as { card: { issuer: { fingerprint: string } } }
  wrongFp.card.issuer.fingerprint = other.fingerprint
  assert.deepEqual(pick(verifyCardText(JSON.stringify(wrongFp))), { valid: false, reason: 'fingerprint' })

  const extra = JSON.parse(text) as Record<string, unknown>
  extra.note = 'x'
  assert.deepEqual(pick(verifyCardText(JSON.stringify(extra))), { valid: false, reason: 'schema' })

  const extraInner = cardBody(key) as { content: { front: Record<string, unknown> } }
  extraInner.content.front.email = 'a@b.c'
  assert.deepEqual(pick(verifyCardText(signedCardText(key, extraInner as unknown as Record<string, unknown>))), { valid: false, reason: 'schema' })

  const badDate = cardBody(key, { issuedAt: '2026-02-30T00:00:00Z' })
  assert.deepEqual(pick(verifyCardText(signedCardText(key, badDate))), { valid: false, reason: 'schema' })
  const longName = cardBody(key, { displayName: 'x'.repeat(81) })
  assert.deepEqual(pick(verifyCardText(signedCardText(key, longName))), { valid: false, reason: 'schema' })

  assert.deepEqual(pick(verifyCardText('{not json')), { valid: false, reason: 'parse' })
})

function pick(r: ReturnType<typeof verifyCardText>): { valid: boolean; reason?: string } {
  return r.valid ? { valid: true } : { valid: false, reason: r.reason }
}

test('cards: publish → fetch by any account → unchanged → new version → history cap → delete', async () => {
  const h = await startHarness()
  try {
    const me = newKey()
    const friend = newKey()
    const t = (await login(h.base, me)).token
    const ft = (await login(h.base, friend)).token
    const text1 = signedCardText(me)

    const r1 = await putCard(h.base, t, text1)
    assert.equal(r1.status, 200)
    const j1 = (await r1.json()) as Record<string, unknown>
    assert.deepEqual(j1, { fingerprint: me.fingerprint, version: 1, published_at: new Date(h.clock.t).toISOString(), unchanged: false })

    h.clock.t += 1000
    const r2 = await putCard(h.base, t, text1)
    assert.deepEqual(await r2.json(), { ...j1, unchanged: true })

    const g = await fetch(`${h.base}/v1/cards/${me.fingerprint}`, { headers: bearer(ft) })
    assert.equal(g.status, 200)
    const gj = (await g.json()) as { card: string; version: number; published_at: string }
    assert.equal(gj.card, text1, 'served verbatim')
    assert.equal(gj.version, 1)
    assert.equal(verifyCardText(gj.card).valid, true)

    const text2 = signedCardText(me, cardBody(me, { summary: '第二版' }))
    const r3 = (await (await putCard(h.base, t, text2)).json()) as { version: number; unchanged: boolean }
    assert.deepEqual([r3.version, r3.unchanged], [2, false])
    assert.equal(((await (await fetch(`${h.base}/v1/cards/${me.fingerprint}`, { headers: bearer(ft) })).json()) as { card: string }).card, text2)

    for (let i = 0; i < 23; i++) await putCard(h.base, t, signedCardText(me, cardBody(me, { summary: `v${i}` })))
    const rows = h.app.db.prepare('SELECT version FROM cards WHERE account_id = ? ORDER BY version').all(me.fingerprint) as Array<{ version: number }>
    assert.equal(rows.length, 20)
    assert.equal(rows[19].version, 25)
    assert.equal(rows[0].version, 6)

    const d = await fetch(h.base + '/v1/cards', { method: 'DELETE', headers: bearer(t) })
    assert.equal(d.status, 204)
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n, 0)
    const g404 = await fetch(`${h.base}/v1/cards/${me.fingerprint}`, { headers: bearer(ft) })
    assert.equal(g404.status, 404)
    assert.equal(await errorCode(g404), 'not_found')

    // Versions stay monotonic after a delete (friends' caches never see a number reused).
    const again = (await (await putCard(h.base, t, text1)).json()) as { version: number }
    assert.equal(again.version, 26)
  } finally {
    await h.close()
  }
})

test('cards: another key → 403 card_not_owner; tampered/forged → 400 card_invalid; Lens card of a foreign key → 403', async () => {
  const h = await startHarness()
  try {
    const me = newKey()
    const other = newKey()
    const t = (await login(h.base, me)).token

    const r403 = await putCard(h.base, t, signedCardText(other))
    assert.equal(r403.status, 403)
    assert.equal(await errorCode(r403), 'card_not_owner')
    assert.equal((await putCard(h.base, t, LENS_FIXTURE)).status, 403)

    for (const bad of [
      signedCardText(me).replace('喜欢写代码', '喜欢写小说'),
      signedCardText(me, cardBody(me), other),
      '{"card":1}',
      'not json'
    ]) {
      const r = await putCard(h.base, t, bad)
      assert.equal(r.status, 400)
      assert.equal(await errorCode(r), 'card_invalid')
    }
    const empty = await fetch(h.base + '/v1/cards', { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(t) }, body: '{"card":5}' })
    assert.equal(await errorCode(empty), 'invalid_request')

    const huge = await putCard(h.base, t, 'x'.repeat(64 * 1024 + 1))
    assert.equal(huge.status, 413)

    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n, 0)

    assert.equal((await fetch(`${h.base}/v1/cards/${me.fingerprint}`)).status, 401)
    assert.equal((await fetch(h.base + '/v1/cards', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401)
    const badFp = await fetch(`${h.base}/v1/cards/${me.fingerprint.toUpperCase()}`, { headers: bearer(t) })
    assert.equal(badFp.status, 400)
  } finally {
    await h.close()
  }
})

test('cards: GET is rate-limited per account', async () => {
  const h = await startHarness({ cardFetchMax: 3 })
  try {
    const me = newKey()
    const t = (await login(h.base, me)).token
    const t2 = (await login(h.base, newKey())).token
    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${h.base}/v1/cards/${me.fingerprint}`, { headers: bearer(t) })).status)
    assert.deepEqual(codes, [404, 404, 404, 429])
    assert.equal((await fetch(`${h.base}/v1/cards/${me.fingerprint}`, { headers: bearer(t2) })).status, 404, 'other account unaffected')
  } finally {
    await h.close()
  }
})
