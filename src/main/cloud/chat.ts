// S1-FULL C3 / C5 / C6 / C7 — Lens Chat service (main only).
//
// Flow: `preview` (or `wechatPreview`) assembles a redacted context bundle from the LOCAL Runtime
// and parks it in main under a random `previewId` (bounded LRU, 15 min TTL). The renderer shows
// the exact items; `send({previewId, includeIds})` sends exactly those stored items plus the
// question fixed at preview time — the renderer cannot inject context text. The SSE reply is
// streamed back to the requesting webContents only, and the conversation (with the sent item
// snapshots and resolved citations) is persisted in `<LensStore>/chat/<id>.json` (0600, dir 0700).
// Nothing is stored server-side by Lens. 「记住这条」 goes through Runtime MCP `remember` after a
// main-owned native confirm. Network access only via `client.ts` (this file never calls fetch).
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ModelGraphResponse } from '../../shared/types'
import { stripSecrets } from '../import/redact'
import { scrubKnownSecrets } from '../mcp/known-secrets'
import { ensureSecureDir, readFileIfExists, writeFileSecure } from '../store/paths'
import {
  CHAT_EVENT_CHANNEL,
  CHAT_LIMITS,
  CONTEXT_KINDS,
  type ChatAssistantMessage,
  type ChatContextItem,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatEvent,
  type ChatMessage,
  type ChatMessageStatus,
  type ChatPreview,
  type ChatRememberPreview,
  type ChatSendStarted,
  type ChatServerUsage,
  type ChatTask,
  type ChatUsage
} from './chat-api'
import type { CloudErrorCode } from './api'
import type { CloudClient } from './client'
import { buildBundle, gatherContext, gatherWechat, type ContextSourceDeps } from './context'
import { tr } from '../../shared/i18n'
import { CloudError, cloudMessage } from './errors'
import type { CloudConfirm } from './service'

/** The subset of Electron's WebContents used for stream events (no electron import here). */
export interface ChatSender {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}

export interface ChatDeps {
  storeRoot: string
  /** The cloud service (client + status). */
  cloud: { client: CloudClient; status(): { enabled: boolean; signedIn: boolean } }
  ossTool(name: string, args: Record<string, unknown>): Promise<string>
  runtime?: () => { modelGraph(): Promise<ModelGraphResponse> }
  /** Runtime local token + env secrets, scrubbed verbatim before anything is sent / remembered. */
  knownSecrets?: () => string[]
  /** Main-owned native confirm; absent ⇒ 「记住这条」 is refused. */
  nativeConfirm?: CloudConfirm
  now?: () => Date
  randomHex?: (bytes: number) => string
  previewTtlMs?: number
  maxPreviews?: number
}

export interface ChatService {
  preview(args: { question: string; conversationId?: string }): Promise<ChatPreview>
  wechatPreview(args: { keyword?: string; conversationId?: string }): Promise<ChatPreview>
  discardPreview(previewId: string): boolean
  send(args: { previewId: string; includeIds: string[] }, sender: ChatSender | null): Promise<ChatSendStarted>
  cancel(streamId: string): boolean
  list(): ChatConversationSummary[]
  get(id: string): ChatConversation
  delete(id: string): boolean
  usage(): Promise<ChatServerUsage>
  rememberPreview(args: { conversationId: string; messageIndex: number }): ChatRememberPreview
  remember(rememberId: string, sender: unknown): Promise<{ entryId: string }>
  /** Resolves when the stream has finished and its message is persisted (tests / shutdown). */
  settled(streamId: string): Promise<void>
}

export const CHAT_DIR = 'chat'
export const CONVERSATION_ID_RE = /^c-[0-9a-f]{16}$/
export const HEX32_RE = /^[0-9a-f]{32}$/
export const REMEMBER_TAGS = ['lens-chat', 'cloud-chat'] as const
const DEFAULT_PREVIEW_TTL_MS = 15 * 60_000
const DEFAULT_MAX_PREVIEWS = 16
const REMEMBER_TTL_MS = 10 * 60_000
const REMEMBER_MAX_CHARS = 20_000
const MAX_ANSWER_CHARS = 200_000
const EXCERPT_CHARS = 400

export function wechatQuestion(keyword?: string): string {
  const kw = keyword?.trim()
  return `请按群整理这周微信群里的讨论要点${kw ? `（关键词：${kw}）` : ''}：每个群列出主要话题、结论和待办，并标注引用。只依据提供的屏幕采集内容，没有的内容不要补充或猜测。`
}

