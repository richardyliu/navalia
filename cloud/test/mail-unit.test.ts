import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, loadConfig } from '../src/config.ts'
import { DEFAULT_FROM_NAME, MailSendError, assertHeaderSafe, createMailer, fromNameFor, letterMail, maskEmail, simpleHtml } from '../src/mail.ts'
import { emailHash, parseUnsubscribeToken, unsubscribeToken } from '../src/secrets.ts'
import { canonicalize } from '../src/canonical.ts'
import { sortedJson } from './c89-helpers.ts'

test('config: mail modes, pepper, SMTP settings', () => {
  const base = { CLOUD_PUBLIC_ORIGIN: 'https://cloud.example.com' }
  const pep = { CLOUD_EMAIL_PEPPER: 'q'.repeat(32) }
  const off = loadConfig(base)
  assert.equal(off.mail.mode, null)
  assert.equal(off.emailPepper, null)
  assert.equal(createMailer(off.mail), null)

  const smtp = loadConfig({ ...base, ...pep, CLOUD_MAIL_MODE: 'smtp', CLOUD_MAIL_FROM: 'letters@example.com', CLOUD_SMTP_HOST: 'smtp.example.com', CLOUD_SMTP_USER: 'u', CLOUD_SMTP_PASS: 'p' })
  assert.deepEqual(smtp.mail.smtp, { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p' })
  assert.equal(loadConfig({ ...base, ...pep, CLOUD_MAIL_MODE: 'smtp', CLOUD_MAIL_FROM: 'a@example.com', CLOUD_SMTP_HOST: 'h', CLOUD_SMTP_SECURE: '1' }).mail.smtp.port, 465)
  const outbox = loadConfig({ ...base, CLOUD_MAIL_MODE: 'outbox', CLOUD_MAIL_FROM: 'a@example.com', CLOUD_MAIL_OUTBOX_DIR: '/tmp/x' })
  assert.equal(outbox.mail.outboxDir, '/tmp/x')
  assert.equal(loadConfig({ ...base, CLOUD_EMAIL_PEPPER: 'p'.repeat(32) }).emailPepper, 'p'.repeat(32))

  for (const env of [
    { CLOUD_MAIL_MODE: 'sendmail' },
    { CLOUD_MAIL_MODE: 'smtp', CLOUD_MAIL_FROM: 'a@example.com' },
    { CLOUD_MAIL_MODE: 'smtp', CLOUD_MAIL_FROM: 'a@example.com\r\nBcc: x@y.z', CLOUD_SMTP_HOST: 'h' },
    { CLOUD_MAIL_MODE: 'smtp', CLOUD_MAIL_FROM: 'Name <a@example.com>', CLOUD_SMTP_HOST: 'h' },
    { CLOUD_MAIL_MODE: 'smtp', CLOUD_MAIL_FROM: 'a@example.com', CLOUD_SMTP_HOST: 'h', CLOUD_SMTP_USER: 'u' },
    { CLOUD_MAIL_MODE: 'outbox', CLOUD_MAIL_FROM: 'a@example.com' },
    { CLOUD_EMAIL_PEPPER: 'short' },
    // smtp without an env pepper: refused (a DB-stored pepper would sit next to the hashes it protects)
    { CLOUD_MAIL_MODE: 'smtp', CLOUD_MAIL_FROM: 'a@example.com', CLOUD_SMTP_HOST: 'h' }
  ]) {
    assert.throws(() => loadConfig({ ...base, ...env }), ConfigError, JSON.stringify(env))
  }
})

test('mail: header injection rejected; names, masking, escaping', async () => {
  const ok = letterMail({ to: 'a@example.com', fromName: '小明', title: 't', markdown: 'm', unsubscribeUrl: 'https://x/v1/unsubscribe?token=a', origin: 'https://x' })
  assert.doesNotThrow(() => assertHeaderSafe(ok, 'l@example.com'))
  for (const bad of [
    { ...ok, subject: 'a\r\nBcc: v@example.com' },
    { ...ok, to: 'a@example.com\nBcc: v@example.com' },
    { ...ok, fromName: 'x\ry' },
    { ...ok, headers: { 'X-A': 'b\nc' } }
  ]) {
    assert.throws(() => assertHeaderSafe(bad, 'l@example.com'), (e: unknown) => e instanceof MailSendError && e.code === 'header_unsafe' && e.permanent)
  }
  // the mailer refuses before touching the transport
  const outbox = createMailer({ mode: 'outbox', from: 'l@example.com', outboxDir: '/nonexistent-should-not-be-created', smtp: { host: '', port: 0, secure: false, user: '', pass: '' } })!
  await assert.rejects(outbox.send({ ...ok, subject: 'x\r\nBcc: v@example.com' }), (e: unknown) => e instanceof MailSendError && e.code === 'header_unsafe')

  assert.equal(fromNameFor(null), DEFAULT_FROM_NAME)
  assert.equal(fromNameFor('  '), DEFAULT_FROM_NAME)
  assert.equal(fromNameFor('a\nb'), DEFAULT_FROM_NAME)
  assert.equal(fromNameFor(' 小明 '), '小明')
  assert.equal(maskEmail('alice@Example.COM'), 'a***@example.com')
  assert.equal(simpleHtml('a <b>\nc\n\n"d" & e'), '<p>a &#60;b&#62;<br>c</p>\n<p>&#34;d&#34; &#38; e</p>')
})

test('secrets: unsubscribe tokens are authentic and pepper-bound; email hash is case-insensitive', () => {
  const id = '6f1c1f0e-2b7a-4c1e-9a43-0d6f8f6f2b11'
  const t = unsubscribeToken('pepper-one'.padEnd(32, 'x'), id)
  assert.equal(parseUnsubscribeToken('pepper-one'.padEnd(32, 'x'), t), id)
  assert.equal(parseUnsubscribeToken('pepper-two'.padEnd(32, 'x'), t), null)
  assert.equal(parseUnsubscribeToken('pepper-one'.padEnd(32, 'x'), t.replace(id, '6f1c1f0e-2b7a-4c1e-9a43-0d6f8f6f2b12')), null)
  assert.equal(parseUnsubscribeToken('p', null), null)
  assert.equal(emailHash('p', 'A@Example.com'), emailHash('p', ' a@example.com '))
  assert.notEqual(emailHash('p', 'a@example.com'), emailHash('q', 'a@example.com'))
})

test('canonical.ts (port of Lens JCS) agrees with an independent sorted-keys serializer', () => {
  const v = { b: [1, 2.5, -0, 1e21, 'é😀 ', null, true], a: { 'zé': 1, Z: { y: '"\\\n\t' } }, '': 0 }
  assert.equal(canonicalize(v), sortedJson(v).replace('-0', '0'))
  assert.throws(() => canonicalize({ s: '\ud800' }))
})
