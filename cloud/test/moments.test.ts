import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID, sign } from 'node:crypto'
import { verifyAcceptanceText, verifyMomentText } from '../src/signed.ts'
import { bearer, errorCode, login, newKey, postJson, startHarness, type Harness, type TestKey } from './helpers.ts'
import { sortedJson } from './c89-helpers.ts'

// Signing re-implemented with node:crypto + the independent sorted-keys serializer from c89-helpers.

const TITLE = 'TITLE-SECRET 一起爬山'
const NOTE = 'NOTE-SECRET 山顶很冷'
const PLACE = 'PLACE-SECRET 香山'

interface MomentOpts {
  id?: string
  participants?: unknown
  visibility?: string
  title?: string
  note?: string
  place?: string | null
  occurredOn?: { start: string; end: string }
  extra?: Record<string, unknown>
}

function sortedPair(a: TestKey, b: TestKey): string[] {
  return [a.fingerprint, b.fingerprint].sort()
}

function momentUnsigned(proposer: TestKey, other: TestKey, o: MomentOpts = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: 'persome-moment',
    moment_id: o.id ?? randomUUID(),
    title: o.title ?? TITLE,
    note: o.note ?? NOTE,
    occurred_on: o.occurredOn ?? { start: '2026-11-01', end: '2026-11-02' },
    place: o.place === undefined ? PLACE : o.place,
    participants: o.participants ?? sortedPair(proposer, other),
    visibility: o.visibility ?? 'letters',
    proposer: { public_key: proposer.publicKey, fingerprint: proposer.fingerprint },
    created_at: '2026-11-05T10:00:00.000Z',
    ...o.extra
  }
}

function signMoment(unsigned: Record<string, unknown>, signer: TestKey): string {
  const sig = sign(null, Buffer.from('persome-moment-v1\n' + sortedJson(unsigned), 'utf8'), signer.privateKey).toString('base64url')
  return JSON.stringify({ ...unsigned, signature: sig }, null, 2)
}

function momentText(proposer: TestKey, other: TestKey, o: MomentOpts = {}): string {
  return signMoment(momentUnsigned(proposer, other, o), proposer)
}

const shaOf = (text: string): string => createHash('sha256').update(sortedJson(JSON.parse(text)), 'utf8').digest('hex')

function acceptanceText(accepter: TestKey, mText: string, o: { id?: string; sha?: string; signer?: TestKey; claim?: TestKey } = {}): string {
  const m = JSON.parse(mText) as { moment_id: string }
  const claim = o.claim ?? accepter
  const unsigned = {
    version: 1,
    kind: 'persome-moment-accept',
    moment_id: o.id ?? m.moment_id,
    moment_sha256: o.sha ?? shaOf(mText),
    accepter: { public_key: claim.publicKey, fingerprint: claim.fingerprint },
    accepted_at: '2026-11-05T11:00:00.000Z'
  }
  const sig = sign(null, Buffer.from('persome-moment-accept-v1\n' + sortedJson(unsigned), 'utf8'), (o.signer ?? accepter).privateKey).toString('base64url')
  return JSON.stringify({ ...unsigned, signature: sig })
}

const propose = (h: Harness, token: string, moment: string) => postJson(h.base, '/v1/moments', { moment }, bearer(token))
const accept = (h: Harness, token: string, id: string, acceptance: string) => postJson(h.base, `/v1/moments/${id}/accept`, { acceptance }, bearer(token))
const decline = (h: Harness, token: string, id: string) => fetch(`${h.base}/v1/moments/${id}/decline`, { method: 'POST', headers: bearer(token) })
const del = (h: Harness, token: string, id: string) => fetch(`${h.base}/v1/moments/${id}`, { method: 'DELETE', headers: bearer(token) })
const list = async (h: Harness, token: string) => {
  const r = await fetch(`${h.base}/v1/moments`, { headers: bearer(token) })
  assert.equal(r.status, 200)
  return (await r.json()) as Array<{ moment_id: string; status: string; moment: string; acceptance: string | null; updated_at: string }>
}
const idOf = (text: string): string => (JSON.parse(text) as { moment_id: string }).moment_id

interface Trio {
  a: TestKey
  b: TestKey
  c: TestKey
  ta: string
  tb: string
  tc: string
}

