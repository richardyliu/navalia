/**
 * Grant wire types (zod only, no Node imports) so the renderer can share them.
 *
 * A Connection is per-agent FULL ACCESS by default.
 * `scopes` below is an optional extension (DEVIATIONS D1).
 */
import { z } from 'zod'

/** Extension scope names (PLAN-v2 §4). */
export const EXTENSION_SCOPES = [
  'card:read',
  'identity:read',
  'now:read',
  'rewind:read',
  'evidence:read',
  'reports:read',
  'model:search',
  'model:ask',
  'model:jot',
  'model:correct',
  'connectors:read',
  'connectors:connect'
] as const

export const ScopeSchema = z.enum(EXTENSION_SCOPES)
export type Scope = z.infer<typeof ScopeSchema>

export const ClientIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

export const AccessSchema = z.discriminatedUnion('mode', [
  /** Original behaviour: the connected agent may read everything the Broker serves. */
  z.object({ mode: z.literal('full') }).strict(),
  /** Lens extension: least-privilege subset. */
  z.object({ mode: z.literal('scoped'), extension: z.literal(true), scopes: z.array(ScopeSchema).min(1).max(EXTENSION_SCOPES.length) }).strict()
])
export type GrantAccess = z.infer<typeof AccessSchema>

export const NewGrantInputSchema = z
  .object({
    client: ClientIdSchema,
    label: z.string().trim().min(1).max(80).optional(),
    /** Omitted = full access (original behaviour). Present = Lens extension. */
    scopes: z.array(ScopeSchema).min(1).max(EXTENSION_SCOPES.length).optional(),
    /** Time to live in seconds. Omitted = no expiry. */
    ttlSeconds: z.number().int().min(1).max(365 * 24 * 3600).optional(),
    /** Omitted = unlimited reads. */
    maxReads: z.number().int().min(1).max(10_000_000).optional()
  })
  .strict()
export type NewGrantInput = z.infer<typeof NewGrantInputSchema>

export type GrantState = 'active' | 'revoked' | 'expired' | 'exhausted'

/** Public view of a grant: never contains the token or its hash. */
export interface GrantView {
  id: string
  client: string
  label: string
  access: GrantAccess
  createdAt: string
  expiresAt: string | null
  maxReads: number | null
  reads: number
  lastReadAt: string | null
  revokedAt: string | null
  state: GrantState
}

/** Returned exactly once, at creation. The token is not recoverable afterwards. */
export interface IssuedGrant {
  grant: GrantView
  token: string
}
