import { ipcRenderer } from 'electron'
import { CONNECTOR_CHANNELS, type ConnectorsApi } from '../main/connectors/api'

// Preload bridge fragment for local connectors (S1-R3-07 / C19). The renderer never sends a file path;
// the IMAP password goes renderer → main only (imapSave) and never comes back.
export const connectorsBridge: ConnectorsApi = {
  connectors: {
    pick: (kind) => ipcRenderer.invoke(CONNECTOR_CHANNELS.pick, { kind }),
    commit: (previewId, keys, opts, confirm) => ipcRenderer.invoke(CONNECTOR_CHANNELS.commit, { previewId, keys, opts, confirm }),
    discard: (previewId) => ipcRenderer.invoke(CONNECTOR_CHANNELS.discard, { previewId }),
    consentStatus: () => ipcRenderer.invoke(CONNECTOR_CHANNELS.consentStatus),
    consentGrant: (kind) => ipcRenderer.invoke(CONNECTOR_CHANNELS.consentGrant, { kind }),
    consentRevoke: (kind) => ipcRenderer.invoke(CONNECTOR_CHANNELS.consentRevoke, { kind }),
    csvMap: (previewId, mapping) => ipcRenderer.invoke(CONNECTOR_CHANNELS.csvMap, { previewId, mapping }),
    imapStatus: () => ipcRenderer.invoke(CONNECTOR_CHANNELS.imapStatus),
    imapSave: (config) => ipcRenderer.invoke(CONNECTOR_CHANNELS.imapSave, { config }),
    imapClear: () => ipcRenderer.invoke(CONNECTOR_CHANNELS.imapClear),
    imapFetch: (opts) => ipcRenderer.invoke(CONNECTOR_CHANNELS.imapFetch, { opts }),
    ledger: () => ipcRenderer.invoke(CONNECTOR_CHANNELS.ledger),
    deleteImported: (kind, confirm) => ipcRenderer.invoke(CONNECTOR_CHANNELS.deleteImported, { kind, confirm })
  }
}
