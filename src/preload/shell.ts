import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { SHELL_CHANNELS, SHELL_NAVIGATE_EVENT, isQuickOpenPage, type ShellApi } from '../main/shell/api'

// Preload bridge fragment for OG-04 (Tray / global shortcut / Quick Box).
export const shellBridge: ShellApi = {
  shell: {
    get: () => ipcRenderer.invoke(SHELL_CHANNELS.get),
    set: (patch) => ipcRenderer.invoke(SHELL_CHANNELS.set, { patch }),
    openQuickBox: () => ipcRenderer.invoke(SHELL_CHANNELS.quickBoxOpen),
    closeQuickBox: () => ipcRenderer.invoke(SHELL_CHANNELS.quickBoxClose),
    openPage: (page) => ipcRenderer.invoke(SHELL_CHANNELS.openPage, { page }),
    readClipboard: () => ipcRenderer.invoke(SHELL_CHANNELS.readClipboard),
    onNavigate: (listener) => {
      // Only a known page id ever reaches the page; the raw event object is never exposed.
      const handler = (_event: IpcRendererEvent, page: unknown): void => {
        if (isQuickOpenPage(page)) listener(page)
      }
      ipcRenderer.on(SHELL_NAVIGATE_EVENT, handler)
      return () => {
        ipcRenderer.removeListener(SHELL_NAVIGATE_EVENT, handler)
      }
    }
  }
}
