import { ipcRenderer } from 'electron'
import { ASK_SAVE_CHANNELS, type AskSaveApi } from '../main/mcp/save-answer-api'

// Preload bridge fragment for S1-R3-09 「把回答保存到记忆」. `save` carries only the preview token.
export const askSaveBridge: AskSaveApi = {
  askSave: {
    preview: (text, agent) => ipcRenderer.invoke(ASK_SAVE_CHANNELS.preview, agent ? { text, agent } : { text }),
    save: (token) => ipcRenderer.invoke(ASK_SAVE_CHANNELS.save, { token }),
    discard: (token) => ipcRenderer.invoke(ASK_SAVE_CHANNELS.discard, { token })
  }
}
