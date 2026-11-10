// DB-backed outbox worker for confirmation mails and letter deliveries.
//
// - Rows are claimed atomically (status queued → sending) in batches of `concurrency`, so at
//   most `concurrency` sends are in flight.
// - ≤ MAX_ATTEMPTS attempts; between attempts next_attempt_at = now + backoff, so a drain never
//   re-claims a row it just failed (no tight loop). Permanent SMTP rejections (5xx) and
//   header-unsafe mails fail immediately.
// - start() polls every intervalMs (unref'd timer); poke() asks for a prompt drain; stop()
//   waits for the in-flight drain. Tests call drain() directly with an injected clock.
// - Nothing is logged.

import type { Db } from './db.ts'
import { publishedDisplayName } from './cards.ts'
import { MailSendError, confirmMail, fromNameFor, letterMail, type Mailer } from './mail.ts'
import { unsubscribeToken } from './secrets.ts'

export const MAX_ATTEMPTS = 3
export const BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000]

export interface OutboxDeps {
  db: Db
  now: () => number
  mailer: Mailer | null
  origin: string
  pepper: string
  concurrency?: number
  intervalMs?: number
}

export interface DrainStats {
  sent: number
  retried: number
  failed: number
  suppressed: number
}

interface DeliveryRow {
  id: number
  letter_id: string
  subscriber_id: string
  attempts: number
}

interface ConfirmRow {
  id: number
  subscriber_id: string
  token: string
  attempts: number
}

export class Outbox {
  private readonly d: OutboxDeps
  private readonly concurrency: number
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private running: Promise<DrainStats> | null = null
  private again = false

  constructor(d: OutboxDeps) {
    this.d = d
    this.concurrency = Math.max(1, d.concurrency ?? 4)
    this.intervalMs = d.intervalMs ?? 5000
    // Crash recovery: anything left "sending" by a previous process is retried.
    d.db.prepare("UPDATE deliveries SET status = 'queued' WHERE status = 'sending'").run()
    d.db.prepare("UPDATE confirm_queue SET status = 'queued' WHERE status = 'sending'").run()
  }

  get enabled(): boolean {
    return this.d.mailer !== null
  }

