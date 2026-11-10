/**
 * Runtime owner-alias review (Runtime schema 2026-11-05.3, personal-model-og be0a0bc).
 * Pure zod + types (no Node imports) so the renderer can share the wire types.
 *
 * REST, all behind the local Bearer token (api/routes.py, api/models.py):
 *   GET  /owner-aliases?status=pending|active|rejected|all   (default pending)
 *        → ApiResponse {success, data: {status, aliases: [row]}}
 *          row = store/owner_aliases.py review_list(): alias, alias_key, status, confidence,
 *          evidence_count, first_seen_at, last_seen_at, activated_at, decision_source,
 *          evidence: [{session_id, source_kind, quote, confidence, created_at}] (newest 5)
 *   POST /owner-aliases/confirm  OwnerAliasDecisionBody {alias, note?}
 *   POST /owner-aliases/reject   OwnerAliasDecisionBody {alias, note?}  (note is ignored upstream)
 *        → ApiResponse {success, data: {alias, status}}; 400 {"detail": "unusable_alias"};
 *          422 on body validation.
 *   OwnerAliasDecisionBody: alias 1–160 chars, pattern ^[^\x00-\x1f\x7f]+$; note ≤ 500 chars.
 * CLI equivalents: `persome alias confirm <alias>` / `persome alias reject <alias>`.
 */
import { z } from 'zod'

export const OWNER_ALIAS_STATUSES = ['pending', 'active', 'rejected'] as const
export const OwnerAliasStatusSchema = z.enum(OWNER_ALIAS_STATUSES)
export type OwnerAliasStatus = z.infer<typeof OwnerAliasStatusSchema>

export const OwnerAliasListStatusSchema = z.enum(['pending', 'active', 'rejected', 'all'])
export type OwnerAliasListStatus = z.infer<typeof OwnerAliasListStatusSchema>

/**
 * Runtime OwnerAliasDecisionBody bounds (1–160 chars, no C0 / DEL), tightened for the native dialog
 * (security review F4): no C1 controls, no format characters (bidi overrides / isolates, zero-width,
 * BOM: \p{Cf}) and no line / paragraph separators, so the alias the dialog shows is the alias posted.
 */
export const OwnerAliasSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\x00-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]+$/u, 'alias must not contain control, format or separator characters')

const Ts = z.string().max(64).nullable()

export const OwnerAliasEvidenceSchema = z.object({
  session_id: z.string().max(256),
  source_kind: z.string().max(64),
  quote: z.string().max(20_000),
  confidence: z.number(),
  created_at: Ts
})

export const OwnerAliasRowSchema = z.object({
  alias: z.string().max(400),
  alias_key: z.string().max(400),
  status: OwnerAliasStatusSchema,
  confidence: z.number(),
  evidence_count: z.number().int().min(0),
  first_seen_at: Ts,
  last_seen_at: Ts,
  activated_at: Ts,
  decision_source: z.string().max(64).nullable(),
  evidence: z.array(OwnerAliasEvidenceSchema).max(100)
})
export type OwnerAliasRow = z.infer<typeof OwnerAliasRowSchema>

export const OwnerAliasListSchema = z.object({
  status: OwnerAliasListStatusSchema,
  aliases: z.array(OwnerAliasRowSchema).max(10_000)
})
export type OwnerAliasList = z.infer<typeof OwnerAliasListSchema>

export const OwnerAliasStateSchema = z.object({ alias: z.string().max(400), status: OwnerAliasStatusSchema })
export type OwnerAliasState = z.infer<typeof OwnerAliasStateSchema>

/** IPC result of a confirm / reject. `decided: false` = the user chose Cancel in the native dialog. */
export interface OwnerAliasDecision {
  decided: boolean
  alias: string
  status: OwnerAliasStatus | null
}
