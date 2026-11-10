import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { verifyLetterText } from '../src/signed.ts'
import { MailSendError } from '../src/mail.ts'
import { MAIL_DISABLED, type MailConfig } from '../src/config.ts'
import { AUDIENCE, bearer, errorCode, login, makeTempDir, newKey, removeTempDir, startHarness, type Harness, type TestKey } from './helpers.ts'
import {
  letterText,
  letterUnsigned,
  decodeWords,
  parseMime,
  postForm,
  postLetter,
  putCard,
  recordingMailer,
  signLetter,
  signedCardText,
  cardBody,
  startFakeSmtp,
  subscribeJson,
  tokenFrom,
  type RecordingMailer
} from './c89-helpers.ts'

const smtpConfig = (port: number): MailConfig => ({
  mode: 'smtp',
  from: 'letters@cloud.test.invalid',
  outboxDir: '',
  smtp: { host: '127.0.0.1', port, secure: false, user: '', pass: '' }
})

/** Subscribes + confirms `email` to `pub` through the public endpoints. Returns subscriber confirm token. */
async function confirmedSubscriber(h: Harness, rec: RecordingMailer, pub: TestKey, email: string): Promise<void> {
  assert.equal((await subscribeJson(h.base, pub.fingerprint, email)).status, 202)
  await h.app.outbox.drain()
  const mail = rec.sent.findLast((m) => m.to === email)
  assert.ok(mail, 'confirmation mail sent')
  const token = tokenFrom(mail.text, '/v1/subscribe/confirm')
  const r = await postForm(h.base, '/v1/subscribe/confirm', { token })
  assert.equal(r.status, 200)
}

