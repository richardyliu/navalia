// S1-R4-05 proactive IPC. Every channel is zod-validated and returns LensResult<T>. Renderer-facing
// error messages are fixed strings (no paths, no errno detail).
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import type { LensResult } from '../../shared/types'
import { PROACTIVE_CHANNELS } from './api'
import type { ProactiveService } from './service'

const NoArgs = z.undefined()
const SetArgs = z.strictObject({ patch: z.unknown() })

async function run<T>(failMessage: string, fn: () => T | Promise<T>): Promise<LensResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) } }
    }
    console.warn(`[proactive] ${failMessage}:`, error instanceof Error ? error.name : typeof error)
    return { ok: false, error: { code: 'unknown', message: failMessage } }
  }
}

export function registerProactiveIpc(ipc: Pick<IpcMain, 'handle'>, service: ProactiveService): void {
  const C = PROACTIVE_CHANNELS
  ipc.handle(C.get, (_e, raw: unknown) => run(tr('Failed to read notification settings', '读取通知设置失败'), () => (NoArgs.parse(raw), service.view())))
  ipc.handle(C.set, (_e, raw: unknown) => run(tr('Failed to save notification settings', '保存通知设置失败'), () => service.update(SetArgs.parse(raw).patch)))
  ipc.handle(C.test, (_e, raw: unknown) => run(tr('Test notification failed', '测试通知失败'), () => (NoArgs.parse(raw), service.test())))
  ipc.handle(C.reportDenied, (_e, raw: unknown) => run(tr('Save failed', '保存失败'), () => (NoArgs.parse(raw), service.reportDenied())))
  ipc.handle(C.clearDecisions, (_e, raw: unknown) => run(tr('Failed to clear the log', '清空记录失败'), () => (NoArgs.parse(raw), service.clearDecisions())))
}
