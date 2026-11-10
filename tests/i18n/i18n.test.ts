import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, getLocale, intlLocale, isLocale, onLocaleChange, setLocale, tr } from '../../src/shared/i18n'
import { localeFile, readLocale, writeLocale } from '../../src/main/i18n/store'
import { registerI18nIpc } from '../../src/main/i18n/ipc'

const TMP_PREFIX = path.join(os.tmpdir(), 'navalia-i18n-test-')
const dirs: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(TMP_PREFIX)
  dirs.push(d)
  return d
}

afterEach(() => {
  setLocale(DEFAULT_LOCALE)
  for (const d of dirs.splice(0)) {
    // Guard: only ever remove our own prefixed temp dirs.
    if (d.startsWith(TMP_PREFIX)) fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('shared i18n', () => {
  it('defaults to English', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(getLocale()).toBe('en')
    expect(tr('Save', '保存')).toBe('Save')
    expect(intlLocale()).toBe('en-US')
  })

  it('switches at call time and notifies listeners once per change', () => {
    const seen: string[] = []
    const off = onLocaleChange((l) => seen.push(l))
    setLocale('zh')
    setLocale('zh')
    expect(tr('Save', '保存')).toBe('保存')
    expect(intlLocale()).toBe('zh-CN')
    setLocale('en')
    off()
    setLocale('zh')
    expect(seen).toEqual(['zh', 'en'])
  })

  it('ignores invalid locales', () => {
    expect(isLocale('fr')).toBe(false)
    setLocale('fr' as never)
    expect(getLocale()).toBe('en')
  })
})

describe('locale store + IPC', () => {
  it('missing or corrupt file → English; round-trips a saved value', () => {
    const root = tmp()
    expect(readLocale(root)).toBe('en')
    fs.writeFileSync(localeFile(root), '{not json')
    expect(readLocale(root)).toBe('en')
    fs.writeFileSync(localeFile(root), JSON.stringify({ version: 1, locale: 'fr' }))
    expect(readLocale(root)).toBe('en')
    writeLocale(root, 'zh')
    expect(readLocale(root)).toBe('zh')
    expect(fs.statSync(localeFile(root)).mode & 0o777).toBe(0o600)
  })

  it('get/set persist and apply; invalid args rejected without writing', async () => {
    const root = tmp()
    const handlers = new Map<string, (e: unknown, raw?: unknown) => unknown>()
    registerI18nIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, root)
    expect(await handlers.get('lens:i18n:get')!({})).toEqual({ ok: true, data: 'en' })
    expect(await handlers.get('lens:i18n:set')!({}, { locale: 'zh' })).toEqual({ ok: true, data: 'zh' })
    expect(getLocale()).toBe('zh')
    expect(readLocale(root)).toBe('zh')
    const bad = (await handlers.get('lens:i18n:set')!({}, { locale: 'de' })) as { ok: boolean }
    expect(bad.ok).toBe(false)
    expect(readLocale(root)).toBe('zh')
  })
})
