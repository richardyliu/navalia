// C9 weekly letters + email subscriptions (double opt-in, RFC 8058 one-click unsubscribe).
//
// Privacy rules enforced here:
// - Raw addresses exist only in subscribers.email. Unsubscribe / removal deletes the row and
//   keeps only HMAC(pepper, lowercased address) in `suppressions`.
// - Public endpoints never reveal whether an address is known, subscribed or suppressed.
// - No open/click tracking: mails contain no images and no rewritten links; the only
//   per-recipient URL is the unsubscribe link.
// - Nothing here logs.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EMAIL_RE } from './config.ts'
import { tx, type Db } from './db.ts'
import { HttpError, isFormType, isJsonRequest, queryParams, readForm, readJson, sendJson } from './http.ts'
import { esc, hiddenInput, sendPage, shortFingerprint } from './html.ts'
import { publishedDisplayName, FINGERPRINT_RE } from './cards.ts'
import { fromNameFor, maskEmail } from './mail.ts'
import { emailHash, parseUnsubscribeToken } from './secrets.ts'
import { verifyLetterText } from './signed.ts'

/** Envelope text cap (100 000 CJK chars ≈ 300 KB UTF-8). */
export const LETTER_MAX_BYTES = 512 * 1024
/** Body cap for POST /v1/letters: the envelope is a JSON string inside JSON, escaping can double it. */
export const LETTER_BODY_LIMIT_BYTES = 1024 * 1024
export const FORM_LIMIT_BYTES = 4 * 1024
export const LETTERS_PER_DAY = 10
export const LETTERS_BY_LIMIT = 12
export const CONFIRM_TTL_MS = 48 * 3600 * 1000
export const CONFIRM_MAILS_PER_ADDRESS_PER_DAY = 3
export const MAX_SUBSCRIBERS_PER_PUBLISHER = 10_000
export const DAY_MS = 24 * 3600 * 1000
export const QUEUED_EXPIRE_MS = 7 * DAY_MS
export const BODY_RETENTION_MS = 30 * DAY_MS
export const DELIVERY_RETENTION_MS = 90 * DAY_MS

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONFIRM_TOKEN = /^[A-Za-z0-9_-]{43}$/

