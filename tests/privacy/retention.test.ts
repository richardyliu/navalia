import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { RETENTION_DEFAULTS, formatHours, readRetention } from '../../src/main/privacy/retention'
import { configStateText, retentionRows } from '../../src/renderer/src/components/settings/privacyView'

const roots: string[] = []
afterEach(() => {
  setLocale('en')
  const prefix = path.join(os.tmpdir(), 'lens-priv-rt-')
  for (const r of roots.splice(0)) if (r.startsWith(prefix)) fs.rmSync(r, { recursive: true, force: true })
})
function tempRuntime(config?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-priv-rt-'))
  roots.push(root)
  if (config !== undefined) fs.writeFileSync(path.join(root, 'config.toml'), config)
  return root
}

describe('PRIV-02 retention display (read-only, authoritative = Runtime config.toml)', () => {
  test('defaults match the OSS CaptureConfig (168 h buffer = 7 days, 24 h screenshots)', () => {
    expect(RETENTION_DEFAULTS).toEqual({ buffer_retention_hours: 168, screenshot_retention_hours: 24 })
    expect(formatHours(168)).toBe('168 hours (7 days)')
    expect(formatHours(5)).toBe('5 hours')
    setLocale('zh')
    expect(formatHours(168)).toBe('168 小时（7 天）')
    expect(formatHours(5)).toBe('5 小时')
  })

  test('missing config → defaults, labelled as defaults; never editable', () => {
    const root = tempRuntime()
    const v = readRetention(root, '/nonexistent-home')
    expect(v.configState).toBe('missing')
    expect(v.editable).toBe(false)
    expect(v.values.map((x) => [x.key, x.hours, x.origin])).toEqual([
      ['buffer_retention_hours', 168, 'default'],
      ['screenshot_retention_hours', 24, 'default']
    ])
    expect(configStateText(v)).toMatch(/not found/)
    expect(retentionRows(v).every((r) => r.tone === 'warn')).toBe(true)
  })

  test('configured values come from [capture] only; other sections ignored', () => {
    const root = tempRuntime('[server]\nbuffer_retention_hours = 1\n\n[capture]\nsource = "ingest"\nbuffer_retention_hours = 72 # 3 days\n')
    const v = readRetention(root, '/nonexistent-home')
    expect(v.configState).toBe('ok')
    expect(v.values[0]).toMatchObject({ key: 'buffer_retention_hours', hours: 72, origin: 'config' })
    expect(v.values[0].display).toContain('3 days')
    expect(v.values[1]).toMatchObject({ key: 'screenshot_retention_hours', hours: 24, origin: 'default' })
  })

  test('non-integer value is flagged invalid, not shown as a number', () => {
    const root = tempRuntime('[capture]\nscreenshot_retention_hours = "a day"\n')
    const v = readRetention(root, '/nonexistent-home')
    expect(v.values[1]).toMatchObject({ hours: null, origin: 'invalid' })
    expect(retentionRows(v)[1].tone).toBe('bad')
  })

  test('home directory is shown as ~ and how-to-change mentions the manual steps', () => {
    const root = tempRuntime('[capture]\n')
    const v = readRetention(root, path.dirname(root))
    expect(v.configPath.startsWith('~')).toBe(true)
    expect(v.howToChange.join('\n')).toMatch(/persome stop/)
    expect(v.howToChange.join('\n')).toMatch(/never rewrites/)
  })
})
