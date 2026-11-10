// C18 shared moments: a two-party signed relay.
//
// A moment exists only when one participant proposes it (signed) and the other accepts it
// (signed). The server infers nothing; it verifies once on write (so it never stores junk or
// someone else's signature) and serves the signed texts verbatim. Clients MUST re-verify.
//
// Privacy: titles / notes / places live only inside the stored signed text; they are never
// logged and never copied into other columns.

import type { IncomingMessage } from 'node:http'
import { tx, type Db } from './db.ts'
import { HttpError, readJson } from './http.ts'
import { verifyAcceptanceText, verifyMomentText } from './signed.ts'
import { secondsToUtcMidnight, utcDay } from './chat.ts'

export const MOMENT_BODY_LIMIT_BYTES = 64 * 1024
export const MOMENTS_PENDING_MAX = 50
export const MOMENTS_PER_DAY = 20
export const MOMENTS_LIST_MAX = 500

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface MomentDeps {
  db: Db
  now: () => number
}

interface Row {
  id: string
  proposer_id: string
  other_id: string
  status: 'pending' | 'accepted' | 'declined'
  moment_text: string
  acceptance_text: string | null
  updated_at: number
}

export interface MomentListItem {
  moment_id: string
  status: Row['status']
  moment: string
  acceptance: string | null
  updated_at: string
}

const notFound = (): HttpError => new HttpError(404, 'not_found', 'No such moment')

export async function proposeMoment(d: MomentDeps, req: IncomingMessage, accountId: string): Promise<{ moment_id: string; status: 'pending' }> {
  const body = (await readJson(req, MOMENT_BODY_LIMIT_BYTES, true))!
  const text = body.moment
  if (typeof text !== 'string' || text === '') throw new HttpError(400, 'invalid_request', 'moment must be the signed moment JSON text')
  const v = verifyMomentText(text)
  if (!v.valid) {
    if (v.reason === 'not_participant') throw new HttpError(403, 'moment_not_owner', 'The proposer must be one of the participants')
    throw new HttpError(400, 'moment_invalid', 'Moment does not parse, fails the schema, or its signature does not verify')
  }
  if (v.moment.proposer.fingerprint !== accountId) throw new HttpError(403, 'moment_not_owner', 'Moment is signed by a different key than this account')

  const now = d.now()
  const day = utcDay(now)
  return tx(d.db, () => {
    if (d.db.prepare('SELECT 1 FROM moments WHERE id = ?').get(v.moment.moment_id)) {
      throw new HttpError(409, 'duplicate_moment', 'This moment_id already exists')
    }
    const pending = (d.db.prepare("SELECT COUNT(*) AS n FROM moments WHERE proposer_id = ? AND status = 'pending'").get(accountId) as { n: number }).n
    if (pending >= MOMENTS_PENDING_MAX) {
      throw new HttpError(429, 'rate_limited', `At most ${MOMENTS_PENDING_MAX} pending proposals; delete some or wait for answers`, { 'retry-after': '3600' })
    }
    const used = (d.db.prepare('SELECT n FROM moment_usage WHERE account_id = ? AND day = ?').get(accountId, day) as { n: number } | undefined)?.n ?? 0
    if (used >= MOMENTS_PER_DAY) {
      throw new HttpError(429, 'rate_limited', `At most ${MOMENTS_PER_DAY} proposals per UTC day`, { 'retry-after': String(secondsToUtcMidnight(now)) })
    }
    d.db
      .prepare('INSERT INTO moment_usage (account_id, day, n) VALUES (?, ?, 1) ON CONFLICT(account_id, day) DO UPDATE SET n = n + 1')
      .run(accountId, day)
    d.db
      .prepare(
        "INSERT INTO moments (id, proposer_id, other_id, status, moment_text, moment_sha256, acceptance_text, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, ?)"
      )
      .run(v.moment.moment_id, accountId, v.other, text, v.sha256, now, now)
    return { moment_id: v.moment.moment_id, status: 'pending' as const }
  })
}

export function listMoments(d: MomentDeps, accountId: string): MomentListItem[] {
  const rows = d.db
    .prepare(
      'SELECT id, status, moment_text, acceptance_text, updated_at FROM moments WHERE proposer_id = ? OR other_id = ? ORDER BY updated_at DESC, created_at DESC, id LIMIT ?'
    )
    .all(accountId, accountId, MOMENTS_LIST_MAX) as unknown as Row[]
  return rows.map((r) => ({
    moment_id: r.id,
    status: r.status,
    moment: r.moment_text,
    acceptance: r.acceptance_text,
    updated_at: new Date(r.updated_at).toISOString()
  }))
}

function load(d: MomentDeps, id: string): Row | undefined {
  if (!UUID.test(id)) return undefined
  return d.db.prepare('SELECT id, proposer_id, other_id, status, moment_text, acceptance_text, updated_at FROM moments WHERE id = ?').get(id) as
    | Row
    | undefined
}

/** Only the non-proposing participant may answer; and only a pending moment. */
function answerable(d: MomentDeps, id: string, accountId: string): Row {
  const row = load(d, id)
  if (!row) throw notFound()
  // Non-participants get the same 404 as an unknown id (no existence leak; lead, Phase 4 gate).
  if (row.proposer_id !== accountId && row.other_id !== accountId) throw notFound()
  if (row.proposer_id === accountId) throw new HttpError(403, 'moment_not_owner', 'The proposer cannot answer their own proposal')
  if (row.status !== 'pending') throw new HttpError(409, 'moment_not_pending', `Moment is already ${row.status}`)
  return row
}

export async function acceptMoment(d: MomentDeps, req: IncomingMessage, accountId: string, id: string): Promise<{ status: 'accepted' }> {
  const body = (await readJson(req, MOMENT_BODY_LIMIT_BYTES, true))!
  const text = body.acceptance
  if (typeof text !== 'string' || text === '') throw new HttpError(400, 'invalid_request', 'acceptance must be the signed acceptance JSON text')
  return tx(d.db, () => {
    const row = answerable(d, id, accountId)
    const v = verifyAcceptanceText(text, row.moment_text)
    // `not_participant` here means signed by someone other than the account that must accept.
    if (!v.valid || v.acceptance.accepter.fingerprint !== accountId) {
      throw new HttpError(400, 'acceptance_invalid', 'Acceptance does not verify, or does not reference this exact moment, or is not signed by you')
    }
    d.db.prepare("UPDATE moments SET status = 'accepted', acceptance_text = ?, updated_at = ? WHERE id = ?").run(text, d.now(), row.id)
    return { status: 'accepted' as const }
  })
}

export function declineMoment(d: MomentDeps, accountId: string, id: string): { status: 'declined' } {
  return tx(d.db, () => {
    const row = answerable(d, id, accountId)
    d.db.prepare("UPDATE moments SET status = 'declined', updated_at = ? WHERE id = ?").run(d.now(), row.id)
    return { status: 'declined' as const }
  })
}

/** Either participant may delete; deletes for both. Non-participants get 404 (no existence leak). */
export function deleteMoment(d: MomentDeps, accountId: string, id: string): void {
  if (!UUID.test(id)) throw notFound()
  const r = d.db.prepare('DELETE FROM moments WHERE id = ? AND (proposer_id = ? OR other_id = ?)').run(id, accountId, accountId)
  if (r.changes === 0) throw notFound()
}

/** GC: daily counters older than 2 days are useless. */
export function purgeMomentUsage(db: Db, now: number): void {
  db.prepare('DELETE FROM moment_usage WHERE day < ?').run(utcDay(now - 2 * 86_400_000))
}
