import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import type { SecretBox } from '../identity/secret-box'
import { redactForDisplay } from '../import/redact'
import { resolvePort } from '../runtime/paths'
import { readLocalToken } from '../runtime/token'
import type { S1Deps } from '../s1/deps'
import { CONNECTOR_CHANNELS, CONSENT_TEXT, consentKindOf, type ConnectorKind, type ConnectorPreview, type ConsentKind } from './api'
import { fetchImapMessages } from './imap/fetch'
import { ConnectorError, createConnectorService, type ConnectorService } from './service'
import { tr } from '../../shared/i18n'
import { ipcRunner, senderOf } from '../ipc-result'

const FileKind = z.enum(['calendar', 'health', 'email', 'csv'])
const AnyKind = z.enum(['calendar', 'health', 'email', 'csv', 'imap'])
const ConsentKindZ = z.enum(['calendar', 'health', 'email-file', 'imap', 'csv'])
const PreviewId = z.string().regex(/^[0-9a-f]{24}$/)
const PickArgs = z.strictObject({ kind: FileKind })
const ItemKey = z.string().regex(/^(ev-[0-9a-f]{24}|mail-[0-9a-f]{24}|row-[0-9a-f]{24}|day:\d{4}-\d{2}-\d{2})$/)
const CommitArgs = z.strictObject({
  previewId: PreviewId,
  keys: z.array(ItemKey).min(1).max(20_000),
  opts: z.strictObject({ target: z.enum(['memory', 'timeline']).optional() }),
  confirm: z.literal(true)
})
const DiscardArgs = z.strictObject({ previewId: PreviewId })
const ConsentArgs = z.strictObject({ kind: ConsentKindZ })
const Col = z.number().int().min(0).max(999)
const CsvMapArgs = z.strictObject({
  previewId: PreviewId,
  mapping: z.strictObject({ date: Col.nullable(), title: Col.nullable(), body: z.array(Col).max(50), tags: Col.nullable() })
})
// Host: a DNS name or IPv4 literal; no scheme, path, user-info or whitespace.
const Host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/, { error: () => tr('Invalid server address (for example imap.gmail.com)', '服务器地址格式不对（例如 imap.gmail.com）') })
const NoCtl = (max: number) => z.string().max(max).regex(/^[^\r\n\0]*$/, { error: () => tr('Cannot contain line breaks or NUL characters', '不能包含换行或 NUL 字符') })
const ImapSaveArgs = z.strictObject({
  config: z.strictObject({
    host: Host,
    port: z.number().int().min(1).max(65_535),
    user: NoCtl(320).min(1),
    password: NoCtl(512),
    mailbox: NoCtl(200)
  })
})
const ImapFetchArgs = z.strictObject({
  opts: z.strictObject({ sinceDays: z.number().int().min(1).max(365), maxMessages: z.number().int().min(1).max(500) })
})
const DeleteArgs = z.strictObject({ kind: AnyKind, confirm: z.literal(true) })

const FILTERS: Record<z.infer<typeof FileKind>, Array<{ name: string; extensions: string[] }>> = {
  get calendar() {
    return [{ name: tr('Calendar (.ics)', '日历（.ics）'), extensions: ['ics', 'ical', 'ifb'] }]
  },
  get health() {
    return [{ name: tr('Health / workout export (CSV / JSON / Apple Health export.xml / .zip)', '健康 / 训练导出（CSV / JSON / Apple Health export.xml / .zip）'), extensions: ['csv', 'json', 'txt', 'xml', 'zip'] }]
  },
  // Thunderbird / Apple Mail mailboxes often have no extension, hence the 「所有文件」 entry.
  get email() {
    return [
      { name: tr('Email (.eml / mbox)', '邮件（.eml / mbox）'), extensions: ['eml', 'mbox', 'mbx'] },
      { name: tr('All files', '所有文件'), extensions: ['*'] }
    ]
  },
  csv: [{ name: 'CSV（.csv / .tsv / .txt）', extensions: ['csv', 'tsv', 'txt'] }]
}
const PICK_TITLE: Record<z.infer<typeof FileKind>, string> = {
  get calendar() {
    return tr('Choose a calendar file (.ics)', '选择日历文件（.ics）')
  },
  get health() {
    return tr('Choose a health / workout export (CSV / JSON / Apple Health export.xml or .zip)', '选择健康 / 训练导出（CSV / JSON / Apple Health export.xml 或 .zip）')
  },
  get email() {
    return tr('Choose an email file (.eml / mbox)', '选择邮件文件（.eml / mbox）')
  },
  get csv() {
    return tr('Choose a CSV file', '选择 CSV 文件')
  }
}

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  if (error instanceof ConnectorError) return { code: error.code, message: redactForDisplay(error.message) }
  return { code: 'unknown', message: redactForDisplay(error instanceof Error ? error.message : String(error)) }
}

