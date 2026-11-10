/**
 * S1-FULL C15 — Workflow extraction through the opt-in Lens cloud (main only).
 *
 * Flow (same trust model as Lens Chat):
 *  1. `preview(sessionKey)` reads one local agent session (read-only HET adapters), turns it into
 *     redacted `recent` context items (`buildBundle` → `redactForCloud`; ≤60000 chars total, ≤8000
 *     per item) and parks them in main under a random `previewId`. Nothing leaves the machine.
 *  2. `run(previewId, includeIds)` sends exactly those parked snapshots (the renderer only names ids)
 *     to `POST /v1/chat/completions` with `task: "workflow_extract"` via the cloud client's `stream()`.
 *     The reply must be a ```json block (cloud-draft.ts); it is parsed + validated, cites outside the
 *     sent ids are dropped, and an unparseable reply is rejected whole. The draft is parked in main.
 *  3. `save(extractionId, draft)` stores the user-reviewed draft as a new Workflow with
 *     `extraction.source = cloud_extracted` (session ref, model, cited item snapshots, edit markers).
 *
 * Cloud OFF / signed out / not wired ⇒ `run` refuses before any network call. This file never calls
 * fetch: the only network path is `src/main/cloud/client.ts`.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { buildBundle, redactForCloud } from '../cloud/context'
import type { CloudClient } from '../cloud/client'
import { CloudError } from '../cloud/errors'
import type { CloudExtractDraftResult, CloudExtractItem, CloudExtractPreview, CloudExtractStatus, CloudSaveResult, SessionList, SessionSummary } from './api'
import { CloudDraftSchema, citedIds, draftEditedFields, editFromCloudDraft, itemCitesOf, parseCloudReply, type CloudDraft } from './cloud-draft'
import type { CloudSessionRef, ExtractionMeta } from './schema'
import { sessionCandidates, type SessionSource } from './sessions'
import { WorkflowError } from './store'
import type { WorkflowService } from './service'

export const WORKFLOW_EXTRACT_TASK = 'workflow_extract'
export const CLOUD_AGENT_LABEL = 'Navalia 云端'
const CHAT_PATH = '/v1/chat/completions'
const MAX_REPLY_CHARS = 200_000
const DEFAULT_PREVIEW_TTL_MS = 15 * 60_000
const DEFAULT_DRAFT_TTL_MS = 60 * 60_000
const MAX_PARKED = 8

export interface CloudExtractDeps {
  workflows: Pick<WorkflowService, 'saveCloudExtracted'>
  /** The cloud service (client + status); null/undefined when not wired ⇒ extraction unavailable. */
  cloud?: { client: CloudClient; status(): { enabled: boolean; signedIn: boolean } } | null
  sessions: SessionSource
  sources: { claudeCode: boolean; codex: boolean }
  knownSecrets?: () => string[]
  now?: () => Date
  randomHex?: (bytes: number) => string
  previewTtlMs?: number
  draftTtlMs?: number
}

interface ParkedPreview {
  preview: CloudExtractPreview
  hint: string
  expires: number
}

interface ParkedDraft {
  session: CloudSessionRef
  sent: CloudExtractItem[]
  draft: CloudDraft
  model: string | null
  extractedAt: string
  expires: number
}

const DeltaSchema = z.object({ text: z.string() })
const UsageSchema = z.object({ model: z.string().max(200) })
const DoneSchema = z.object({ finish_reason: z.enum(['stop', 'length', 'error']) })

function safeJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

/** The fixed instruction sent as the single user message (the server owns the system prompt). */
export function extractInstruction(hint: string): string {
  const focus = hint.trim() ? `\n用户关心的工作：${hint.trim()}` : ''
  return [
    '请从提供的会话片段中抽取一个可复用的工作流（Workflow）。',
    '只输出一个 ```json 代码块，格式：{"title","steps":[{"title","detail","cites":["ctx-N"]}],"artifacts":[{"name","kind","cites"}],"rules":[{"text","cites"}],"problems":[{"text","resolution","cites"}]}。',
    '每一项都必须在 cites 里写出依据的 ctx id；片段里没有依据的内容不要写，宁可留空。' + focus
  ].join('\n')
}

