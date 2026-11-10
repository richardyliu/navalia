import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import { tr } from '../../shared/i18n'
import { RuntimeError } from '../runtime/client'
import { TokenError } from '../runtime/token'
import type { S1Deps } from '../s1/deps'
import { PEERS_CHANNELS, type SubscriptionStatus } from './api'
import { createPeersService, type PeersDeps, type PeersService } from './service'
import { MAX_CARD_BYTES } from './store'
import { AutoScanSchema, SubscriptionError } from './subscription'
import { redactForDisplay } from '../import/redact'
import { ipcRunner } from '../ipc-result'

const NoArgs = z.undefined()
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/)
const FpArgs = z.strictObject({ fingerprint: Fingerprint })
const TextArgs = z.strictObject({ text: z.string().min(1).max(MAX_CARD_BYTES) })
const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
        return true
      } catch {
        return false
      }
    },
    { message: 'unknown IANA time zone' }
  )
// S1-FULL C11: the letter no longer cites keyword overlap, so there is no `cite` argument.
const LetterArgs = z.strictObject({ fingerprint: Fingerprint, timezone: TimeZone })
const MomentsArgs = z.strictObject({ fingerprint: Fingerprint, timezone: TimeZone.optional() })
const ExportArgs = z.strictObject({ fingerprint: Fingerprint, markdown: z.string().min(1).max(200_000) })

/** Messages go to the renderer: home-dir paths (`/Users/<name>`) and secrets are redacted (S2-SEC L4). */
export function toLensError(error: unknown): LensError {
  const e = rawLensError(error)
  return { ...e, message: redactForDisplay(e.message) }
}

function rawLensError(error: unknown): LensError {
  if (error instanceof RuntimeError) return { code: error.code, message: error.message }
  if (error instanceof TokenError) return { code: 'token_unavailable', message: error.message }
  if (error instanceof SubscriptionError) return { code: error.code === 'invalid_folder' ? 'not_found' : 'schema', message: error.message }
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

const run = ipcRunner(toLensError)

/** Register the S1-11 peers IPC channels (`lens:peers:*`). Every payload is zod-validated. */
export function registerPeersIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: S1Deps | PeersDeps): PeersService {
  const service = createPeersService(deps)
  ipcMain.handle(PEERS_CHANNELS.list, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.list()
    })
  )
  ipcMain.handle(PEERS_CHANNELS.get, (_e, raw: unknown) => run(() => service.get(FpArgs.parse(raw).fingerprint)))
  ipcMain.handle(PEERS_CHANNELS.importFile, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.importFile()
    })
  )
  ipcMain.handle(PEERS_CHANNELS.importText, (_e, raw: unknown) => run(() => service.importText(TextArgs.parse(raw).text)))
  ipcMain.handle(PEERS_CHANNELS.remove, (_e, raw: unknown) => run(() => ({ removed: service.remove(FpArgs.parse(raw).fingerprint) })))
  ipcMain.handle(PEERS_CHANNELS.suggestions, (_e, raw: unknown) => run(() => service.suggestions(FpArgs.parse(raw).fingerprint)))
  ipcMain.handle(PEERS_CHANNELS.sharedMoments, (_e, raw: unknown) =>
    run(() => {
      const args = MomentsArgs.parse(raw)
      return service.sharedMoments(args.fingerprint, args.timezone)
    })
  )
  ipcMain.handle(PEERS_CHANNELS.letterDraft, (_e, raw: unknown) =>
    run(() => {
      const args = LetterArgs.parse(raw)
      return service.letterDraft(args.fingerprint, args.timezone)
    })
  )
  ipcMain.handle(PEERS_CHANNELS.exportLetter, (_e, raw: unknown) =>
    run(() => {
      const args = ExportArgs.parse(raw)
      return service.exportLetter(args.fingerprint, args.markdown)
    })
  )
  const noArgs =
    <T>(fn: () => T | Promise<T>) =>
    (_e: unknown, raw: unknown) =>
      run(() => {
        NoArgs.parse(raw)
        return fn()
      })
  // S1-R4-06: every settings change re-syncs the opt-in periodic scan; status carries its last run.
  const { scheduler } = service
  function synced(s: SubscriptionStatus): SubscriptionStatus
  function synced(s: SubscriptionStatus | null): SubscriptionStatus | null
  function synced(s: SubscriptionStatus | null): SubscriptionStatus | null {
    scheduler.sync()
    return s ? scheduler.decorate(s) : s
  }
  ipcMain.handle(PEERS_CHANNELS.subStatus, noArgs(() => scheduler.decorate(service.subscription.status())))
  ipcMain.handle(PEERS_CHANNELS.subChoose, noArgs(async () => synced(await service.subscription.choose())))
  ipcMain.handle(PEERS_CHANNELS.subEnable, noArgs(() => synced(service.subscription.enable())))
  ipcMain.handle(PEERS_CHANNELS.subDisable, noArgs(() => synced(service.subscription.disable())))
  ipcMain.handle(PEERS_CHANNELS.subRefresh, noArgs(() => service.subscription.refresh()))
  ipcMain.handle(PEERS_CHANNELS.subAutoScan, (_e, raw: unknown) => run(() => synced(service.subscription.setAutoScan(AutoScanSchema.parse(raw)))))
  // Arms a timer only when the persisted config already has the periodic scan on.
  scheduler.sync()
  return service
}