test('verifyLetterText: valid, tampered, forged, wrong fingerprint, bad fields', () => {
  const key = newKey()
  const other = newKey()
  const text = letterText(key)
  const v = verifyLetterText(text)
  assert.equal(v.valid, true)

  const tampered = text.replace('做了很多事', '什么也没做')
  assert.notEqual(tampered, text)
  assert.equal((verifyLetterText(tampered) as { reason: string }).reason, 'signature')
  assert.equal((verifyLetterText(letterText(key, {}, other)) as { reason: string }).reason, 'signature')

  const u = letterUnsigned(key)
  ;(u.signer as { fingerprint: string }).fingerprint = other.fingerprint
  assert.equal((verifyLetterText(signLetter(u, key)) as { reason: string }).reason, 'fingerprint')

  for (const o of [{ title: '换行\n标题' }, { title: 'x'.repeat(201) }, { week: '2026-W54' }, { issueId: 'not-a-uuid' }, { markdown: '' }, { createdAt: 'yesterday' }]) {
    assert.equal((verifyLetterText(letterText(key, o)) as { reason: string }).reason, 'schema', JSON.stringify(o))
  }
  const extra = JSON.parse(text) as Record<string, unknown>
  extra.tracking = true
  assert.equal((verifyLetterText(JSON.stringify(extra)) as { reason: string }).reason, 'schema')
  // Domain separation: a signature over the bare canonical JSON (card-style) does not verify.
  assert.equal(verifyLetterText(text.replace(/"signature":"[^"]+"/, `"signature":"${'A'.repeat(86)}"`)).valid, false)
})

test('letter happy path through a fake SMTP server: headers, no tracking, deliveries, by-fingerprint', async () => {
  const smtp = await startFakeSmtp()
  const h = await startHarness({ mail: smtpConfig(smtp.port) })
  try {
    const pub = newKey()
    const t = (await login(h.base, pub)).token
    assert.equal((await putCard(h.base, t, signedCardText(pub, cardBody(pub, { displayName: '小明 Ming' })))).status, 200)

    // double opt-in through real SMTP
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'Reader@Example.com')).status, 202)
    await h.app.outbox.drain()
    assert.equal(smtp.messages.length, 1)
    const confirm = parseMime(smtp.messages[0].data)
    assert.deepEqual(smtp.messages[0].to, ['Reader@example.com'], 'nodemailer lowercases the domain only')
    const ctoken = tokenFrom(confirm.text, '/v1/subscribe/confirm')
    assert.ok(confirm.text.includes(`${AUDIENCE}/v1/subscribe/confirm?token=`))
    assert.equal((await postForm(h.base, '/v1/subscribe/confirm', { token: ctoken })).status, 200)

    const md = '# 本周\n\n做了 <b>很多</b> 事。\n\n链接：https://example.org/a?b=1&c=2\n\n![图](https://tracker.example/p.png)'
    const text = letterText(pub, { markdown: md, title: '第 45 周：小结' })
    const r = await postLetter(h.base, t, text)
    assert.equal(r.status, 202)
    const pj = (await r.json()) as { letter_id: string; issue_id: string; recipients: number }
    assert.equal(pj.recipients, 1)
    assert.equal(pj.issue_id, (JSON.parse(text) as { issue_id: string }).issue_id)

    const before = await (await fetch(`${h.base}/v1/letters/${pj.letter_id}/deliveries`, { headers: bearer(t) })).json()
    assert.deepEqual((before as Array<{ status: string }>).map((d) => d.status), ['queued'])

    const stats = await h.app.outbox.drain()
    assert.equal(stats.sent, 1)
    assert.equal(smtp.messages.length, 2)
    const msg = smtp.messages[1]
    assert.deepEqual(msg.to, ['Reader@example.com'])
    assert.equal(msg.from, 'letters@cloud.test.invalid')
    const mail = parseMime(msg.data)
    assert.match(mail.headers, /^List-Unsubscribe: <https:\/\/cloud\.test\.invalid\/v1\/unsubscribe\?token=[^>]+>$/m)
    assert.match(mail.headers, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)
    assert.match(mail.headers, /^Subject: =\?UTF-8\?/m)
    const fromLine = /^From: (.*)$/m.exec(mail.headers)![1]
    assert.match(fromLine, /=\?UTF-8\?/)
    assert.equal(decodeWords(fromLine), '小明 Ming <letters@cloud.test.invalid>')
    assert.equal(decodeWords(/^Subject: (.*)$/m.exec(mail.headers)![1]), '第 45 周：小结')
    assert.ok(!/^Reply-To:/im.test(mail.headers))
    // body: original markdown in text part, escaped in html, links untouched, no tracking
    assert.ok(mail.text.includes('链接：https://example.org/a?b=1&c=2'))
    assert.ok(mail.text.includes(`你在 ${AUDIENCE} 订阅了「小明 Ming」的周信`))
    assert.ok(mail.html.includes('做了 &#60;b&#62;很多&#60;/b&#62; 事。'))
    assert.ok(mail.html.includes('https://example.org/a?b&#61;1&#38;c&#61;2'))
    assert.ok(!/<img/i.test(mail.html), 'no images / pixels')
    const hrefs = [...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
    assert.equal(hrefs.length, 1, 'the only link is unsubscribe')
    assert.ok(hrefs[0].startsWith(`${AUDIENCE}/v1/unsubscribe?token&#61;`))
    const unsubToken = tokenFrom(mail.headers, '/v1/unsubscribe')
    assert.ok(mail.text.includes(unsubToken))

    const deliveries = (await (await fetch(`${h.base}/v1/letters/${pj.letter_id}/deliveries`, { headers: bearer(t) })).json()) as Array<Record<string, unknown>>
    assert.equal(deliveries.length, 1)
    assert.deepEqual(Object.keys(deliveries[0]).sort(), ['attempts', 'email_masked', 'error_code', 'status', 'subscriber_id', 'updated_at'])
    assert.equal(deliveries[0].status, 'sent')
    assert.equal(deliveries[0].email_masked, 'R***@example.com')
    assert.equal(deliveries[0].attempts, 1)
    assert.equal(deliveries[0].error_code, null)

    const list = (await (await fetch(`${h.base}/v1/letters`, { headers: bearer(t) })).json()) as Array<Record<string, unknown>>
    assert.equal(list.length, 1)
    assert.deepEqual(list[0], {
      letter_id: pj.letter_id,
      issue_id: pj.issue_id,
      week: '2026-W45',
      title: '第 45 周：小结',
      created_at: '2026-11-05T08:00:00.000Z',
      counts: { queued: 0, sent: 1, failed: 0, suppressed: 0 }
    })

    // Lens-to-Lens: any account can read the signed envelopes verbatim.
    const reader = (await login(h.base, newKey())).token
    const by = (await (await fetch(`${h.base}/v1/letters/by/${pub.fingerprint}`, { headers: bearer(reader) })).json()) as Array<{ letter: string; published_at: string }>
    assert.equal(by.length, 1)
    assert.equal(by[0].letter, text)
    assert.equal(verifyLetterText(by[0].letter).valid, true)

    // deliveries are owner-only
    const other = await fetch(`${h.base}/v1/letters/${pj.letter_id}/deliveries`, { headers: bearer(reader) })
    assert.equal(other.status, 404)
  } finally {
    await h.close()
    await smtp.close()
  }
})