async function trio(h: Harness): Promise<Trio> {
  const a = newKey()
  const b = newKey()
  const c = newKey()
  return { a, b, c, ta: (await login(h.base, a)).token, tb: (await login(h.base, b)).token, tc: (await login(h.base, c)).token }
}

// ---------------------------------------------------------------- pure verifiers

test('verifyMomentText / verifyAcceptanceText: valid pair, formatting-independent; failure reasons', () => {
  const a = newKey()
  const b = newKey()
  const c = newKey()
  const m = momentText(a, b)
  const v = verifyMomentText(m)
  assert.equal(v.valid, true)
  if (v.valid) {
    assert.equal(v.other, b.fingerprint)
    assert.equal(v.sha256, shaOf(m))
  }
  // reordered keys + compact: same canonical form, same sha
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(m) as Record<string, unknown>).reverse()))
  const v2 = verifyMomentText(reordered)
  assert.equal(v2.valid && v2.sha256, shaOf(m))

  const acc = acceptanceText(b, m)
  assert.equal(verifyAcceptanceText(acc, m).valid, true)
  assert.equal(verifyAcceptanceText(acc, reordered).valid, true, 'sha is over canonical JSON, not the text bytes')

  const reason = (r: { valid: boolean; reason?: string }) => (r.valid ? 'ok' : r.reason)
  assert.equal(reason(verifyMomentText(m.replace('一起爬山', '一起游泳'))), 'signature')
  assert.equal(reason(verifyMomentText(signMoment(momentUnsigned(a, b), c))), 'signature')
  assert.equal(reason(verifyMomentText(momentText(a, b, { participants: sortedPair(b, c) }))), 'not_participant')
  assert.equal(reason(verifyMomentText(momentText(a, b, { participants: sortedPair(a, b).reverse() }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { participants: [a.fingerprint, a.fingerprint] }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { participants: [...sortedPair(a, b), c.fingerprint].sort() }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { participants: [a.fingerprint] }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { title: 'line1\nline2' }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { title: 'x'.repeat(201) }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { note: 'x'.repeat(4001) }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { place: 'x'.repeat(201) }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { place: null, note: '' }))), 'ok')
  assert.equal(reason(verifyMomentText(momentText(a, b, { visibility: 'public' }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { occurredOn: { start: '2026-11-03', end: '2026-11-02' } }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { occurredOn: { start: '2026-02-30', end: '2026-03-01' } }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { id: randomUUID().toUpperCase() }))), 'schema')
  assert.equal(reason(verifyMomentText(momentText(a, b, { extra: { inferred: true } }))), 'schema')
  assert.equal(reason(verifyMomentText('{nope')), 'parse')

  assert.equal(reason(verifyAcceptanceText(acceptanceText(b, m, { sha: 'f'.repeat(64) }), m)), 'mismatch')
  assert.equal(reason(verifyAcceptanceText(acceptanceText(b, m, { id: randomUUID() }), m)), 'mismatch')
  assert.equal(reason(verifyAcceptanceText(acceptanceText(a, m), m)), 'not_participant', 'proposer cannot accept')
  assert.equal(reason(verifyAcceptanceText(acceptanceText(c, m), m)), 'not_participant', 'third party cannot accept')
  assert.equal(reason(verifyAcceptanceText(acceptanceText(b, m, { signer: c }), m)), 'signature', 'claims b, signed by c')
  assert.equal(reason(verifyAcceptanceText(acc, m.replace('一起爬山', '一起游泳'))), 'moment_invalid')
  // an acceptance of a different (validly signed) moment with the same id does not transfer
  const m2 = momentText(a, b, { id: idOf(m), visibility: 'private' })
  assert.equal(reason(verifyAcceptanceText(acc, m2)), 'mismatch', 'visibility is covered by the acceptance')
})

// ---------------------------------------------------------------- HTTP

