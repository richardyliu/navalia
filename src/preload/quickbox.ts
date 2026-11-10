import { contextBridge, ipcRenderer } from 'electron'
import type { LensApi } from '../shared/api'

// OG8: reduced preload for the Quick Box window. Only what the Quick Box component calls is
// exposed, with the same shape as the full bridge. Main enforces the same list per window
// (QUICKBOX_CHANNELS in src/main/security.ts), so this file is not the only line of defence.
// Channel names are literals on purpose: importing shared modules would let the bundler split a
// shared chunk, which a sandboxed preload cannot `require`. tests/shell/quickbox-preload.test.ts
// keeps them in sync with SHELL_CHANNELS and the main allowlist.
export const QUICKBOX_PRELOAD_CHANNELS = {
  closeQuickBox: 'lens:shell:quickbox-close',
  openPage: 'lens:shell:open-page',
  readClipboard: 'lens:shell:read-clipboard',
  search: 'lens:mcp:search',
  remember: 'lens:mcp:remember',
  locale: 'lens:i18n:get'
} as const

export interface QuickBoxApi {
  shell: Pick<LensApi['shell'], 'closeQuickBox' | 'openPage' | 'readClipboard'>
  mcp: Pick<LensApi['mcp'], 'search' | 'remember'>
  i18n: Pick<LensApi['i18n'], 'get'>
}

const C = QUICKBOX_PRELOAD_CHANNELS

export const quickBoxApi: QuickBoxApi = {
  shell: {
    closeQuickBox: () => ipcRenderer.invoke(C.closeQuickBox),
    openPage: (page) => ipcRenderer.invoke(C.openPage, { page }),
    readClipboard: () => ipcRenderer.invoke(C.readClipboard)
  },
  mcp: {
    search: (query, topK) => ipcRenderer.invoke(C.search, { query, topK }),
    remember: (content, tags) => ipcRenderer.invoke(C.remember, { content, tags })
  },
  i18n: {
    get: () => ipcRenderer.invoke(C.locale)
  }
}

contextBridge.exposeInMainWorld('lens', quickBoxApi)
