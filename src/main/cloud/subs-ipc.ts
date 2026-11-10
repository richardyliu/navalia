// `lens:subs:*` (C10) and `lens:cloud-cards:*` (C8) IPC. zod strictObject on every argument,
// CloudResult out, fixed sanitized messages (toCloudIpcError). Arguments are ids / user-edited
// title + markdown only: no signature, envelope or card text is ever accepted from the renderer.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { CloudResult } from './api'
import { createCloudCardsService, type CloudCardsDeps, type CloudCardsService } from './cards'
import { toCloudIpcError } from './ipc'
import { createSubsService, type SubsDeps, type SubsService } from './subs'
import { CLOUD_CARDS_CHANNELS, FINGERPRINT_RE, LETTER_LIMITS, SERVER_ID_RE, SUBS_CHANNELS, WEEK_RE } from './subs-api'
import { HEX32_RE } from './subs-common'
import { ipcRunner, senderOf } from '../ipc-result'

const NoArgs = z.union([z.undefined(), z.strictObject({})])
const Fingerprint = z.strictObject({ fingerprint: z.string().regex(FINGERPRINT_RE) })
const PreviewId = z.strictObject({ previewId: z.string().regex(HEX32_RE) })
export const DraftArgs = z.strictObject({ timezone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/) })
/** Only the user-edited fields; main adds issue_id / created_at / signer and signs. */
export const LetterPreviewArgs = z.strictObject({
  title: z.string().trim().min(1).max(LETTER_LIMITS.maxTitleChars),
  markdown: z.string().min(1).max(LETTER_LIMITS.maxMarkdownChars),
  week: z.string().regex(WEEK_RE)
})
const LetterId = z.strictObject({ letterId: z.string().regex(SERVER_ID_RE) })
const SubscriberId = z.strictObject({ subscriberId: z.string().regex(SERVER_ID_RE) })

const run = ipcRunner(toCloudIpcError)


function noArgs<T>(fn: () => T | Promise<T>): (_e: unknown, raw: unknown) => Promise<CloudResult<T>> {
  return (_e, raw) =>
    run(() => {
      NoArgs.parse(raw)
      return fn()
    })
}

export function registerSubsHandlers(ipcMain: Pick<IpcMain, 'handle'>, subs: SubsService, cards: CloudCardsService): void {
  ipcMain.handle(SUBS_CHANNELS.letterDraft, (_e, raw: unknown) => run(() => subs.letterDraft(DraftArgs.parse(raw))))
  ipcMain.handle(SUBS_CHANNELS.letterPreview, (_e, raw: unknown) => run(() => subs.letterPreview(LetterPreviewArgs.parse(raw))))
  ipcMain.handle(SUBS_CHANNELS.letterDiscard, (_e, raw: unknown) => run(() => subs.letterDiscard(PreviewId.parse(raw).previewId)))
  ipcMain.handle(SUBS_CHANNELS.letterPublish, (e, raw: unknown) => run(() => subs.letterPublish(PreviewId.parse(raw).previewId, senderOf(e))))
  ipcMain.handle(SUBS_CHANNELS.letters, noArgs(() => subs.letters()))
  ipcMain.handle(SUBS_CHANNELS.deliveries, (_e, raw: unknown) => run(() => subs.deliveries(LetterId.parse(raw).letterId)))
  ipcMain.handle(SUBS_CHANNELS.subscribers, noArgs(() => subs.subscribers()))
  ipcMain.handle(SUBS_CHANNELS.removeSubscriber, (e, raw: unknown) => run(() => subs.removeSubscriber(SubscriberId.parse(raw).subscriberId, senderOf(e))))
  ipcMain.handle(SUBS_CHANNELS.subscribeLink, noArgs(() => subs.subscribeLink()))
  ipcMain.handle(SUBS_CHANNELS.friendLetters, (_e, raw: unknown) => run(() => subs.friendLetters(Fingerprint.parse(raw).fingerprint)))
  ipcMain.handle(SUBS_CHANNELS.cachedLetters, (_e, raw: unknown) => run(() => subs.cachedLetters(Fingerprint.parse(raw).fingerprint)))

  ipcMain.handle(CLOUD_CARDS_CHANNELS.status, noArgs(() => cards.status()))
  ipcMain.handle(CLOUD_CARDS_CHANNELS.publishPreview, noArgs(() => cards.publishPreview()))
  ipcMain.handle(CLOUD_CARDS_CHANNELS.publish, (e, raw: unknown) => run(() => cards.publish(PreviewId.parse(raw).previewId, senderOf(e))))
  ipcMain.handle(CLOUD_CARDS_CHANNELS.unpublish, (e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return cards.unpublish(senderOf(e))
    })
  )
  ipcMain.handle(CLOUD_CARDS_CHANNELS.fetchFriend, (_e, raw: unknown) => run(() => cards.fetchFriend(Fingerprint.parse(raw).fingerprint)))
}

export type SubsIpcDeps = SubsDeps & Pick<CloudCardsDeps, 'peers'>

/** Register `lens:subs:*` + `lens:cloud-cards:*`; returns both services. */
export function registerSubsIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: SubsIpcDeps): { subs: SubsService; cards: CloudCardsService } {
  const subs = createSubsService(deps)
  const cards = createCloudCardsService(deps)
  registerSubsHandlers(ipcMain, subs, cards)
  return { subs, cards }
}
