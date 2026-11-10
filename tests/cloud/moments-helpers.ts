// Helpers for the C18 / C11 shared-moments tests: temp stores (prefix `lens-moments-`, guarded
// cleanup), real KeyManagers with an in-memory AES box, signed cards, and a fake server implementing
// the moments contract on top of the auth fake in helpers.ts. The fake validates with the cloud
// server's own pure verifiers (cloud/src/signed.ts). Nothing touches ~/.persome or the real Lens Store.
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { CARD_FORMAT, newCardId, signCard, type SignedCard } from '../../src/main/identity/card'
import type { CardContent } from '../../src/main/identity/card-schema'
import { createKeyManager, type KeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { createPeerStore } from '../../src/main/peers/store'
import { verifyAcceptanceText as serverVerifyAcceptance, verifyMomentText as serverVerifyMoment } from '../../cloud/src/signed.ts'
import { createTestBox } from '../identity/helpers'
import { errBody, fakeBox, LOOPBACK, type FakeServer } from './helpers'

export const PREFIX = 'lens-moments-'

export function momentsTemp(roots: string[], label = 'x'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${label}-`))
  roots.push(dir)
  return dir
}

/** Remove ONLY directories we created with mkdtemp (basename prefix guard; never a parent / tmpdir). */
export function cleanupMoments(roots: string[]): void {
  for (const d of roots.splice(0)) {
    if (!path.basename(d).startsWith(PREFIX)) throw new Error(`refusing to delete ${d}`)
    if (path.resolve(d) === path.resolve(os.tmpdir())) throw new Error('refusing to delete tmpdir')
    fs.rmSync(d, { recursive: true, force: true })
  }
}

export interface Person {
  label: string
  root: string
  keys: KeyManager
  fingerprint: string
  publicKey: string
  card(name?: string | null): SignedCard
  cloud: CloudService | null
}

export function person(roots: string[], label: string): Person {
  const root = path.join(momentsTemp(roots, label), 'store')
  const keys = createKeyManager(storePaths(root), createTestBox())
  const id = keys.ensureIdentity()
  return {
    label,
    root,
    keys,
    fingerprint: id.fingerprint,
    publicKey: id.public_key,
    cloud: null,
    card(name) {
      const content: CardContent = {
        front: {
          display_name: name === undefined ? `Name-${label}` : name,
          summary: '独立开发者。',
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
          issued_at: '2026-11-01T09:00:00.000Z',
          issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint },
          content
        },
        keys
      )
    }
  }
}

/** `a` imports `b`'s card into its Peers list. */
export function befriend(a: Person, b: Person): void {
  const r = createPeerStore({ storeRoot: a.root }).importText(`${JSON.stringify(b.card(), null, 2)}\n`)
  if (!r.ok) throw new Error(`import failed: ${r.reason}`)
}

export interface MomentRow {
  text: string
  participants: [string, string]
  proposer: string
  status: 'pending' | 'accepted' | 'declined'
  acceptance: string | null
  updated_at: string
}

export interface MomentsServer {
  calls: Array<{ method: string; url: string; body: unknown; who: string | null }>
  moments: Map<string, MomentRow>
  /** Rows injected verbatim into one fingerprint's GET /v1/moments (forged-row tests). */
  extra: Map<string, unknown[]>
  /** token → fingerprint (bound by `signIn`). */
  tokens: Map<string, string>
  failNext: { status: number; code: string } | null
}

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

export function installMomentsRoutes(server: FakeServer): MomentsServer {
  const st: MomentsServer = { calls: [], moments: new Map(), extra: new Map(), tokens: new Map(), failNext: null }
  server.override = (req, res, body) => {
    const url = req.url ?? ''
    const method = req.method ?? ''
    if (!/^\/v1\/moments(\/|$)/.test(url)) return false
    let parsed: unknown = null
    try {
      parsed = body ? JSON.parse(body) : null
    } catch {
      parsed = body
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
    const who = st.tokens.get(bearer) ?? null
    st.calls.push({ method, url, body: parsed, who })
    if (!who) return (json(res, 401, errBody('unauthorized', 'x')), true)
    if (st.failNext) {
      const f = st.failNext
      st.failNext = null
      return (json(res, f.status, errBody(f.code, `server text ${bearer}`)), true)
    }
    const now = new Date().toISOString()
    let m: RegExpExecArray | null
    if (method === 'POST' && url === '/v1/moments') {
      const text = (parsed as { moment?: unknown })?.moment
      if (typeof text !== 'string') return (json(res, 400, errBody('invalid_request', 'x')), true)
      const v = serverVerifyMoment(text)
      if (!v.valid) return (json(res, 400, errBody('moment_invalid', v.reason)), true)
      if (v.moment.proposer.fingerprint !== who) return (json(res, 403, errBody('moment_not_owner', 'no')), true)
      if (st.moments.has(v.moment.moment_id)) return (json(res, 409, errBody('duplicate_moment', 'dup')), true)
      st.moments.set(v.moment.moment_id, { text, participants: v.moment.participants, proposer: who, status: 'pending', acceptance: null, updated_at: now })
      return (json(res, 201, { moment_id: v.moment.moment_id, status: 'pending' }), true)
    }
    if (method === 'GET' && url === '/v1/moments') {
      const rows = [...st.moments.entries()]
        .filter(([, r]) => r.participants.includes(who))
        .map(([id, r]) => ({ moment_id: id, status: r.status, moment: r.text, acceptance: r.acceptance, updated_at: r.updated_at }))
      return (json(res, 200, [...rows, ...(st.extra.get(who) ?? [])]), true)
    }
    if ((m = /^\/v1\/moments\/([0-9a-f-]{36})\/(accept|decline)$/.exec(url)) && method === 'POST') {
      const row = st.moments.get(m[1])
      if (!row || !row.participants.includes(who)) return (json(res, 404, errBody('not_found', 'none')), true)
      if (row.proposer === who) return (json(res, 403, errBody('moment_not_owner', 'own')), true)
      if (row.status !== 'pending') return (json(res, 409, errBody('moment_not_pending', 'done')), true)
      if (m[2] === 'decline') {
        row.status = 'declined'
        row.updated_at = now
        return (json(res, 200, { status: 'declined' }), true)
      }
      const acc = (parsed as { acceptance?: unknown })?.acceptance
      const v = typeof acc === 'string' ? serverVerifyAcceptance(acc, row.text) : null
      if (!v?.valid || v.acceptance.accepter.fingerprint !== who) return (json(res, 400, errBody('acceptance_invalid', 'bad')), true)
      row.status = 'accepted'
      row.acceptance = acc as string
      row.updated_at = now
      return (json(res, 200, { status: 'accepted' }), true)
    }
    if ((m = /^\/v1\/moments\/([0-9a-f-]{36})$/.exec(url)) && method === 'DELETE') {
      const row = st.moments.get(m[1])
      if (!row || !row.participants.includes(who)) return (json(res, 404, errBody('not_found', 'none')), true)
      st.moments.delete(m[1])
      res.writeHead(204)
      res.end()
      return true
    }
    return (json(res, 404, errBody('not_found', 'no route')), true)
  }
  return st
}

/** Configure + sign `p` into the fake server and bind the issued token to its fingerprint. */
export async function signIn(p: Person, server: FakeServer, st: MomentsServer): Promise<CloudService> {
  writeCloudConfig(cloudPaths(p.root).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
  const cloud = createCloudService({ storeRoot: p.root, box: fakeBox(), sign: (m) => p.keys.sign(m), getPublicIdentity: () => p.keys.getPublicIdentity(), allowInsecureLoopback: true })
  await cloud.signIn()
  st.tokens.set(server.issued[server.issued.length - 1], p.fingerprint)
  p.cloud = cloud
  return cloud
}
