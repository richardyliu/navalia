// `lens:cloud:*` IPC. zod strictObject on every argument, CloudResult (LensResult shape) out,
// fixed sanitized messages. The token never crosses IPC.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { CLOUD_CHANNELS, type CloudIpcError } from './api'
import { CloudError, cloudMessage } from './errors'
import { createCloudService, type CloudDeps, type CloudService } from './service'
import { ipcRunner, senderOf } from '../ipc-result'

const NoArgs = z.union([z.undefined(), z.strictObject({})])
const ConfigureArgs = z.strictObject({
  enabled: z.boolean(),
  baseUrl: z.string().min(1).max(2048).nullable(),
  confirm: z.literal(true).optional()
})
const DeleteArgs = z.strictObject({ confirm: z.literal(true) })

export function toCloudIpcError(error: unknown): CloudIpcError {
  if (error instanceof z.ZodError) return { code: 'invalid_args', message: cloudMessage('invalid_args') }
  if (error instanceof CloudError) return error.toIpc()
  // Unknown errors may carry anything (paths, bodies): never forward their text.
  return { code: 'unknown', message: cloudMessage('unknown') }
}

const run = ipcRunner(toCloudIpcError)


export function registerCloudHandlers(ipcMain: Pick<IpcMain, 'handle'>, service: CloudService): void {
  ipcMain.handle(CLOUD_CHANNELS.status, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.status()
    })
  )
  ipcMain.handle(CLOUD_CHANNELS.configure, (e, raw: unknown) => run(() => service.configure(ConfigureArgs.parse(raw), senderOf(e))))
  ipcMain.handle(CLOUD_CHANNELS.signIn, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.signIn()
    })
  )
  ipcMain.handle(CLOUD_CHANNELS.signOut, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.signOut()
    })
  )
  ipcMain.handle(CLOUD_CHANNELS.deleteAccount, (e, raw: unknown) =>
    run(() => {
      DeleteArgs.parse(raw)
      return service.deleteAccount(senderOf(e))
    })
  )
}

/** Register `lens:cloud:*`; returns the service so Phase-1 features (Chat) can use `service.client`. */
export function registerCloudIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: CloudDeps): CloudService {
  const service = createCloudService(deps)
  registerCloudHandlers(ipcMain, service)
  return service
}
