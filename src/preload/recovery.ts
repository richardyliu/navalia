import { ipcRenderer } from 'electron'
import { RECOVERY_CHANNELS, type RecoveryApi } from '../main/recovery/api'

// Preload bridge fragment for OG-06 Recovery. No paths, commands or secrets cross from the renderer:
// only fixed action ids, a main-issued nonce and the phrase the user typed.
export const recoveryBridge: RecoveryApi = {
  recovery: {
    health: () => ipcRenderer.invoke(RECOVERY_CHANNELS.health),
    startRuntime: () => ipcRenderer.invoke(RECOVERY_CHANNELS.startRuntime),
    restartRuntime: () => ipcRenderer.invoke(RECOVERY_CHANNELS.restartRuntime),
    doctor: () => ipcRenderer.invoke(RECOVERY_CHANNELS.doctor),
    diagnostics: (copy) => ipcRenderer.invoke(RECOVERY_CHANNELS.diagnostics, { copy }),
    confirmIssue: (action) => ipcRenderer.invoke(RECOVERY_CHANNELS.confirmIssue, { action }),
    confirmRun: (action, nonce, phrase) => ipcRenderer.invoke(RECOVERY_CHANNELS.confirmRun, { action, nonce, phrase })
  }
}
