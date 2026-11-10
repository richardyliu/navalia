import { ipcRenderer } from 'electron'
import { PROACTIVE_CHANNELS, type ProactiveApi } from '../main/proactive/api'

// Preload bridge fragment for S1-R4-05 (X9 local notifications, opt-in).
export const proactiveBridge: ProactiveApi = {
  proactive: {
    get: () => ipcRenderer.invoke(PROACTIVE_CHANNELS.get),
    set: (patch) => ipcRenderer.invoke(PROACTIVE_CHANNELS.set, { patch }),
    test: () => ipcRenderer.invoke(PROACTIVE_CHANNELS.test),
    reportDenied: () => ipcRenderer.invoke(PROACTIVE_CHANNELS.reportDenied),
    clearDecisions: () => ipcRenderer.invoke(PROACTIVE_CHANNELS.clearDecisions)
  }
}
