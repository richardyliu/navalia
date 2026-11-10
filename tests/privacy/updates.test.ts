import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { checkForUpdates, updateBlockedReasons } from '../../src/main/privacy/updates'
import { updateLines } from '../../src/renderer/src/components/settings/privacyView'

const FILE = path.join(__dirname, '../../src/main/privacy/updates.ts')

afterEach(() => {
  vi.unstubAllGlobals()
  setLocale('en')
})

describe('OG-D4 update check: BLOCKED, no network at all', () => {
  test('static: the module imports nothing but its own types (+ the pure i18n helper) and names no network API', () => {
    const src = fs.readFileSync(FILE, 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const imports = [...code.matchAll(/(?:import|require)\s*(?:type\s+)?[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(imports).toEqual(['./api', '../../shared/i18n'])
    for (const banned of [/\bfetch\b/, /\bhttps?\b/i, /\bnet\b/, /XMLHttpRequest/, /WebSocket/, /autoUpdater/, /electron/, /setInterval/, /setTimeout/, /RELEASES\.json['"]/]) {
      expect(code).not.toMatch(banned)
    }
  })

  test('runtime: calling the check never touches fetch', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network used')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const r = checkForUpdates(() => '0.1.0')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(r).toEqual({ status: 'blocked', currentVersion: '0.1.0', reasons: updateBlockedReasons(), networkRequested: false, decision: 'OG-D4' })
    expect(r.reasons.join('\n')).toMatch(/RELEASES\.json/)
    expect(r.reasons.join('\n')).toMatch(/Unsigned/)
    setLocale('zh')
    expect(checkForUpdates(() => '0.1.0').reasons.join('\n')).toMatch(/未签名/)
  })

  test('version getter failure degrades to unknown; view lines say BLOCKED', () => {
    const r = checkForUpdates(() => {
      throw new Error('no app')
    })
    expect(r.currentVersion).toBeNull()
    expect(updateLines(r)[0]).toBe('Current version: unknown')
    setLocale('zh')
    expect(updateLines(r)[0]).toBe('当前版本：未知')
    expect(updateLines(r)[1]).toMatch(/BLOCKED/)
  })
})
