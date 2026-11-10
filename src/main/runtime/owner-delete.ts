// Runtime R10 (build 7066066+) per-item delete contract, shared by RuntimeClient (meetings) and the
// connectors service. Routes (bearer-only, loopback): POST /imports/delete, /memory/entries/delete,
// /timeline/delete. One transaction + one id/count-only audit row per request on the Runtime side.
// 200 → `OwnerDeleteResult`; 404 with `{detail:{error:"not_found"}}` → nothing with these ids ever
// existed; any other 404/405 → the Runtime predates R10 (no such route).
import { z } from 'zod'
import { tr } from '../../shared/i18n'

export const OWNER_DELETE_MAX_IDS = 1000

export type ImportDeleteBy = 'source_key' | 'content_sha256' | 'session_id'
export type TimelineDeleteBy = 'block_id' | 'source_key' | 'content_sha256'

const Ids = z.array(z.string().max(300)).max(OWNER_DELETE_MAX_IDS)

export const OwnerDeleteResultSchema = z.object({
  kind: z.enum(['import', 'memory_entry', 'timeline']),
  deleted: z.record(z.string().max(64), z.number().int().nonnegative()),
  deleted_ids: Ids,
  already_deleted: Ids,
  missing: Ids,
  refused: z.array(z.object({ id: z.string().max(300), reason: z.string().max(64) })).max(OWNER_DELETE_MAX_IDS),
  modeled_sessions: z.number().int().nonnegative().optional(),
  derived_memory: z.string().max(32).optional()
})
export type OwnerDeleteResult = z.infer<typeof OwnerDeleteResultSchema>

/** Body of the Runtime's 404 for ids it never had (distinguishes it from a missing route). */
const NotFoundSchema = z.object({ detail: z.object({ error: z.literal('not_found'), missing: Ids.optional() }) })

export function parseOwnerDeleteResult(payload: unknown): OwnerDeleteResult | null {
  const data = (payload as { data?: unknown } | null)?.data ?? payload
  const parsed = OwnerDeleteResultSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** `true` when a 404 body is the Runtime's "these ids never existed" answer (not a missing route). */
export function isOwnerDeleteNotFound(body: unknown): boolean {
  return NotFoundSchema.safeParse(body).success
}

/** Result object for "none of these ids exist in the Runtime" (the 404 case), so callers handle one shape. */
export function notFoundResult(kind: OwnerDeleteResult['kind'], ids: string[]): OwnerDeleteResult {
  return { kind, deleted: {}, deleted_ids: [], already_deleted: [], missing: [...ids], refused: [] }
}

/** Human (zh) text for a Runtime refusal reason code. Unknown codes are shown as the code itself. */
export const OWNER_DELETE_REFUSAL_TEXT: Record<string, string> = {
  get not_agent_written() {
    return tr(
      "This memory wasn't written by Navalia / an agent (no source:agent-run tag), so the Runtime won't delete it as a single entry.",
      '这条记忆不是由 Navalia / agent 写入的（没有 source:agent-run 标记），Runtime 不允许按条删除。'
    )
  },
  get in_supersede_chain() {
    return tr(
      "This memory has been updated (it's in a version chain), so the Runtime won't delete one link of the chain on its own.",
      '这条记忆已经被更新过（处在新旧版本链里），Runtime 不会单独删除链上的一条。'
    )
  },
  get evomem_authority() {
    return tr(
      "The Runtime's write authority is evomem, which this endpoint doesn't handle. Use Withdraw instead.",
      'Runtime 的写入权限为 evomem，这个接口不处理；可以用「撤回」。'
    )
  },
  get source_file_missing() {
    return tr("The Runtime can't find the Markdown file holding this memory.", 'Runtime 找不到这条记忆所在的 Markdown 文件。')
  },
  get not_in_source_file() {
    return tr(
      "This memory no longer exists in the Runtime's Markdown file (index and file disagree).",
      '这条记忆在 Runtime 的 Markdown 文件里已经不存在（索引与文件不一致）。'
    )
  },
  get concurrent_change() {
    return tr("The Runtime's data was changing during the delete. Try again.", '删除时 Runtime 的数据正在变化，请再试一次。')
  }
}

export function refusalText(reason: string): string {
  return OWNER_DELETE_REFUSAL_TEXT[reason] ?? tr(`Runtime refused: ${reason.slice(0, 64)}`, `Runtime 拒绝：${reason.slice(0, 64)}`)
}
