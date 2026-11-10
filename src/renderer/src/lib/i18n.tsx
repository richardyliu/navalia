// Renderer side of UI language. See src/shared/i18n.ts for `tr()` rules.
import { Fragment, useSyncExternalStore, type ReactNode } from 'react'
import { DEFAULT_LOCALE, getLocale, intlLocale, onLocaleChange, setLocale, type Locale } from '../../../shared/i18n'

export { tr, getLocale, intlLocale, LOCALE_LABELS, LOCALES, type Locale } from '../../../shared/i18n'

function applyDocumentLang(): void {
  document.documentElement.lang = intlLocale()
}

/** Read the saved locale from main before the first render. Any failure → English. */
export async function loadInitialLocale(): Promise<void> {
  try {
    const r = await window.lens.i18n.get()
    setLocale(r.ok ? r.data : DEFAULT_LOCALE)
  } catch {
    setLocale(DEFAULT_LOCALE)
  }
  applyDocumentLang()
}

/** Persist and apply. Returns an error message (in the new-or-current locale) on failure. */
export async function changeLocale(locale: Locale): Promise<string | null> {
  const r = await window.lens.i18n.set(locale)
  if (!r.ok) return r.error.message
  setLocale(locale)
  applyDocumentLang()
  return null
}

export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale)
}

/**
 * Remounts its children when the locale changes, so every `tr()` (including ones inside memoized
 * components and view-model helpers) re-evaluates. State outside this boundary (React Query cache) survives.
 */
export function LocaleBoundary({ children }: { children: ReactNode }) {
  const locale = useLocale()
  return <Fragment key={locale}>{children}</Fragment>
}
