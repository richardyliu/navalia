import type { IpcMain } from 'electron'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import type { LensError, LensResult } from '../../shared/types'
import { GrantError } from '../identity/grants'
import { RuntimeError } from '../runtime/client'
import { redactCliOutput } from '../recovery/exec'
import { DELETE_TARGETS, PRIVACY_ACTIONS, PRIVACY_CHANNELS } from './api'
import { PrivacyConfirmError } from './confirm'
import { PrivacyError, createPrivacyService, type PrivacyDeps, type PrivacyService } from './service'

export const NoArgs = z.undefined()
export const IssueArgs = z.strictObject({ action: z.enum(PRIVACY_ACTIONS) })
const Nonce = z.string().regex(/^[0-9a-f]{32}$/)
const Phrase = z.string().max(200)
export const DeleteArgs = z.strictObject({ target: z.enum(DELETE_TARGETS), nonce: Nonce, phrase: Phrase, backupFirst: z.boolean() })
export const WithdrawArgs = z.strictObject({ nonce: Nonce, phrase: Phrase })

/** Fixed code + redacted, length-capped message; stack traces and command lines never cross. */
export function toPrivacyError(error: unknown, scrub: (s: string) => string): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  if (error instanceof PrivacyConfirmError) return { code: 'unknown', message: error.message }
  if (error instanceof PrivacyError || error instanceof RuntimeError) return { code: error.code, message: scrub(error.message).slice(0, 500) }
  if (error instanceof GrantError) return { code: 'unauthorized', message: `${error.code}: ${scrub(error.message)}`.slice(0, 500) }
  return { code: 'unknown', message: scrub(error instanceof Error ? error.message : String(error)).slice(0, 500) }
}

export function registerPrivacyHandlers(ipcMain: Pick<IpcMain, 'handle'>, service: PrivacyService, scrub: (s: string) => string): void {
  const run = async <T>(fn: () => T | Promise<T>): Promise<LensResult<T>> => {
    try {
      return { ok: true, data: await fn() }
    } catch (error) {
      return { ok: false, error: toPrivacyError(error, scrub) }
    }
  }
  ipcMain.handle(PRIVACY_CHANNELS.retention, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.retention())))
  ipcMain.handle(PRIVACY_CHANNELS.updateCheck, (_e, raw: unknown) => run(() => (NoArgs.parse(raw), service.updateCheck())))
  ipcMain.handle(PRIVACY_CHANNELS.confirmIssue, (_e, raw: unknown) => run(() => service.confirmIssue(IssueArgs.parse(raw).action)))
  // OG3: the sender is passed through so the native confirmation is parented to its window.
  ipcMain.handle(PRIVACY_CHANNELS.deleteRun, (e, raw: unknown) =>
    run(() => {
      const a = DeleteArgs.parse(raw)
      return service.deleteRun(a.target, a.nonce, a.phrase, a.backupFirst, e?.sender)
    })
  )
  ipcMain.handle(PRIVACY_CHANNELS.withdrawRun, (e, raw: unknown) =>
    run(() => {
      const a = WithdrawArgs.parse(raw)
      return service.withdrawRun(a.nonce, a.phrase, e?.sender)
    })
  )
}

/** Register `lens:privacy:*` channels. */
export function registerPrivacyIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: PrivacyDeps): PrivacyService {
  const service = createPrivacyService(deps)
  const scrub = (s: string): string => {
    let secrets: string[] = []
    try {
      secrets = deps.knownSecrets?.(deps.locate().root) ?? []
    } catch {
      secrets = []
    }
    return redactCliOutput(s, secrets, deps.homeDir)
  }
  registerPrivacyHandlers(ipcMain, service, scrub)
  return service
}
