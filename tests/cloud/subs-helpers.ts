// Helpers for the C8 / C10 tests: temp stores (prefix `lens-subs-`, guarded cleanup), real
// KeyManagers with an in-memory AES box, signed cards, and a fake server implementing the cards /
// letters / subscribers contract on top of the auth fake in helpers.ts. Nothing touches ~/.persome,
// the real Lens Store or real email.
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { CARD_FORMAT, newCardId, signCard, verifyCardText, type SignedCard } from '../../src/main/identity/card'
import type { CardContent } from '../../src/main/identity/card-schema'
import { createKeyManager, type KeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { verifyLetterText } from '../../src/main/cloud/letter-sign'
import { createTestBox } from '../identity/helpers'
import { errBody, type FakeServer } from './helpers'

export const PREFIX = 'lens-subs-'

/** mkdtemp under $TMPDIR with our prefix; returns the dir itself (recorded for cleanup). */
export function subsTemp(roots: string[], label = 'x'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${label}-`))
  roots.push(dir)
  return dir
}

/** Remove ONLY directories we created with mkdtemp (basename prefix guard; never a parent). */
export function cleanupSubs(roots: string[]): void {
  for (const d of roots.splice(0)) {
    if (!path.basename(d).startsWith(PREFIX)) throw new Error(`refusing to delete ${d}`)
    if (path.resolve(d) === path.resolve(os.tmpdir())) throw new Error('refusing to delete tmpdir')
    fs.rmSync(d, { recursive: true, force: true })
  }
}

export interface Person {
  root: string
  keys: KeyManager
  fingerprint: string
  publicKey: string
  card(opts?: { name?: string | null; issuedAt?: string }): SignedCard
}

export function person(roots: string[], label: string): Person {
  const root = path.join(subsTemp(roots, label), 'store')
  const keys = createKeyManager(storePaths(root), createTestBox())
  const id = keys.ensureIdentity()
  return {
    root,
    keys,
    fingerprint: id.fingerprint,
    publicKey: id.public_key,
    card(opts = {}) {
      const content: CardContent = {
        front: {
          display_name: opts.name === undefined ? `Name-${label}` : opts.name,
          summary: '独立开发者，专注于个人知识管理。',
          summary_confidence: 0.8,
          summary_observations: 12,
          highlights: [{ level: 'face', signature: '在做本地优先的工具', observations: 5, confidence: 0.7 }],
          as_of: '2026-11-01T08:00:00.000Z',
          model_status: 'complete',
          degraded: false
        },
        back: {
          mini_map: { nodes: [{ key: 'r0', level: 'root', label: '独立开发者', observations: 12, confidence: 0.8, member_count: 1 }], edges: [] },
          stats: { points: 40, evolution_lines: 2, relation_lines: 3, faces: 2, volumes: 1, roots: 1 }
        }
      }
      return signCard(
        {
          format: CARD_FORMAT,
          version: 1,
          card_id: newCardId(),
          issued_at: opts.issuedAt ?? '2026-11-01T09:00:00.000Z',
          issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint },
          content
        },
        keys
      )
    }
  }
}

export const cardTextOf = (c: SignedCard): string => `${JSON.stringify(c, null, 2)}\n`

export interface SubsServer {
  /** Every request to a C8/C10 route: method, url, parsed body. */
  calls: Array<{ method: string; url: string; body: unknown }>
  cards: Map<string, { card: string; version: number; published_at: string }>
  /** Served by GET /v1/letters/by/:fp (tests inject forged entries directly). */
  byFp: Map<string, Array<{ letter: string; published_at: string }>>
  published: Array<{ letter_id: string; issue_id: string; week: string; title: string; created_at: string; text: string }>
  subscribers: Array<{ subscriber_id: string; email_masked: string; status: 'pending' | 'confirmed'; created_at: string; confirmed_at: string | null }>
  deliveries: Map<string, unknown[]>
  /** Force a status for the next C8/C10 request (then cleared). */
  failNext: { status: number; code: string } | null
}

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

/** Install the C8/C10 routes. `owner` is the signed-in account's fingerprint. */
export function installSubsRoutes(server: FakeServer, owner: () => string): SubsServer {
  const st: SubsServer = { calls: [], cards: new Map(), byFp: new Map(), published: [], subscribers: [], deliveries: new Map(), failNext: null }
  let seq = 0
  server.override = (req, res, body) => {
    const url = req.url ?? ''
    const method = req.method ?? ''
    if (!/^\/v1\/(cards|letters|subscribers)(\/|$)/.test(url)) return false
    let parsed: unknown = null
    try {
      parsed = body ? JSON.parse(body) : null
    } catch {
      parsed = body
    }
    st.calls.push({ method, url, body: parsed })
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!bearer || !server.issued.includes(bearer)) return (json(res, 401, errBody('unauthorized', 'x')), true)
    if (st.failNext) {
      const f = st.failNext
      st.failNext = null
      return (json(res, f.status, errBody(f.code, `server text ${bearer}`)), true)
    }
    const now = new Date().toISOString()
    let m: RegExpExecArray | null
    if (method === 'PUT' && url === '/v1/cards') {
      const text = (parsed as { card?: unknown })?.card
      const v = typeof text === 'string' ? verifyCardText(text) : null
      if (!v?.valid) return (json(res, 400, errBody('card_invalid', 'bad')), true)
      if (v.card.card.issuer.fingerprint !== owner()) return (json(res, 403, errBody('card_not_owner', 'no')), true)
      const prev = st.cards.get(owner())
      const unchanged = prev?.card === text
      const version = unchanged ? prev!.version : (prev?.version ?? 0) + 1
      st.cards.set(owner(), { card: text as string, version, published_at: unchanged ? prev!.published_at : now })
      return (json(res, 200, { fingerprint: owner(), version, published_at: st.cards.get(owner())!.published_at, unchanged }), true)
    }
    if (method === 'DELETE' && url === '/v1/cards') {
      st.cards.delete(owner())
      res.writeHead(204)
      res.end()
      return true
    }
    if (method === 'GET' && (m = /^\/v1\/cards\/([0-9a-f]{64})$/.exec(url))) {
      const c = st.cards.get(m[1])
      if (!c) return (json(res, 404, errBody('not_found', 'none')), true)
      return (json(res, 200, c), true)
    }
    if (method === 'POST' && url === '/v1/letters') {
      const text = (parsed as { letter?: unknown })?.letter
      const v = typeof text === 'string' ? verifyLetterText(text) : null
      if (!v?.valid) return (json(res, 400, errBody('letter_invalid', 'bad')), true)
      if (v.envelope.signer.fingerprint !== owner()) return (json(res, 403, errBody('letter_not_owner', 'no')), true)
      if (st.published.some((p) => p.issue_id === v.envelope.issue_id)) return (json(res, 409, errBody('duplicate_issue', 'dup')), true)
      const letter_id = `L${++seq}`
      st.published.push({ letter_id, issue_id: v.envelope.issue_id, week: v.envelope.week, title: v.envelope.title, created_at: v.envelope.created_at, text: text as string })
      const confirmed = st.subscribers.filter((s) => s.status === 'confirmed')
      st.deliveries.set(
        letter_id,
        confirmed.map((s) => ({ subscriber_id: s.subscriber_id, email_masked: s.email_masked, status: 'queued', attempts: 0, updated_at: now, error_code: null }))
      )
      return (json(res, 202, { letter_id, issue_id: v.envelope.issue_id, recipients: confirmed.length }), true)
    }
    if (method === 'GET' && url === '/v1/letters') {
      return (
        json(
          res,
          200,
          st.published.map((p) => {
            const d = (st.deliveries.get(p.letter_id) ?? []) as Array<{ status: string }>
            const n = (s: string): number => d.filter((x) => x.status === s).length
            return { letter_id: p.letter_id, issue_id: p.issue_id, week: p.week, title: p.title, created_at: p.created_at, counts: { queued: n('queued'), sent: n('sent'), failed: n('failed'), suppressed: n('suppressed') } }
          })
        ),
        true
      )
    }
    if (method === 'GET' && (m = /^\/v1\/letters\/([A-Za-z0-9_-]+)\/deliveries$/.exec(url))) {
      const d = st.deliveries.get(m[1])
      if (!d) return (json(res, 404, errBody('not_found', 'none')), true)
      return (json(res, 200, d), true)
    }
    if (method === 'GET' && (m = /^\/v1\/letters\/by\/([0-9a-f]{64})$/.exec(url))) {
      return (json(res, 200, st.byFp.get(m[1]) ?? []), true)
    }
    if (method === 'GET' && url === '/v1/subscribers') return (json(res, 200, st.subscribers), true)
    if (method === 'DELETE' && (m = /^\/v1\/subscribers\/([A-Za-z0-9_-]+)$/.exec(url))) {
      const i = st.subscribers.findIndex((s) => s.subscriber_id === m![1])
      if (i < 0) return (json(res, 404, errBody('not_found', 'none')), true)
      st.subscribers.splice(i, 1)
      res.writeHead(204)
      res.end()
      return true
    }
    return (json(res, 404, errBody('not_found', 'no route')), true)
  }
  return st
}
