import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import { STEM_RE } from '../broker/rewind'
import { REWIND_CHANNELS, REWIND_PAGE_MAX } from './api'
import { createRewindService, RewindError, sanitizeRewindError, type RewindService, type RewindServiceDeps } from './service'
import { tr } from '../../shared/i18n'
import { ipcRunner } from '../ipc-result'

const Iso = z.string().max(64).refine((v) => !Number.isNaN(Date.parse(v)), { error: () => tr('Time must be ISO-8601', '时间必须是 ISO-8601') })
const Stem = z.string().max(64).regex(STEM_RE, { error: () => tr('Invalid frame id', '帧标识不合法') })
const ListArgs = z
  .strictObject({
    since: Iso.optional(),
    until: Iso.optional(),
    appName: z.string().trim().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(REWIND_PAGE_MAX).optional(),
    cursor: Stem.optional()
  })
  .optional()
const ViewArgs = z.strictObject({ fileStem: Stem })

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'schema', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  const e = error instanceof RewindError ? error : sanitizeRewindError(error)
  return { code: e.code, message: e.message }
}

const run = ipcRunner(toLensError)

/** Handlers on an explicit service (tests inject one over a temp root). */
export function registerRewindHandlers(ipcMain: Pick<IpcMain, 'handle'>, service: RewindService): void {
  ipcMain.handle(REWIND_CHANNELS.list, (_e, raw: unknown) =>
    run(() => {
      const a = ListArgs.parse(raw) ?? {}
      if (a.since && a.until && Date.parse(a.since) > Date.parse(a.until)) throw new RewindError('schema', tr('Start time is after end time', '开始时间晚于结束时间'))
      return service.list(a)
    })
  )
  ipcMain.handle(REWIND_CHANNELS.view, (_e, raw: unknown) => run(() => service.view(ViewArgs.parse(raw).fileStem)))
}

export function registerRewindIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: RewindServiceDeps): RewindService {
  const service = createRewindService(deps)
  registerRewindHandlers(ipcMain, service)
  return service
}
