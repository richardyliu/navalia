import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { readFileIfExists, writeFileSecure, type StorePaths } from '../store/paths'
import {
  AccessSchema,
  ClientIdSchema,
  NewGrantInputSchema,
  type GrantState,
  type GrantView,
  type IssuedGrant,
  type NewGrantInput,
  type Scope
} from './grants-schema'

export * from './grants-schema'

export const TOKEN_PREFIX = 'plg_'
const TOKEN_RE = /^plg_[A-Za-z0-9_-]{43}$/

const Iso = z.string().datetime({ offset: true })

const GrantRecordSchema = z
  .object({
    id: z.string().regex(/^grt_[0-9a-f]{16}$/),
    client: ClientIdSchema,
    label: z.string().min(1).max(80),
    access: AccessSchema,
    /** SHA-256 of the token (hex). The plaintext token is never stored. */
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: Iso,
    expires_at: Iso.nullable(),
    max_reads: z.number().int().min(1).nullable(),
    reads: z.number().int().min(0),
    last_read_at: Iso.nullable(),
    revoked_at: Iso.nullable()
  })
  .strict()
type GrantRecord = z.infer<typeof GrantRecordSchema>

const GrantsFileSchema = z.object({ version: z.literal(1), grants: z.array(GrantRecordSchema) }).strict()

export type GrantErrorCode = 'invalid_token' | 'revoked' | 'expired' | 'exhausted' | 'scope_denied' | 'not_found'

