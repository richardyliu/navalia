// `lens:meetings:*` IPC (S1-FULL C12–C14). zod strictObject on every argument, CloudResult out,
// fixed sanitized messages (toCloudIpcError). The renderer sends ids, a title, the consent flag and
// audio chunk bytes; it never sends Markdown, summary text or context items.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { toCloudIpcError } from './ipc'
import { createMeetingsService, type MeetingsDeps, type MeetingsService } from './meetings'
import { MEETING_ID_RE, MEETING_LIMITS, MEETING_MIME_ALLOWLIST, MEETINGS_CHANNELS, normalizeMime } from './meetings-api'
import { HEX32_RE } from './subs-common'
import { ipcRunner, senderOf } from '../ipc-result'

const NoArgs = z.union([z.undefined(), z.strictObject({})])
const MeetingId = z.string().regex(MEETING_ID_RE)
const IdArgs = z.strictObject({ meetingId: MeetingId })
const PreviewArgs = z.strictObject({ previewId: z.string().regex(HEX32_RE) })

export const StartArgs = z.strictObject({
  title: z.string().trim().min(1).max(MEETING_LIMITS.maxTitleChars),
  participantsInformed: z.literal(true),
  languageHints: z
    .array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/))
    .max(MEETING_LIMITS.maxLanguageHints)
    .optional()
})

export const ChunkArgs = z.strictObject({
  meetingId: MeetingId,
  seq: z.number().int().min(0).max(MEETING_LIMITS.maxChunks - 1),
  mime: z
    .string()
    .max(64)
    .refine((m) => (MEETING_MIME_ALLOWLIST as readonly string[]).includes(normalizeMime(m))),
  durationMs: z.number().int().min(1).max(MEETING_LIMITS.chunkMaxMs),
  data: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= MEETING_LIMITS.chunkMaxBytes)
})

export const StopArgs = z.strictObject({ meetingId: MeetingId, chunks: z.number().int().min(0).max(MEETING_LIMITS.maxChunks) })
export const SummarySendArgs = z.strictObject({
  previewId: z.string().regex(HEX32_RE),
  includeIds: z.array(z.string().regex(/^ctx-\d{1,3}$/)).max(100)
})
export const DeleteArgs = z.strictObject({ meetingId: MeetingId, localOnly: z.boolean().optional() })

const run = ipcRunner(toCloudIpcError)


export function registerMeetingsHandlers(ipcMain: Pick<IpcMain, 'handle'>, service: MeetingsService): void {
  const C = MEETINGS_CHANNELS
  ipcMain.handle(C.list, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.list()
    })
  )
  ipcMain.handle(C.refresh, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.refresh()
    })
  )
  ipcMain.handle(C.get, (_e, raw: unknown) => run(() => service.get(IdArgs.parse(raw).meetingId)))
  ipcMain.handle(C.start, (e, raw: unknown) => run(() => service.start(StartArgs.parse(raw), senderOf(e))))
  ipcMain.handle(C.chunk, (_e, raw: unknown) => run(() => service.chunk(ChunkArgs.parse(raw))))
  ipcMain.handle(C.stop, (_e, raw: unknown) => run(() => service.stop(StopArgs.parse(raw))))
  ipcMain.handle(C.retry, (_e, raw: unknown) => run(() => service.retry(IdArgs.parse(raw).meetingId)))
  ipcMain.handle(C.markdownPreview, (_e, raw: unknown) => run(() => service.markdownPreview(IdArgs.parse(raw).meetingId)))
  ipcMain.handle(C.importToRuntime, (e, raw: unknown) => run(() => service.importToRuntime(PreviewArgs.parse(raw).previewId, senderOf(e))))
  ipcMain.handle(C.summaryPreview, (_e, raw: unknown) => run(() => service.summaryPreview(IdArgs.parse(raw).meetingId)))
  ipcMain.handle(C.summarySend, (_e, raw: unknown) => run(() => service.summarySend(SummarySendArgs.parse(raw))))
  ipcMain.handle(C.rememberSummary, (e, raw: unknown) => run(() => service.rememberSummary(IdArgs.parse(raw).meetingId, senderOf(e))))
  ipcMain.handle(C.delete, (e, raw: unknown) => run(() => service.delete(DeleteArgs.parse(raw), senderOf(e))))
  ipcMain.handle(C.deleteFromRuntime, (e, raw: unknown) => run(() => service.deleteFromRuntime(IdArgs.parse(raw).meetingId, senderOf(e))))
}

/** Register `lens:meetings:*`; returns the service (its `micArm` feeds security.ts's mic gate). */
export function registerMeetingsIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: MeetingsDeps): MeetingsService {
  const service = createMeetingsService(deps)
  registerMeetingsHandlers(ipcMain, service)
  return service
}
