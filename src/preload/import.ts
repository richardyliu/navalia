import { ipcRenderer } from 'electron'
import { IMPORT_CHANNELS, type ImportApi } from '../main/import/api'

// Preload bridge fragment for S1 import. Owned by the import feature agent.
export const importBridge: ImportApi = {
  importer: {
    scan: () => ipcRenderer.invoke(IMPORT_CHANNELS.scan),
    prepare: (keys, opts) => ipcRenderer.invoke(IMPORT_CHANNELS.prepare, { keys, includeTools: opts?.includeTools !== false }),
    commit: (runId) => ipcRenderer.invoke(IMPORT_CHANNELS.commit, { runId }),
    build: (runId, confirm) => ipcRenderer.invoke(IMPORT_CHANNELS.build, { runId, confirm }),
    discard: (runId) => ipcRenderer.invoke(IMPORT_CHANNELS.discard, { runId })
  }
}
