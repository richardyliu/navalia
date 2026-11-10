import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearer, errorCode, login, newKey, startHarness, type Harness, type TestKey } from './helpers.ts'
import { cardBody, letterText, postForm, postLetter, putCard, recordingMailer, signedCardText, subscribeJson, tokenFrom, type RecordingMailer } from './c89-helpers.ts'
import { PAGE_CSP } from '../src/html.ts'

const LONG_TTL = { tokenTtlS: 365 * 24 * 3600 }

async function setup(over: Parameters<typeof startHarness>[0] = {}): Promise<{ h: Harness; rec: RecordingMailer; pub: TestKey; token: string }> {
  const rec = recordingMailer()
  const h = await startHarness({ ...LONG_TTL, ...over }, { mailer: rec.mailer })
  const pub = newKey()
  const token = (await login(h.base, pub)).token
  return { h, rec, pub, token }
}

const confirmTokenFor = (rec: RecordingMailer, email: string): string => {
  const m = rec.sent.findLast((x) => x.to === email && x.subject.startsWith('请确认订阅'))
  assert.ok(m, `confirmation mail for ${email}`)
  return tokenFrom(m.text, '/v1/subscribe/confirm')
}

async function subscribeAndConfirm(h: Harness, rec: RecordingMailer, pub: TestKey, email: string): Promise<void> {
  assert.equal((await subscribeJson(h.base, pub.fingerprint, email)).status, 202)
  await h.app.outbox.drain()
  assert.equal((await postForm(h.base, '/v1/subscribe/confirm', { token: confirmTokenFor(rec, email) })).status, 200)
}

async function sendLetter(h: Harness, rec: RecordingMailer, pub: TestKey, token: string): Promise<{ recipients: number; mails: string[] }> {
  const before = rec.sent.length
  const r = await postLetter(h.base, token, letterText(pub))
  assert.equal(r.status, 202)
  const { recipients } = (await r.json()) as { recipients: number }
  await h.app.outbox.drain()
  return { recipients, mails: rec.sent.slice(before).map((m) => m.to) }
}

const status = (h: Harness, email: string): string | undefined =>
  (h.app.db.prepare('SELECT status FROM subscribers WHERE email = ?').get(email) as { status: string } | undefined)?.status

function assertPage(r: Response): void {
  assert.match(r.headers.get('content-type') ?? '', /^text\/html; charset=utf-8$/)
  assert.equal(r.headers.get('content-security-policy'), PAGE_CSP)
  assert.match(PAGE_CSP, /default-src 'none'/)
  assert.match(PAGE_CSP, /form-action 'self'/)
  assert.equal(r.headers.get('x-frame-options'), 'DENY')
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(r.headers.get('cache-control'), 'no-store')
}

function assertNoScripts(html: string): void {
  assert.ok(!/<script/i.test(html), 'no script')
  assert.ok(!/(src|href)=["']?https?:/i.test(html), 'no external resources')
}

test('double opt-in: GET confirm does not confirm, POST does; token single-use; expired token rejected', async () => {
  const { h, rec, pub } = await setup()
  try {
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'a@example.com')).status, 202)
    await h.app.outbox.drain()
    assert.equal(status(h, 'a@example.com'), 'pending')
    const token = confirmTokenFor(rec, 'a@example.com')
    const mail = rec.sent[0]
    assert.ok(mail.text.includes('48 小时'))
    assert.equal(mail.headers, undefined, 'confirmation mail has no list headers')
    // the raw token left the DB once the mail was handed over
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM confirm_queue').get() as { n: number }).n, 0)

    const g = await fetch(`${h.base}/v1/subscribe/confirm?token=${token}`)
    assert.equal(g.status, 200)
    assertPage(g)
    const html = await g.text()
    assertNoScripts(html)
    assert.ok(html.includes('method="post" action="/v1/subscribe/confirm"'))
    assert.ok(html.includes(`value="${token.replace(/=/g, '&#61;')}"`))
    assert.equal(status(h, 'a@example.com'), 'pending', 'GET must not confirm')

    const p = await postForm(h.base, '/v1/subscribe/confirm', { token })
    assert.equal(p.status, 200)
    assertPage(p)
    assert.ok((await p.text()).includes('订阅成功'))
    assert.equal(status(h, 'a@example.com'), 'confirmed')
    assert.equal((await postForm(h.base, '/v1/subscribe/confirm', { token })).status, 400, 'single use')

    // expiry: 48 h
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'late@example.com')).status, 202)
    await h.app.outbox.drain()
    const late = confirmTokenFor(rec, 'late@example.com')
    h.clock.t += 48 * 3600 * 1000
    const e = await postForm(h.base, '/v1/subscribe/confirm', { token: late })
    assert.equal(e.status, 400)
    assert.ok((await e.text()).includes('已过期'))
    assert.equal(status(h, 'late@example.com'), 'pending')
    h.app.purge()
    assert.equal(status(h, 'late@example.com'), undefined, 'expired pending row (with its address) is purged')

    assert.equal((await fetch(`${h.base}/v1/subscribe/confirm?token=%3Cscript%3E`)).status, 400)
    assert.equal((await postForm(h.base, '/v1/subscribe/confirm', { token: 'x'.repeat(43) })).status, 400)
  } finally {
    await h.close()
  }
})

