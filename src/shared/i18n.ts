// UI language (en / zh). Default English. No node / electron imports: used by main, preload and renderer.
//
// Usage: `tr('Save', '保存')`, `tr(`${n} items`, `${n} 项`)`. Both languages are written side by side at
// the call site, so a string can never be missing a translation.
//
// `tr` reads the current locale AT CALL TIME. Never call it at module top level (a constant built at import
// time freezes whatever locale was active then); wrap such constants in a function or getter instead.
//
// Locale is persisted by main (`<LensStore>/locale.json`). The renderer reads it once at boot via
// `window.lens.i18n.get()` and remounts the React tree when it changes.
import type { LensResult } from './types'

export const LOCALES = ['en', 'zh'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

let current: Locale = DEFAULT_LOCALE
const listeners = new Set<(locale: Locale) => void>()

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh'
}

export function getLocale(): Locale {
  return current
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === current) return
  current = locale
  for (const listener of listeners) listener(locale)
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Pick the string for the active locale. */
export function tr(en: string, zh: string): string {
  return current === 'zh' ? zh : en
}

/** BCP 47 tag for Intl / toLocale* APIs. */
export function intlLocale(): 'en-US' | 'zh-CN' {
  return current === 'zh' ? 'zh-CN' : 'en-US'
}

/** Native names: always shown as-is in the language picker. */
export const LOCALE_LABELS: Record<Locale, string> = { en: 'English', zh: '中文' }

export const I18N_CHANNELS = {
  get: 'lens:i18n:get',
  set: 'lens:i18n:set'
} as const

export interface I18nApi {
  i18n: {
    get(): Promise<LensResult<Locale>>
    set(locale: Locale): Promise<LensResult<Locale>>
  }
}
