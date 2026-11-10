import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { CLOUD_CHANNELS, type CloudApi } from '../main/cloud/api'
import { CHAT_CHANNELS, CHAT_EVENT_CHANNEL, CHAT_EVENT_TYPES, type ChatEvent } from '../main/cloud/chat-api'
import { MEETINGS_CHANNELS } from '../main/cloud/meetings-api'
import { CLOUD_CARDS_CHANNELS, SUBS_CHANNELS } from '../main/cloud/subs-api'
import { MOMENTS_CHANNELS, type MomentsApiFragment } from '../main/cloud/moments-api'

// Preload bridge fragment for the opt-in cloud client (S1-FULL C2) and Lens Chat (C3–C7).
// Secrets never reach here: chat calls carry ids only; context text stays in main until sent.
function isChatEvent(v: unknown): v is ChatEvent {
  if (!v || typeof v !== 'object') return false
  const e = v as { streamId?: unknown; type?: unknown }
  return typeof e.streamId === 'string' && (CHAT_EVENT_TYPES as readonly unknown[]).includes(e.type)
}

export const cloudBridge: CloudApi & MomentsApiFragment = {
  cloud: {
    status: () => ipcRenderer.invoke(CLOUD_CHANNELS.status),
    configure: (args) => ipcRenderer.invoke(CLOUD_CHANNELS.configure, args),
    signIn: () => ipcRenderer.invoke(CLOUD_CHANNELS.signIn),
    signOut: () => ipcRenderer.invoke(CLOUD_CHANNELS.signOut),
    deleteAccount: (args) => ipcRenderer.invoke(CLOUD_CHANNELS.deleteAccount, args)
  },
  chat: {
    preview: (args) => ipcRenderer.invoke(CHAT_CHANNELS.preview, args),
    wechatPreview: (args) => ipcRenderer.invoke(CHAT_CHANNELS.wechatPreview, args),
    discardPreview: (previewId) => ipcRenderer.invoke(CHAT_CHANNELS.discardPreview, { previewId }),
    send: (args) => ipcRenderer.invoke(CHAT_CHANNELS.send, { previewId: args.previewId, includeIds: args.includeIds }),
    cancel: (streamId) => ipcRenderer.invoke(CHAT_CHANNELS.cancel, { streamId }),
    list: () => ipcRenderer.invoke(CHAT_CHANNELS.list),
    get: (conversationId) => ipcRenderer.invoke(CHAT_CHANNELS.get, { conversationId }),
    delete: (conversationId) => ipcRenderer.invoke(CHAT_CHANNELS.delete, { conversationId }),
    usage: () => ipcRenderer.invoke(CHAT_CHANNELS.usage),
    rememberPreview: (args) => ipcRenderer.invoke(CHAT_CHANNELS.rememberPreview, { conversationId: args.conversationId, messageIndex: args.messageIndex }),
    remember: (rememberId) => ipcRenderer.invoke(CHAT_CHANNELS.remember, { rememberId }),
    onEvent: (listener) => {
      // Only well-formed chat events reach the page; the raw IPC event object is never exposed.
      const handler = (_event: IpcRendererEvent, payload: unknown): void => {
        if (isChatEvent(payload)) listener(payload)
      }
      ipcRenderer.on(CHAT_EVENT_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, handler)
      }
    }
  },
  // S1-FULL C10: ids and user-edited title / markdown only; main builds + signs the envelope.
  subs: {
    letterDraft: (args) => ipcRenderer.invoke(SUBS_CHANNELS.letterDraft, { timezone: args.timezone }),
    letterPreview: (args) => ipcRenderer.invoke(SUBS_CHANNELS.letterPreview, { title: args.title, markdown: args.markdown, week: args.week }),
    letterDiscard: (previewId) => ipcRenderer.invoke(SUBS_CHANNELS.letterDiscard, { previewId }),
    letterPublish: (previewId) => ipcRenderer.invoke(SUBS_CHANNELS.letterPublish, { previewId }),
    letters: () => ipcRenderer.invoke(SUBS_CHANNELS.letters),
    deliveries: (letterId) => ipcRenderer.invoke(SUBS_CHANNELS.deliveries, { letterId }),
    subscribers: () => ipcRenderer.invoke(SUBS_CHANNELS.subscribers),
    removeSubscriber: (subscriberId) => ipcRenderer.invoke(SUBS_CHANNELS.removeSubscriber, { subscriberId }),
    subscribeLink: () => ipcRenderer.invoke(SUBS_CHANNELS.subscribeLink),
    friendLetters: (fingerprint) => ipcRenderer.invoke(SUBS_CHANNELS.friendLetters, { fingerprint }),
    cachedLetters: (fingerprint) => ipcRenderer.invoke(SUBS_CHANNELS.cachedLetters, { fingerprint })
  },
  // S1-FULL C8: main uploads the card it previewed; the renderer never supplies card text.
  cloudCards: {
    status: () => ipcRenderer.invoke(CLOUD_CARDS_CHANNELS.status),
    publishPreview: () => ipcRenderer.invoke(CLOUD_CARDS_CHANNELS.publishPreview),
    publish: (previewId) => ipcRenderer.invoke(CLOUD_CARDS_CHANNELS.publish, { previewId }),
    unpublish: () => ipcRenderer.invoke(CLOUD_CARDS_CHANNELS.unpublish),
    fetchFriend: (fingerprint) => ipcRenderer.invoke(CLOUD_CARDS_CHANNELS.fetchFriend, { fingerprint })
  },
  // S1-FULL C12–C14: ids, title, consent flag and audio chunk bytes only; Markdown / summary text
  // are built in main and never accepted from the page.
  meetings: {
    list: () => ipcRenderer.invoke(MEETINGS_CHANNELS.list),
    refresh: () => ipcRenderer.invoke(MEETINGS_CHANNELS.refresh),
    get: (meetingId) => ipcRenderer.invoke(MEETINGS_CHANNELS.get, { meetingId }),
    start: (args) =>
      ipcRenderer.invoke(MEETINGS_CHANNELS.start, {
        title: args.title,
        participantsInformed: args.participantsInformed,
        ...(args.languageHints ? { languageHints: args.languageHints } : {})
      }),
    chunk: (args) =>
      ipcRenderer.invoke(MEETINGS_CHANNELS.chunk, { meetingId: args.meetingId, seq: args.seq, mime: args.mime, durationMs: args.durationMs, data: args.data }),
    stop: (args) => ipcRenderer.invoke(MEETINGS_CHANNELS.stop, { meetingId: args.meetingId, chunks: args.chunks }),
    retry: (meetingId) => ipcRenderer.invoke(MEETINGS_CHANNELS.retry, { meetingId }),
    markdownPreview: (meetingId) => ipcRenderer.invoke(MEETINGS_CHANNELS.markdownPreview, { meetingId }),
    importToRuntime: (previewId) => ipcRenderer.invoke(MEETINGS_CHANNELS.importToRuntime, { previewId }),
    summaryPreview: (meetingId) => ipcRenderer.invoke(MEETINGS_CHANNELS.summaryPreview, { meetingId }),
    summarySend: (args) => ipcRenderer.invoke(MEETINGS_CHANNELS.summarySend, { previewId: args.previewId, includeIds: args.includeIds }),
    rememberSummary: (meetingId) => ipcRenderer.invoke(MEETINGS_CHANNELS.rememberSummary, { meetingId }),
    delete: (args) =>
      ipcRenderer.invoke(MEETINGS_CHANNELS.delete, args.localOnly === undefined ? { meetingId: args.meetingId } : { meetingId: args.meetingId, localOnly: args.localOnly }),
    deleteFromRuntime: (meetingId) => ipcRenderer.invoke(MEETINGS_CHANNELS.deleteFromRuntime, { meetingId })
  },
  // S1-FULL C18 shared moments: the user's own fields and ids only; main builds, signs and verifies.
  moments: {
    local: () => ipcRenderer.invoke(MOMENTS_CHANNELS.local),
    sync: () => ipcRenderer.invoke(MOMENTS_CHANNELS.sync),
    proposePreview: (args) =>
      ipcRenderer.invoke(MOMENTS_CHANNELS.proposePreview, {
        friendFingerprint: args.friendFingerprint,
        title: args.title,
        start: args.start,
        end: args.end,
        place: args.place,
        note: args.note,
        visibility: args.visibility
      }),
    propose: (previewId) => ipcRenderer.invoke(MOMENTS_CHANNELS.propose, { previewId }),
    acceptPreview: (momentId) => ipcRenderer.invoke(MOMENTS_CHANNELS.acceptPreview, { momentId }),
    accept: (previewId) => ipcRenderer.invoke(MOMENTS_CHANNELS.accept, { previewId }),
    discardPreview: (previewId) => ipcRenderer.invoke(MOMENTS_CHANNELS.discardPreview, { previewId }),
    decline: (momentId) => ipcRenderer.invoke(MOMENTS_CHANNELS.decline, { momentId }),
    remove: (momentId) => ipcRenderer.invoke(MOMENTS_CHANNELS.remove, { momentId }),
    forgetLocal: (momentId) => ipcRenderer.invoke(MOMENTS_CHANNELS.forgetLocal, { momentId }),
    setNote: (momentId, text) => ipcRenderer.invoke(MOMENTS_CHANNELS.setNote, { momentId, text })
  }
}
