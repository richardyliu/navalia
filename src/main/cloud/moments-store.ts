// S1-FULL C18 — local store of ACCEPTED shared moments: `<LensStore>/moments/<moment_id>.json`
// (files 0600, dir 0700). Each file keeps both signed texts verbatim plus the user's own local
// reflective note. Both signatures are re-verified on every read; a file that fails is ignored and
// reported (never shown, never deleted automatically). No network here (used offline by Peers and
// by the weekly-letter drafts).
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PublicIdentitySchema, fingerprintOf } from '../identity/keys'
import { createPeerStore } from '../peers/store'
import { ensureSecureDir, readFileIfExists, storePaths, writeFileSecure } from '../store/paths'
import { MOMENT_ID_RE, MOMENT_LIMITS, type LocalMoment, type LocalMomentsResult, type MomentView, type RejectedLocalMoment } from './moments-api'
import { verifyAcceptedPair, type SignedMoment } from './moments-sign'

export const MOMENTS_DIR = 'moments'

const Iso = z.string().datetime({ offset: true })
const FileSchema = z.strictObject({
  version: z.literal(1),
  saved_at: Iso,
  moment: z.string().min(1).max(64 * 1024),
  acceptance: z.string().min(1).max(8 * 1024),
  my_note: z.strictObject({ text: z.string().max(MOMENT_LIMITS.maxMyNoteChars), updated_at: Iso }).nullable()
})
type MomentFile = z.infer<typeof FileSchema>

/** Fingerprint of the current local identity, recomputed from the public key (null if none / bad). */
export function currentFingerprint(storeRoot: string): string | null {
  try {
    const raw = readFileIfExists(storePaths(storeRoot).identityFile)
    if (!raw) return null
    const id = PublicIdentitySchema.safeParse(JSON.parse(raw.toString('utf8')))
    if (!id.success) return null
    const pub = Buffer.from(id.data.public_key, 'base64url')
    if (pub.length !== 32) return null
    const fp = fingerprintOf(pub)
    return fp === id.data.fingerprint ? fp : null
  } catch {
    return null
  }
}

/** Display names from verified Peers cards (null name = unnamed card). */
export function peerNames(storeRoot: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  try {
    for (const p of createPeerStore({ storeRoot }).list().peers) out.set(p.fingerprint, p.displayName?.trim() || null)
  } catch {
    /* unreadable peers dir: no names */
  }
  return out
}

export function momentView(m: SignedMoment, me: string, names: Map<string, string | null>): MomentView {
  const friend = m.participants[0] === me ? m.participants[1] : m.participants[0]
  return {
    momentId: m.moment_id,
    title: m.title,
    note: m.note,
    start: m.occurred_on.start,
    end: m.occurred_on.end,
    place: m.place,
    visibility: m.visibility,
    createdAt: m.created_at,
    proposerFingerprint: m.proposer.fingerprint,
    friendFingerprint: friend,
    friendName: names.get(friend) ?? null,
    friendKnown: names.has(friend),
    iAmProposer: m.proposer.fingerprint === me
  }
}

export interface MomentsStoreOptions {
  storeRoot: string
  /** Current identity fingerprint (default: read from the Lens Store identity file). */
  me?: () => string | null
  now?: () => Date
}

export interface MomentsStore {
  dir: string
  list(): LocalMomentsResult
  get(momentId: string): LocalMoment | null
  /** Verify both texts (me must be a participant), then write. Keeps an existing local note. */
  save(momentText: string, acceptanceText: string): LocalMoment
  remove(momentId: string): boolean
  setNote(momentId: string, text: string): LocalMoment
  /** Ids of files present (verified or not), for the "server no longer lists it" check. */
  ids(): string[]
}

export class MomentStoreError extends Error {
  constructor(readonly code: 'no_identity' | 'invalid' | 'not_found') {
    super(code)
    this.name = 'MomentStoreError'
  }
}