// --- persisted conversation schema (read side; fail closed on anything unexpected) -----------

const ItemSchema = z.strictObject({
  id: z.string().regex(/^ctx-\d{1,3}$/),
  kind: z.enum(CONTEXT_KINDS),
  title: z.string().max(400),
  text: z.string().max(CHAT_LIMITS.maxItemChars + 200),
  ref: z.string().max(512).nullable(),
  chars: z.number().int().nonnegative()
})
const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  model: z.string().max(200),
  estimated: z.boolean().optional()
})
const MessageSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('user'), content: z.string(), at: z.string() }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string(),
    at: z.string(),
    task: z.enum(['chat', 'group_digest']),
    status: z.enum(['complete', 'truncated', 'error', 'cancelled']),
    partial: z.boolean(),
    errorCode: z.string().max(64).nullable(),
    context: z.array(ItemSchema),
    citations: z.array(ItemSchema),
    usage: z
      .strictObject({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        model: z.string(),
        estimated: z.boolean().optional()
      })
      .nullable(),
    rememberedEntryId: z.string().max(256).nullable()
  })
])
const ConversationSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(CONVERSATION_ID_RE),
  title: z.string().max(200),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(MessageSchema)
})

// --- SSE payloads ---------------------------------------------------------------------------

const DeltaSchema = z.object({ text: z.string() })
const ErrorEventSchema = z.object({ code: z.string().max(64) })
const DoneSchema = z.object({
  finish_reason: z.enum(['stop', 'length', 'error']),
  citations: z.array(z.string().max(32)).max(500).optional()
})
const ServerUsageSchema = z.object({
  day: z.string().max(32),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable().optional()
})
const RememberResponse = z.object({ entry_id: z.string().min(1).max(256) })

interface StoredPreview {
  preview: ChatPreview
  conversationId: string | null
  expires: number
}

interface PendingRemember {
  conversationId: string
  messageIndex: number
  content: string
  expires: number
  busy: boolean
}

interface ActiveStream {
  conversationId: string
  controller: AbortController
  done: Promise<void>
}

function safeJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