test('moments: propose → both list → accept → verbatim texts; decline; either side deletes for both', async () => {
  const h = await startHarness()
  try {
    const { a, b, ta, tb, tc } = await trio(h)
    const m = momentText(a, b)
    const id = idOf(m)
    const r = await propose(h, ta, m)
    assert.equal(r.status, 201)
    assert.deepEqual(await r.json(), { moment_id: id, status: 'pending' })

    for (const t of [ta, tb]) {
      const l = await list(h, t)
      assert.equal(l.length, 1)
      assert.deepEqual(l[0], { moment_id: id, status: 'pending', moment: m, acceptance: null, updated_at: new Date(h.clock.t).toISOString() })
    }
    assert.deepEqual(await list(h, tc), [], 'third party sees nothing')

    h.clock.t += 5000
    const acc = acceptanceText(b, m)
    const ra = await accept(h, tb, id, acc)
    assert.equal(ra.status, 200)
    assert.deepEqual(await ra.json(), { status: 'accepted' })
    const la = await list(h, ta)
    assert.equal(la[0].status, 'accepted')
    assert.equal(la[0].acceptance, acc, 'served verbatim')
    assert.equal(la[0].updated_at, new Date(h.clock.t).toISOString())
    assert.equal(verifyAcceptanceText(la[0].acceptance!, la[0].moment).valid, true, 'client can re-verify the served pair')

    // accept twice → 409; decline after accept → 409
    const again = await accept(h, tb, id, acc)
    assert.equal(again.status, 409)
    assert.equal(await errorCode(again), 'moment_not_pending')
    assert.equal((await decline(h, tb, id)).status, 409)

    // decline flow (b proposes, a declines), newest first in list
    h.clock.t += 1000
    const m2 = momentText(b, a, { visibility: 'private' })
    assert.equal((await propose(h, tb, m2)).status, 201)
    const pd = await decline(h, tc, idOf(m2))
    assert.equal(pd.status, 404) // third party: indistinguishable from an unknown id
    assert.equal(await errorCode(pd), 'not_found')
    const pp = await decline(h, tb, idOf(m2))
    assert.equal(pp.status, 403)
    assert.equal(await errorCode(pp), 'moment_not_owner')
    h.clock.t += 1000
    const dr = await decline(h, ta, idOf(m2))
    assert.equal(dr.status, 200)
    assert.deepEqual(await dr.json(), { status: 'declined' })
    assert.equal((await accept(h, ta, idOf(m2), acceptanceText(a, m2))).status, 409, 'declined cannot be accepted')
    const lb = await list(h, tb)
    assert.deepEqual(lb.map((x) => [x.moment_id, x.status]), [[idOf(m2), 'declined'], [id, 'accepted']])

    // third party DELETE → 404 (same as unknown id); nothing removed
    const d3 = await del(h, tc, id)
    assert.equal(d3.status, 404)
    assert.equal(await errorCode(d3), 'not_found')
    assert.equal((await del(h, tc, randomUUID())).status, 404)
    assert.equal((await del(h, tc, 'not-a-uuid')).status, 404)
    assert.equal((await list(h, ta)).length, 2)

    // the accepter (not the proposer) deletes → gone for both
    assert.equal((await del(h, tb, id)).status, 204)
    assert.deepEqual((await list(h, ta)).map((x) => x.moment_id), [idOf(m2)])
    assert.deepEqual((await list(h, tb)).map((x) => x.moment_id), [idOf(m2)])
    assert.equal((await del(h, tb, id)).status, 404)
    // the proposer deletes → gone for both
    assert.equal((await del(h, tb, idOf(m2))).status, 204)
    assert.deepEqual(await list(h, ta), [])
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM moments').get() as { n: number }).n, 0)

    // 401 without token
    assert.equal((await fetch(`${h.base}/v1/moments`)).status, 401)
  } finally {
    await h.close()
  }
})