test('unsubscribe: GET does not unsubscribe; POST form and RFC 8058 one-click do; idempotent; raw address deleted', async () => {
  const { h, rec, pub, token } = await setup()
  try {
    await subscribeAndConfirm(h, rec, pub, 'u1@example.com')
    await subscribeAndConfirm(h, rec, pub, 'U2@Example.com')
    const { mails } = await sendLetter(h, rec, pub, token)
    assert.deepEqual(mails.sort(), ['U2@Example.com', 'u1@example.com'])
    const tokFor = (to: string): string => tokenFrom(rec.sent.findLast((m) => m.to === to)!.headers!['List-Unsubscribe'], '/v1/unsubscribe')
    const t1 = tokFor('u1@example.com')
    const t2 = tokFor('U2@Example.com')

    const g = await fetch(`${h.base}/v1/unsubscribe?token=${encodeURIComponent(t1)}`)
    assert.equal(g.status, 200)
    assertPage(g)
    const gh = await g.text()
    assertNoScripts(gh)
    assert.ok(gh.includes('action="/v1/unsubscribe"'))
    assert.equal(status(h, 'u1@example.com'), 'confirmed', 'GET must not unsubscribe')

    const p = await postForm(h.base, '/v1/unsubscribe', { token: t1 })
    assert.equal(p.status, 200)
    assertPage(p)
    assert.equal(status(h, 'u1@example.com'), undefined)
    assert.equal((await postForm(h.base, '/v1/unsubscribe', { token: t1 })).status, 200, 'idempotent')

    // RFC 8058: POST <List-Unsubscribe URL> with body List-Unsubscribe=One-Click
    const oc = await fetch(`${h.base}/v1/unsubscribe?token=${encodeURIComponent(t2)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click'
    })
    assert.equal(oc.status, 200)
    assert.equal(status(h, 'U2@Example.com'), undefined)

    // forged token
    const forged = t1.slice(0, -2) + (t1.endsWith('AA') ? 'BB' : 'AA')
    assert.equal((await postForm(h.base, '/v1/unsubscribe', { token: forged })).status, 400)
    assert.equal((await fetch(`${h.base}/v1/unsubscribe?token=${encodeURIComponent(forged)}`)).status, 400)

    // only hashes remain
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM suppressions WHERE account_id = ?').get(pub.fingerprint) as { n: number }).n, 2)
    assertAddressGone(h, ['u1@example.com', 'U2@Example.com', 'u2@example.com'])

    // suppressed addresses get no further letter …
    const next = await sendLetter(h, rec, pub, token)
    assert.deepEqual([next.recipients, next.mails], [0, []])
    // … and no confirmation mail (but the response is the same 202)
    const before = rec.sent.length
    const s = await subscribeJson(h.base, pub.fingerprint, 'u1@example.com')
    assert.equal(s.status, 202)
    assert.deepEqual(await s.json(), { status: 'pending' })
    await h.app.outbox.drain()
    assert.equal(rec.sent.length, before)
    assert.equal(status(h, 'u1@example.com'), undefined)
  } finally {
    await h.close()
  }
})

function assertAddressGone(h: Harness, addrs: string[]): void {
  const tables = (h.app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
  for (const t of tables) {
    const rows = h.app.db.prepare(`SELECT * FROM "${t}"`).all()
    const dump = JSON.stringify(rows).toLowerCase()
    for (const a of addrs) assert.ok(!dump.includes(a.toLowerCase()), `${t} still contains an address`)
  }
}

test('unsubscribing cancels queued deliveries; re-subscribe via the old link + address (double opt-in) lifts suppression', async () => {
  const { h, rec, pub, token } = await setup()
  try {
    await subscribeAndConfirm(h, rec, pub, 'r@example.com')
    await sendLetter(h, rec, pub, token)
    const unsub = tokenFrom(rec.sent.findLast((m) => m.to === 'r@example.com')!.text, '/v1/unsubscribe')

    // queue a letter, then unsubscribe before the worker runs
    const { letter_id } = (await (await postLetter(h.base, token, letterText(pub))).json()) as { letter_id: string }
    assert.equal((await postForm(h.base, '/v1/unsubscribe', { token: unsub })).status, 200)
    await h.app.outbox.drain()
    const d = (await (await fetch(`${h.base}/v1/letters/${letter_id}/deliveries`, { headers: bearer(token) })).json()) as Array<Record<string, unknown>>
    assert.deepEqual([d[0].status, d[0].error_code], ['suppressed', 'unsubscribed'])
    const counts = ((await (await fetch(`${h.base}/v1/letters`, { headers: bearer(token) })).json()) as Array<{ letter_id: string; counts: unknown }>).find(
      (l) => l.letter_id === letter_id
    )!.counts
    assert.deepEqual(counts, { queued: 0, sent: 0, failed: 0, suppressed: 1 })

    // wrong address with a valid token: same page, nothing sent
    const n0 = rec.sent.length
    const wrong = await postForm(h.base, '/v1/resubscribe', { token: unsub, email: 'someone-else@example.com' })
    assert.equal(wrong.status, 200)
    const wrongHtml = await wrong.text()
    await h.app.outbox.drain()
    assert.equal(rec.sent.length, n0)

    const ok = await postForm(h.base, '/v1/resubscribe', { token: unsub, email: 'R@example.com' })
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), wrongHtml, 'same page whether or not the address matched')
    await h.app.outbox.drain()
    assert.equal(rec.sent.length, n0 + 1)
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM suppressions').get() as { n: number }).n, 1, 'suppression stays until confirmed')
    assert.equal((await postForm(h.base, '/v1/subscribe/confirm', { token: confirmTokenFor(rec, 'R@example.com') })).status, 200)
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM suppressions').get() as { n: number }).n, 0, 'double opt-in lifted it')
    const next = await sendLetter(h, rec, pub, token)
    assert.deepEqual(next.mails, ['R@example.com'])
  } finally {
    await h.close()
  }
})

test('subscribe is non-enumerating; ≤3 confirmation mails per address per 24 h; per-IP and per-publisher limits', async () => {
  const { h, rec, pub } = await setup()
  try {
    await subscribeAndConfirm(h, rec, pub, 'known@example.com')
    const unknownPublisher = newKey().fingerprint
    const cases: Array<[string, string]> = [
      [pub.fingerprint, 'new@example.com'],
      [pub.fingerprint, 'known@example.com'],
      [pub.fingerprint, 'KNOWN@example.com'],
      [unknownPublisher, 'new@example.com']
    ]
    for (const [p, e] of cases) {
      const r = await subscribeJson(h.base, p, e)
      assert.equal(r.status, 202)
      assert.deepEqual(await r.json(), { status: 'pending' })
    }
    await h.app.outbox.drain()
    assert.deepEqual(
      rec.sent.filter((m) => m.subject.startsWith('请确认')).map((m) => m.to),
      ['known@example.com', 'new@example.com'],
      'no mail for an already-confirmed address or an unknown publisher'
    )

    // per-address cap (counts across publishers): new@ already got 1
    const pub2 = newKey()
    await login(h.base, pub2)
    for (let i = 0; i < 4; i++) assert.equal((await subscribeJson(h.base, i % 2 ? pub.fingerprint : pub2.fingerprint, 'new@example.com')).status, 202)
    await h.app.outbox.drain()
    assert.equal(rec.sent.filter((m) => m.to === 'new@example.com').length, 3)
    h.clock.t += 24 * 3600 * 1000 + 1
    h.app.purge()
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'new@example.com')).status, 202)
    await h.app.outbox.drain()
    assert.equal(rec.sent.filter((m) => m.to === 'new@example.com').length, 4, 'cap resets after 24 h')

    // validation is about the input only, never about subscription state
    assert.equal(await errorCode(await subscribeJson(h.base, pub.fingerprint, 'not an address')), 'invalid_request')
    assert.equal(await errorCode(await subscribeJson(h.base, 'abc', 'x@example.com')), 'invalid_request')
    assert.equal(await errorCode(await subscribeJson(h.base, pub.fingerprint, 'a@example.com\r\nBcc: victim@example.com')), 'invalid_request')
  } finally {
    await h.close()
  }
  const lim = await setup({ subscribeIpPerHour: 3 })
  try {
    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await subscribeJson(lim.h.base, lim.pub.fingerprint, `ip${i}@example.com`)).status)
    assert.deepEqual(codes, [202, 202, 202, 429])
  } finally {
    await lim.h.close()
  }
  const lp = await setup({ subscribePublisherPerHour: 2 })
  try {
    const other = newKey()
    await login(lp.h.base, other)
    const codes: number[] = []
    for (let i = 0; i < 3; i++) codes.push((await subscribeJson(lp.h.base, lp.pub.fingerprint, `pp${i}@example.com`)).status)
    codes.push((await subscribeJson(lp.h.base, other.fingerprint, 'pp@example.com')).status)
    assert.deepEqual(codes, [202, 202, 429, 202])
  } finally {
    await lp.h.close()
  }
})

test('publisher API: masked subscriber list; DELETE removes + suppresses; owner only', async () => {
  const { h, rec, pub, token } = await setup()
  try {
    await subscribeAndConfirm(h, rec, pub, 'alice@example.com')
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'bob@Example.ORG')).status, 202)
    await h.app.outbox.drain()
    const r = await fetch(`${h.base}/v1/subscribers`, { headers: bearer(token) })
    const text = await r.text()
    assert.ok(!text.includes('alice') && !text.includes('bob'), 'no raw address in API')
    const list = JSON.parse(text) as Array<Record<string, unknown>>
    assert.deepEqual(
      list.map((s) => [s.email_masked, s.status, s.confirmed_at === null]),
      [
        ['a***@example.com', 'confirmed', false],
        ['b***@example.org', 'pending', true]
      ]
    )
    assert.deepEqual(Object.keys(list[0]).sort(), ['confirmed_at', 'created_at', 'email_masked', 'status', 'subscriber_id'])

    const intruder = (await login(h.base, newKey())).token
    assert.equal((await fetch(`${h.base}/v1/subscribers/${list[0].subscriber_id}`, { method: 'DELETE', headers: bearer(intruder) })).status, 404)
    assert.deepEqual(await (await fetch(`${h.base}/v1/subscribers`, { headers: bearer(intruder) })).json(), [])

    assert.equal((await fetch(`${h.base}/v1/subscribers/${list[0].subscriber_id}`, { method: 'DELETE', headers: bearer(token) })).status, 204)
    assert.equal((await fetch(`${h.base}/v1/subscribers/${list[0].subscriber_id}`, { method: 'DELETE', headers: bearer(token) })).status, 404)
    assertAddressGone(h, ['alice@example.com'])
    const n = rec.sent.length
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'alice@example.com')).status, 202)
    await h.app.outbox.drain()
    assert.equal(rec.sent.length, n, 'removed address is suppressed for this publisher')
  } finally {
    await h.close()
  }
})

test('public /s/:fingerprint page: form subscribe without JS, escaping, CSP', async () => {
  const { h, rec, pub, token } = await setup()
  try {
    const plain = await fetch(`${h.base}/s/${pub.fingerprint}`)
    assert.equal(plain.status, 200)
    assertPage(plain)
    const ph = await plain.text()
    assertNoScripts(ph)
    const visible = ph.replace(/<input type="hidden"[^>]*>/g, '')
    assert.ok(visible.includes(pub.fingerprint.slice(0, 8)) && !visible.includes(pub.fingerprint), 'short fingerprint only (full one only in the hidden form field)')
    assert.ok(ph.includes('这位发布者'))
    assert.ok(ph.includes('<form method="post" action="/v1/subscribe">'))

    const evil = `<script>alert("x")</script>&'`
    assert.equal((await putCard(h.base, token, signedCardText(pub, cardBody(pub, { displayName: evil })))).status, 200)
    const named = await (await fetch(`${h.base}/s/${pub.fingerprint}`)).text()
    assert.ok(!named.includes('<script>'))
    assert.ok(named.includes('&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;&#38;&#39;'))
    assert.ok(!named.includes('喜欢写代码'), 'no card content beyond the display name')

    const form = await postForm(h.base, '/v1/subscribe', { publisher: pub.fingerprint, email: 'form@example.com' })
    assert.equal(form.status, 200)
    assertPage(form)
    assert.ok((await form.text()).includes('确认邮件'))
    await h.app.outbox.drain()
    const m = rec.sent.findLast((x) => x.to === 'form@example.com')!
    assert.ok(m.subject.includes(evil), 'subject carries the name; nodemailer encodes it')
    assert.ok(m.html.includes('&#60;script&#62;') && !m.html.includes('<script>'))

    const bad = await postForm(h.base, '/v1/subscribe', { publisher: pub.fingerprint, email: '<b>@x' })
    assert.equal(bad.status, 400)
    assertPage(bad)
    assert.equal((await fetch(`${h.base}/s/not-a-fingerprint`)).status, 404)
    assert.equal((await fetch(`${h.base}/v1/subscribe`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415)
  } finally {
    await h.close()
  }
})

test('logs and stdout/stderr never contain addresses, letter text or tokens', async () => {
  const chunks: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  const capture =
    (orig: typeof process.stdout.write) =>
    (c: string | Uint8Array, ...rest: unknown[]): boolean => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'))
      return (orig as (c: string | Uint8Array, ...r: unknown[]) => boolean)(c, ...rest)
    }
  process.stdout.write = capture(origOut) as typeof process.stdout.write
  process.stderr.write = capture(origErr) as typeof process.stderr.write
  const { h, rec, pub, token } = await setup()
  try {
    const email = 'secret.person@private-domain.example'
    await subscribeAndConfirm(h, rec, pub, email)
    const confirmToken = tokenFrom(rec.sent[0].text, '/v1/subscribe/confirm')
    const secretLine = 'LETTERSECRET 周信正文不可出现在日志'
    await postLetter(h.base, token, letterText(pub, { markdown: secretLine, title: 'TITLESECRET' }))
    await h.app.outbox.drain()
    const unsub = tokenFrom(rec.sent.at(-1)!.headers!['List-Unsubscribe'], '/v1/unsubscribe')
    await fetch(`${h.base}/v1/unsubscribe?token=${encodeURIComponent(unsub)}`)
    await postForm(h.base, '/v1/unsubscribe', { token: unsub })
    await postForm(h.base, '/v1/resubscribe', { token: unsub, email })
    await fetch(`${h.base}/s/${pub.fingerprint}`)
    await fetch(`${h.base}/v1/cards/${pub.fingerprint}`, { headers: bearer(token) })
    await fetch(`${h.base}/v1/letters/by/${pub.fingerprint}`, { headers: bearer(token) })
    h.app.purge()

    const all = h.logs.join('\n') + chunks.join('')
    const routes = new Set(h.logs.map((l) => (JSON.parse(l) as { route: string }).route))
    for (const r of ['/v1/subscribe', '/v1/subscribe/confirm', '/v1/unsubscribe', '/v1/resubscribe', '/v1/letters', '/s/:fingerprint', '/v1/cards/:fingerprint', '/v1/letters/by/:fingerprint']) {
      assert.ok(routes.has(r), r)
    }
    for (const line of h.logs) assert.deepEqual(Object.keys(JSON.parse(line) as object).sort(), ['method', 'ms', 'req_id', 'route', 'status'])
    for (const f of [email, 'secret.person', 'private-domain', secretLine, 'LETTERSECRET', 'TITLESECRET', confirmToken, unsub, unsub.split('.')[1], pub.fingerprint, token]) {
      assert.ok(!all.includes(f), `leaked ${f.slice(0, 10)}…`)
    }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
    await h.close()
  }
})

test('account deletion cascades cards, letters, deliveries, subscribers (raw addresses), suppressions, queue', async () => {
  const { h, rec, pub, token } = await setup()
  try {
    const other = newKey()
    const ot = (await login(h.base, other)).token
    await putCard(h.base, token, signedCardText(pub))
    await putCard(h.base, ot, signedCardText(other))
    await subscribeAndConfirm(h, rec, pub, 'c1@example.com')
    await subscribeAndConfirm(h, rec, pub, 'c2@example.com')
    await subscribeAndConfirm(h, rec, other, 'keep@example.com')
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'pending@example.com')).status, 202) // confirm mail still queued
    await sendLetter(h, rec, pub, token)
    await postLetter(h.base, token, letterText(pub)) // queued, not drained
    const unsub = tokenFrom(rec.sent.findLast((m) => m.to === 'c2@example.com')!.text, '/v1/unsubscribe')
    await postForm(h.base, '/v1/unsubscribe', { token: unsub })

    const r = await fetch(`${h.base}/v1/account`, { method: 'DELETE', headers: bearer(token) })
    assert.equal(r.status, 204)
    for (const t of ['cards', 'card_counters', 'letters', 'deliveries', 'subscribers', 'suppressions']) {
      const n = (h.app.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`).get(pub.fingerprint) as { n: number }).n
      assert.equal(n, 0, t)
    }
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM confirm_queue').get() as { n: number }).n, 0)
    assertAddressGone(h, ['c1@example.com', 'c2@example.com', 'pending@example.com'])
    // the other publisher is intact
    assert.equal(status(h, 'keep@example.com'), 'confirmed')
    assert.equal((await fetch(`${h.base}/v1/cards/${other.fingerprint}`, { headers: bearer(ot) })).status, 200)
    for (const t of ['cards', 'card_counters', 'letters', 'deliveries', 'subscribers', 'suppressions', 'confirm_queue']) {
      const fks = h.app.db.prepare(`SELECT "table" AS t, on_delete FROM pragma_foreign_key_list('${t}')`).all() as Array<{ t: string; on_delete: string }>
      assert.ok(fks.length > 0 && fks.every((f) => f.on_delete === 'CASCADE'), `${t} FKs cascade`)
    }
  } finally {
    await h.close()
  }
})

test('retention: letter body purged 30 d after deliveries are terminal; delivery rows after 90 d', async () => {
  const { h, rec, pub, token } = await setup()
  try {
    await subscribeAndConfirm(h, rec, pub, 'ret@example.com')
    const r = await postLetter(h.base, token, letterText(pub))
    const { letter_id } = (await r.json()) as { letter_id: string }
    const envelope = (): string | null => (h.app.db.prepare('SELECT envelope FROM letters WHERE id = ?').get(letter_id) as { envelope: string | null }).envelope

    h.clock.t += 31 * 24 * 3600 * 1000
    h.app.purge() // delivery still queued → expires after 7 d → becomes terminal now; body kept 30 more days
    assert.notEqual(envelope(), null)
    h.clock.t += 30 * 24 * 3600 * 1000
    h.app.purge()
    assert.equal(envelope(), null)
    const reader = (await login(h.base, newKey())).token
    assert.deepEqual(await (await fetch(`${h.base}/v1/letters/by/${pub.fingerprint}`, { headers: bearer(reader) })).json(), [])
    const meta = (await (await fetch(`${h.base}/v1/letters`, { headers: bearer(token) })).json()) as unknown[]
    assert.equal(meta.length, 1, 'metadata kept')
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number }).n, 1)
    h.clock.t += 60 * 24 * 3600 * 1000
    h.app.purge()
    assert.equal((h.app.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number }).n, 0)
  } finally {
    await h.close()
  }
})
