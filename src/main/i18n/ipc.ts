// UI language IPC. zod-validated, returns LensResult<Locale>.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { I18N_CHANNELS, LOCALES, getLocale, setLocale, tr, type Locale } from '../../shared/i18n'
import type { LensResult } from '../../shared/types'
import { readLocale, writeLocale } from './store'

const SetArgs = z.strictObject({ locale: z.enum(LOCALES) })

/** Load the saved locale into main's module state, then register `get` / `set`. */
export function registerI18nIpc(ipc: Pick<IpcMain, 'handle'>, storeRoot: string): void {
  setLocale(readLocale(storeRoot))
  ipc.handle(I18N_CHANNELS.get, (): LensResult<Locale> => ({ ok: true, data: getLocale() }))
  ipc.handle(I18N_CHANNELS.set, (_e, raw: unknown): LensResult<Locale> => {
    const parsed = SetArgs.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'unknown', message: tr('Invalid language', '语言参数不合法') } }
    try {
      writeLocale(storeRoot, parsed.data.locale)
    } catch (error) {
      console.warn('[i18n] write failed:', error instanceof Error ? error.name : typeof error)
      return { ok: false, error: { code: 'unknown', message: tr('Could not save language setting', '保存语言设置失败') } }
    }
    setLocale(parsed.data.locale)
    return { ok: true, data: parsed.data.locale }
  })
}