test('moments: propose validation — not owner / not participant 403, bad participants / tampered 400, duplicate 409, body cap 413', async () => {
  const h = await startHarness()
  try {
    const { a, b, c, ta } = await trio(h)
    const code = async (r: Response) => [r.status, await errorCode(r)]

    // proposer not in participants → 403 moment_not_owner
    assert.deepEqual(await code(await propose(h, ta, momentText(a, b, { participants: sortedPair(b, c) }))), [403, 'moment_not_owner'])
    // signed by another key (b's valid moment uploaded by a) → 403
    assert.deepEqual(await code(await propose(h, ta, momentText(b, a))), [403, 'moment_not_owner'])

    for (const bad of [
      momentText(a, b, { participants: sortedPair(a, b).reverse() }),
      momentText(a, b, { participants: [a.fingerprint, a.fingerprint] }),
      momentText(a, b, { participants: [a.fingerprint] }),
      momentText(a, b, { participants: [...sortedPair(a, b), c.fingerprint].sort() }),
      momentText(a, b).replace('山顶很冷', '山顶很热'),
      signMoment(momentUnsigned(a, b), c),
      momentText(a, b, { title: '' }),
      'not json'
    ]) {
      assert.deepEqual(await code(await propose(h, ta, bad)), [400, 'moment_invalid'], bad.slice(0, 80))
    }
    assert.deepEqual(await code(await postJson(h.base, '/v1/moments', { moment: 5 }, bearer(ta))), [400, 'invalid_request'])

    const m = momentText(a, b)
    assert.equal((await propose(h, ta, m)).status, 201)
    assert.deepEqual(await code(await propose(h, ta, m)), [409, 'duplicate_moment'])
    // same id, different content → still 409
    assert.equal((await propose(h, ta, momentText(a, b, { id: idOf(m), title: 'other' }))).status, 409)

    const huge = await postJson(h.base, '/v1/moments', { moment: 'x'.repeat(64 * 1024) }, bearer(ta))
    assert.equal(huge.status, 413)
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM moments').get() as { n: number }).n, 1)
  } finally {
    await h.close()
  }
})

test('moments: acceptance must be the other participant, signed by them, bound to this exact moment', async () => {
  const h = await startHarness()
  try {
    const { a, b, c, ta, tb, tc } = await trio(h)
    const m = momentText(a, b)
    const id = idOf(m)
    assert.equal((await propose(h, ta, m)).status, 201)
    const code = async (r: Response) => [r.status, await errorCode(r)]

    // proposer tries to accept own moment
    assert.deepEqual(await code(await accept(h, ta, id, acceptanceText(a, m))), [403, 'moment_not_owner'])
    // third party tries
    assert.deepEqual(await code(await accept(h, tc, id, acceptanceText(c, m))), [404, 'not_found'])
    // unknown id
    assert.deepEqual(await code(await accept(h, tb, randomUUID(), acceptanceText(b, m))), [404, 'not_found'])

    const other = momentText(a, b)
    for (const [label, bad] of [
      ['wrong sha', acceptanceText(b, m, { sha: shaOf(other) })],
      ['wrong id', acceptanceText(b, m, { id: idOf(other) })],
      ['acceptance of another moment', acceptanceText(b, other)],
      ['signed by proposer', acceptanceText(a, m)],
      ['signed by third party', acceptanceText(c, m)],
      ['claims b, signed by c', acceptanceText(b, m, { signer: c })],
      ['tampered', acceptanceText(b, m).replace('2026-11-05T11:00:00.000Z', '2026-11-05T12:00:00.000Z')],
      ['junk', '{"kind":"persome-moment-accept"}']
    ] as const) {
      assert.deepEqual(await code(await accept(h, tb, id, bad)), [400, 'acceptance_invalid'], label)
    }
    assert.equal((await list(h, ta))[0].status, 'pending', 'still pending after rejected acceptances')
    assert.equal((await accept(h, tb, id, acceptanceText(b, m))).status, 200)
  } finally {
    await h.close()
  }
})

test('moments: account deletion cascades both directions; the other side needs no account to be proposed to', async () => {
  const h = await startHarness()
  try {
    const { a, b, c, ta, tb, tc } = await trio(h)
    const ab = momentText(a, b) // a proposes to b
    const ba = momentText(b, a) // b proposes to a
    const bc = momentText(b, c) // unrelated to a
    const noAccount = newKey() // never logged in
    const aN = momentText(a, noAccount)
    for (const [t, m] of [[ta, ab], [tb, ba], [tb, bc], [ta, aN]] as const) assert.equal((await propose(h, t, m)).status, 201)
    assert.equal((await accept(h, tb, idOf(ab), acceptanceText(b, ab))).status, 200)
    assert.equal((await list(h, ta)).length, 3)

    const r = await fetch(h.base + '/v1/account', { method: 'DELETE', headers: bearer(ta) })
    assert.equal(r.status, 204)
    // b keeps only the moment that never involved a
    assert.deepEqual((await list(h, tb)).map((x) => x.moment_id), [idOf(bc)])
    assert.deepEqual((await list(h, tc)).map((x) => x.moment_id), [idOf(bc)])
    const rows = h.app.db.prepare('SELECT id FROM moments').all() as Array<{ id: string }>
    assert.deepEqual(rows.map((x) => x.id), [idOf(bc)])
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM moment_usage WHERE account_id = ?').get(a.fingerprint) as { n: number }).n, 0)

    // c (the *other* participant of bc) deletes their account → bc gone too
    assert.equal((await fetch(h.base + '/v1/account', { method: 'DELETE', headers: bearer(tc) })).status, 204)
    assert.deepEqual(await list(h, tb), [])
  } finally {
    await h.close()
  }
})

