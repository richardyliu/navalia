import { ipcRenderer } from 'electron'
import { PEERS_CHANNELS, type PeersApi } from '../main/peers/api'

// Preload bridge fragment for S1-11 peers. Owned by the peers feature agent.
export const peersBridge: PeersApi = {
  peers: {
    list: () => ipcRenderer.invoke(PEERS_CHANNELS.list),
    get: (fingerprint) => ipcRenderer.invoke(PEERS_CHANNELS.get, { fingerprint }),
    importFile: () => ipcRenderer.invoke(PEERS_CHANNELS.importFile),
    importText: (text) => ipcRenderer.invoke(PEERS_CHANNELS.importText, { text }),
    remove: (fingerprint) => ipcRenderer.invoke(PEERS_CHANNELS.remove, { fingerprint }),
    suggestions: (fingerprint) => ipcRenderer.invoke(PEERS_CHANNELS.suggestions, { fingerprint }),
    sharedMoments: (fingerprint, timezone) =>
      ipcRenderer.invoke(PEERS_CHANNELS.sharedMoments, timezone === undefined ? { fingerprint } : { fingerprint, timezone }),
    letterDraft: (fingerprint, timezone) => ipcRenderer.invoke(PEERS_CHANNELS.letterDraft, { fingerprint, timezone }),
    exportLetter: (fingerprint, markdown) => ipcRenderer.invoke(PEERS_CHANNELS.exportLetter, { fingerprint, markdown }),
    subStatus: () => ipcRenderer.invoke(PEERS_CHANNELS.subStatus),
    subChoose: () => ipcRenderer.invoke(PEERS_CHANNELS.subChoose),
    subEnable: () => ipcRenderer.invoke(PEERS_CHANNELS.subEnable),
    subDisable: () => ipcRenderer.invoke(PEERS_CHANNELS.subDisable),
    subRefresh: () => ipcRenderer.invoke(PEERS_CHANNELS.subRefresh),
    subSetAutoScan: (enabled, intervalMinutes) => ipcRenderer.invoke(PEERS_CHANNELS.subAutoScan, { enabled, intervalMinutes })
  }
}
