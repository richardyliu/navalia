// `lens:moments:*` IPC (S1-FULL C18). zod strictObject on every argument, CloudResult out, fixed
// sanitized messages (toCloudIpcError). The renderer sends ids and the user's own fields only:
// never a signature, a moment / acceptance text, participants or a proposer.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { toCloudIpcError } from './ipc'
import { DATE_RE, MOMENT_ID_RE, MOMENT_LIMITS, MOMENTS_CHANNELS } from './moments-api'
import { createMomentsService, type MomentsDeps, type MomentsService } from './moments'
import { HEX32_RE } from './subs-common'
import { ipcRunner, senderOf } from '../ipc-result'

const NoArgs = z.union([z.undefined(), z.strictObject({})])
const MomentId = z.strictObject({ momentId: z.string().regex(MOMENT_ID_RE) })
const PreviewId = z.strictObject({ previewId: z.string().regex(HEX32_RE) })
export const ProposeArgs = z.strictObject({
  friendFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(1).max(MOMENT_LIMITS.maxTitleChars),
  start: z.string().regex(DATE_RE),
  end: z.string().regex(DATE_RE),
  place: z.string().max(MOMENT_LIMITS.maxPlaceChars).nullable(),
  note: z.string().max(MOMENT_LIMITS.maxNoteChars),
  visibility: z.enum(['private', 'letters'])
})
const NoteArgs = z.strictObject({ momentId: z.string().regex(MOMENT_ID_RE), text: z.string().max(MOMENT_LIMITS.maxMyNoteChars) })

const run = ipcRunner(toCloudIpcError)


export function registerMomentsHandlers(ipcMain: Pick<IpcMain, 'handle'>, svc: MomentsService): void {
  const C = MOMENTS_CHANNELS
  ipcMain.handle(C.local, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return svc.local()
    })
  )
  ipcMain.handle(C.sync, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return svc.sync()
    })
  )
  ipcMain.handle(C.proposePreview, (_e, raw: unknown) => run(() => svc.proposePreview(ProposeArgs.parse(raw))))
  ipcMain.handle(C.propose, (e, raw: unknown) => run(() => svc.propose(PreviewId.parse(raw).previewId, senderOf(e))))
  ipcMain.handle(C.acceptPreview, (_e, raw: unknown) => run(() => svc.acceptPreview(MomentId.parse(raw).momentId)))
  ipcMain.handle(C.accept, (e, raw: unknown) => run(() => svc.accept(PreviewId.parse(raw).previewId, senderOf(e))))
  ipcMain.handle(C.discardPreview, (_e, raw: unknown) => run(() => svc.discardPreview(PreviewId.parse(raw).previewId)))
  ipcMain.handle(C.decline, (e, raw: unknown) => run(() => svc.decline(MomentId.parse(raw).momentId, senderOf(e))))
  ipcMain.handle(C.remove, (e, raw: unknown) => run(() => svc.remove(MomentId.parse(raw).momentId, senderOf(e))))
  ipcMain.handle(C.forgetLocal, (e, raw: unknown) => run(() => svc.forgetLocal(MomentId.parse(raw).momentId, senderOf(e))))
  ipcMain.handle(C.setNote, (_e, raw: unknown) =>
    run(() => {
      const a = NoteArgs.parse(raw)
      return svc.setNote(a.momentId, a.text)
    })
  )
}

/** Register `lens:moments:*`; returns the service. */
export function registerMomentsIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: MomentsDeps): MomentsService {
  const svc = createMomentsService(deps)
  registerMomentsHandlers(ipcMain, svc)
  return svc
}