export function createMomentsStore(opts: MomentsStoreOptions): MomentsStore {
  const dir = path.join(opts.storeRoot, MOMENTS_DIR)
  const me = opts.me ?? (() => currentFingerprint(opts.storeRoot))
  const now = opts.now ?? (() => new Date())

  function fileOf(id: string): string {
    if (!MOMENT_ID_RE.test(id)) throw new MomentStoreError('invalid')
    return path.join(dir, `${id}.json`)
  }

  type Loaded = { file: MomentFile; local: LocalMoment } | { rejected: RejectedLocalMoment['reason'] } | null

  function load(id: string, my: string, names: Map<string, string | null>): Loaded {
    const raw = readFileIfExists(fileOf(id))
    if (!raw) return null
    let file: MomentFile
    try {
      file = FileSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      return { rejected: 'unreadable' }
    }
    const v = verifyAcceptedPair(file.moment, file.acceptance, my)
    if (!v.valid) return { rejected: v.reason }
    if (v.moment.moment_id !== id) return { rejected: 'file_name' }
    return {
      file,
      local: {
        ...momentView(v.moment, my, names),
        acceptedAt: v.acceptance.accepted_at,
        verified: true,
        myNote: file.my_note?.text || null,
        myNoteUpdatedAt: file.my_note?.updated_at ?? null
      }
    }
  }

  function ids(): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.json') && MOMENT_ID_RE.test(n.slice(0, -5)))
        .map((n) => n.slice(0, -5))
        .sort()
    } catch {
      return []
    }
  }

  function requireMe(): string {
    const my = me()
    if (!my) throw new MomentStoreError('no_identity')
    return my
  }

  function write(id: string, file: MomentFile): void {
    ensureSecureDir(dir)
    writeFileSecure(fileOf(id), `${JSON.stringify(file, null, 2)}\n`)
  }

  return {
    dir,
    ids,

    list() {
      const my = me()
      if (!my) return { moments: [], rejected: ids().map((id) => ({ file: `${id}.json`, reason: 'not_participant' as const })) }
      const names = peerNames(opts.storeRoot)
      const moments: LocalMoment[] = []
      const rejected: RejectedLocalMoment[] = []
      for (const id of ids()) {
        let l: Loaded
        try {
          l = load(id, my, names)
        } catch {
          l = { rejected: 'unreadable' }
        }
        if (!l) continue
        if ('rejected' in l) rejected.push({ file: `${id}.json`, reason: l.rejected })
        else moments.push(l.local)
      }
      moments.sort((a, b) => b.start.localeCompare(a.start) || b.end.localeCompare(a.end) || a.momentId.localeCompare(b.momentId))
      return { moments, rejected }
    },

    get(momentId) {
      if (!MOMENT_ID_RE.test(momentId)) return null
      const my = me()
      if (!my) return null
      const l = load(momentId, my, peerNames(opts.storeRoot))
      return l && !('rejected' in l) ? l.local : null
    },

    save(momentText, acceptanceText) {
      const my = requireMe()
      const v = verifyAcceptedPair(momentText, acceptanceText, my)
      if (!v.valid) throw new MomentStoreError('invalid')
      const id = v.moment.moment_id
      let note: MomentFile['my_note'] = null
      try {
        const prev = readFileIfExists(fileOf(id))
        const parsed = prev ? FileSchema.safeParse(JSON.parse(prev.toString('utf8'))) : null
        if (parsed?.success) note = parsed.data.my_note
      } catch {
        note = null
      }
      write(id, { version: 1, saved_at: now().toISOString(), moment: momentText, acceptance: acceptanceText, my_note: note })
      const l = load(id, my, peerNames(opts.storeRoot))
      if (!l || 'rejected' in l) throw new MomentStoreError('invalid')
      return l.local
    },

    remove(momentId) {
      const f = fileOf(momentId)
      // Only `<dir>/<uuid>.json` is ever removed.
      if (path.dirname(f) !== dir || !fs.existsSync(f)) return false
      fs.rmSync(f, { force: true })
      return true
    },

    setNote(momentId, text) {
      const my = requireMe()
      if (text.length > MOMENT_LIMITS.maxMyNoteChars) throw new MomentStoreError('invalid')
      const l = load(momentId, my, peerNames(opts.storeRoot))
      if (!l || 'rejected' in l) throw new MomentStoreError('not_found')
      const trimmed = text.trim()
      write(momentId, { ...l.file, my_note: trimmed ? { text, updated_at: now().toISOString() } : null })
      const again = load(momentId, my, peerNames(opts.storeRoot))
      if (!again || 'rejected' in again) throw new MomentStoreError('not_found')
      return again.local
    }
  }
}

/** Inclusive date ranges overlap. */
export function overlapsWindow(m: Pick<MomentView, 'start' | 'end'>, range: { start: string; end: string }): boolean {
  return m.start <= range.end && m.end >= range.start
}

/**
 * C11: moments a weekly letter may mention — accepted + both signatures verified (store guarantees)
 * + `visibility: "letters"` + dates overlapping the letter window. `private` never qualifies.
 * Optional `friend` restricts to one friend (per-friend letter).
 */
export function letterMoments(moments: readonly LocalMoment[], range: { start: string; end: string }, friend?: string): LocalMoment[] {
  return moments
    .filter((m) => m.verified === true && m.visibility === 'letters' && overlapsWindow(m, range) && (friend === undefined || m.friendFingerprint === friend))
    .sort((a, b) => a.start.localeCompare(b.start) || a.momentId.localeCompare(b.momentId))
}