test('letters: tampered/forged → 400 letter_invalid; other signer → 403; duplicate issue → 409; daily cap', async () => {
  const rec = recordingMailer()
  const h = await startHarness({ tokenTtlS: 365 * 24 * 3600 }, { mailer: rec.mailer })
  try {
    const pub = newKey()
    const other = newKey()
    const t = (await login(h.base, pub)).token
    const text = letterText(pub)
    for (const bad of [text.replace('做了很多事', '什么也没做'), letterText(pub, {}, other), '{}', 'nope']) {
      const r = await postLetter(h.base, t, bad)
      assert.equal(r.status, 400)
      assert.equal(await errorCode(r), 'letter_invalid')
    }
    const r403 = await postLetter(h.base, t, letterText(other))
    assert.equal(r403.status, 403)
    assert.equal(await errorCode(r403), 'letter_not_owner')

    assert.equal((await postLetter(h.base, t, text)).status, 202)
    const dup = await postLetter(h.base, t, text)
    assert.equal(dup.status, 409)
    assert.equal(await errorCode(dup), 'duplicate_issue')
    // Same issue_id, different content: still a duplicate.
    const issueId = (JSON.parse(text) as { issue_id: string }).issue_id
    assert.equal((await postLetter(h.base, t, letterText(pub, { issueId, title: '另一个' }))).status, 409)

    for (let i = 0; i < 9; i++) assert.equal((await postLetter(h.base, t, letterText(pub))).status, 202)
    const capped = await postLetter(h.base, t, letterText(pub))
    assert.equal(capped.status, 429)
    h.clock.t += 24 * 3600 * 1000 + 1
    assert.equal((await postLetter(h.base, t, letterText(pub))).status, 202)

    // 100 000-char CJK letter fits (body limit on this route is 1 MiB).
    const big = letterText(pub, { markdown: '字'.repeat(100_000) })
    assert.equal((await postLetter(h.base, t, big)).status, 202)
    assert.equal(await errorCode(await postLetter(h.base, t, letterText(pub, { markdown: '字'.repeat(100_001) }))), 'letter_invalid')
  } finally {
    await h.close()
  }
})

test('outbox: temporary SMTP failure retries with backoff (no tight loop) then fails; 5xx fails at once', async () => {
  const smtp = await startFakeSmtp()
  const h = await startHarness({ mail: smtpConfig(smtp.port), tokenTtlS: 365 * 24 * 3600 })
  try {
    const pub = newKey()
    const t = (await login(h.base, pub)).token
    // confirm one subscriber via the DB-backed flow
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'r1@example.com')).status, 202)
    await h.app.outbox.drain()
    const tok = tokenFrom(parseMime(smtp.messages[0].data).text, '/v1/subscribe/confirm')
    await postForm(h.base, '/v1/subscribe/confirm', { token: tok })

    smtp.rcptReply = () => '451 4.3.0 try later'
    const { letter_id } = (await (await postLetter(h.base, t, letterText(pub))).json()) as { letter_id: string }
    const row = (): { status: string; attempts: number; error_code: string | null; next_attempt_at: number } =>
      h.app.db.prepare('SELECT status, attempts, error_code, next_attempt_at FROM deliveries WHERE letter_id = ?').get(letter_id) as never

    let s = await h.app.outbox.drain()
    assert.deepEqual(s, { sent: 0, retried: 1, failed: 0, suppressed: 0 })
    assert.deepEqual({ ...row(), next_attempt_at: row().next_attempt_at - h.clock.t }, { status: 'queued', attempts: 1, error_code: 'smtp_temporary', next_attempt_at: 60_000 })
    const conns = smtp.connections
    s = await h.app.outbox.drain()
    assert.deepEqual(s, { sent: 0, retried: 0, failed: 0, suppressed: 0 }, 'not due yet: nothing claimed')
    assert.equal(smtp.connections, conns)

    h.clock.t += 60_000
    s = await h.app.outbox.drain()
    assert.equal(s.retried, 1)
    assert.equal(row().attempts, 2)
    assert.equal(row().next_attempt_at - h.clock.t, 5 * 60_000)
    h.clock.t += 5 * 60_000
    s = await h.app.outbox.drain()
    assert.equal(s.failed, 1)
    assert.deepEqual({ status: row().status, attempts: row().attempts, error_code: row().error_code }, { status: 'failed', attempts: 3, error_code: 'smtp_temporary' })
    h.clock.t += 3600_000
    assert.deepEqual(await h.app.outbox.drain(), { sent: 0, retried: 0, failed: 0, suppressed: 0 })

    smtp.rcptReply = () => '550 5.1.1 no such user'
    const second = (await (await postLetter(h.base, t, letterText(pub))).json()) as { letter_id: string }
    s = await h.app.outbox.drain()
    assert.equal(s.failed, 1)
    const d = (await (await fetch(`${h.base}/v1/letters/${second.letter_id}/deliveries`, { headers: bearer(t) })).json()) as Array<Record<string, unknown>>
    assert.deepEqual([d[0].status, d[0].attempts, d[0].error_code], ['failed', 1, 'smtp_rejected'])
  } finally {
    await h.close()
    await smtp.close()
  }
})

