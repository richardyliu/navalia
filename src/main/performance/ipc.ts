// S1-FULL C16 「表现」 IPC. Main window only (security.ts: not a Quick Box channel). Every channel is
// zod-validated and returns LensResult<T>. Error messages are fixed strings or store messages
// (no paths, no errno detail). Nothing here is reachable from the Broker, REST or the cloud.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import type { LensResult } from '../../shared/types'
import { ACTIVITY_WINDOWS, COUNT_KINDS, PERFORMANCE_CHANNELS } from './api'
import type { PerformanceService } from './service'
import { PerformanceStoreError } from './store'

const NoArgs = z.undefined()
const Id = z.string().regex(/^[a-z0-9-]{4,64}$/)
const Range = z.enum(['day', 'week'])
const Offset = z.number().int().min(-520).max(0)
const CountsArgs = z.strictObject({ range: Range, offset: Offset })
const RowsArgs = z.strictObject({ range: Range, offset: Offset, kind: z.enum(COUNT_KINDS), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
const IdArgs = z.strictObject({ id: Id })
const UpdateRepoArgs = z.strictObject({ id: Id, authorEmail: z.string().trim().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/, { error: () => tr('Invalid email format', '邮箱格式不对') }).nullable() })
const SaveArgs = z.strictObject({ input: z.unknown() })
const DoneArgs = z.strictObject({ projectId: Id, milestoneId: Id, done: z.boolean() })
const ActivityArgs = z.strictObject({ projectId: Id, days: z.union(ACTIVITY_WINDOWS.map((d) => z.literal(d)) as [z.ZodLiteral<7>, z.ZodLiteral<30>, z.ZodLiteral<90>]) })

export async function run<T>(failMessage: string, fn: () => T | Promise<T>): Promise<LensResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) } }
    }
    if (error instanceof PerformanceStoreError) return { ok: false, error: { code: 'unknown', message: error.message } }
    console.warn(`[performance] ${failMessage}:`, error instanceof Error ? error.name : typeof error)
    return { ok: false, error: { code: 'unknown', message: failMessage } }
  }
}

export function registerPerformanceIpc(ipc: Pick<IpcMain, 'handle'>, service: PerformanceService): void {
  const C = PERFORMANCE_CHANNELS
  ipc.handle(C.counts, (_e, raw: unknown) =>
    run(tr('Failed to read counts', '读取计数失败'), () => {
      const a = CountsArgs.parse(raw)
      return service.counts(a.range, a.offset)
    })
  )
  ipc.handle(C.rows, (_e, raw: unknown) =>
    run(tr('Failed to read details', '读取明细失败'), () => {
      const a = RowsArgs.parse(raw)
      return service.rows(a.range, a.offset, a.kind, a.day)
    })
  )
  ipc.handle(C.repos, (_e, raw: unknown) => run(tr('Failed to read repos', '读取仓库失败'), () => (NoArgs.parse(raw), service.repos())))
  ipc.handle(C.addRepo, (_e, raw: unknown) => run(tr('Failed to add repo', '添加仓库失败'), () => (NoArgs.parse(raw), service.addRepo())))
  ipc.handle(C.updateRepo, (_e, raw: unknown) =>
    run(tr('Save failed', '保存失败'), () => {
      const a = UpdateRepoArgs.parse(raw)
      return service.updateRepo(a.id, a.authorEmail)
    })
  )
  ipc.handle(C.removeRepo, (_e, raw: unknown) => run(tr('Remove failed', '移除失败'), () => service.removeRepo(IdArgs.parse(raw).id)))
  ipc.handle(C.projects, (_e, raw: unknown) => run(tr('Failed to read projects', '读取项目失败'), () => (NoArgs.parse(raw), service.projects())))
  ipc.handle(C.saveProject, (_e, raw: unknown) => run(tr('Failed to save project', '保存项目失败'), () => service.saveProject(SaveArgs.parse(raw).input)))
  ipc.handle(C.deleteProject, (_e, raw: unknown) => run(tr('Failed to delete project', '删除项目失败'), () => service.deleteProject(IdArgs.parse(raw).id)))
  ipc.handle(C.setMilestoneDone, (_e, raw: unknown) =>
    run(tr('Save failed', '保存失败'), () => {
      const a = DoneArgs.parse(raw)
      return service.setMilestoneDone(a.projectId, a.milestoneId, a.done)
    })
  )
  ipc.handle(C.activity, (_e, raw: unknown) =>
    run(tr('Failed to read activity', '读取活动失败'), () => {
      const a = ActivityArgs.parse(raw)
      return service.activity(a.projectId, a.days)
    })
  )
}
