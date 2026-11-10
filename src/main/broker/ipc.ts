import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import { tr } from '../../shared/i18n'
import { GrantError, type GrantStore } from '../identity/grants'
import type { AgentManager } from './agents'
import { AGENT_IDS, CLEAR_LOG_CONFIRM, CONNECTIONS_CHANNELS, type BrokerStatus } from './api'
import type { AuditLog } from './audit'
import { ipcRunner } from '../ipc-result'

const AgentArg = z.object({ agent: z.enum(AGENT_IDS) }).strict()
const GrantArg = z.object({ grantId: z.string().regex(/^grt_[0-9a-f]{16}$/) }).strict()
const RenewArg = z
  .object({ grantId: z.string().regex(/^grt_[0-9a-f]{16}$/), ttlSeconds: z.number().int().min(60).max(365 * 24 * 3600).nullable() })
  .strict()
const ListArg = z.object({ days: z.number().int().min(1).max(30).optional(), includeFailures: z.boolean().optional() }).strict().optional()
const DaysArg = z.object({ days: z.number().int().min(1).max(30).optional() }).strict().optional()
const PreviewArg = z.object({ id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict()
const ClearArg = z.object({ confirm: z.literal(CLEAR_LOG_CONFIRM) }).strict()
const NoArgs = z.undefined()

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  if (error instanceof GrantError) return { code: 'unauthorized', message: `${error.code}: ${error.message}` }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

const run = ipcRunner(toLensError)

export interface ConnectionsDeps {
  agents: AgentManager
  grants: GrantStore
  audit: AuditLog
  brokerStatus: () => BrokerStatus
  /** Main-process clipboard write (Electron `clipboard.writeText`). */
  copyToClipboard: (text: string) => void
}

/** Register Connections + Access log channels. No token or token hash is ever returned. */
export function registerConnectionsIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: ConnectionsDeps): void {
  const C = CONNECTIONS_CHANNELS
  ipcMain.handle(C.list, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return { broker: deps.brokerStatus(), agents: deps.agents.list() }
    })
  )
  ipcMain.handle(C.connect, (_e, raw: unknown) =>
    run(() => ({ agent: deps.agents.connect(AgentArg.parse(raw).agent), restartRequired: true as const }))
  )
  ipcMain.handle(C.disconnect, (_e, raw: unknown) => run(() => deps.agents.disconnect(AgentArg.parse(raw).agent)))
  ipcMain.handle(C.copyManual, (_e, raw: unknown) =>
    run(() => {
      const { agent, json } = deps.agents.manualConfig(AgentArg.parse(raw).agent)
      deps.copyToClipboard(json)
      return agent
    })
  )
  ipcMain.handle(C.revoke, (_e, raw: unknown) => run(() => deps.grants.revoke(GrantArg.parse(raw).grantId)))
  ipcMain.handle(C.renew, (_e, raw: unknown) =>
    run(() => {
      const a = RenewArg.parse(raw)
      return deps.grants.renew(a.grantId, a.ttlSeconds)
    })
  )
  ipcMain.handle(C.logList, (_e, raw: unknown) => run(() => deps.audit.list(ListArg.parse(raw) ?? {})))
  ipcMain.handle(C.logDaily, (_e, raw: unknown) => run(() => deps.audit.daily(DaysArg.parse(raw)?.days ?? 30)))
  ipcMain.handle(C.logPreview, (_e, raw: unknown) => run(() => deps.audit.preview(PreviewArg.parse(raw).id)))
  ipcMain.handle(C.logClear, (_e, raw: unknown) =>
    run(() => {
      ClearArg.parse(raw)
      // Clearing the log never touches grants or agent configs (T-ID-08 step 6).
      return { removed: deps.audit.clear() }
    })
  )
}