export function createChatService(deps: ChatDeps): ChatService {
  const now = deps.now ?? (() => new Date())
  const hex = deps.randomHex ?? ((n: number) => randomBytes(n).toString('hex'))
  const ttl = deps.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
  const maxPreviews = deps.maxPreviews ?? DEFAULT_MAX_PREVIEWS
  const dir = path.join(deps.storeRoot, CHAT_DIR)
  const previews = new Map<string, StoredPreview>()
  const remembers = new Map<string, PendingRemember>()
  const streams = new Map<string, ActiveStream>()
  const known = (): string[] => {
    try {
      return deps.knownSecrets?.() ?? []
    } catch {
      return []
    }
  }
  const sourceDeps: ContextSourceDeps = { ossTool: deps.ossTool, runtime: deps.runtime, knownSecrets: known, now }

  // --- storage -------------------------------------------------------------------------------

  function fileOf(id: string): string {
    if (!CONVERSATION_ID_RE.test(id)) throw new CloudError('invalid_args')
    return path.join(dir, `${id}.json`)
  }

  function load(id: string): ChatConversation | null {
    const buf = readFileIfExists(fileOf(id))
    if (!buf) return null
    try {
      return ConversationSchema.parse(JSON.parse(buf.toString('utf8'))) as ChatConversation
    } catch {
      return null
    }
  }

  function save(c: ChatConversation): void {
    writeFileSecure(fileOf(c.id), `${JSON.stringify(c, null, 2)}\n`)
  }

  // --- previews ------------------------------------------------------------------------------

  function sweep(): void {
    const t = now().getTime()
    for (const [k, v] of previews) if (v.expires < t) previews.delete(k)
    for (const [k, v] of remembers) if (v.expires < t && !v.busy) remembers.delete(k)
  }

  function park(task: ChatTask, question: string, conversationId: string | null, items: ChatContextItem[], totalChars: number, warnings: string[]): ChatPreview {
    sweep()
    while (previews.size >= maxPreviews) previews.delete(previews.keys().next().value as string)
    const previewId = hex(16)
    const expires = now().getTime() + ttl
    const preview: ChatPreview = { previewId, task, question, items, totalChars, warnings, expiresAt: new Date(expires).toISOString() }
    previews.set(previewId, { preview, conversationId, expires })
    return preview
  }

  function checkConversation(id: string | undefined): string | null {
    if (id === undefined) return null
    if (!load(id)) throw new CloudError('not_found', { detail: tr('Conversation not found', '对话不存在') })
    return id
  }

  // --- streaming -----------------------------------------------------------------------------

  function emit(sender: ChatSender | null, event: ChatEvent): void {
    if (!sender) return
    try {
      if (sender.isDestroyed?.()) return
      sender.send(CHAT_EVENT_CHANNEL, event)
    } catch {
      // Window gone: the message is still persisted.
    }
  }

  async function pump(
    streamId: string,
    conversationId: string,
    task: ChatTask,
    sent: ChatContextItem[],
    body: unknown,
    signal: AbortSignal,
    sender: ChatSender | null
  ): Promise<void> {
    let text = ''
    let usage: ChatUsage | null = null
    let done: z.infer<typeof DoneSchema> | null = null
    let errorCode: CloudErrorCode | null = null
    try {
      for await (const ev of deps.cloud.client.stream('/v1/chat/completions', body, { signal })) {
        const data = safeJson(ev.data)
        if (ev.event === 'delta') {
          const d = DeltaSchema.safeParse(data)
          if (!d.success || !d.data.text) continue
          const room = MAX_ANSWER_CHARS - text.length
          if (room <= 0) continue
          const piece = d.data.text.slice(0, room)
          text += piece
          emit(sender, { streamId, type: 'delta', text: piece })
        } else if (ev.event === 'usage') {
          const u = UsageSchema.safeParse(data)
          if (!u.success) continue
          usage = { prompt_tokens: u.data.prompt_tokens, completion_tokens: u.data.completion_tokens, model: u.data.model, ...(u.data.estimated === undefined ? {} : { estimated: u.data.estimated }) }
          emit(sender, { streamId, type: 'usage', usage })
        } else if (ev.event === 'error') {
          const e = ErrorEventSchema.safeParse(data)
          errorCode = e.success && e.data.code === 'upstream_timeout' ? 'upstream_timeout' : 'upstream_error'
          emit(sender, { streamId, type: 'error', code: errorCode, message: cloudMessage(errorCode) })
        } else if (ev.event === 'done') {
          const d = DoneSchema.safeParse(data)
          done = d.success ? d.data : { finish_reason: 'error' }
          break
        }
      }
    } catch (e) {
      errorCode = e instanceof CloudError ? e.code : 'unknown'
      emit(sender, { streamId, type: 'error', code: errorCode, message: e instanceof CloudError ? e.message : cloudMessage('unknown') })
    }

    let status: ChatMessageStatus
    if (signal.aborted && !done) status = 'cancelled'
    else if (errorCode) status = 'error'
    else if (!done) {
      status = 'error'
      errorCode = 'bad_response'
      emit(sender, { streamId, type: 'error', code: errorCode, message: tr('The answer did not finish normally and may be incomplete', '回答没有正常结束，内容可能不完整') })
    } else if (done.finish_reason === 'error') {
      status = 'error'
      errorCode = 'upstream_error'
    } else if (done.finish_reason === 'length') status = 'truncated'
    else status = 'complete'

    const byId = new Map(sent.map((i) => [i.id, i]))
    const citations: ChatContextItem[] = []
    for (const id of new Set(done?.citations ?? [])) {
      const item = byId.get(id)
      if (item) citations.push(item)
    }
    const message: ChatAssistantMessage = {
      role: 'assistant',
      content: text,
      at: now().toISOString(),
      task,
      status,
      partial: status !== 'complete',
      errorCode,
      context: sent,
      citations,
      usage,
      rememberedEntryId: null
    }
    // Deleted while streaming ⇒ do not resurrect the file.
    const conv = load(conversationId)
    if (conv) {
      conv.messages.push(message)
      conv.updatedAt = message.at
      save(conv)
    }
    emit(sender, { streamId, type: 'end', status, conversationId })
  }

  function historyFor(conv: ChatConversation): Array<{ role: 'user' | 'assistant'; content: string }> {
    return conv.messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content.slice(0, CHAT_LIMITS.maxMessageChars) }))
  }

  // --- remember ------------------------------------------------------------------------------

  function rememberText(conversationId: string, m: ChatAssistantMessage): string {
    const ids = m.citations.map((c) => c.id)
    const refs = m.citations.map((c) => c.ref).filter((r): r is string => Boolean(r))
    const source = `来源：Navalia Chat ${conversationId} · 引用 ${ids.length ? ids.join(', ') : '无'}${refs.length ? ` (${refs.join('; ')})` : ''}`
    return `${m.content.trim()}\n\n${source}`
  }

  return {
    async preview(args) {
      const conversationId = checkConversation(args.conversationId)
      const question = args.question.trim()
      if (!question) throw new CloudError('invalid_args', { detail: tr('The question is empty', '问题为空') })
      const g = await gatherContext(question, sourceDeps)
      const b = buildBundle(g.candidates, { knownSecrets: known() })
      return park('chat', question, conversationId, b.items, b.totalChars, [...g.warnings, ...b.warnings])
    },

    async wechatPreview(args) {
      const conversationId = checkConversation(args.conversationId)
      const g = await gatherWechat(args.keyword, sourceDeps)
      const b = buildBundle(g.candidates, { knownSecrets: known() })
      return park('group_digest', wechatQuestion(args.keyword), conversationId, b.items, b.totalChars, [...g.warnings, ...b.warnings])
    },

    discardPreview(previewId) {
      return previews.delete(previewId)
    },

    async send(args, sender) {
      sweep()
      const stored = previews.get(args.previewId)
      if (!stored) throw new CloudError('not_found', { detail: tr('The preview has expired (older than 15 minutes or already sent). Preview again', '预览已失效（超过 15 分钟或已发送），请重新预览') })
      const wanted = new Set(args.includeIds)
      for (const id of wanted) if (!stored.preview.items.some((i) => i.id === id)) throw new CloudError('invalid_args', { detail: tr(`${id} is not in the preview`, `预览里没有 ${id}`) })
      // Exactly the stored snapshots, in preview order.
      const sent = stored.preview.items.filter((i) => wanted.has(i.id))
      if (stored.preview.task === 'group_digest' && sent.length === 0) throw new CloudError('invalid_args', { detail: tr('Select at least one group', '至少选择一个群') })
      deps.cloud.client.origin() // `disabled` before anything else
      if (!deps.cloud.status().signedIn) throw new CloudError('unauthorized', { detail: tr('Sign in to Cloud first', '请先登录云端') })

      let conv: ChatConversation | null = stored.conversationId ? load(stored.conversationId) : null
      if (stored.conversationId && !conv) throw new CloudError('not_found', { detail: tr('Conversation not found', '对话不存在') })
      if (conv && [...streams.values()].some((s) => s.conversationId === conv!.id)) throw new CloudError('busy', { detail: tr('This conversation is still generating an answer', '这个对话还在生成回答') })
      const at = now().toISOString()
      if (!conv) {
        const title = stored.preview.task === 'group_digest' ? '微信群整理' : stored.preview.question.replace(/\s+/g, ' ').slice(0, 40)
        conv = { version: 1, id: `c-${hex(8)}`, title, createdAt: at, updatedAt: at, messages: [] }
      }
      const question = stored.preview.question.slice(0, CHAT_LIMITS.maxMessageChars)
      const messages = [...historyFor(conv), { role: 'user' as const, content: question }].slice(-CHAT_LIMITS.maxMessages)
      const body = {
        messages,
        // `ref` is optional server-side (and never forwarded to the LLM); omitted when null.
        context: { items: sent.map(({ id, kind, title, text, ref }) => (ref === null ? { id, kind, title, text } : { id, kind, title, text, ref })) },
        task: stored.preview.task
      }
      // Single use: a preview is consumed by its first send.
      previews.delete(args.previewId)
      conv.messages.push({ role: 'user', content: question, at } satisfies ChatMessage)
      conv.updatedAt = at
      save(conv)

      const streamId = hex(16)
      const controller = new AbortController()
      const conversationId = conv.id
      const done = pump(streamId, conversationId, stored.preview.task, sent, body, controller.signal, sender)
        .catch(() => undefined)
        .finally(() => streams.delete(streamId))
      streams.set(streamId, { conversationId, controller, done })
      return { streamId, conversationId }
    },

    cancel(streamId) {
      const s = streams.get(streamId)
      if (!s) return false
      s.controller.abort()
      return true
    },

    list() {
      ensureSecureDir(dir)
      const out: ChatConversationSummary[] = []
      for (const f of fs.readdirSync(dir)) {
        const m = /^(c-[0-9a-f]{16})\.json$/.exec(f)
        if (!m) continue
        const c = load(m[1])
        if (c) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: c.messages.length })
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    get(id) {
      const c = load(id)
      if (!c) throw new CloudError('not_found', { detail: tr('Conversation not found', '对话不存在') })
      return c
    },

    delete(id) {
      const file = fileOf(id)
      for (const s of streams.values()) if (s.conversationId === id) s.controller.abort()
      const existed = fs.existsSync(file)
      fs.rmSync(file, { force: true })
      for (const [k, r] of remembers) if (r.conversationId === id) remembers.delete(k)
      return existed
    },

    async usage() {
      const u = await deps.cloud.client.requestJson('GET', '/v1/usage', undefined, ServerUsageSchema)
      return { day: u.day, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, limit: u.limit ?? null }
    },

    rememberPreview(args) {
      const c = load(args.conversationId)
      if (!c) throw new CloudError('not_found', { detail: tr('Conversation not found', '对话不存在') })
      const m = c.messages[args.messageIndex]
      if (!m || m.role !== 'assistant' || !m.content.trim()) throw new CloudError('invalid_args', { detail: tr('Only a cloud answer with content can be remembered', '只能记住有内容的云端回答') })
      const raw = rememberText(c.id, m)
      const k = scrubKnownSecrets(raw, known())
      const s = stripSecrets(k.text)
      if (s.dropped) throw new CloudError('invalid_args', { detail: tr('The content looks like environment variables or credentials and cannot be written to memory', '内容疑似环境变量 / 凭据输出，不能写入记忆') })
      if (s.text.length > REMEMBER_MAX_CHARS) throw new CloudError('invalid_args', { detail: tr(`Content is too long (${s.text.length} characters, limit ${REMEMBER_MAX_CHARS})`, `内容过长（${s.text.length} 字，上限 ${REMEMBER_MAX_CHARS}）`) })
      sweep()
      while (remembers.size >= 8) remembers.delete(remembers.keys().next().value as string)
      const rememberId = hex(16)
      remembers.set(rememberId, { conversationId: c.id, messageIndex: args.messageIndex, content: s.text, expires: now().getTime() + REMEMBER_TTL_MS, busy: false })
      return { rememberId, content: s.text, tags: [...REMEMBER_TAGS], chars: s.text.length, redactions: s.redactions + k.count }
    },

    async remember(rememberId, sender) {
      sweep()
      const p = remembers.get(rememberId)
      if (!p) throw new CloudError('not_found', { detail: tr('The preview has expired. Click "Remember this" again', '预览已失效，请重新点「记住这条」') })
      if (p.busy) throw new CloudError('busy')
      if (!deps.nativeConfirm) throw new CloudError('cancelled', { detail: tr('Writing to memory needs confirmation from the main process, which is unavailable right now', '写入记忆需要主进程确认，当前不可用') })
      p.busy = true
      try {
        const ok = await deps.nativeConfirm(sender, {
          message: tr('Write this cloud answer to Persome memory?', '把这条云端回答写入 Persome 记忆？'),
          detail: `${tr(`${p.content.length} characters, tags: ${REMEMBER_TAGS.join(', ')}. Once written, other connected Agents can read it too. Will write:`, `${p.content.length} 字，标签：${REMEMBER_TAGS.join(', ')}。写入后其他连接的 Agent 也能读到。将写入：`)}\n\n${p.content.length > EXCERPT_CHARS ? `${p.content.slice(0, EXCERPT_CHARS)}…` : p.content}`,
          confirmLabel: tr('Write', '写入')
        })
        if (!ok) throw new CloudError('cancelled', { detail: tr('Not written to memory', '未写入记忆') })
        let raw: string
        try {
          raw = await deps.ossTool('remember', { content: p.content, tags: REMEMBER_TAGS.join(',') })
        } catch {
          throw new CloudError('runtime', { detail: tr('The remember call failed; the write was not confirmed', 'remember 调用失败，未确认写入') })
        }
        let entryId: string
        try {
          entryId = RememberResponse.parse(JSON.parse(raw)).entry_id
        } catch {
          throw new CloudError('runtime', { detail: tr('Could not read the remember response. Check in Search whether it was written before retrying', 'remember 的返回无法解析；请在「搜索」里确认是否已写入再决定是否重试') })
        }
        remembers.delete(rememberId)
        const c = load(p.conversationId)
        const m = c?.messages[p.messageIndex]
        if (c && m && m.role === 'assistant') {
          m.rememberedEntryId = entryId
          save(c)
        }
        return { entryId }
      } finally {
        p.busy = false
      }
    },

    async settled(streamId) {
      await streams.get(streamId)?.done
    }
  }
}
