import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import { redactForDisplay } from '../import/redact'
import type { S1Deps } from '../s1/deps'
import { BACKUP_CHANNELS, type BackupExportResult, type BackupInspection } from './api'
import { MAX_PASSPHRASE, MIN_PASSPHRASE, ENC_EXT, LEGACY_ENC_EXT } from './crypto'
import { BackupError, createBackupService, type BackupService } from './service'
import { tr } from '../../shared/i18n'
import { ipcRunner } from '../ipc-result'

const Passphrase = z.string().min(MIN_PASSPHRASE, { error: () => tr(`Passphrase must be at least ${MIN_PASSPHRASE} characters`, `口令至少 ${MIN_PASSPHRASE} 个字符`) }).max(MAX_PASSPHRASE)
const ExportArgs = z.strictObject({
  withoutModel: z.boolean(),
  includeAccessLog: z.boolean().optional(),
  includeChat: z.boolean().optional(),
  includeMeetings: z.boolean().optional(),
  includeMoments: z.boolean().optional(),
  passphrase: Passphrase.optional()
})
const InspectArgs = z.union([z.undefined(), z.strictObject({ encrypted: z.literal(true), passphrase: Passphrase })])
const RestoreArgs = z.strictObject({ inspectionId: z.string().regex(/^[0-9a-f]{24}$/), confirm: z.literal(true) })

function toLensError(error: unknown): LensError {
  // Never echo payload values (a passphrase could be one): only the issue messages.
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  if (error instanceof BackupError) return { code: error.code, message: redactForDisplay(error.message) }
  return { code: 'unknown', message: redactForDisplay(error instanceof Error ? error.message : String(error)) }
}

const run = ipcRunner(toLensError)

type PickDir = NonNullable<S1Deps['openDirectoryDialog']>

const CANCELLED_EXPORT: BackupExportResult = { cancelled: true, path: null, files: 0, bytes: 0, modelSnapshot: null, excluded: [], skipped: [] }
const CANCELLED_INSPECT: BackupInspection = {
  cancelled: true,
  inspectionId: null,
  name: null,
  createdAt: null,
  appVersion: null,
  counts: { workflows: 0, peers: 0, cards: 0, files: 0, bytes: 0 },
  modelSnapshot: false
}

/** Handlers on an explicit service + picker (tests inject both). Paths never come from the renderer. */
/** S1-R3-SEC L5: main-side confirm before a restore writes anything (in addition to the renderer's). C21: `detail` = plan. */
export type ConfirmRestore = (summary: { inspectionId: string; detail: string }, sender: unknown) => Promise<boolean>
type PickFile = S1Deps['openDialog']

export function registerBackupHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  service: BackupService,
  pickDir: PickDir | undefined,
  confirmRestore: ConfirmRestore,
  pickFile?: PickFile
): void {
  const pick = async (title: string, createDirectory: boolean): Promise<string | null> => {
    if (!pickDir) throw new BackupError('unknown', tr('Choosing a folder is not supported in this environment.', '当前环境不支持选择目录。'))
    return pickDir({ title, createDirectory })
  }
  ipcMain.handle(BACKUP_CHANNELS.exportBackup, (_e, raw: unknown) =>
    run(async () => {
      const args = ExportArgs.parse(raw)
      const dir = await pick(tr('Choose where to save the backup', '选择备份保存位置'), true)
      if (!dir) return CANCELLED_EXPORT
      return service.exportTo(dir, args)
    })
  )
  ipcMain.handle(BACKUP_CHANNELS.inspect, (_e, raw: unknown) =>
    run(async () => {
      const args = InspectArgs.parse(raw)
      if (args?.encrypted) {
        if (!pickFile) throw new BackupError('unknown', tr('Choosing a file is not supported in this environment.', '当前环境不支持选择文件。'))
        const file = await pickFile({ title: tr('Choose an encrypted navalia-backup-….navaliabackup file', '选择 navalia-backup-….navaliabackup 加密备份'), filters: [{ name: tr('Navalia encrypted backup', 'Navalia 加密备份'), extensions: [ENC_EXT, LEGACY_ENC_EXT] }] })
        if (!file) return CANCELLED_INSPECT
        return service.inspectEncrypted(file, args.passphrase)
      }
      const dir = await pick(tr('Choose a navalia-backup-… backup folder', '选择 navalia-backup-… 备份目录'), false)
      if (!dir) return CANCELLED_INSPECT
      return service.inspect(dir)
    })
  )
  ipcMain.handle(BACKUP_CHANNELS.restore, (e, raw: unknown) =>
    run(async () => {
      const args = RestoreArgs.parse(raw)
      const ok = await confirmRestore({ inspectionId: args.inspectionId, detail: service.describe(args.inspectionId) }, (e as { sender?: unknown } | null | undefined)?.sender ?? null)
      if (!ok) throw new BackupError('unknown', tr('Cancelled. Nothing was restored.', '已取消，未恢复任何内容'))
      return service.restore(args.inspectionId)
    })
  )
}

function appVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getVersion(): string } }
    return electron.app?.getVersion() ?? null
  } catch {
    return null
  }
}

/** Register `lens:backup:*` channels. */
export function registerBackupIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: S1Deps): void {
  registerBackupHandlers(
    ipcMain,
    createBackupService({
      storeRoot: deps.storeRoot,
      runtimeRoot: deps.runtimeRoot,
      persomeBin: deps.persomeBin,
      appVersion,
      // C21: the same KeyManager that signs Cards (already in S1Deps): signs backup manifests,
      // and decides which backups are "mine" (current or retired key).
      identity: deps.identityKeys
    }),
    deps.openDirectoryDialog,
    async (summary, sender) =>
      deps.nativeConfirm
        ? deps.nativeConfirm(sender, {
            message: tr('Restore this backup into Navalia on this Mac?', '从这个备份恢复到本机 Navalia？'),
            detail: summary.detail,
            confirmLabel: tr('Restore', '恢复')
          })
        : false,
    deps.openDialog
  )
}
