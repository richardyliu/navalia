import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import type { OpenDialog } from './app-picker'
import { CAPTURE_CHANNELS } from './api'
import {
  buildCaptureDiagnostics,
  fetchRuntimeOcrHealth,
  readRuntimeConfigSummary,
  type RuntimeOcrHealth
} from './diagnostics'
import type { CaptureService } from './service'
import { tr } from '../../shared/i18n'
import { ipcRunner } from '../ipc-result'

const NoArgs = z.undefined()
const PauseArgs = z.object({ mode: z.enum(['now', 'untilMidnight']) }).strict()
const ExclusionArgs = z
  .object({ kind: z.enum(['bundleId', 'appName']), value: z.string().trim().min(1).max(256) })
  .strict()
const PaneArgs = z.object({ pane: z.enum(['accessibility', 'screenRecording']) }).strict()

/** Fixed System Settings deep links; nothing caller-supplied reaches openExternal. */
const PRIVACY_URLS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
} as const

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) {
    return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

const run = ipcRunner(toLensError)

export interface CaptureIpcDeps {
  dialog: OpenDialog
  openExternal: (url: string) => Promise<void>
  /** S1-04 seams. Default: unauthenticated loopback GET /health on the Runtime port. */
  runtimeOcrHealth?: (port: number) => Promise<RuntimeOcrHealth | null>
  /**
   * Secrets to scrub verbatim from the diagnostics text (e.g. the local API
   * token). Used only for redaction inside main; never returned.
   */
  knownSecrets?: (root: string) => string[]
  now?: () => number
}

export function registerCaptureIpc(ipcMain: Pick<IpcMain, 'handle'>, service: CaptureService, deps: CaptureIpcDeps): void {
  const C = CAPTURE_CHANNELS
  ipcMain.handle(C.status, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.status())))
  ipcMain.handle(C.restart, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.restart())))
  ipcMain.handle(C.pause, (_e, raw: unknown) => run(() => service.pause(PauseArgs.parse(raw).mode)))
  ipcMain.handle(C.resume, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.resume())))
  ipcMain.handle(C.excludeAdd, (_e, raw: unknown) =>
    run(() => {
      const a = ExclusionArgs.parse(raw)
      service.addExclusion(a.kind, a.value)
      return true
    })
  )
  ipcMain.handle(C.excludeRemove, (_e, raw: unknown) =>
    run(() => {
      const a = ExclusionArgs.parse(raw)
      service.removeExclusion(a.kind, a.value)
      return true
    })
  )
  ipcMain.handle(C.pickApp, (_e, raw: unknown) =>
    run(async () => {
      NoArgs.parse(raw)
      const info = await service.pickAndExclude(deps.dialog)
      return info ? { bundleId: info.bundleId, name: info.name } : null
    })
  )
  ipcMain.handle(C.requestAccessibility, (_e, raw: unknown) =>
    run(() => (NoArgs.parse(raw), service.requestAccessibility()))
  )
  ipcMain.handle(C.requestScreenRecording, (_e, raw: unknown) =>
    run(() => (NoArgs.parse(raw), service.requestScreenRecording()))
  )
  ipcMain.handle(C.openPrivacy, (_e, raw: unknown) =>
    run(async () => {
      await deps.openExternal(PRIVACY_URLS[PaneArgs.parse(raw).pane])
      return true
    })
  )
  ipcMain.handle(C.diagnostics, (_e, raw: unknown) =>
    run(async () => {
      NoArgs.parse(raw)
      const status = service.status()
      const config = readRuntimeConfigSummary(status.runtime.root)
      const runtimeOcr = await (deps.runtimeOcrHealth ?? ((port: number) => fetchRuntimeOcrHealth(port)))(status.runtime.port)
      let knownSecrets: string[] = []
      try {
        knownSecrets = deps.knownSecrets?.(status.runtime.root) ?? []
      } catch {
        knownSecrets = []
      }
      return buildCaptureDiagnostics({
        status,
        config,
        runtimeOcr,
        now: (deps.now ?? Date.now)(),
        knownSecrets
      })
    })
  )
}
