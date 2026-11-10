// `lens:chat:*` IPC (S1-FULL C3–C7). zod strictObject on every argument, CloudResult out, fixed
// sanitized messages (toCloudIpcError). Stream events go to the invoking webContents only.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { CHAT_CHANNELS, CHAT_LIMITS } from './chat-api'
import { CONVERSATION_ID_RE, HEX32_RE, createChatService, type ChatDeps, type ChatSender, type ChatService } from './chat'
import { toCloudIpcError } from './ipc'
import { ipcRunner } from '../ipc-result'

const ConversationId = z.string().regex(CONVERSATION_ID_RE)
const Hex32 = z.string().regex(HEX32_RE)
const NoArgs = z.union([z.undefined(), z.strictObject({})])

export const PreviewArgs = z.strictObject({
  question: z.string().trim().min(1).max(CHAT_LIMITS.maxMessageChars),
  conversationId: ConversationId.optional()
})
export const WechatArgs = z.strictObject({
  keyword: z.string().trim().max(100).optional(),
  conversationId: ConversationId.optional()
})
/** Only ids: any renderer-supplied text / items / context field is rejected by strictObject. */
export const SendArgs = z.strictObject({
  previewId: Hex32,
  includeIds: z.array(z.string().regex(/^ctx-\d{1,3}$/)).max(CHAT_LIMITS.maxItems)
})
const PreviewIdArgs = z.strictObject({ previewId: Hex32 })
const StreamArgs = z.strictObject({ streamId: Hex32 })
const IdArgs = z.strictObject({ conversationId: ConversationId })
const RememberPreviewArgs = z.strictObject({ conversationId: ConversationId, messageIndex: z.number().int().min(0).max(10_000) })
const RememberArgs = z.strictObject({ rememberId: Hex32 })

const run = ipcRunner(toCloudIpcError)

function senderOf(e: unknown): ChatSender | null {
  const s = (e as { sender?: unknown } | undefined)?.sender
  return s && typeof (s as ChatSender).send === 'function' ? (s as ChatSender) : null
}

export function registerChatHandlers(ipcMain: Pick<IpcMain, 'handle'>, service: ChatService): void {
  ipcMain.handle(CHAT_CHANNELS.preview, (_e, raw: unknown) => run(() => service.preview(PreviewArgs.parse(raw))))
  ipcMain.handle(CHAT_CHANNELS.wechatPreview, (_e, raw: unknown) => run(() => service.wechatPreview(WechatArgs.parse(raw ?? {}))))
  ipcMain.handle(CHAT_CHANNELS.discardPreview, (_e, raw: unknown) => run(() => service.discardPreview(PreviewIdArgs.parse(raw).previewId)))
  ipcMain.handle(CHAT_CHANNELS.send, (e, raw: unknown) => run(() => service.send(SendArgs.parse(raw), senderOf(e))))
  ipcMain.handle(CHAT_CHANNELS.cancel, (_e, raw: unknown) => run(() => service.cancel(StreamArgs.parse(raw).streamId)))
  ipcMain.handle(CHAT_CHANNELS.list, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.list()
    })
  )
  ipcMain.handle(CHAT_CHANNELS.get, (_e, raw: unknown) => run(() => service.get(IdArgs.parse(raw).conversationId)))
  ipcMain.handle(CHAT_CHANNELS.delete, (_e, raw: unknown) => run(() => service.delete(IdArgs.parse(raw).conversationId)))
  ipcMain.handle(CHAT_CHANNELS.usage, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.usage()
    })
  )
  ipcMain.handle(CHAT_CHANNELS.rememberPreview, (_e, raw: unknown) => run(() => service.rememberPreview(RememberPreviewArgs.parse(raw))))
  ipcMain.handle(CHAT_CHANNELS.remember, (e, raw: unknown) =>
    run(() => service.remember(RememberArgs.parse(raw).rememberId, (e as { sender?: unknown } | undefined)?.sender ?? null))
  )
}

/** Register `lens:chat:*`; returns the service. */
export function registerChatIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: ChatDeps): ChatService {
  const service = createChatService(deps)
  registerChatHandlers(ipcMain, service)
  return service
}