test('outbox: unreachable SMTP is a temporary error; bounded concurrency', async () => {
  const rec = recordingMailer()
  let inFlight = 0
  let peak = 0
  const slow = {
    async send(m: Parameters<typeof rec.mailer.send>[0]) {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      await rec.mailer.send(m)
    },
    close() {}
  }
  const h = await startHarness({}, { mailer: slow })
  try {
    const pub = newKey()
    const t = (await login(h.base, pub)).token
    for (let i = 0; i < 10; i++) await confirmedSubscriber(h, rec, pub, `p${i}@example.com`)
    rec.failWith = (m) => (m.to === 'p3@example.com' ? new MailSendError('smtp_unavailable', false) : null)
    const { recipients } = (await (await postLetter(h.base, t, letterText(pub))).json()) as { recipients: number }
    assert.equal(recipients, 10)
    peak = 0
    const s = await h.app.outbox.drain()
    assert.deepEqual(s, { sent: 9, retried: 1, failed: 0, suppressed: 0 })
    assert.ok(peak <= 4, `peak concurrency ${peak}`)
  } finally {
    await h.close()
  }
})

test('mail disabled: letters accepted, deliveries stay queued with error_code mail_disabled; subscribe sends nothing', async () => {
  const h = await startHarness({ mail: MAIL_DISABLED, tokenTtlS: 365 * 24 * 3600 })
  try {
    const pub = newKey()
    const t = (await login(h.base, pub)).token
    // a confirmed subscriber from before mail was turned off
    h.app.db
      .prepare("INSERT INTO subscribers (id, account_id, email, email_hash, status, created_at, confirmed_at) VALUES (?, ?, ?, ?, 'confirmed', 0, 0)")
      .run('00000000-0000-4000-8000-000000000001', pub.fingerprint, 'old@example.com', 'h')
    const r = await postLetter(h.base, t, letterText(pub))
    assert.equal(r.status, 202)
    const { letter_id, recipients } = (await r.json()) as { letter_id: string; recipients: number }
    assert.equal(recipients, 1)
    assert.deepEqual(await h.app.outbox.drain(), { sent: 0, retried: 0, failed: 0, suppressed: 0 })
    const d = (await (await fetch(`${h.base}/v1/letters/${letter_id}/deliveries`, { headers: bearer(t) })).json()) as Array<Record<string, unknown>>
    assert.deepEqual([d[0].status, d[0].error_code, d[0].email_masked], ['queued', 'mail_disabled', 'o***@example.com'])

    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'new@example.com')).status, 202)
    assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'pending'").get() as { n: number }).n, 0)

    // queued deliveries expire after 7 days so the body can be purged later
    h.clock.t += 7 * 24 * 3600 * 1000
    h.app.purge()
    const d2 = (await (await fetch(`${h.base}/v1/letters/${letter_id}/deliveries`, { headers: bearer(t) })).json()) as Array<Record<string, unknown>>
    assert.deepEqual([d2[0].status, d2[0].error_code], ['failed', 'expired'])
  } finally {
    await h.close()
  }
})

test('outbox mode writes 0600 .eml files and never uses the network', async () => {
  const dir = makeTempDir()
  const outDir = join(dir, 'outbox')
  const h = await startHarness({ mail: { ...MAIL_DISABLED, mode: 'outbox', from: 'letters@cloud.test.invalid', outboxDir: outDir } })
  try {
    const pub = newKey()
    await login(h.base, pub)
    assert.equal((await subscribeJson(h.base, pub.fingerprint, 'eml@example.com')).status, 202)
    await h.app.outbox.drain()
    const files = readdirSync(outDir)
    assert.equal(files.length, 1)
    assert.ok(files[0].endsWith('.eml') && !files[0].includes('eml@'))
    if (process.platform !== 'win32') {
      assert.equal(statSync(outDir).mode & 0o777, 0o700)
      assert.equal(statSync(join(outDir, files[0])).mode & 0o777, 0o600)
    }
    const raw = readFileSync(join(outDir, files[0]), 'utf8')
    assert.match(raw, /^To: eml@example\.com\r$/m)
    assert.ok(parseMime(raw).text.includes('/v1/subscribe/confirm?token='))
  } finally {
    await h.close()
    removeTempDir(dir)
  }
})
