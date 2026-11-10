/**
 * S1-10 glue between the signed package (package.ts) and the Workflow service/store.
 * No dialogs or file I/O here so it is testable without Electron.
 */
import { tr } from '../../shared/i18n'
import type { KeyManager } from '../identity/keys'
import type { SkillImportReport } from '../workflows/api'
import type { WorkflowService } from '../workflows/service'
import { SKILL_FILE_EXT, SkillShareError, rejectionMessage, selfSignedNote, signSkill, verifySkillText } from './package'

export interface SkillShareDeps {
  service: WorkflowService
  /** The identity KeyManager (same one that signs Cards). Absent/uninitialised → export refused. */
  keys: () => KeyManager | null | undefined
  now?: () => Date
}

export function skillFileName(id: string, at: Date): string {
  return `${id}-${at.toISOString().slice(0, 10)}${SKILL_FILE_EXT}`
}

export function createSkillShare(deps: SkillShareDeps) {
  const now = deps.now ?? (() => new Date())
  return {
    async exportSkill(id: string) {
      const detail = await deps.service.get(id)
      if (!detail) throw new SkillShareError('rejected', tr(`Workflow not found: ${id}`, `找不到 Workflow：${id}`))
      const signed = signSkill(detail.workflow, deps.keys(), now)
      return { ...signed, fileName: skillFileName(detail.workflow.id, now()) }
    },

    async importSkill(text: string, fileName: string): Promise<SkillImportReport> {
      const r = verifySkillText(text)
      if (!r.valid) throw new SkillShareError('rejected', tr(`Import rejected: ${rejectionMessage(r)}`, `已拒绝导入：${rejectionMessage(r)}`))
      const { payload } = r.pkg
      const known = (await deps.service.catalog()).workflows
      const item = deps.service.store.importShared(
        payload.workflow,
        { fileName, sharedAt: payload.exported_at, signerFingerprint: r.fingerprint, packageHash: r.packageHash, chain: payload.provenance_chain },
        known
      )
      return { file: fileName, item, fingerprint: r.fingerprint, sharedAt: payload.exported_at, trustNote: selfSignedNote() }
    }
  }
}

export type SkillShare = ReturnType<typeof createSkillShare>
