import type { IpcMain } from 'electron'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import type { LensError, LensResult } from '../../shared/types'
import { runtimeSecretValues } from '../backup/service'
import { RuntimeError } from '../runtime/client'
import { TokenError, readLocalToken } from '../runtime/token'
import { RECOVERY_CHANNELS } from './api'
import { ConfirmError } from './confirm'
import { redactCliOutput } from './exec'
import { RecoveryError, createRecoveryService, type RecoveryDeps, type RecoveryService } from './service'

const NoArgs = z.undefined()
const DiagnosticsArgs = z.strictObject({ copy: z.boolean() })
const Destructive = z.enum(['rebuild-captures-index'])
const IssueArgs = z.strictObject({ action: Destructive })
const RunArgs = z.strictObject({
  action: Destructive,
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  phrase: z.string().max(200)
})

/** Errors are reduced to a fixed code + redacted message; stack traces and command lines never cross. */
export function toRecoveryError(error: unknown, scrub: (s: string) => string): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  if (error instanceof RecoveryError || error instanceof RuntimeError) return { code: error.code, message: scrub(error.message) }
  if (error instanceof TokenError) return { code: 'token_unavailable', message: scrub(error.message) }
  if (error instanceof ConfirmError) return { code: 'unknown', message: error.message }
  return { code: 'unknown', message: scrub(error instanceof Error ? error.message : String(error)).slice(0, 500) }
}

export function registerRecoveryHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  service: RecoveryService,
  scrub: (s: string) => string
): void {
  const run = async <T>(fn: () => T | Promise<T>): Promise<LensResult<T>> => {
    try {
      return { ok: true, data: await fn() }
    } catch (error) {
      return { ok: false, error: toRecoveryError(error, scrub) }
    }
  }
  ipcMain.handle(RECOVERY_CHANNELS.health, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.health())))
  ipcMain.handle(RECOVERY_CHANNELS.startRuntime, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.startRuntime())))
  ipcMain.handle(RECOVERY_CHANNELS.restartRuntime, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.restartRuntime())))
  ipcMain.handle(RECOVERY_CHANNELS.doctor, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.doctor())))
  ipcMain.handle(RECOVERY_CHANNELS.diagnostics, (_e, raw: unknown) =>
    run(() => service.diagnostics(DiagnosticsArgs.parse(raw).copy))
  )
  ipcMain.handle(RECOVERY_CHANNELS.confirmIssue, (_e, raw: unknown) => run(() => service.confirmIssue(IssueArgs.parse(raw).action)))
  ipcMain.handle(RECOVERY_CHANNELS.confirmRun, (_e, raw: unknown) =>
    run(() => {
      const args = RunArgs.parse(raw)
      return service.confirmRun(args.action, args.nonce, args.phrase)
    })
  )
}

/** Register `lens:recovery:*` channels. */
export function registerRecoveryIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: RecoveryDeps): RecoveryService {
  const service = createRecoveryService(deps)
  const scrub = (s: string): string => {
    const root = deps.locate().root
    const secrets = new Set<string>(runtimeSecretValues(root))
    try {
      secrets.add(readLocalToken(root))
    } catch {
      // no token
    }
    return redactCliOutput(s, [...secrets], deps.homeDir)
  }
  registerRecoveryHandlers(ipcMain, service, scrub)
  return service
}
