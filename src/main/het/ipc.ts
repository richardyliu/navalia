import type { IpcMain } from 'electron'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import type { LensError } from '../../shared/types'
import { HET_CHANNELS } from './api'
import { isValidTimeZone } from './tz'
import type { HetService } from './service'
import { ipcRunner } from '../ipc-result'

const TimeZone = z.string().max(64).refine(isValidTimeZone, { message: 'unknown IANA time zone' })
const SummaryArgs = z
  .strictObject({ days: z.number().int().min(1).max(366).optional(), timezone: TimeZone.optional() })
  .optional()
const TasksArgs = z
  .strictObject({ limit: z.number().int().min(1).max(200).optional(), includeActivity: z.boolean().optional() })
  .optional()
const PeriodArgs = z.strictObject({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  cursor: z.string().max(400).nullable().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  includeActivity: z.boolean().optional(),
  timezone: TimeZone.optional()
})
const ActivityArgs = z.strictObject({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  timezone: TimeZone.optional()
})
const CorrectArgs = z.strictObject({
  taskId: z.string().regex(/^het_[0-9a-f]{20}$/),
  action: z.enum(['accepted', 'rejected', 'not_agent'])
})
const RevertArgs = z.strictObject({ taskId: z.string().regex(/^het_[0-9a-f]{20}$/) })
const ExportArgs = z.strictObject({ weekStart: z.iso.datetime({ offset: true }) })
const WeekCountsArgs = z.strictObject({ timezone: TimeZone.optional() }).optional()
const FilteredArgs = z.strictObject({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  filter: z.enum(['accepted', 'rejected', 'not_agent', 'commit_signal']),
  cursor: z.string().max(400).nullable().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  timezone: TimeZone.optional()
})
const NoArgs = z.undefined()
const AssessorArgs = z.strictObject({ enabled: z.boolean() })
const SendSummariesArgs = z.strictObject({ enabled: z.boolean() })

/** Native confirm copy for turning ON `sendSummariesToAssessor` (exported for tests / UI parity). */
export const SEND_SUMMARIES_CONFIRM = {
  get message() {
    return tr('Send summaries to the assessor?', '发送摘要给 assessor？')
  },
  get detail() {
    return tr(
      'When on, besides counts, each task awaiting assessment also sends its project path, session title, written file paths and redacted event summaries (≤200 chars each) to the CLI provider configured in Persome Runtime (the [agent_funding] client, e.g. Claude Code / Codex, processed by that provider\'s service). ' +
        'Content already sent cannot be recalled; turning this off only affects later assessments. Full raw conversations are never sent.',
      '开启后，每个待评估任务除计数外，还会把项目路径、会话标题、写入文件路径和已脱敏的事件摘要（每条 ≤200 字）发给 Persome Runtime 配置的 CLI 提供方（[agent_funding] 的 client，例如 Claude Code / Codex，由该提供方的服务处理）。' +
        '已发送的内容无法撤回；关闭此开关只影响之后的评估。不发送原始对话全文。'
    )
  },
  get confirmLabel() {
    return tr('Turn on and send summaries', '开启并发送摘要')
  }
}

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

const run = ipcRunner(toLensError)

export interface HetIpcDeps {
  service: HetService
  /**
   * X3: main-owned native confirm (security.ts `nativeConfirm`) for turning ON
   * `sendSummariesToAssessor`. Absent ⇒ turning it ON is refused (stays false).
   */
  confirm?: (sender: unknown, opts: { message: string; detail: string; confirmLabel: string }) => Promise<boolean>
  /** Main-process save dialog; resolves to the chosen `.md` path or null if cancelled. */
  chooseExportPath(defaultName: string): Promise<string | null>
}

export function registerHetIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: HetIpcDeps): void {
  const { service } = deps
  ipcMain.handle(HET_CHANNELS.summary, (_e, raw: unknown) =>
    run(() => {
      const a = SummaryArgs.parse(raw)
      return service.summary(a?.days, a?.timezone)
    })
  )
  ipcMain.handle(HET_CHANNELS.activity, (_e, raw: unknown) =>
    run(() => {
      const a = ActivityArgs.parse(raw)
      return service.activity(Date.parse(a.start), Date.parse(a.end), a.timezone)
    })
  )
  ipcMain.handle(HET_CHANNELS.tasks, (_e, raw: unknown) =>
    run(() => {
      const a = TasksArgs.parse(raw)
      return service.tasks(a?.limit, a?.includeActivity)
    })
  )
  ipcMain.handle(HET_CHANNELS.period, (_e, raw: unknown) =>
    run(() => {
      const a = PeriodArgs.parse(raw)
      return service.period(Date.parse(a.start), Date.parse(a.end), a.cursor ?? null, a.limit, a.includeActivity, a.timezone)
    })
  )
  ipcMain.handle(HET_CHANNELS.correct, (_e, raw: unknown) =>
    run(() => {
      const a = CorrectArgs.parse(raw)
      return service.correct(a.taskId, a.action)
    })
  )
  ipcMain.handle(HET_CHANNELS.revertCorrection, (_e, raw: unknown) =>
    run(() => service.revertCorrection(RevertArgs.parse(raw).taskId))
  )
  ipcMain.handle(HET_CHANNELS.retry, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.retry()
    })
  )
  ipcMain.handle(HET_CHANNELS.status, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.status()
    })
  )
  ipcMain.handle(HET_CHANNELS.setAssessorEnabled, (_e, raw: unknown) =>
    run(() => service.setAssessorEnabled(AssessorArgs.parse(raw).enabled))
  )
  ipcMain.handle(HET_CHANNELS.assessorInfo, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.assessorInfo()
    })
  )
  ipcMain.handle(HET_CHANNELS.setSendSummaries, (e, raw: unknown) =>
    run(async () => {
      const { enabled } = SendSummariesArgs.parse(raw)
      if (!enabled) return { send_summaries: service.setSendSummaries(false), confirmed: true }
      const ok = deps.confirm ? await deps.confirm((e as { sender?: unknown } | undefined)?.sender ?? null, { ...SEND_SUMMARIES_CONFIRM }) : false
      if (!ok) return { send_summaries: service.assessorInfo().send_summaries, confirmed: false }
      return { send_summaries: service.setSendSummaries(true), confirmed: true }
    })
  )
  ipcMain.handle(HET_CHANNELS.weekCounts, (_e, raw: unknown) =>
    run(() => service.weekCounts(WeekCountsArgs.parse(raw)?.timezone))
  )
  ipcMain.handle(HET_CHANNELS.filteredTasks, (_e, raw: unknown) =>
    run(() => {
      const a = FilteredArgs.parse(raw)
      return service.filteredTasks(Date.parse(a.start), Date.parse(a.end), a.filter, a.cursor ?? null, a.limit, a.timezone)
    })
  )
  ipcMain.handle(HET_CHANNELS.exportWeekly, (_e, raw: unknown) =>
    run(async () => {
      const ws = Date.parse(ExportArgs.parse(raw).weekStart)
      const d = new Date(ws)
      const name = `het-weekly-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
      const target = await deps.chooseExportPath(name)
      return service.exportWeekly(ws, target)
    })
  )
}