const run = ipcRunner(toLensError)

type PickFile = (kind: z.infer<typeof FileKind>) => Promise<string | null>
/** S1-R3-SEC L5: main-side confirm before a commit writes anything (in addition to the renderer's). */
export type ConfirmCommit = (summary: { kind: ConnectorKind | null; items: number; fileName: string | null }, sender: unknown) => Promise<boolean>
/** C19: main-side native confirms for consent grants and deletions. Absent → refused (fail closed). */
export interface ConnectorConfirms {
  consent?: (kind: ConsentKind, sender: unknown) => Promise<boolean>
  deletion?: (summary: { kind: ConnectorKind; memoryEntries: number; healthEvents: number; timelineDocs: number }, sender: unknown) => Promise<boolean>
}

const cancelled = (kind: ConnectorKind): ConnectorPreview => ({
  cancelled: true,
  previewId: null,
  kind,
  fileName: null,
  items: [],
  warnings: [],
  totals: { items: 0, events: 0, redactions: 0 },
  mapping: []
})


/** Handlers on an explicit service + picker (tests inject both). File paths never come from the renderer. */
export function registerConnectorHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  service: ConnectorService,
  pickFile: PickFile,
  confirmCommit: ConfirmCommit,
  confirms: ConnectorConfirms = {}
): void {
  // previewId → kind / file name, so the native dialog can say what is about to be written.
  const previews = new Map<string, { kind: ConnectorKind; fileName: string | null }>()
  const track = (p: ConnectorPreview): ConnectorPreview => {
    if (p.previewId) {
      if (previews.size >= 32) previews.delete(previews.keys().next().value as string)
      previews.set(p.previewId, { kind: p.kind, fileName: p.fileName })
    }
    return p
  }
  ipcMain.handle(CONNECTOR_CHANNELS.pick, (_e, raw: unknown) =>
    run(async () => {
      const { kind } = PickArgs.parse(raw)
      // C19: no consent → no file dialog at all.
      service.consent.require(consentKindOf(kind))
      const file = await pickFile(kind)
      if (!file) return cancelled(kind)
      return track(await service.previewFile(kind, file))
    })
  )
  ipcMain.handle(CONNECTOR_CHANNELS.commit, (e, raw: unknown) =>
    run(async () => {
      const a = CommitArgs.parse(raw)
      const info = previews.get(a.previewId)
      const ok = await confirmCommit({ kind: info?.kind ?? null, items: a.keys.length, fileName: info?.fileName ?? null }, senderOf(e))
      if (!ok) throw new ConnectorError('unknown', tr('Cancelled. Nothing was written', '已取消，未写入任何内容'))
      return service.commit(a.previewId, a.keys, a.opts)
    })
  )
  ipcMain.handle(CONNECTOR_CHANNELS.discard, (_e, raw: unknown) => run(() => service.discard(DiscardArgs.parse(raw).previewId)))

  ipcMain.handle(CONNECTOR_CHANNELS.consentStatus, () => run(() => service.consent.list()))
  ipcMain.handle(CONNECTOR_CHANNELS.consentGrant, (e, raw: unknown) =>
    run(async () => {
      const { kind } = ConsentArgs.parse(raw)
      if (!confirms.consent) throw new ConnectorError('unauthorized', tr('Cannot show the system confirmation dialog. Consent was not recorded.', '无法显示系统确认对话框，未记录同意。'))
      const ok = await confirms.consent(kind, senderOf(e))
      if (!ok) throw new ConnectorError('unauthorized', tr('Cancelled. Consent was not recorded.', '已取消，未记录同意。'))
      return service.consent.grant(kind)
    })
  )
  ipcMain.handle(CONNECTOR_CHANNELS.consentRevoke, (_e, raw: unknown) => run(() => service.consent.revoke(ConsentArgs.parse(raw).kind)))
  ipcMain.handle(CONNECTOR_CHANNELS.csvMap, (_e, raw: unknown) =>
    run(() => {
      const a = CsvMapArgs.parse(raw)
      return track(service.csvMap(a.previewId, a.mapping))
    })
  )
  ipcMain.handle(CONNECTOR_CHANNELS.imapStatus, () => run(() => service.imapStatus()))
  ipcMain.handle(CONNECTOR_CHANNELS.imapSave, (_e, raw: unknown) => run(() => service.imapSave(ImapSaveArgs.parse(raw).config)))
  ipcMain.handle(CONNECTOR_CHANNELS.imapClear, () => run(() => service.imapClear()))
  ipcMain.handle(CONNECTOR_CHANNELS.imapFetch, (_e, raw: unknown) =>
    run(async () => {
      service.consent.require('imap')
      return track(await service.imapFetch(ImapFetchArgs.parse(raw).opts))
    })
  )
  ipcMain.handle(CONNECTOR_CHANNELS.ledger, () => run(() => service.ledger()))
  ipcMain.handle(CONNECTOR_CHANNELS.deleteImported, (e, raw: unknown) =>
    run(async () => {
      const { kind } = DeleteArgs.parse(raw)
      const v = service.ledger().connectors.find((c) => c.kind === kind)
      if (!v) throw new ConnectorError('not_found', tr('This connector has no import records.', '这个连接器没有导入记录。'))
      if (!confirms.deletion) throw new ConnectorError('unknown', tr('Cannot show the system confirmation dialog. Nothing was deleted.', '无法显示系统确认对话框，未删除任何内容。'))
      const ok = await confirms.deletion({ kind, memoryEntries: v.memoryEntries, healthEvents: v.healthEvents, timelineDocs: v.timelineDocs }, senderOf(e))
      if (!ok) throw new ConnectorError('unknown', tr('Cancelled. Nothing was deleted', '已取消，未删除任何内容'))
      return service.deleteImported(kind)
    })
  )
}

