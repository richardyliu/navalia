import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import type { S1Deps } from '../s1/deps'
import { IMPORT_CHANNELS } from './api'
import { redactForDisplay } from './redact'
import { createImportService, ImportError, RUN_ID_RE, type ImportService } from './service'
import { tr } from '../../shared/i18n'
import { ipcRunner } from '../ipc-result'

const SessionKey = z.string().regex(/^(claude-code|codex):[A-Za-z0-9._:-]{1,200}$/)
const NoArgs = z.undefined()
const PrepareArgs = z.strictObject({ keys: z.array(SessionKey).min(1).max(500), includeTools: z.boolean().optional() })
const RunArgs = z.strictObject({ runId: z.string().regex(RUN_ID_RE) })
const BuildArgs = z.strictObject({ runId: z.string().regex(RUN_ID_RE), confirm: z.literal(true) })

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  if (error instanceof ImportError) return { code: error.code, message: redactForDisplay(error.message) }
  return { code: 'unknown', message: redactForDisplay(error instanceof Error ? error.message : String(error)) }
}

const run = ipcRunner(toLensError)

/** Handlers on an explicit service (tests inject one with a fake exec). */
export function registerImportHandlers(ipcMain: Pick<IpcMain, 'handle'>, service: ImportService): void {
  ipcMain.handle(IMPORT_CHANNELS.scan, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.scan()
    })
  )
  ipcMain.handle(IMPORT_CHANNELS.prepare, (_e, raw: unknown) => run(() => {
      const a = PrepareArgs.parse(raw)
      return service.prepare(a.keys, { includeTools: a.includeTools !== false })
    }))
  ipcMain.handle(IMPORT_CHANNELS.commit, (_e, raw: unknown) => run(() => service.commit(RunArgs.parse(raw).runId)))
  ipcMain.handle(IMPORT_CHANNELS.build, (_e, raw: unknown) => run(() => service.build(BuildArgs.parse(raw).runId)))
  ipcMain.handle(IMPORT_CHANNELS.discard, (_e, raw: unknown) => run(() => service.discard(RunArgs.parse(raw).runId)))
}

/** Register the S1 import IPC channels (`lens:import:*`). Validate every payload with zod. */
export function registerImportIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: S1Deps): void {
  registerImportHandlers(
    ipcMain,
    createImportService({
      storeRoot: deps.storeRoot,
      homeDir: deps.homeDir,
      runtimeRoot: deps.runtimeRoot,
      persomeBin: deps.persomeBin
    })
  )
}
