import { tr } from '../../shared/i18n'
import fs from 'node:fs'
import path from 'node:path'
import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import { FILE_MODE } from '../store/paths'
import type { S1Deps } from '../s1/deps'
import { WORKFLOW_CHANNELS } from './api'
import { WorkflowEditSchema, WorkflowIdSchema } from './schema'
import { createWorkflowService } from './service'
import { EXTRACT_SAVE_AS, MAX_EXTRACTION_BYTES } from './extract'
import { MAX_IMPORT_BYTES, WorkflowError } from './store'
import { LEGACY_SKILL_FILE_EXT, MAX_SKILL_BYTES, PREV_SKILL_FILE_EXT, SKILL_FILE_EXT, SkillShareError } from '../skillshare/package'
import { createSkillShare } from '../skillshare/service'
import { redactForDisplay } from '../import/redact'
import { CloudError } from '../cloud/errors'
import type { CloudClient } from '../cloud/client'
import { hetRootsFromEnv } from '../het/sources'
import { CloudDraftSchema } from './cloud-draft'
import { createCloudExtractService } from './cloud-extract'
import { createSessionSource, type SessionRoots } from './sessions'
import { ipcRunner } from '../ipc-result'

/** S1-FULL C15: optional cloud extraction wiring (absent ⇒ cloud extraction shows 「未接入」, zero network). */
export interface WorkflowsIpcExtras {
  cloud?: { client: CloudClient; status(): { enabled: boolean; signedIn: boolean } } | null
  knownSecrets?: () => string[]
  /** Transcript roots; default `hetRootsFromEnv()` (LENS_HET_CLAUDE_ROOT / LENS_HET_CODEX_ROOT or ~/.claude, ~/.codex). */
  sessionRoots?: SessionRoots
}

const Hex32 = z.string().regex(/^[0-9a-f]{32}$/)
const CloudPreviewArgs = z.strictObject({ sessionKey: z.string().regex(/^[0-9a-f]{16}$/), hint: z.string().max(200).optional() })
const PreviewIdArgs = z.strictObject({ previewId: Hex32 })
const CloudRunArgs = z.strictObject({ previewId: Hex32, includeIds: z.array(z.string().regex(/^ctx-\d{1,3}$/)).min(1).max(100) })
const CloudSaveArgs = z.strictObject({ extractionId: Hex32, draft: CloudDraftSchema })

const NoArgs = z.undefined()
const GetArgs = z.strictObject({ id: WorkflowIdSchema })
const SaveArgs = z.strictObject({ id: WorkflowIdSchema, baseVersion: z.number().int().min(1), edit: WorkflowEditSchema })
const ExportArgs = z.strictObject({ ids: z.array(WorkflowIdSchema).min(1).max(500) })
const ExportSkillArgs = z.strictObject({ id: WorkflowIdSchema })
const ExtractArgs = z.strictObject({
  text: z.string().min(1).max(MAX_EXTRACTION_BYTES),
  as: z.enum(EXTRACT_SAVE_AS),
  agent: z.string().trim().min(1).max(100)
})
const SKILL_FILTERS = [{ name: 'Navalia skill', extensions: [SKILL_FILE_EXT.slice(1)] }]
const SKILL_OPEN_FILTERS = [{ name: 'Navalia skill', extensions: [SKILL_FILE_EXT.slice(1), PREV_SKILL_FILE_EXT.slice(1), LEGACY_SKILL_FILE_EXT.slice(1)] }]

/** Messages go to the renderer: home-dir paths (`/Users/<name>`) and secrets are redacted (S2-SEC L4). */
export function toLensError(error: unknown): LensError {
  const e = rawLensError(error)
  return { ...e, message: redactForDisplay(e.message) }
}

function rawLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'schema', message: tr(`Invalid arguments: ${error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, `参数不合法：${error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`) }
  if (error instanceof SkillShareError) return { code: error.code === 'no_identity' ? 'not_found' : 'schema', message: error.message }
  if (error instanceof WorkflowError) return { code: error.code === 'not_found' ? 'not_found' : 'schema', message: error.message }
  // C15: CloudError messages are fixed strings per code (never token / body text).
  if (error instanceof CloudError) return { code: cloudLensCode(error.code), message: error.message }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

function cloudLensCode(code: CloudError['code']): LensError['code'] {
  if (code === 'disabled' || code === 'unauthorized' || code === 'no_identity' || code === 'forbidden') return 'unauthorized'
  if (code === 'timeout' || code === 'upstream_timeout') return 'timeout'
  if (code === 'network') return 'unreachable'
  if (code === 'not_found') return 'not_found'
  if (code === 'invalid_args') return 'schema'
  return 'server'
}

const run = ipcRunner(toLensError)

function exportName(ids: string[]): string {
  const stamp = new Date().toISOString().slice(0, 10)
  return ids.length === 1 ? `workflow-${ids[0]}-${stamp}.json` : `workflows-${ids.length}-${stamp}.json`
}

/** Register the S1 workflows IPC channels (`lens:workflows:*`). Every payload is zod-validated. */
export function registerWorkflowsIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: S1Deps, extras: WorkflowsIpcExtras = {}): void {
  const service = createWorkflowService({ storeRoot: deps.storeRoot, runtimeRoot: deps.runtimeRoot, ossTool: deps.ossTool })
  const roots = extras.sessionRoots ?? hetRootsFromEnv()
  const cloudExtract = createCloudExtractService({
    workflows: service,
    cloud: extras.cloud ?? null,
    sessions: createSessionSource({ ...roots, knownSecrets: extras.knownSecrets }),
    sources: { claudeCode: roots.claudeRoot !== null, codex: roots.codexRoot !== null },
    knownSecrets: extras.knownSecrets
  })

  ipcMain.handle(WORKFLOW_CHANNELS.list, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.catalog()
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.get, (_e, raw: unknown) =>
    run(() => service.get(GetArgs.parse(raw).id))
  )
  ipcMain.handle(WORKFLOW_CHANNELS.save, (_e, raw: unknown) =>
    run(() => {
      const a = SaveArgs.parse(raw)
      return service.save(a.id, a.baseVersion, a.edit)
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.export, (_e, raw: unknown) =>
    run(async () => {
      const a = ExportArgs.parse(raw)
      const { json, count } = await service.exportJson(a.ids)
      const target = await deps.saveDialog({ title: tr('Export Workflow', '导出 Workflow'), defaultPath: exportName(a.ids), filters: [{ name: 'Workflow JSON', extensions: ['json'] }] })
      if (!target) return { path: null, count: 0 }
      // Not writeFileSecure: that would chmod the user's chosen folder to 0700.
      fs.writeFileSync(target, json, { encoding: 'utf8', mode: FILE_MODE })
      return { path: target, count }
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.import, (_e, raw: unknown) =>
    run(async () => {
      NoArgs.parse(raw)
      const file = await deps.openDialog({ title: tr('Import Workflow', '导入 Workflow'), filters: [{ name: 'Workflow JSON', extensions: ['json'] }] })
      if (!file) return null
      const st = fs.statSync(file)
      if (!st.isFile()) throw new WorkflowError('invalid', tr('Choose a file', '请选择一个文件'))
      if (st.size > MAX_IMPORT_BYTES) throw new WorkflowError('invalid', tr(`File exceeds ${MAX_IMPORT_BYTES} bytes`, `文件超过 ${MAX_IMPORT_BYTES} 字节`))
      return service.importJson(fs.readFileSync(file, 'utf8'), path.basename(file))
    })
  )
  // S2-07: paste-back of an external-agent extraction. Validation only; no LLM, no network.
  ipcMain.handle(WORKFLOW_CHANNELS.extract, (_e, raw: unknown) =>
    run(() => {
      const a = ExtractArgs.parse(raw)
      return service.saveExtracted(a.text, a.as, a.agent)
    })
  )

  // S1-FULL C15: cloud extraction. Preview is local; run sends only parked items by id; save stores a reviewed draft.
  ipcMain.handle(WORKFLOW_CHANNELS.cloudStatus, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return cloudExtract.status()
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.cloudSessions, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return cloudExtract.sessions()
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.cloudPreview, (_e, raw: unknown) =>
    run(() => {
      const a = CloudPreviewArgs.parse(raw)
      return cloudExtract.preview(a.sessionKey, a.hint)
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.cloudDiscard, (_e, raw: unknown) => run(() => cloudExtract.discard(PreviewIdArgs.parse(raw).previewId)))
  ipcMain.handle(WORKFLOW_CHANNELS.cloudCancel, (_e, raw: unknown) => run(() => cloudExtract.cancel(PreviewIdArgs.parse(raw).previewId)))
  ipcMain.handle(WORKFLOW_CHANNELS.cloudRun, (_e, raw: unknown) =>
    run(() => {
      const a = CloudRunArgs.parse(raw)
      return cloudExtract.run(a.previewId, a.includeIds)
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.cloudSave, (_e, raw: unknown) =>
    run(() => {
      const a = CloudSaveArgs.parse(raw)
      return cloudExtract.save(a.extractionId, a.draft)
    })
  )

  // S1-10: signed `.navaliaskill` share packages. Signing uses the identity key; never creates one.
  const skills = createSkillShare({ service, keys: () => deps.identityKeys })
  ipcMain.handle(WORKFLOW_CHANNELS.exportSkill, (_e, raw: unknown) =>
    run(async () => {
      const a = ExportSkillArgs.parse(raw)
      const signed = await skills.exportSkill(a.id)
      const target = await deps.saveDialog({ title: tr('Export .navaliaskill', '导出 .navaliaskill'), defaultPath: signed.fileName, filters: SKILL_FILTERS })
      if (!target) return { path: null, fingerprint: signed.fingerprint, redacted: signed.redacted }
      fs.writeFileSync(target, signed.text, { encoding: 'utf8', mode: FILE_MODE })
      return { path: target, fingerprint: signed.fingerprint, redacted: signed.redacted }
    })
  )
  ipcMain.handle(WORKFLOW_CHANNELS.importSkill, (_e, raw: unknown) =>
    run(async () => {
      NoArgs.parse(raw)
      const file = await deps.openDialog({ title: tr('Import .navaliaskill', '导入 .navaliaskill'), filters: SKILL_OPEN_FILTERS })
      if (!file) return null
      const st = fs.statSync(file)
      if (!st.isFile()) throw new SkillShareError('rejected', tr('Choose a file', '请选择一个文件'))
      if (st.size > MAX_SKILL_BYTES) throw new SkillShareError('rejected', tr(`Import rejected: file exceeds ${MAX_SKILL_BYTES} bytes`, `已拒绝导入：文件超过 ${MAX_SKILL_BYTES} 字节`))
      return skills.importSkill(fs.readFileSync(file, 'utf8'), path.basename(file))
    })
  )
}
