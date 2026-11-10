// Server-side secret material for C9: the email pepper and values derived from it.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from './db.ts'

/** CLOUD_EMAIL_PEPPER if set, else a random value generated once and kept in server_secrets. */
export function resolvePepper(db: Db, configured: string | null, now: number): string {
  if (configured) return configured
  db.prepare('INSERT INTO server_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING').run(
    'email_pepper',
    randomBytes(32).toString('base64url'),
    now
  )
  return (db.prepare("SELECT value FROM server_secrets WHERE name = 'email_pepper'").get() as { value: string }).value
}

/** Suppression / dedup key: HMAC-SHA256(pepper, lowercased address), hex. */
export function emailHash(pepper: string, email: string): string {
  return createHmac('sha256', pepper).update(email.trim().toLowerCase()).digest('hex')
}

function unsubMac(pepper: string, subscriberId: string): Buffer {
  return createHmac('sha256', pepper).update(`persome-unsubscribe-v1\n${subscriberId}`).digest()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/

/**
 * Unsubscribe token = "<subscriber_id>.<base64url HMAC>". Derived (not stored), so it stays
 * valid after the subscriber row is gone: that is what makes unsubscribe idempotent and lets an
 * old link start a re-subscribe.
 */
export function unsubscribeToken(pepper: string, subscriberId: string): string {
  if (!UUID.test(subscriberId)) throw new Error('bad subscriber id')
  return `${subscriberId}.${unsubMac(pepper, subscriberId).toString('base64url')}`
}

/** Returns the subscriber id for an authentic token, else null. */
export function parseUnsubscribeToken(pepper: string, token: string | null): string | null {
  if (!token) return null
  const m = TOKEN.exec(token)
  if (!m) return null
  const given = Buffer.from(m[2], 'base64url')
  const want = unsubMac(pepper, m[1])
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null
  return m[1]
}
