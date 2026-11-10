// Local Peers list: `<storeRoot>/peers/<fingerprint>.json`, owner-only (0700 dir, 0600 files).
// A peer is identified by its card's key fingerprint. Every card is verified with the Identity
// Plane's offline verifier before it is written, and again every time it is read back.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { verifyCardText, verifySignedCard, type SignedCard } from '../identity/card'
import { PublicIdentitySchema, RetiredIdentitySchema } from '../identity/keys'
import { ensureSecureDir, readFileIfExists, storePaths, writeFileSecure } from '../store/paths'
import type { PeerDetail, PeerEvent, PeerImportResult, PeerList, PeerSummary } from './api'
import { cardTopics } from './topics'

export const MAX_CARD_BYTES = 2_000_000
export const MAX_HISTORY = 20
export const MAX_EVENTS = 100
export const FINGERPRINT_RE = /^[0-9a-f]{64}$/

const Iso = z.string().datetime({ offset: true })
const EventSchema = z
  .object({
    at: Iso,
    kind: z.enum(['imported', 'updated', 'reimported_same', 'older_version']),
    cardId: z.string().max(64),
    cardIssuedAt: Iso
  })
  .strict()
const PeerFileSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(FINGERPRINT_RE),
    importedAt: Iso,
    updatedAt: Iso,
    /** Raw signed cards (unknown here; each is re-verified on read). Newest issued_at is current. */
    history: z.array(z.object({ importedAt: Iso, card: z.unknown() }).strict()).min(1).max(MAX_HISTORY),
    events: z.array(EventSchema).max(MAX_EVENTS)
  })
  .strict()
type PeerFile = z.infer<typeof PeerFileSchema>

export interface PeerStoreOptions {
  storeRoot: string
  now?: () => Date
}

export interface PeerStore {
  dir: string
  list(): PeerList
  get(fingerprint: string): PeerDetail | null
  importText(text: string): PeerImportResult
  remove(fingerprint: string): boolean
}

function ownFingerprints(storeRoot: string): Set<string> {
  const paths = storePaths(storeRoot)
  const out = new Set<string>()
  try {
    const raw = readFileIfExists(paths.identityFile)
    if (raw) {
      const id = PublicIdentitySchema.safeParse(JSON.parse(raw.toString('utf8')))
      if (id.success) out.add(id.data.fingerprint)
    }
  } catch {
    /* unreadable identity: treat as none */
  }
  try {
    const raw = readFileIfExists(paths.previousIdentitiesFile)
    if (raw) {
      const prev = z.object({ identities: z.array(RetiredIdentitySchema) }).safeParse(JSON.parse(raw.toString('utf8')))
      if (prev.success) for (const p of prev.data.identities) out.add(p.fingerprint)
    }
  } catch {
    /* ignore */
  }
  return out
}

interface Loaded {
  file: PeerFile
  /** Verified history, newest issued_at first. */
  cards: Array<{ card: SignedCard; importedAt: string }>
}

function issued(card: SignedCard): number {
  return Date.parse(card.card.issued_at)
}

