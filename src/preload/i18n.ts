import { ipcRenderer } from 'electron'
import { I18N_CHANNELS, type I18nApi } from '../shared/i18n'

// Preload bridge fragment: UI language get / set.
export const i18nBridge: I18nApi = {
  i18n: {
    get: () => ipcRenderer.invoke(I18N_CHANNELS.get),
    set: (locale) => ipcRenderer.invoke(I18N_CHANNELS.set, { locale })
  }
}