export function createCloudExtractService(deps: CloudExtractDeps) {
  const now = deps.now ?? (() => new Date())
  const hex = deps.randomHex ?? ((n: number) => randomBytes(n).toString('hex'))
  const previewTtl = deps.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
  const draftTtl = deps.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS
  const previews = new Map<string, ParkedPreview>()
  const drafts = new Map<string, ParkedDraft>()
  const running = new Map<string, AbortController>()
  const known = (): string[] => {
    try {
      return deps.knownSecrets?.() ?? []
    } catch {
      return []
    }
  }

  /** Titles leave main (renderer, saved provenance): scrub them with this service's known secrets too. */
  function scrubbed(summary: SessionSummary): SessionSummary {
    const r = redactForCloud(summary.title, known())
    return { ...summary, title: r.dropped ? '（标题已省略）' : r.text.slice(0, 200) }
  }

  function sweep(): void {
    const t = now().getTime()
    for (const [k, v] of previews) if (v.expires < t) previews.delete(k)
    for (const [k, v] of drafts) if (v.expires < t) drafts.delete(k)
  }

  function status(): CloudExtractStatus {
    if (!deps.cloud) return { available: false, enabled: false, signedIn: false, reason: tr('This build has no cloud service; cloud extraction is unavailable', '这个版本没有接入云端服务，云端抽取不可用') }
    let s: { enabled: boolean; signedIn: boolean }
    try {
      s = deps.cloud.status()
    } catch {
      return { available: true, enabled: false, signedIn: false, reason: tr('Could not read cloud settings; cloud extraction is unavailable', '读取云端设置失败，云端抽取不可用') }
    }
    if (!s.enabled) return { available: true, enabled: false, signedIn: false, reason: tr('Cloud is off: turn it on and sign in under Settings → Cloud to extract', '云端未开启：在「设置 → 云端」开启并登录后才能抽取') }
    if (!s.signedIn) return { available: true, enabled: true, signedIn: false, reason: tr('Cloud is on but not signed in: sign in to extract', '云端已开启但未登录：登录后才能抽取') }
    return { available: true, enabled: true, signedIn: true, reason: null }
  }

  /** Throws before any network call unless cloud is wired, ON and signed in. */
  function requireCloud(): { client: CloudClient } {
    if (!deps.cloud) throw new CloudError('disabled', { detail: tr('No cloud service connected', '未接入云端服务') })
    deps.cloud.client.origin() // `disabled` when OFF / no server
    if (!deps.cloud.status().signedIn) throw new CloudError('unauthorized', { detail: tr('Sign in to the cloud first', '请先登录云端') })
    return deps.cloud
  }

  function refOf(summary: CloudExtractPreview['session']): CloudSessionRef {
    return { agent: summary.agent, key: summary.key, title: summary.title.slice(0, 200), started_at: summary.startedAt, ended_at: summary.endedAt }
  }

  return {
    status,

    sessions(): SessionList {
      return { sessions: deps.sessions.list().map(scrubbed), sources: deps.sources }
    },

    preview(sessionKey: string, hint = ''): CloudExtractPreview {
      sweep()
      const found = deps.sessions.events(sessionKey)
      if (!found) throw new WorkflowError('not_found', tr('Session not found (it may have been deleted or is outside the latest 30 files); refresh the session list', '找不到这个会话（可能已被删除或超出最近 30 个文件），请刷新会话列表'))
      const s = { summary: scrubbed(found.summary), events: found.events }
      const b = buildBundle(sessionCandidates(s.summary, s.events), { maxItems: 100, knownSecrets: known() })
      if (b.items.length === 0) throw new WorkflowError('invalid', tr('This session has nothing to send (everything may have been redacted)', '这个会话没有可发送的内容（可能全部被脱敏省略）'))
      while (previews.size >= MAX_PARKED) previews.delete(previews.keys().next().value as string)
      const previewId = hex(16)
      const expires = now().getTime() + previewTtl
      const preview: CloudExtractPreview = {
        previewId,
        session: s.summary,
        items: b.items.map(({ id, kind, title, text, ref, chars }) => ({ id, kind, title, text, ref, chars })),
        totalChars: b.totalChars,
        warnings: b.warnings,
        expiresAt: new Date(expires).toISOString()
      }
      previews.set(previewId, { preview, hint: hint.trim().slice(0, 200), expires })
      return preview
    },

    discard(previewId: string): boolean {
      return previews.delete(previewId)
    },

    cancel(previewId: string): boolean {
      const c = running.get(previewId)
      if (!c) return false
      c.abort()
      return true
    },

    async run(previewId: string, includeIds: string[]): Promise<CloudExtractDraftResult> {
      sweep()
      const parked = previews.get(previewId)
      if (!parked) throw new WorkflowError('not_found', tr('The preview has expired (over 15 minutes old or already sent); preview again', '预览已失效（超过 15 分钟或已发送），请重新预览'))
      if (running.has(previewId)) throw new CloudError('busy')
      const wanted = new Set(includeIds)
      for (const id of wanted) if (!parked.preview.items.some((i) => i.id === id)) throw new WorkflowError('invalid', tr(`${id} is not in the preview`, `预览里没有 ${id}`))
      // Exactly the parked snapshots, in preview order.
      const sent = parked.preview.items.filter((i) => wanted.has(i.id))
      if (sent.length === 0) throw new WorkflowError('invalid', tr('Select at least one item', '至少选择一条内容'))
      const cloud = requireCloud()

      const body = {
        messages: [{ role: 'user' as const, content: extractInstruction(parked.hint) }],
        // `ref` is optional server-side (never forwarded to the LLM); omitted when null.
        context: { items: sent.map(({ id, kind, title, text, ref }) => (ref === null ? { id, kind, title, text } : { id, kind, title, text, ref })) },
        task: WORKFLOW_EXTRACT_TASK
      }
      previews.delete(previewId) // single use
      const controller = new AbortController()
      running.set(previewId, controller)
      let text = ''
      let model: string | null = null
      let done: z.infer<typeof DoneSchema> | null = null
      try {
        for await (const ev of cloud.client.stream(CHAT_PATH, body, { signal: controller.signal })) {
          const data = safeJson(ev.data)
          if (ev.event === 'delta') {
            const d = DeltaSchema.safeParse(data)
            if (d.success && text.length < MAX_REPLY_CHARS) text += d.data.text.slice(0, MAX_REPLY_CHARS - text.length)
          } else if (ev.event === 'usage') {
            const u = UsageSchema.safeParse(data)
            if (u.success) model = u.data.model
          } else if (ev.event === 'error') {
            throw new CloudError('upstream_error', { detail: tr('No draft was generated', '没有生成草稿') })
          } else if (ev.event === 'done') {
            const d = DoneSchema.safeParse(data)
            done = d.success ? d.data : { finish_reason: 'error' }
            break
          }
        }
      } finally {
        running.delete(previewId)
      }
      if (controller.signal.aborted && !done) throw new CloudError('cancelled', { detail: tr('Cancelled; no draft was generated', '已取消，未生成草稿') })
      if (!done) throw new CloudError('bad_response', { detail: tr('The reply did not finish normally; no draft was generated', '回复没有正常结束，未生成草稿') })
      if (done.finish_reason !== 'stop') throw new CloudError(done.finish_reason === 'length' ? 'bad_response' : 'upstream_error', { detail: tr('The reply was cut off or failed; no draft was generated', '回复被截断或出错，未生成草稿') })

      const parsed = parseCloudReply(text, sent.map((i) => i.id))
      if (!parsed.ok) throw new WorkflowError('invalid', parsed.error)
      const extractionId = hex(16)
      const expires = now().getTime() + draftTtl
      while (drafts.size >= MAX_PARKED) drafts.delete(drafts.keys().next().value as string)
      drafts.set(extractionId, { session: refOf(parked.preview.session), sent, draft: parsed.draft, model, extractedAt: now().toISOString(), expires })
      return {
        extractionId,
        draft: parsed.draft,
        sent,
        model,
        droppedItems: parsed.droppedItems,
        strippedCites: parsed.strippedCites,
        expiresAt: new Date(expires).toISOString()
      }
    },

    async save(extractionId: string, rawDraft: CloudDraft): Promise<CloudSaveResult> {
      sweep()
      const parked = drafts.get(extractionId)
      if (!parked) throw new WorkflowError('not_found', tr('The draft has expired (over 60 minutes old or already saved); extract again', '草稿已失效（超过 60 分钟或已保存），请重新抽取'))
      const draft = CloudDraftSchema.parse(rawDraft)
      const sentIds = new Set(parked.sent.map((i) => i.id))
      for (const id of citedIds(draft)) if (!sentIds.has(id)) throw new WorkflowError('invalid', tr(`Citation ${id} is not among the sent items`, `引用 ${id} 不在已发送的内容里`))
      if (draft.steps.length === 0) throw new WorkflowError('invalid', tr('At least one step is needed to save', '至少需要一个步骤才能保存'))
      const editedFields = draftEditedFields(parked.draft, draft)
      const cited = new Set(citedIds(draft))
      const meta: ExtractionMeta = {
        source: 'cloud_extracted',
        agent: CLOUD_AGENT_LABEL,
        extracted_at: parked.extractedAt,
        model: parked.model,
        session: parked.session,
        sent_ids: parked.sent.map((i) => i.id),
        cited_items: parked.sent.filter((i) => cited.has(i.id)).map(({ id, kind, title, text, ref }) => ({ id, kind, title, text, ref })),
        item_cites: itemCitesOf(draft),
        edited_fields: editedFields
      }
      const agentName = parked.session.agent === 'codex' ? 'Codex' : 'Claude Code'
      const note = `云端抽取自 ${agentName} 会话「${parked.session.title}」：发送 ${parked.sent.length} 条，引用 ${cited.size} 条`
      const item = await deps.workflows.saveCloudExtracted(editFromCloudDraft(draft), meta, note)
      drafts.delete(extractionId)
      return { item, editedFields }
    }
  }
}