  start(): void {
    if (this.timer || !this.d.mailer) return
    this.timer = setInterval(() => this.poke(), this.intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.again = false
    if (this.running) await this.running.catch(() => undefined)
  }

  /** Schedule a drain soon (only while started). Never throws. */
  poke(): void {
    if (!this.timer) return
    if (this.running) {
      this.again = true
      return
    }
    void this.drain()
      .catch(() => undefined)
      .then(() => {
        if (this.again && this.timer) {
          this.again = false
          this.poke()
        }
      })
  }

  /** Sends everything currently due. Concurrent callers share one drain. */
  drain(): Promise<DrainStats> {
    if (this.running) return this.running
    this.running = this.drainOnce().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async drainOnce(): Promise<DrainStats> {
    const stats: DrainStats = { sent: 0, retried: 0, failed: 0, suppressed: 0 }
    if (!this.d.mailer) return stats
    for (;;) {
      const confirms = this.claimConfirms()
      const room = this.concurrency - confirms.length
      const deliveries = room > 0 ? this.claimDeliveries(room) : []
      if (confirms.length === 0 && deliveries.length === 0) break
      await Promise.all([...confirms.map((r) => this.sendConfirm(r, stats)), ...deliveries.map((r) => this.sendDelivery(r, stats))])
    }
    return stats
  }

  private claimConfirms(): ConfirmRow[] {
    return this.d.db
      .prepare(
        `UPDATE confirm_queue SET status = 'sending' WHERE id IN (
           SELECT id FROM confirm_queue WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT ?)
         RETURNING id, subscriber_id, token, attempts`
      )
      .all(this.d.now(), this.concurrency) as unknown as ConfirmRow[]
  }

  private claimDeliveries(n: number): DeliveryRow[] {
    return this.d.db
      .prepare(
        `UPDATE deliveries SET status = 'sending' WHERE id IN (
           SELECT id FROM deliveries WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT ?)
         RETURNING id, letter_id, subscriber_id, attempts`
      )
      .all(this.d.now(), n) as unknown as DeliveryRow[]
  }

  private retryAt(attempts: number): number {
    return this.d.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]
  }

  private async sendConfirm(r: ConfirmRow, stats: DrainStats): Promise<void> {
    const db = this.d.db
    const sub = db.prepare("SELECT email, account_id FROM subscribers WHERE id = ? AND status = 'pending'").get(r.subscriber_id) as
      | { email: string; account_id: string }
      | undefined
    if (!sub) {
      db.prepare('DELETE FROM confirm_queue WHERE id = ?').run(r.id)
      stats.suppressed++
      return
    }
    const name = fromNameFor(publishedDisplayName(db, sub.account_id))
    const url = `${this.d.origin}/v1/subscribe/confirm?token=${encodeURIComponent(r.token)}`
    try {
      await this.d.mailer!.send(confirmMail(sub.email, name, url, this.d.origin))
      // The raw token leaves the DB as soon as the mail is handed over.
      db.prepare('DELETE FROM confirm_queue WHERE id = ?').run(r.id)
      stats.sent++
    } catch (err) {
      const e = err instanceof MailSendError ? err : new MailSendError('smtp_unavailable', false)
      const attempts = r.attempts + 1
      if (e.permanent || attempts >= MAX_ATTEMPTS) {
        db.prepare('DELETE FROM confirm_queue WHERE id = ?').run(r.id)
        stats.failed++
      } else {
        db.prepare("UPDATE confirm_queue SET status = 'queued', attempts = ?, next_attempt_at = ? WHERE id = ?").run(attempts, this.retryAt(attempts), r.id)
        stats.retried++
      }
    }
  }

  private finish(id: number, status: 'sent' | 'failed' | 'suppressed' | 'queued', attempts: number, errorCode: string | null, nextAt?: number): void {
    const now = this.d.now()
    this.d.db
      .prepare('UPDATE deliveries SET status = ?, attempts = ?, error_code = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?')
      .run(status, attempts, errorCode, now, nextAt ?? now, id)
  }

  private async sendDelivery(r: DeliveryRow, stats: DrainStats): Promise<void> {
    const db = this.d.db
    const sub = db.prepare("SELECT email, account_id FROM subscribers WHERE id = ? AND status = 'confirmed'").get(r.subscriber_id) as
      | { email: string; account_id: string }
      | undefined
    if (!sub) {
      this.finish(r.id, 'suppressed', r.attempts, 'unsubscribed')
      stats.suppressed++
      return
    }
    const letter = db.prepare('SELECT envelope, title, account_id FROM letters WHERE id = ?').get(r.letter_id) as
      | { envelope: string | null; title: string; account_id: string }
      | undefined
    if (!letter || letter.envelope === null || letter.account_id !== sub.account_id) {
      this.finish(r.id, 'failed', r.attempts, 'expired')
      stats.failed++
      return
    }
    const markdown = (JSON.parse(letter.envelope) as { markdown: string }).markdown
    const token = unsubscribeToken(this.d.pepper, r.subscriber_id)
    const mail = letterMail({
      to: sub.email,
      fromName: fromNameFor(publishedDisplayName(db, sub.account_id)),
      title: letter.title,
      markdown,
      unsubscribeUrl: `${this.d.origin}/v1/unsubscribe?token=${encodeURIComponent(token)}`,
      origin: this.d.origin
    })
    const attempts = r.attempts + 1
    try {
      await this.d.mailer!.send(mail)
      this.finish(r.id, 'sent', attempts, null)
      stats.sent++
    } catch (err) {
      const e = err instanceof MailSendError ? err : new MailSendError('smtp_unavailable', false)
      if (e.permanent || attempts >= MAX_ATTEMPTS) {
        this.finish(r.id, 'failed', attempts, e.code)
        stats.failed++
      } else {
        this.finish(r.id, 'queued', attempts, e.code, this.retryAt(attempts))
        stats.retried++
      }
    }
  }
}
