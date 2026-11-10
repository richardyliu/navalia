// Lens Chat view-model (S1-FULL C5 / C6 / C7): pure functions, tested by vitest (no DOM).
import type { CloudErrorCode, CloudStatus } from '../../../main/cloud/api'
import { tr } from '../../../shared/i18n'
import type {
  ChatContextItem,
  ChatEvent,
  ChatMessageStatus,
  ChatServerUsage,
  ChatUsage,
  ContextKind
} from '../../../main/cloud/chat-api'

export function neverSentNote(): string {
  return tr(
    'Screenshots, images, the Runtime database file (index.db) and any tokens are never sent. Only the text you tick below is sent.',
    '截图、图片、Runtime 数据库文件（index.db）和任何令牌都不会发送；只发送下面勾选的文字。'
  )
}
export function notStoredNote(): string {
  return tr(
    'Conversations are saved only in the local Navalia Store; Navalia does not keep them in the cloud. Deleting one deletes the local file.',
    '对话只保存在本机 Navalia Store；Navalia 不在云端保存对话。删除即删除本机文件。'
  )
}
export function wechatCoverageNote(): string {
  return tr(
    'Covers only what appeared on screen and was read or OCR-ed; groups you did not open and messages you did not scroll to are not included',
    '只覆盖屏幕上出现过、被 OCR/读取到的内容；未打开的群和未滚动到的消息不在其中'
  )
}
export function notE2eeNote(): string {
  return tr(
    'The cloud server is not end-to-end encrypted: the operator can read the text you send on the server (by default the server does not write it to disk).',
    '云端服务器不是端到端加密：发送的文字在服务器上可被运营方读取（服务器默认不落盘）。'
  )
}

/** Main stores the WeChat digest conversation title in Chinese (persisted data); translate it only for display. */
export function conversationTitle(title: string): string {
  return title === '微信群整理' ? tr('WeChat group digest', '微信群整理') : title
}

export type Segment = { type: 'text'; text: string } | { type: 'cite'; id: string; known: boolean }

const CITE_GROUP = /\[(ctx-\d{1,3}(?:\s*[,，、]\s*ctx-\d{1,3})*)\]/g

/**
 * Split answer text into text / citation segments. Works on the ACCUMULATED text (the server
 * splits `[ctx-N]` markers across deltas). `[ctx-1, ctx-3]` yields two chips. `known` is false
 * when the id was not among the items sent with that reply.
 */
export function parseCitations(text: string, knownIds?: ReadonlySet<string>): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(CITE_GROUP)) {
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) })
    for (const id of m[1].split(/\s*[,，、]\s*/)) out.push({ type: 'cite', id, known: knownIds ? knownIds.has(id) : true })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

export function selectedItems(items: readonly ChatContextItem[], selected: ReadonlySet<string>): ChatContextItem[] {
  return items.filter((i) => selected.has(i.id))
}

export function totals(items: readonly ChatContextItem[], selected: ReadonlySet<string>): { count: number; chars: number } {
  const s = selectedItems(items, selected)
  return { count: s.length, chars: s.reduce((n, i) => n + i.chars, 0) }
}

export function totalsText(items: readonly ChatContextItem[], selected: ReadonlySet<string>): string {
  const t = totals(items, selected)
  return tr(`Will send ${t.count} item(s), ${t.chars.toLocaleString('en-US')} characters in total`, `将发送 ${t.count} 条、共 ${t.chars.toLocaleString('en-US')} 字符`)
}

const KIND_LABEL = {
  get memory() {
    return tr('Memory', '记忆')
  },
  get model() {
    return tr('Model', '模型')
  },
  get entity() {
    return tr('People/projects', '人物/项目')
  },
  get workflow() {
    return tr('Workflow', '工作流')
  },
  get recent() {
    return tr('Recent', '最近')
  },
  get capture() {
    return tr('Screen capture', '屏幕采集')
  }
} satisfies Record<ContextKind, string>

export function kindLabel(kind: ContextKind): string {
  return (KIND_LABEL as Record<ContextKind, string>)[kind] ?? kind
}

export type Gate =
  | { state: 'loading' }
  | { state: 'off'; text: string }
  | { state: 'signed_out'; text: string }
  | { state: 'ready'; text: string }

