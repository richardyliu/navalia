// C8 friend cards: PUT /v1/cards, GET /v1/cards/:fingerprint, DELETE /v1/cards.
// The server is a relay: it verifies once on publish (so it never stores junk / someone else's
// card) but clients MUST re-verify offline. Card text is stored and served verbatim.

import type { IncomingMessage } from 'node:http'
import type { Db } from './db.ts'
import { HttpError, readJson } from './http.ts'
import { sha256Hex } from './auth.ts'
import { verifyCardText } from './signed.ts'

export const CARD_MAX_BYTES = 64 * 1024
/** JSON escaping can roughly triple a card; the text itself is capped at CARD_MAX_BYTES. */
export const CARD_BODY_LIMIT_BYTES = 256 * 1024
export const CARD_HISTORY = 20
export const FINGERPRINT_RE = /^[0-9a-f]{64}$/

export interface CardDeps {
  db: Db
  now: () => number
}

export interface PublishResult {
  fingerprint: string
  version: number
  published_at: string
  unchanged: boolean
}

export async function publishCard(d: CardDeps, req: IncomingMessage, accountId: string): Promise<PublishResult> {
  const body = (await readJson(req, CARD_BODY_LIMIT_BYTES, true))!
  const text = body.card
  if (typeof text !== 'string' || text === '') throw new HttpError(400, 'invalid_request', 'card must be the .navaliacard file text')
  if (Buffer.byteLength(text, 'utf8') > CARD_MAX_BYTES) throw new HttpError(413, 'payload_too_large', 'Card exceeds 64 KiB')
  const v = verifyCardText(text)
  if (!v.valid) throw new HttpError(400, 'card_invalid', 'Card does not parse or its signature does not verify')
  if (v.card.fingerprint !== accountId) throw new HttpError(403, 'card_not_owner', 'Card is signed by a different key than this account')

  const now = d.now()
  const hash = sha256Hex(text)
  d.db.exec('BEGIN IMMEDIATE')
  try {
    const latest = d.db
      .prepare('SELECT version, text_sha256, published_at FROM cards WHERE account_id = ? ORDER BY version DESC LIMIT 1')
      .get(accountId) as { version: number; text_sha256: string; published_at: number } | undefined
    if (latest && latest.text_sha256 === hash) {
      d.db.exec('COMMIT')
      return { fingerprint: accountId, version: latest.version, published_at: new Date(latest.published_at).toISOString(), unchanged: true }
    }
    const counter = d.db
      .prepare(
        'INSERT INTO card_counters (account_id, last_version) VALUES (?, 1) ON CONFLICT(account_id) DO UPDATE SET last_version = last_version + 1 RETURNING last_version'
      )
      .get(accountId) as { last_version: number }
    const version = counter.last_version
    d.db
      .prepare('INSERT INTO cards (account_id, version, card_text, text_sha256, display_name, published_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(accountId, version, text, hash, v.card.displayName, now)
    d.db
      .prepare('DELETE FROM cards WHERE account_id = ? AND version NOT IN (SELECT version FROM cards WHERE account_id = ? ORDER BY version DESC LIMIT ?)')
      .run(accountId, accountId, CARD_HISTORY)
    d.db.exec('COMMIT')
    return { fingerprint: accountId, version, published_at: new Date(now).toISOString(), unchanged: false }
  } catch (err) {
    d.db.exec('ROLLBACK')
    throw err
  }
}

export function fetchCard(d: CardDeps, fingerprint: string): { card: string; version: number; published_at: string } {
  if (!FINGERPRINT_RE.test(fingerprint)) throw new HttpError(400, 'invalid_request', 'fingerprint must be 64 lowercase hex characters')
  const row = d.db
    .prepare('SELECT card_text, version, published_at FROM cards WHERE account_id = ? ORDER BY version DESC LIMIT 1')
    .get(fingerprint) as { card_text: string; version: number; published_at: number } | undefined
  if (!row) throw new HttpError(404, 'not_found', 'No published card for this fingerprint')
  return { card: row.card_text, version: row.version, published_at: new Date(row.published_at).toISOString() }
}

export function deleteCards(d: CardDeps, accountId: string): void {
  d.db.prepare('DELETE FROM cards WHERE account_id = ?').run(accountId)
}

/** Display name from the publisher's latest published card, or null. */
export function publishedDisplayName(db: Db, accountId: string): string | null {
  const row = db.prepare('SELECT display_name FROM cards WHERE account_id = ? ORDER BY version DESC LIMIT 1').get(accountId) as
    | { display_name: string | null }
    | undefined
  return row?.display_name ?? null
}
