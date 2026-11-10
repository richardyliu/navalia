import { ipcRenderer } from 'electron'
import { WORKFLOW_CHANNELS, type WorkflowsApi } from '../main/workflows/api'

// Preload bridge fragment for S1 workflows. Owned by the workflows feature agent.
export const workflowsBridge: WorkflowsApi = {
  workflows: {
    list: () => ipcRenderer.invoke(WORKFLOW_CHANNELS.list),
    get: (id) => ipcRenderer.invoke(WORKFLOW_CHANNELS.get, { id }),
    save: (id, baseVersion, edit) => ipcRenderer.invoke(WORKFLOW_CHANNELS.save, { id, baseVersion, edit }),
    export: (ids) => ipcRenderer.invoke(WORKFLOW_CHANNELS.export, { ids }),
    import: () => ipcRenderer.invoke(WORKFLOW_CHANNELS.import),
    exportSkill: (id) => ipcRenderer.invoke(WORKFLOW_CHANNELS.exportSkill, { id }),
    importSkill: () => ipcRenderer.invoke(WORKFLOW_CHANNELS.importSkill),
    extract: (text, as, agent) => ipcRenderer.invoke(WORKFLOW_CHANNELS.extract, { text, as, agent }),
    // S1-FULL C15: cloud extraction (renderer names ids only; context text stays in main).
    cloudStatus: () => ipcRenderer.invoke(WORKFLOW_CHANNELS.cloudStatus),
    cloudSessions: () => ipcRenderer.invoke(WORKFLOW_CHANNELS.cloudSessions),
    cloudPreview: (sessionKey, hint) => ipcRenderer.invoke(WORKFLOW_CHANNELS.cloudPreview, hint === undefined ? { sessionKey } : { sessionKey, hint }),
    cloudDiscard: (previewId) => ipcRenderer.invoke(WORKFLOW_CHANNELS.cloudDiscard, { previewId }),
    cloudRun: (previewId, includeIds) => ipcRenderer.invoke(WORKFLOW_CHANNELS.cloudRun, { previewId, includeIds }),
    cloudCancel: (previewId) => ipcRenderer.invoke(WORKFLOW_CHANNELS.cloudCancel, { previewId }),
    cloudSave: (extractionId, draft) => ipcRenderer.invoke(WORKFLOW_CHANNELS.cloudSave, { extractionId, draft })
  }
}