export interface LetterDeps {
  db: Db
  now: () => number
  origin: string
  pepper: string
  mailEnabled: boolean
  /** Ask the outbox worker to drain soon. */
  poke: () => void
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const iso = (ms: number): string => new Date(ms).toISOString()

// ───────────────────────────── letters (publisher, Bearer) ─────────────────────────────

export async function publishLetter(d: LetterDeps, req: IncomingMessage, accountId: string): Promise<{ letter_id: string; issue_id: string; recipients: number }> {
  const body = (await readJson(req, LETTER_BODY_LIMIT_BYTES, true))!
  const text = body.letter
  if (typeof text !== 'string' || text === '') throw new HttpError(400, 'invalid_request', 'letter must be the signed envelope JSON text')
  if (Buffer.byteLength(text, 'utf8') > LETTER_MAX_BYTES) throw new HttpError(413, 'payload_too_large', 'Letter exceeds 512 KiB')
  const v = verifyLetterText(text)
  if (!v.valid) throw new HttpError(400, 'letter_invalid', 'Letter does not parse or its signature does not verify')
  const l = v.letter
  if (l.signer.fingerprint !== accountId) throw new HttpError(403, 'letter_not_owner', 'Letter is signed by a different key than this account')
  const now = d.now()

  return tx(d.db, () => {
    const dup = d.db.prepare('SELECT 1 FROM letters WHERE account_id = ? AND issue_id = ?').get(accountId, l.issue_id)
    if (dup) throw new HttpError(409, 'duplicate_issue', 'This issue_id was already published')
    const recent = (d.db.prepare('SELECT COUNT(*) AS n FROM letters WHERE account_id = ? AND published_at > ?').get(accountId, now - DAY_MS) as { n: number }).n
    if (recent >= LETTERS_PER_DAY) throw new HttpError(429, 'rate_limited', `At most ${LETTERS_PER_DAY} letters per 24 h`, { 'retry-after': '3600' })
    const letterId = randomUUID()
    d.db
      .prepare('INSERT INTO letters (id, account_id, issue_id, week, title, created_at, envelope, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(letterId, accountId, l.issue_id, l.week, l.title, l.created_at, text, now)
    const subs = d.db.prepare("SELECT id, email FROM subscribers WHERE account_id = ? AND status = 'confirmed' ORDER BY created_at, rowid").all(accountId) as Array<{
      id: string
      email: string
    }>
    const ins = d.db.prepare(
      "INSERT INTO deliveries (letter_id, account_id, subscriber_id, email_masked, status, attempts, next_attempt_at, created_at, updated_at, error_code) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)"
    )
    for (const s of subs) ins.run(letterId, accountId, s.id, maskEmail(s.email), now, now, now, d.mailEnabled ? null : 'mail_disabled')
    queueMicrotask(d.poke)
    return { letter_id: letterId, issue_id: l.issue_id, recipients: subs.length }
  })
}

type Counts = { queued: number; sent: number; failed: number; suppressed: number }

export function listLetters(d: LetterDeps, accountId: string): unknown[] {
  const letters = d.db
    .prepare('SELECT id, issue_id, week, title, created_at FROM letters WHERE account_id = ? ORDER BY published_at DESC, rowid DESC')
    .all(accountId) as Array<{ id: string; issue_id: string; week: string; title: string; created_at: string }>
  const countStmt = d.db.prepare('SELECT status, COUNT(*) AS n FROM deliveries WHERE letter_id = ? GROUP BY status')
  return letters.map((l) => {
    const counts: Counts = { queued: 0, sent: 0, failed: 0, suppressed: 0 }
    for (const r of countStmt.all(l.id) as Array<{ status: string; n: number }>) {
      const k = (r.status === 'sending' ? 'queued' : r.status) as keyof Counts
      counts[k] += r.n
    }
    return { letter_id: l.id, issue_id: l.issue_id, week: l.week, title: l.title, created_at: l.created_at, counts }
  })
}

export function listDeliveries(d: LetterDeps, accountId: string, letterId: string): unknown[] {
  const owner = UUID.test(letterId) ? d.db.prepare('SELECT 1 FROM letters WHERE id = ? AND account_id = ?').get(letterId, accountId) : undefined
  if (!owner) throw new HttpError(404, 'not_found', 'No such letter')
  const rows = d.db
    .prepare('SELECT subscriber_id, email_masked, status, attempts, updated_at, error_code FROM deliveries WHERE letter_id = ? ORDER BY id')
    .all(letterId) as Array<{ subscriber_id: string; email_masked: string; status: string; attempts: number; updated_at: number; error_code: string | null }>
  return rows.map((r) => ({
    subscriber_id: r.subscriber_id,
    email_masked: r.email_masked,
    status: r.status === 'sending' ? 'queued' : r.status,
    attempts: r.attempts,
    updated_at: iso(r.updated_at),
    error_code: r.error_code
  }))
}

export function lettersBy(d: LetterDeps, fingerprint: string): unknown[] {
  if (!FINGERPRINT_RE.test(fingerprint)) throw new HttpError(400, 'invalid_request', 'fingerprint must be 64 lowercase hex characters')
  const rows = d.db
    .prepare('SELECT envelope, published_at FROM letters WHERE account_id = ? AND envelope IS NOT NULL ORDER BY published_at DESC, rowid DESC LIMIT ?')
    .all(fingerprint, LETTERS_BY_LIMIT) as Array<{ envelope: string; published_at: number }>
  return rows.map((r) => ({ letter: r.envelope, published_at: iso(r.published_at) }))
}

// ───────────────────────────── subscribers (publisher, Bearer) ─────────────────────────────

export function listSubscribers(d: LetterDeps, accountId: string): unknown[] {
  const rows = d.db
    .prepare('SELECT id, email, status, created_at, confirmed_at FROM subscribers WHERE account_id = ? ORDER BY created_at, rowid')
    .all(accountId) as Array<{ id: string; email: string; status: string; created_at: number; confirmed_at: number | null }>
  return rows.map((r) => ({
    subscriber_id: r.id,
    email_masked: maskEmail(r.email),
    status: r.status,
    created_at: iso(r.created_at),
    confirmed_at: r.confirmed_at === null ? null : iso(r.confirmed_at)
  }))
}

/** Deletes the subscriber (raw address gone), records the suppression hash, stops queued mail. */
function removeSubscriber(d: LetterDeps, sub: { id: string; account_id: string; email_hash: string }, reason: string): void {
  const now = d.now()
  d.db
    .prepare(
      'INSERT INTO suppressions (account_id, email_hash, former_subscriber_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, email_hash) DO UPDATE SET former_subscriber_id = excluded.former_subscriber_id, created_at = excluded.created_at'
    )
    .run(sub.account_id, sub.email_hash, sub.id, now)
  d.db
    .prepare("UPDATE deliveries SET status = 'suppressed', error_code = ?, updated_at = ? WHERE subscriber_id = ? AND status = 'queued'")
    .run(reason, now, sub.id)
  d.db.prepare('DELETE FROM subscribers WHERE id = ?').run(sub.id) // cascades confirm_queue (raw token)
}

export function deleteSubscriber(d: LetterDeps, accountId: string, id: string): void {
  const sub = UUID.test(id)
    ? (d.db.prepare('SELECT id, account_id, email_hash FROM subscribers WHERE id = ? AND account_id = ?').get(id, accountId) as
        | { id: string; account_id: string; email_hash: string }
        | undefined)
    : undefined
  if (!sub) throw new HttpError(404, 'not_found', 'No such subscriber')
  tx(d.db, () => removeSubscriber(d, sub, 'removed'))
}

// ───────────────────────────── public: subscribe / confirm / unsubscribe ─────────────────────────────

/**
 * Starts double opt-in. Silent no-op (same response to the caller) when: publisher unknown,
 * mail disabled, address suppressed (unless `resubscribe`), already confirmed, per-address
 * confirmation cap reached, or publisher at the subscriber cap.
 */
export function requestSubscription(d: LetterDeps, publisher: string, email: string, resubscribe = false): void {
  if (!d.mailEnabled) return
  const now = d.now()
  const hash = emailHash(d.pepper, email)
  tx(d.db, () => {
    if (!d.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(publisher)) return
    if (!resubscribe && d.db.prepare('SELECT 1 FROM suppressions WHERE account_id = ? AND email_hash = ?').get(publisher, hash)) return
    const sub = d.db.prepare('SELECT id, status FROM subscribers WHERE account_id = ? AND email_hash = ?').get(publisher, hash) as
      | { id: string; status: string }
      | undefined
    if (sub?.status === 'confirmed') return
    const sent = (d.db.prepare('SELECT COUNT(*) AS n FROM confirm_sends WHERE email_hash = ? AND sent_at > ?').get(hash, now - DAY_MS) as { n: number }).n
    if (sent >= CONFIRM_MAILS_PER_ADDRESS_PER_DAY) return
    const token = randomBytes(32).toString('base64url')
    let id: string
    if (sub) {
      id = sub.id
      d.db.prepare('UPDATE subscribers SET email = ?, confirm_token_hash = ?, confirm_expires_at = ? WHERE id = ?').run(email, sha256(token), now + CONFIRM_TTL_MS, id)
      d.db.prepare('DELETE FROM confirm_queue WHERE subscriber_id = ?').run(id)
    } else {
      const n = (d.db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE account_id = ?').get(publisher) as { n: number }).n
      if (n >= MAX_SUBSCRIBERS_PER_PUBLISHER) return
      id = randomUUID()
      d.db
        .prepare(
          "INSERT INTO subscribers (id, account_id, email, email_hash, status, created_at, confirm_token_hash, confirm_expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)"
        )
        .run(id, publisher, email, hash, now, sha256(token), now + CONFIRM_TTL_MS)
    }
    d.db.prepare("INSERT INTO confirm_queue (subscriber_id, token, status, attempts, next_attempt_at) VALUES (?, ?, 'queued', 0, ?)").run(id, token, now)
    d.db.prepare('INSERT INTO confirm_sends (email_hash, sent_at) VALUES (?, ?)').run(hash, now)
  })
  queueMicrotask(d.poke)
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim()
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null
}

const CHECK_MAIL =
  '<p>如果这个地址可以订阅，你会收到一封确认邮件。点击邮件里的链接后才算订阅成功；48 小时内未确认则自动作废。</p>' +
  '<p class="muted">出于隐私考虑，这个页面不会告诉你这个地址是否已经订阅过。</p>'

/** POST /v1/subscribe — JSON (Lens / API) or form (the /s/:fingerprint page). */
export async function handleSubscribe(d: LetterDeps, req: IncomingMessage, res: ServerResponse, limitPublisher: (fp: string) => void): Promise<void> {
  if (isFormType(req)) {
    const f = await readForm(req, FORM_LIMIT_BYTES)
    const publisher = f.get('publisher') ?? ''
    const email = normalizeEmail(f.get('email'))
    if (!FINGERPRINT_RE.test(publisher) || !email) {
      sendPage(res, 400, '地址无效', '<p>请返回上一页，填写一个有效的邮箱地址。</p>')
      return
    }
    limitPublisher(publisher)
    requestSubscription(d, publisher, email)
    sendPage(res, 200, '请查收确认邮件', CHECK_MAIL)
    return
  }
  if (!isJsonRequest(req) && req.headers['content-type'] !== undefined) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json or application/x-www-form-urlencoded')
  }
  const body = (await readJson(req, FORM_LIMIT_BYTES, true))!
  const publisher = body.publisher
  const email = normalizeEmail(body.email)
  if (typeof publisher !== 'string' || !FINGERPRINT_RE.test(publisher)) throw new HttpError(400, 'invalid_request', 'publisher must be a 64-hex fingerprint')
  if (!email) throw new HttpError(400, 'invalid_request', 'email must be a valid ASCII email address')
  limitPublisher(publisher)
  requestSubscription(d, publisher, email)
  sendJson(res, 202, { status: 'pending' })
}

/** GET /s/:fingerprint — public subscribe form. */
export function subscribePage(d: LetterDeps, res: ServerResponse, fp: string): void {
  if (!FINGERPRINT_RE.test(fp)) {
    sendPage(res, 404, '找不到这个页面', '<p>链接不完整或已失效。</p>')
    return
  }
  const name = publishedDisplayName(d.db, fp)
  const who = name ? `「${esc(fromNameFor(name))}」` : '这位发布者'
  sendPage(
    res,
    200,
    '订阅周信',
    `<p>订阅${who}的 Persome 周信。发布者指纹：<code>${esc(shortFingerprint(fp))}</code></p>` +
      `<form method="post" action="/v1/subscribe">${hiddenInput('publisher', fp)}` +
      `<label>邮箱<br><input type="email" name="email" required maxlength="254" autocomplete="email"></label><br>` +
      `<button type="submit">订阅</button></form>` +
      `<p class="muted">提交后会收到一封确认邮件（双重确认）。每封周信都带一键退订链接。邮件不含追踪像素，链接不会被改写。</p>`
  )
}

/** GET /v1/subscribe/confirm?token= — never confirms (link scanners prefetch GETs). */
export function confirmPage(res: ServerResponse, req: IncomingMessage): void {
  const token = queryParams(req).get('token') ?? ''
  if (!CONFIRM_TOKEN.test(token)) {
    sendPage(res, 400, '链接无效', '<p>确认链接不完整或已失效。</p>')
    return
  }
  sendPage(
    res,
    200,
    '确认订阅',
    `<p>点击下面的按钮完成订阅。</p><form method="post" action="/v1/subscribe/confirm">${hiddenInput('token', token)}<button type="submit">确认订阅</button></form>`
  )
}

/** POST /v1/subscribe/confirm (form token). */
export async function confirmSubscription(d: LetterDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = (await readForm(req, FORM_LIMIT_BYTES)).get('token') ?? ''
  const now = d.now()
  const ok =
    CONFIRM_TOKEN.test(token) &&
    tx(d.db, () => {
      const sub = d.db.prepare("SELECT id, account_id, email_hash, confirm_expires_at FROM subscribers WHERE confirm_token_hash = ? AND status = 'pending'").get(sha256(token)) as
        | { id: string; account_id: string; email_hash: string; confirm_expires_at: number }
        | undefined
      if (!sub || sub.confirm_expires_at <= now) return false
      d.db
        .prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, confirm_token_hash = NULL, confirm_expires_at = NULL WHERE id = ?")
        .run(now, sub.id)
      d.db.prepare('DELETE FROM confirm_queue WHERE subscriber_id = ?').run(sub.id)
      // Double opt-in lifts an earlier suppression for this publisher.
      d.db.prepare('DELETE FROM suppressions WHERE account_id = ? AND email_hash = ?').run(sub.account_id, sub.email_hash)
      return true
    })
  if (!ok) {
    sendPage(res, 400, '链接无效或已过期', '<p>这个确认链接无效、已经用过或已超过 48 小时。可以回到订阅页重新提交。</p>')
    return
  }
  sendPage(res, 200, '订阅成功', '<p>你已订阅。每封周信底部都有一键退订链接。</p>')
}

/** GET /v1/unsubscribe?token= — confirmation page only (no state change). */
export function unsubscribePage(d: LetterDeps, req: IncomingMessage, res: ServerResponse): void {
  const token = queryParams(req).get('token') ?? ''
  if (!parseUnsubscribeToken(d.pepper, token)) {
    sendPage(res, 400, '链接无效', '<p>退订链接不完整或已失效。</p>')
    return
  }
  sendPage(
    res,
    200,
    '退订周信',
    `<p>点击下面的按钮立即退订，之后不会再收到这位发布者的周信。</p><form method="post" action="/v1/unsubscribe">${hiddenInput('token', token)}<button type="submit">退订</button></form>`
  )
}

/** POST /v1/unsubscribe — form `token`, or RFC 8058 body `List-Unsubscribe=One-Click` with ?token=. Idempotent. */
export async function unsubscribe(d: LetterDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req, FORM_LIMIT_BYTES)
  const token = form.get('token') ?? queryParams(req).get('token') ?? ''
  const id = parseUnsubscribeToken(d.pepper, token)
  if (!id) {
    sendPage(res, 400, '链接无效', '<p>退订链接不完整或已失效。</p>')
    return
  }
  tx(d.db, () => {
    const sub = d.db.prepare('SELECT id, account_id, email_hash FROM subscribers WHERE id = ?').get(id) as
      | { id: string; account_id: string; email_hash: string }
      | undefined
    if (sub) removeSubscriber(d, sub, 'unsubscribed')
  })
  sendPage(
    res,
    200,
    '已退订',
    '<p>你已退订，不会再收到这位发布者的周信。我们删除了你的邮箱地址，只保留一个无法还原的散列值，用来保证不再给你发信。</p>' +
      `<p class="muted">点错了？输入邮箱重新订阅（仍需邮件确认）：</p><form method="post" action="/v1/resubscribe">${hiddenInput('token', token)}` +
      `<input type="email" name="email" required maxlength="254" autocomplete="email"><br><button type="submit">重新订阅</button></form>`
  )
}

/**
 * POST /v1/resubscribe (form token + email). A suppressed address can only re-enter double
 * opt-in through a link that was mailed to it (the unsubscribe token) plus the matching address.
 */
export async function resubscribe(d: LetterDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req, FORM_LIMIT_BYTES)
  const id = parseUnsubscribeToken(d.pepper, form.get('token'))
  const email = normalizeEmail(form.get('email'))
  if (id && email) {
    const sup = d.db.prepare('SELECT account_id, email_hash FROM suppressions WHERE former_subscriber_id = ?').get(id) as
      | { account_id: string; email_hash: string }
      | undefined
    if (sup && sup.email_hash === emailHash(d.pepper, email)) requestSubscription(d, sup.account_id, email, true)
  }
  sendPage(res, 200, '请查收确认邮件', CHECK_MAIL)
}