export function gateOf(status: CloudStatus | null | undefined): Gate {
  if (!status) return { state: 'loading' }
  if (!status.enabled || !status.baseUrl) return { state: 'off', text: tr('Cloud is off: you can preview the context that would be sent, but you cannot send it.', '云端未开启：可以预览将要发送的上下文，但不能发送。') }
  if (!status.signedIn) return { state: 'signed_out', text: tr(`Cloud is on (${status.baseUrl}), but you are not signed in yet.`, `已开启云端（${status.baseUrl}），但还没有登录。`) }
  return { state: 'ready', text: tr(`Signed in to ${status.baseUrl}`, `已登录 ${status.baseUrl}`) }
}

const STATUS_LABEL = {
  complete: '',
  get truncated() {
    return tr('The answer hit the length limit and was cut off', '回答达到长度上限，被截断')
  },
  get error() {
    return tr('Error. The answer below is incomplete', '出错，以下是不完整的回答')
  },
  get cancelled() {
    return tr('Stopped. The answer below is incomplete', '已停止，以下是不完整的回答')
  }
} satisfies Record<ChatMessageStatus, string>

export function statusLabel(status: ChatMessageStatus): string {
  return STATUS_LABEL[status]
}

const ERROR_HINT: Partial<Record<CloudErrorCode, string>> = {
  get disabled() {
    return tr('Turn on Cloud below first.', '先在下方开启云端。')
  },
  get unauthorized() {
    return tr('Please sign in to Cloud again.', '请重新登录云端。')
  },
  get quota_exceeded() {
    return tr('Try again tomorrow, or ask the server admin to raise the quota.', '明天再试，或联系服务器管理员提高额度。')
  },
  get llm_unavailable() {
    return tr('The server has no model configured or it is temporarily off. Try again later.', '服务器没有配置模型或暂时关闭，稍后再试。')
  },
  get rate_limited() {
    return tr('Wait a moment before sending again.', '稍等片刻再发送。')
  },
  get not_found() {
    return tr('Please preview again.', '请重新预览。')
  }
}

export function errorText(e: { code: string; message: string; retryAfterS?: number }): string {
  const hint = ERROR_HINT[e.code as CloudErrorCode]
  return hint ? tr(`${e.message}. ${hint}`, `${e.message}。${hint}`) : e.message
}

export function usageText(u: ChatServerUsage | null | undefined): string {
  if (!u) return ''
  const used = u.prompt_tokens + u.completion_tokens
  return u.limit
    ? tr(`Today (${u.day}): ${used.toLocaleString('en-US')} / ${u.limit.toLocaleString('en-US')} tokens used`, `今天（${u.day}）已用 ${used.toLocaleString('en-US')} / ${u.limit.toLocaleString('en-US')} tokens`)
    : tr(`Today (${u.day}): ${used.toLocaleString('en-US')} tokens used`, `今天（${u.day}）已用 ${used.toLocaleString('en-US')} tokens`)
}

export function replyUsageText(u: ChatUsage | null | undefined): string {
  if (!u) return ''
  return tr(
    `${u.model} · in ${u.prompt_tokens} / out ${u.completion_tokens} tokens${u.estimated ? ' (estimated)' : ''}`,
    `${u.model} · 输入 ${u.prompt_tokens} / 输出 ${u.completion_tokens} tokens${u.estimated ? '（估算）' : ''}`
  )
}

/** Live stream state for one streamId. */
export interface StreamState {
  streamId: string
  conversationId: string
  text: string
  usage: ChatUsage | null
  error: { code: string; message: string } | null
  ended: ChatMessageStatus | null
}

export function startStream(streamId: string, conversationId: string): StreamState {
  return { streamId, conversationId, text: '', usage: null, error: null, ended: null }
}

/** Apply one main → renderer event; events for other streams are ignored. */
export function reduceStream(s: StreamState | null, e: ChatEvent): StreamState | null {
  if (!s || e.streamId !== s.streamId) return s
  switch (e.type) {
    case 'delta':
      return { ...s, text: s.text + e.text }
    case 'usage':
      return { ...s, usage: e.usage }
    case 'error':
      return { ...s, error: { code: e.code, message: e.message } }
    case 'end':
      return { ...s, ended: e.status }
    default:
      return s
  }
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