export function createPeerStore(opts: PeerStoreOptions): PeerStore {
  const now = opts.now ?? (() => new Date())
  const dir = path.join(opts.storeRoot, 'peers')

  function fileOf(fingerprint: string): string {
    if (!FINGERPRINT_RE.test(fingerprint)) throw new Error('invalid fingerprint')
    return path.join(dir, `${fingerprint}.json`)
  }

  /** Null when missing; 'unreadable' when the file exists but any stored card fails verification. */
  function load(fingerprint: string): Loaded | null | 'unreadable' {
    const raw = readFileIfExists(fileOf(fingerprint))
    if (!raw) return null
    let file: PeerFile
    try {
      file = PeerFileSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      return 'unreadable'
    }
    if (file.fingerprint !== fingerprint) return 'unreadable'
    const cards: Loaded['cards'] = []
    for (const h of file.history) {
      const v = verifySignedCard(h.card)
      if (!v.valid || v.card.card.issuer.fingerprint !== fingerprint) return 'unreadable'
      cards.push({ card: v.card, importedAt: h.importedAt })
    }
    cards.sort((a, b) => issued(b.card) - issued(a.card) || b.importedAt.localeCompare(a.importedAt))
    return { file, cards }
  }

  function loadAll(): { peers: Loaded[]; unreadable: number } {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
    } catch {
      return { peers: [], unreadable: 0 }
    }
    const peers: Loaded[] = []
    let unreadable = 0
    for (const n of names.sort()) {
      const l = load(n.slice(0, 64))
      if (l === 'unreadable') unreadable++
      else if (l) peers.push(l)
    }
    return { peers, unreadable }
  }

  function summarize(l: Loaded, all: Loaded[]): PeerSummary {
    const current = l.cards[0].card
    const name = current.card.content.front.display_name
    // Same display name, different key, newer card → this key is probably retired (unverifiable).
    let supersededBy: string | null = null
    if (name) {
      for (const other of all) {
        if (other === l) continue
        const oc = other.cards[0].card
        if (oc.card.content.front.display_name === name && issued(oc) > issued(current)) {
          if (!supersededBy || issued(oc) > issued(all.find((a) => a.file.fingerprint === supersededBy)!.cards[0].card)) {
            supersededBy = other.file.fingerprint
          }
        }
      }
    }
    return {
      fingerprint: l.file.fingerprint,
      displayName: name,
      headline: current.card.content.front.summary,
      topics: cardTopics(current),
      verification: supersededBy ? 'old_key' : 'valid',
      supersededBy,
      cardId: current.card.card_id,
      cardIssuedAt: current.card.issued_at,
      cardAsOf: current.card.content.front.as_of,
      cardDegraded: current.card.content.front.degraded,
      importedAt: l.file.importedAt,
      updatedAt: l.file.updatedAt,
      versions: l.cards.length
    }
  }

  function detail(l: Loaded, all: Loaded[]): PeerDetail {
    return {
      ...summarize(l, all),
      card: l.cards[0].card,
      history: l.cards.map((c) => ({ cardId: c.card.card.card_id, issuedAt: c.card.card.issued_at, importedAt: c.importedAt })),
      events: [...l.file.events].sort((a, b) => b.at.localeCompare(a.at))
    }
  }

  function write(file: PeerFile): void {
    ensureSecureDir(dir)
    writeFileSecure(fileOf(file.fingerprint), `${JSON.stringify(file, null, 2)}\n`)
  }

  return {
    dir,

    list() {
      const { peers, unreadable } = loadAll()
      const out = peers.map((p) => summarize(p, peers))
      out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.fingerprint.localeCompare(b.fingerprint))
      return { peers: out, unreadable }
    },

    get(fingerprint) {
      if (!FINGERPRINT_RE.test(fingerprint)) return null
      const l = load(fingerprint)
      if (!l || l === 'unreadable') return null
      return detail(l, loadAll().peers)
    },

    importText(text) {
      if (Buffer.byteLength(text, 'utf8') > MAX_CARD_BYTES) return { ok: false, reason: 'too_large', detail: tr('File is too large to be a card', '文件太大，不像是一张卡片') }
      const v = verifyCardText(text)
      if (!v.valid) {
        const tampered = v.reason === 'fingerprint' || v.reason === 'signature'
        return { ok: false, reason: tampered ? 'tampered' : 'invalid', detail: v.detail }
      }
      const card = v.card
      const fp = card.card.issuer.fingerprint
      if (ownFingerprints(opts.storeRoot).has(fp)) {
        return { ok: false, reason: 'self', detail: tr('This card is signed with your own key; not added to Peers', '这是用你自己的密钥签名的卡片，不加入朋友列表') }
      }
      const at = now().toISOString()
      const prev = load(fp)
      const event = (kind: PeerEvent['kind']): PeerEvent => ({ at, kind, cardId: card.card.card_id, cardIssuedAt: card.card.issued_at })
      if (prev === null || prev === 'unreadable') {
        // An unreadable file (edited on disk) is replaced by the freshly verified card.
        const file: PeerFile = { version: 1, fingerprint: fp, importedAt: at, updatedAt: at, history: [{ importedAt: at, card }], events: [event('imported')] }
        write(file)
        const l = load(fp) as Loaded
        return { ok: true, outcome: 'added', peer: detail(l, loadAll().peers) }
      }
      const same = prev.cards.find((c) => c.card.signature.value === card.signature.value)
      let outcome: 'updated' | 'unchanged' | 'older_version'
      let history = prev.file.history
      if (same) {
        outcome = 'unchanged'
      } else {
        outcome = issued(card) > issued(prev.cards[0].card) ? 'updated' : 'older_version'
        // Keep the newest MAX_HISTORY versions by issued_at.
        const merged = [...prev.cards, { card, importedAt: at }].sort((a, b) => issued(b.card) - issued(a.card))
        history = merged.slice(0, MAX_HISTORY).map((c) => ({ importedAt: c.importedAt, card: c.card }))
      }
      const events = [...prev.file.events, event(outcome === 'unchanged' ? 'reimported_same' : outcome)].slice(-MAX_EVENTS)
      const file: PeerFile = {
        ...prev.file,
        updatedAt: outcome === 'updated' ? at : prev.file.updatedAt,
        history,
        events
      }
      write(file)
      const l = load(fp) as Loaded
      return { ok: true, outcome, peer: detail(l, loadAll().peers) }
    },

    remove(fingerprint) {
      if (!FINGERPRINT_RE.test(fingerprint)) throw new Error('invalid fingerprint')
      const file = fileOf(fingerprint)
      if (!fs.existsSync(file)) return false
      fs.rmSync(file, { force: true })
      return true
    }
  }
}