test('moments: caps — 50 pending per proposer, 20 proposals per UTC day (deletes do not refund)', async () => {
  const h = await startHarness()
  try {
    const k = await trio(h)
    const { a, b } = k
    let { ta, tb } = k
    for (let i = 0; i < 20; i++) assert.equal((await propose(h, ta, momentText(a, b))).status, 201)
    const r = await propose(h, ta, momentText(a, b))
    assert.equal(r.status, 429)
    assert.equal(await errorCode(r), 'rate_limited')
    assert.ok(Number(r.headers.get('retry-after')) > 0)
    // deleting does not refund the daily counter
    const first = (await list(h, ta))[0].moment_id
    assert.equal((await del(h, ta, first)).status, 204)
    assert.equal((await propose(h, ta, momentText(a, b))).status, 429)
    // b's own budget is separate
    assert.equal((await propose(h, tb, momentText(b, a))).status, 201)

    // next days: pending cap. 19 left + 20 + 11 = 50 pending
    h.clock.t += 86_400_000
    ta = (await login(h.base, a)).token // tokens expire after 1 h in the harness
    for (let i = 0; i < 20; i++) assert.equal((await propose(h, ta, momentText(a, b))).status, 201)
    h.clock.t += 86_400_000
    ta = (await login(h.base, a)).token
    tb = (await login(h.base, b)).token
    for (let i = 0; i < 11; i++) assert.equal((await propose(h, ta, momentText(a, b))).status, 201)
    const pend = (h.app.db.prepare("SELECT COUNT(*) AS n FROM moments WHERE proposer_id = ? AND status = 'pending'").get(a.fingerprint) as { n: number }).n
    assert.equal(pend, 50)
    const capped = await propose(h, ta, momentText(a, b))
    assert.equal(capped.status, 429)
    // once b answers one, a may propose again
    const one = (await list(h, tb)).find((x) => JSON.parse(x.moment).proposer.fingerprint === a.fingerprint)!
    assert.equal((await decline(h, tb, one.moment_id)).status, 200)
    assert.equal((await propose(h, ta, momentText(a, b))).status, 201)

    // GC drops old usage rows
    h.app.purge()
    assert.deepEqual(
      (h.app.db.prepare('SELECT day FROM moment_usage WHERE account_id = ? ORDER BY day').all(a.fingerprint) as Array<{ day: string }>).map((x) => x.day),
      ['2026-01-01', '2026-01-02', '2026-01-03']
    )
    h.clock.t += 3 * 86_400_000
    h.app.purge()
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM moment_usage WHERE account_id = ?').get(a.fingerprint) as { n: number }).n, 0)
  } finally {
    await h.close()
  }
})

test('moments: request logs contain no title / note / place / fingerprints; route templates only', async () => {
  const h = await startHarness()
  try {
    const { a, b, ta, tb } = await trio(h)
    const m = momentText(a, b)
    const id = idOf(m)
    await propose(h, ta, m)
    await propose(h, ta, m.replace('山顶很冷', '山顶很热'))
    await list(h, tb)
    await accept(h, tb, id, acceptanceText(b, m))
    await decline(h, tb, id)
    await del(h, ta, id)
    const joined = h.logs.join('\n')
    for (const f of ['TITLE-SECRET', 'NOTE-SECRET', 'PLACE-SECRET', '爬山', '香山', id, a.fingerprint, b.fingerprint]) {
      assert.ok(!joined.includes(f), `log leaked ${f.slice(0, 16)}`)
    }
    const routes = new Set(h.logs.map((l) => (JSON.parse(l) as { route: string }).route))
    for (const r of ['/v1/moments', '/v1/moments/:id/accept', '/v1/moments/:id/decline', '/v1/moments/:id']) assert.ok(routes.has(r), r)
  } finally {
    await h.close()
  }
})
