import { ipcRenderer } from 'electron'
import { REWIND_CHANNELS, type RewindApi } from '../main/rewind/api'

// Preload bridge fragment for OG-05 Rewind. Only the frame id crosses to main; never a path or key.
export const rewindBridge: RewindApi = {
  rewind: {
    list: (query) => ipcRenderer.invoke(REWIND_CHANNELS.list, query),
    view: (fileStem) => ipcRenderer.invoke(REWIND_CHANNELS.view, { fileStem })
  }
}