/** Typed failure for the Broker: `httpStatus` is what it should answer. */
export class GrantError extends Error {
  readonly code: GrantErrorCode
  readonly httpStatus: 401 | 403 | 404
  /** The matched grant (public view) for revoked / expired / exhausted / scope_denied; never for invalid_token. */
  readonly grant: GrantView | null
  constructor(code: GrantErrorCode, message: string, grant: GrantView | null = null) {
    super(message)
    this.name = 'GrantError'
    this.code = code
    this.grant = grant
    this.httpStatus = code === 'invalid_token' ? 401 : code === 'not_found' ? 404 : 403
  }
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

function stateOf(record: GrantRecord, now: Date): GrantState {
  if (record.revoked_at) return 'revoked'
  if (record.expires_at && Date.parse(record.expires_at) <= now.getTime()) return 'expired'
  if (record.max_reads !== null && record.reads >= record.max_reads) return 'exhausted'
  return 'active'
}

function view(record: GrantRecord, now: Date): GrantView {
  return {
    id: record.id,
    client: record.client,
    label: record.label,
    access: record.access,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    maxReads: record.max_reads,
    reads: record.reads,
    lastReadAt: record.last_read_at,
    revokedAt: record.revoked_at,
    state: stateOf(record, now)
  }
}

export interface AuthorizeOptions {
  /** Count this call as one read (Broker tool calls do; status probes do not). */
  consume?: boolean
  /** Lens extension: required scope. Full-access grants satisfy every scope. */
  scope?: Scope
}

export interface GrantStore {
  /** Connect an agent. By default revokes that client's other active grants (one connection per agent). */
  create(input: NewGrantInput, options?: { replaceExisting?: boolean }): IssuedGrant
  list(): GrantView[]
  get(id: string): GrantView
  revoke(id: string): GrantView
  /** Lens extension: set a new expiry (seconds from now, or null = none) on a non-revoked grant. */
  renew(id: string, ttlSeconds: number | null): GrantView
  /** Newest non-revoked grant of a client, if any. */
  activeFor(client: string): GrantView | null
  /** Does this plaintext token belong to `client`'s newest active grant? (connection state check) */
  matches(client: string, token: string): boolean
  /** Revoke every active grant of a client (Disconnect). Returns how many were revoked. */
  revokeClient(client: string): number
  /** Validate a presented bearer token. Throws GrantError; re-reads grants.json every call. */
  authorize(token: string, options?: AuthorizeOptions): GrantView
}

export function createGrantStore(paths: StorePaths, now: () => Date = () => new Date()): GrantStore {
  function load(): GrantRecord[] {
    const raw = readFileIfExists(paths.grantsFile)
    if (!raw) return []
    return GrantsFileSchema.parse(JSON.parse(raw.toString('utf8'))).grants
  }

  function save(grants: GrantRecord[]): void {
    writeFileSecure(paths.grantsFile, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`)
  }

  function revokeWhere(grants: GrantRecord[], pred: (g: GrantRecord) => boolean, at: string): number {
    let n = 0
    for (const g of grants) {
      if (!g.revoked_at && pred(g)) {
        g.revoked_at = at
        n++
      }
    }
    return n
  }

  return {
    create(rawInput, options = {}) {
      const input = NewGrantInputSchema.parse(rawInput)
      const t = now()
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      const record: GrantRecord = {
        id: `grt_${randomBytes(8).toString('hex')}`,
        client: input.client,
        label: input.label ?? input.client,
        access: input.scopes
          ? { mode: 'scoped', extension: true, scopes: [...new Set(input.scopes)].sort() }
          : { mode: 'full' },
        token_sha256: hashToken(token).toString('hex'),
        created_at: t.toISOString(),
        expires_at: input.ttlSeconds ? new Date(t.getTime() + input.ttlSeconds * 1000).toISOString() : null,
        max_reads: input.maxReads ?? null,
        reads: 0,
        last_read_at: null,
        revoked_at: null
      }
      const grants = load()
      if (options.replaceExisting ?? true) revokeWhere(grants, (g) => g.client === input.client, record.created_at)
      grants.push(GrantRecordSchema.parse(record))
      save(grants)
      return { grant: view(record, t), token }
    },

    list() {
      const t = now()
      return load().map((g) => view(g, t))
    },

    get(id) {
      const g = load().find((r) => r.id === id)
      if (!g) throw new GrantError('not_found', 'no such grant')
      return view(g, now())
    },

    revoke(id) {
      const grants = load()
      const g = grants.find((r) => r.id === id)
      if (!g) throw new GrantError('not_found', 'no such grant')
      if (!g.revoked_at) {
        g.revoked_at = now().toISOString()
        save(grants)
      }
      return view(g, now())
    },

    renew(id, ttlSeconds) {
      if (ttlSeconds !== null && !(Number.isInteger(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= 365 * 24 * 3600)) {
        throw new Error('ttlSeconds must be an integer between 1 and 31536000, or null')
      }
      const grants = load()
      const g = grants.find((r) => r.id === id)
      if (!g) throw new GrantError('not_found', 'no such grant')
      if (g.revoked_at) throw new GrantError('revoked', 'a revoked grant cannot be renewed')
      const t = now()
      g.expires_at = ttlSeconds === null ? null : new Date(t.getTime() + ttlSeconds * 1000).toISOString()
      save(grants)
      return view(g, t)
    },

    activeFor(client) {
      const t = now()
      const list = load().filter((g) => g.client === client && !g.revoked_at)
      const g = list[list.length - 1]
      return g ? view(g, t) : null
    },

    matches(client, token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false
      const presented = hashToken(token)
      const t = now()
      let ok = false
      for (const g of load()) {
        const same = timingSafeEqual(presented, Buffer.from(g.token_sha256, 'hex'))
        if (same && g.client === client && stateOf(g, t) === 'active') ok = true
      }
      return ok
    },

    revokeClient(client) {
      const grants = load()
      const n = revokeWhere(grants, (g) => g.client === client, now().toISOString())
      if (n > 0) save(grants)
      return n
    },

    authorize(token, options = {}) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
        throw new GrantError('invalid_token', 'malformed token')
      }
      const presented = hashToken(token)
      const grants = load()
      // Compare against every record in constant time per comparison; no early exit on match.
      let match: GrantRecord | null = null
      for (const g of grants) {
        if (timingSafeEqual(presented, Buffer.from(g.token_sha256, 'hex')) && !match) match = g
      }
      if (!match) throw new GrantError('invalid_token', 'unknown token')
      const t = now()
      const state = stateOf(match, t)
      if (state !== 'active') throw new GrantError(state, `grant is ${state}`, view(match, t))
      if (options.scope && match.access.mode === 'scoped' && !match.access.scopes.includes(options.scope)) {
        throw new GrantError('scope_denied', `grant lacks scope ${options.scope} (Navalia extension)`, view(match, t))
      }
      if (options.consume) {
        match.reads += 1
        match.last_read_at = t.toISOString()
        save(grants)
      }
      return view(match, t)
    }
  }
}
