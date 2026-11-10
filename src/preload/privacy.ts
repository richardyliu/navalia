import { ipcRenderer } from 'electron'
import { PRIVACY_CHANNELS, type PrivacyApi } from '../main/privacy/api'

// Preload bridge fragment for OG-09 Settings / Privacy.
export const privacyBridge: PrivacyApi = {
  privacy: {
    retention: () => ipcRenderer.invoke(PRIVACY_CHANNELS.retention),
    confirmIssue: (action) => ipcRenderer.invoke(PRIVACY_CHANNELS.confirmIssue, { action }),
    deleteRun: (target, nonce, phrase, backupFirst) => ipcRenderer.invoke(PRIVACY_CHANNELS.deleteRun, { target, nonce, phrase, backupFirst }),
    withdrawRun: (nonce, phrase) => ipcRenderer.invoke(PRIVACY_CHANNELS.withdrawRun, { nonce, phrase }),
    updateCheck: () => ipcRenderer.invoke(PRIVACY_CHANNELS.updateCheck)
  }
}