/**
 * POST JSON to the local Runtime REST API. Loopback only (http://127.0.0.1:<config port>), owner
 * token from `<root>/env` (never logged / sent over IPC). Returns the parsed body.
 */
export async function postRuntime(runtimeRoot: string, route: string, body: unknown, timeoutMs = 60_000): Promise<unknown> {
  if (!/^\/[a-z0-9/_-]+$/.test(route)) throw new ConnectorError('unknown', 'invalid Runtime route')
  const token = readLocalToken(runtimeRoot)
  const url = `http://127.0.0.1:${resolvePort(runtimeRoot)}${route}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error'
    })
  } catch (e) {
    throw new ConnectorError('runtime_missing', tr(
        `Cannot reach Runtime (127.0.0.1): ${e instanceof Error ? e.message : String(e)}. Start Runtime first.`,
        `连不上 Runtime（127.0.0.1）：${e instanceof Error ? e.message : String(e)}。请先启动 Runtime。`
      ))
  }
  const text = await res.text()
  if (!res.ok) {
    let detail = ''
    try {
      const d = (JSON.parse(text) as { detail?: unknown }).detail
      detail =
        typeof d === 'string'
          ? d.slice(0, 200)
          : Array.isArray(d)
            ? JSON.stringify(d).slice(0, 300)
            : // R10 per-item delete 404 body: {detail: {error: "not_found", ...}} → its short code only.
              d && typeof d === 'object' && typeof (d as { error?: unknown }).error === 'string' && /^[a-z_]{1,64}$/.test((d as { error: string }).error)
              ? (d as { error: string }).error
              : ''
    } catch {
      /* not JSON */
    }
    throw new ConnectorError('unknown', tr(`Runtime returned ${res.status}${detail ? `: ${detail}` : ''}`, `Runtime 返回 ${res.status}${detail ? `：${detail}` : ''}`))
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ConnectorError('unknown', tr('Runtime did not return JSON', 'Runtime 返回的不是 JSON'))
  }
}

const KIND_WHAT: Record<ConnectorKind, string> = {
  get calendar() {
    return tr('calendar events', '日历事件')
  },
  get health() {
    return tr('health / workout records (by day)', '健康 / 训练记录（按天）')
  },
  get email() {
    return tr('emails', '邮件')
  },
  get imap() {
    return tr('emails (IMAP)', '邮件（IMAP）')
  },
  get csv() {
    return tr('CSV rows', 'CSV 行')
  }
}

/**
 * Register `lens:connectors:*`. `extra.secretBox` (C19 wiring request): Electron safeStorage box for
 * IMAP settings at rest; without it IMAP settings cannot be saved (nothing is stored in plaintext).
 */
export function registerConnectorsIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: S1Deps, extra: { secretBox?: SecretBox | null } = {}): void {
  const secretBox = extra.secretBox ?? (deps as S1Deps & { secretBox?: SecretBox }).secretBox ?? null
  registerConnectorHandlers(
    ipcMain,
    createConnectorService({
      storeRoot: deps.storeRoot,
      runtimeRoot: deps.runtimeRoot,
      persomeBin: deps.persomeBin,
      ossTool: deps.ossTool,
      postRuntime: (route, body) => postRuntime(deps.runtimeRoot(), route, body),
      secretBox,
      imapFetch: (cred, req) => fetchImapMessages(cred, req)
    }),
    (kind) => deps.openDialog({ title: PICK_TITLE[kind], filters: FILTERS[kind] }),
    async (summary, sender) => {
      if (!deps.nativeConfirm) return false
      const what = summary.kind ? KIND_WHAT[summary.kind] : tr('items', '项目')
      const source = summary.fileName ? redactForDisplay(summary.fileName) : null
      return deps.nativeConfirm(sender, {
        message: tr(`Write ${summary.items} ${what} to Persome?`, `把 ${summary.items} 项${what}写入 Persome？`),
        detail: tr(
          `${source ? `Source: ${source}\n` : ''}Once written, other connected Agents can read it too. You can delete it later under "Connectors → Imported data" (where Runtime supports it).`,
          `${source ? `来源：${source}\n` : ''}写入后其他连接的 Agent 也能读到。之后可以在「连接器 → 已导入的数据」里删除（Runtime 支持的部分）。`
        ),
        confirmLabel: tr('Write', '写入')
      })
    },
    {
      consent: async (kind, sender) => {
        if (!deps.nativeConfirm) return false
        const t = CONSENT_TEXT[kind]
        return deps.nativeConfirm(sender, {
          message: tr(`Allow the "${t.title}" connector?`, `允许「${t.title}」连接器？`),
          detail: [tr(`Reads: ${t.reads.join(' ')}`, `读取：${t.reads.join(' ')}`), tr(`Writes: ${t.writes.join(' ')}`, `写入：${t.writes.join(' ')}`), ...t.notes].join('\n\n'),
          confirmLabel: tr('Agree', '同意')
        })
      },
      deletion: async (s, sender) => {
        if (!deps.nativeConfirm) return false
        return deps.nativeConfirm(sender, {
          message: tr(`Delete the data imported by the "${KIND_WHAT[s.kind]}" connector?`, `删除「${KIND_WHAT[s.kind]}」连接器导入的数据？`),
          detail: tr(
            `Runtime will be asked to delete ${s.memoryEntries} memory entries${s.kind === 'health' ? `, ${s.healthEvents} structured health records` : ''}${s.timelineDocs ? `, ${s.timelineDocs} timeline documents` : ''} (R10 Runtime deletes entry by entry; older Runtimes can only retract memories, not delete timeline documents). Anything Runtime does not support or refuses is listed as-is, never shown as deleted. Backups made before the deletion still contain this content.`,
            `将请求 Runtime 删除 ${s.memoryEntries} 条记忆${s.kind === 'health' ? `、${s.healthEvents} 条结构化健康记录` : ''}${s.timelineDocs ? `、${s.timelineDocs} 个时间线文档` : ''}（R10 Runtime 按条删除；旧版 Runtime 只能撤回记忆、不能删除时间线文档）。Runtime 不支持或拒绝的部分会如实列出，不会假装已删除；删除前做的备份里仍有这些内容。`
          ),
          confirmLabel: tr('Delete', '删除')
        })
      }
    }
  )
}
