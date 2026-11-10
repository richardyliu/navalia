import { ipcRenderer } from 'electron'
import { LIBRARY_CHANNELS, type LibraryApi } from '../main/library/api'

// Preload bridge fragment for S1 library (Library page + daily brief export).
export const libraryBridge: LibraryApi = {
  library: {
    overview: () => ipcRenderer.invoke(LIBRARY_CHANNELS.overview),
    entity: (name) => ipcRenderer.invoke(LIBRARY_CHANNELS.entity, { name }),
    exportBrief: (markdown, date) => ipcRenderer.invoke(LIBRARY_CHANNELS.exportBrief, { markdown, date })
  }
}
