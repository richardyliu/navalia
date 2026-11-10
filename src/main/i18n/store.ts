// UI language preference: `<LensStore>/locale.json` (0600, atomic write). Missing / invalid → English.
import path from 'node:path'
import { z } from 'zod'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../shared/i18n'
import { readFileIfExists, writeFileSecure } from '../store/paths'

export const LOCALE_FILENAME = 'locale.json'

const LocaleFileSchema = z.strictObject({ version: z.literal(1), locale: z.enum(LOCALES) })

export function localeFile(storeRoot: string): string {
  return path.join(storeRoot, LOCALE_FILENAME)
}

export function readLocale(storeRoot: string): Locale {
  try {
    const buf = readFileIfExists(localeFile(storeRoot))
    if (!buf) return DEFAULT_LOCALE
    const parsed = LocaleFileSchema.safeParse(JSON.parse(buf.toString('utf8')))
    return parsed.success ? parsed.data.locale : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function writeLocale(storeRoot: string, locale: Locale): void {
  writeFileSecure(localeFile(storeRoot), `${JSON.stringify({ version: 1, locale }, null, 2)}\n`)
}
