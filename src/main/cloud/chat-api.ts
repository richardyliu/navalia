// Lens Chat (S1-FULL C3 / C5 / C6 / C7) — channel names and renderer-safe types. No node imports:
// the renderer and preload import this file. Merged into `CloudApi` (api.ts) as the `chat`
// namespace, so it reaches `window.lens.chat` through the existing cloud preload fragment.
import type { CloudResult } from './api'

export const CHAT_CHANNELS = {
  preview: 'lens:chat:preview',
  wechatPreview: 'lens:chat:wechat-preview',
  discardPreview: 'lens:chat:discard-preview',
  send: 'lens:chat:send',
  cancel: 'lens:chat:cancel',
  list: 'lens:chat:list',
  get: 'lens:chat:get',
  delete: 'lens:chat:delete',
  usage: 'lens:chat:usage',
  rememberPreview: 'lens:chat:remember-preview',
  remember: 'lens:chat:remember'
} as const

/** main → renderer only (webContents.send to the requesting sender). */
export const CHAT_EVENT_CHANNEL = 'lens:chat:event'

export const CONTEXT_KINDS = ['memory', 'model', 'entity', 'workflow', 'recent', 'capture'] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

export type ChatTask = 'chat' | 'group_digest'

/** Server contract bounds (cloud `/v1/chat/completions`). */
export const CHAT_LIMITS = {
  maxItems: 100,
  defaultMaxItems: 40,
  maxTotalChars: 60_000,
  maxItemChars: 8_000,
  maxTitleChars: 200,
  maxMessageChars: 16_000,
  maxMessages: 40
} as const

/** One context item exactly as it is (or was) sent to the cloud. */
export interface ChatContextItem {
  /** `ctx-N`, assigned by main. */
  id: string
  kind: ContextKind
  title: string
  /** Redacted, possibly truncated text — byte-for-byte what is sent. */
  text: string
  /** Runtime reference (memory entry id, receipt, entity, capture stem…) or null. Never a file path. */
  ref: string | null
  /** title.length + text.length (the unit the server caps on). */
  chars: number
}

export interface ChatPreview {
  previewId: string
  task: ChatTask
  /** The user message that `send` will use (fixed at preview time). */
  question: string
  items: ChatContextItem[]
  totalChars: number
  /** Honest notes: Runtime unreachable, a source failed, items truncated / dropped, … */
  warnings: string[]
  expiresAt: string
}

export interface ChatPreviewArgs {
  question: string
  /** Continue an existing conversation (its history is sent too). */
  conversationId?: string
}

export interface WechatPreviewArgs {
  /** Optional keyword to narrow the search; default searches for 微信 captures. */
  keyword?: string
  conversationId?: string
}

export interface ChatSendArgs {
  previewId: string
  /** Subset of the preview's ids. Main sends exactly these stored items; no renderer text. */
  includeIds: string[]
}

export interface ChatSendStarted {
  streamId: string
  conversationId: string
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  model: string
  estimated?: boolean
}

export type ChatMessageStatus = 'complete' | 'truncated' | 'error' | 'cancelled'

export interface ChatUserMessage {
  role: 'user'
  content: string
  at: string
}

export interface ChatAssistantMessage {
  role: 'assistant'
  content: string
  at: string
  task: ChatTask
  status: ChatMessageStatus
  /** True when the text is incomplete (error / cancel / no `done`). */
  partial: boolean
  errorCode: string | null
  /** Every item sent with this turn (snapshots). */
  context: ChatContextItem[]
  /** Citations returned by the server, resolved to the sent snapshots (unknown ids dropped). */
  citations: ChatContextItem[]
  usage: ChatUsage | null
  /** Entry id returned by Runtime `remember` (C6), when the user saved this answer. */
  rememberedEntryId: string | null
}

export type ChatMessage = ChatUserMessage | ChatAssistantMessage

export interface ChatConversation {
  version: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

export interface ChatConversationSummary {
  id: string
  title: string
  updatedAt: string
  messages: number
}

export interface ChatServerUsage {
  day: string
  prompt_tokens: number
  completion_tokens: number
  limit: number | null
}

export interface ChatRememberPreview {
  rememberId: string
  /** Exactly what Runtime `remember` receives (redacted). */
  content: string
  tags: string[]
  chars: number
  redactions: number
}

export type ChatEvent =
  | { streamId: string; type: 'delta'; text: string }
  | { streamId: string; type: 'usage'; usage: ChatUsage }
  | { streamId: string; type: 'error'; code: string; message: string }
  | { streamId: string; type: 'end'; status: ChatMessageStatus; conversationId: string }

export const CHAT_EVENT_TYPES = ['delta', 'usage', 'error', 'end'] as const

export interface ChatApiFragment {
  chat: {
    preview(args: ChatPreviewArgs): Promise<CloudResult<ChatPreview>>
    wechatPreview(args: WechatPreviewArgs): Promise<CloudResult<ChatPreview>>
    discardPreview(previewId: string): Promise<CloudResult<boolean>>
    send(args: ChatSendArgs): Promise<CloudResult<ChatSendStarted>>
    cancel(streamId: string): Promise<CloudResult<boolean>>
    list(): Promise<CloudResult<ChatConversationSummary[]>>
    get(conversationId: string): Promise<CloudResult<ChatConversation>>
    /** Removes the local file only (nothing is stored server-side). */
    delete(conversationId: string): Promise<CloudResult<boolean>>
    usage(): Promise<CloudResult<ChatServerUsage>>
    rememberPreview(args: { conversationId: string; messageIndex: number }): Promise<CloudResult<ChatRememberPreview>>
    /** Main shows a native confirm; nothing is written unless the user confirms there. */
    remember(rememberId: string): Promise<CloudResult<{ entryId: string }>>
    /** Stream events for streams this window started. Returns an unsubscribe function. */
    onEvent(listener: (event: ChatEvent) => void): () => void
  }
}