// ───────────────────────────── retention ─────────────────────────────

/** Periodic retention GC. Returns rows touched. */
export function purgeMailData(db: Db, now: number): number {
  let n = 0
  // Deliveries that could not be sent within 7 days (e.g. mail disabled) become terminal.
  n += Number(
    db.prepare("UPDATE deliveries SET status = 'failed', error_code = 'expired', updated_at = ? WHERE status = 'queued' AND created_at <= ?").run(now, now - QUEUED_EXPIRE_MS)
      .changes
  )
  // Letter bodies: 30 days after the last delivery became terminal (or after publish with no recipients).
  n += Number(
    db
      .prepare(
        `UPDATE letters SET envelope = NULL, purged_at = ?
         WHERE envelope IS NOT NULL AND published_at <= ?
           AND NOT EXISTS (SELECT 1 FROM deliveries WHERE letter_id = letters.id AND status IN ('queued', 'sending'))
           AND COALESCE((SELECT MAX(updated_at) FROM deliveries WHERE letter_id = letters.id), published_at) <= ?`
      )
      .run(now, now - BODY_RETENTION_MS, now - BODY_RETENTION_MS).changes
  )
  n += Number(
    db.prepare("DELETE FROM deliveries WHERE status IN ('sent', 'failed', 'suppressed') AND updated_at <= ?").run(now - DELIVERY_RETENTION_MS).changes
  )
  // Never-confirmed subscriptions disappear (with their raw address) once the token expired.
  n += Number(db.prepare("DELETE FROM subscribers WHERE status = 'pending' AND confirm_expires_at <= ?").run(now).changes)
  n += Number(db.prepare('DELETE FROM confirm_sends WHERE sent_at <= ?').run(now - DAY_MS).changes)
  return n
}
