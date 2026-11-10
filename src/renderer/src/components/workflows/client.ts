import type { CloudExtractDraftResult, CloudExtractPreview, CloudExtractStatus, CloudSaveResult, SessionList, ExtractSaveResult, ExportResult, ImportReport, SaveResult, SkillExportResult, SkillImportReport, WorkflowCatalog, WorkflowDetail } from '../../../../main/workflows/api'
import type { WorkflowEdit } from '../../../../main/workflows/schema'
import type { ExtractSaveAs } from '../../../../main/workflows/extract'
import type { CloudDraft } from '../../../../main/workflows/cloud-draft'
import { unwrap } from '../../lib/api'

export const workflowsApi = {
  list: (): Promise<WorkflowCatalog> => unwrap(window.lens.workflows.list()),
  get: (id: string): Promise<WorkflowDetail | null> => unwrap(window.lens.workflows.get(id)),
  save: (id: string, baseVersion: number, edit: WorkflowEdit): Promise<SaveResult> => unwrap(window.lens.workflows.save(id, baseVersion, edit)),
  export: (ids: string[]): Promise<ExportResult> => unwrap(window.lens.workflows.export(ids)),
  import: (): Promise<ImportReport | null> => unwrap(window.lens.workflows.import()),
  exportSkill: (id: string): Promise<SkillExportResult> => unwrap(window.lens.workflows.exportSkill(id)),
  importSkill: (): Promise<SkillImportReport | null> => unwrap(window.lens.workflows.importSkill()),
  extract: (text: string, as: ExtractSaveAs, agent: string): Promise<ExtractSaveResult> => unwrap(window.lens.workflows.extract(text, as, agent)),
  // S1-FULL C15: cloud extraction.
  cloudStatus: (): Promise<CloudExtractStatus> => unwrap(window.lens.workflows.cloudStatus()),
  cloudSessions: (): Promise<SessionList> => unwrap(window.lens.workflows.cloudSessions()),
  cloudPreview: (sessionKey: string, hint?: string): Promise<CloudExtractPreview> => unwrap(window.lens.workflows.cloudPreview(sessionKey, hint)),
  cloudDiscard: (previewId: string): Promise<boolean> => unwrap(window.lens.workflows.cloudDiscard(previewId)),
  cloudRun: (previewId: string, includeIds: string[]): Promise<CloudExtractDraftResult> => unwrap(window.lens.workflows.cloudRun(previewId, includeIds)),
  cloudCancel: (previewId: string): Promise<boolean> => unwrap(window.lens.workflows.cloudCancel(previewId)),
  cloudSave: (extractionId: string, draft: CloudDraft): Promise<CloudSaveResult> => unwrap(window.lens.workflows.cloudSave(extractionId, draft))
}
