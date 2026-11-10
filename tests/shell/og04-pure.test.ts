// OG-04 pure logic: settings defaults/persistence, accelerator validation, Quick Box intent routing,
// tray menu model + glyph. Uses only a fresh temp dir; never the real Lens Store or ~/.persome.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateAccelerator } from '../../src/main/shell/accelerator'
import { DEFAULT_ACCELERATOR, QUICK_OPEN_PAGE_IDS, isQuickOpenPage } from '../../src/main/shell/api'
import { matchPages, routeQuickInput, splitPrefix } from '../../src/main/shell/intent'
import {
  DEFAULT_SHELL_SETTINGS,
  applyShellPatch,
  readShellSettings,
  shellSettingsFile,
  writeShellSettings
} from '../../src/main/shell/settings'
import { buildTrayMenuModel, captureLine, renderTrayGlyph } from '../../src/main/shell/trayModel'

const dirs: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-og04-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('shell settings', () => {
  it('defaults are all OFF', () => {
    expect(DEFAULT_SHELL_SETTINGS).toEqual({
      version: 1,
      trayEnabled: false,
      shortcutEnabled: false,
      shortcutAccelerator: DEFAULT_ACCELERATOR,
      keepResidentOnClose: false
    })
    const booleans = Object.entries(DEFAULT_SHELL_SETTINGS).filter(([, v]) => typeof v === 'boolean')
    expect(booleans.length).toBe(3)
    expect(booleans.every(([, v]) => v === false)).toBe(true)
    expect(validateAccelerator(DEFAULT_ACCELERATOR)).toEqual({ ok: true, accelerator: DEFAULT_ACCELERATOR })
  })

  it('missing file → defaults, no error, nothing created', () => {
    const file = shellSettingsFile(tmp())
    expect(readShellSettings(file)).toEqual({ settings: DEFAULT_SHELL_SETTINGS, error: null })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('corrupt or invalid file fails closed to defaults with an error', () => {
    const file = shellSettingsFile(tmp())
    fs.writeFileSync(file, '{not json')
    let r = readShellSettings(file)
    expect(r.settings).toEqual(DEFAULT_SHELL_SETTINGS)
    expect(r.error).toMatch(/invalid/)
    fs.writeFileSync(file, JSON.stringify({ version: 1, trayEnabled: true, shortcutAccelerator: 'Shift+A' }))
    r = readShellSettings(file)
    expect(r.settings.trayEnabled).toBe(false)
    expect(r.error).not.toBeNull()
    fs.writeFileSync(file, JSON.stringify({ version: 1, trayEnabled: true, extra: 1 }))
    expect(readShellSettings(file).settings.trayEnabled).toBe(false)
  })

  it('round-trips through a 0600 file; partial files merge with defaults', () => {
    const file = shellSettingsFile(tmp())
    const next = applyShellPatch(DEFAULT_SHELL_SETTINGS, { trayEnabled: true, shortcutAccelerator: 'cmdorctrl+alt+k' })
    expect(next.shortcutAccelerator).toBe('CommandOrControl+Alt+K')
    writeShellSettings(file, next)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(readShellSettings(file)).toEqual({ settings: next, error: null })
    fs.writeFileSync(file, JSON.stringify({ version: 1, trayEnabled: true }))
    expect(readShellSettings(file).settings).toEqual({ ...DEFAULT_SHELL_SETTINGS, trayEnabled: true })
  })

  it('rejects invalid patches (unknown keys, bad types, bad accelerators)', () => {
    expect(() => applyShellPatch(DEFAULT_SHELL_SETTINGS, { notifications: true })).toThrow()
    expect(() => applyShellPatch(DEFAULT_SHELL_SETTINGS, { trayEnabled: 'yes' })).toThrow()
    expect(() => applyShellPatch(DEFAULT_SHELL_SETTINGS, { shortcutAccelerator: 'Command+Q' })).toThrow()
    expect(() => applyShellPatch(DEFAULT_SHELL_SETTINGS, { version: 2 })).toThrow()
    expect(applyShellPatch(DEFAULT_SHELL_SETTINGS, undefined)).toEqual(DEFAULT_SHELL_SETTINGS)
  })
})

describe('validateAccelerator', () => {
  it.each([
    ['CommandOrControl+Shift+Space', 'CommandOrControl+Shift+Space'],
    ['shift+cmdorctrl+space', null], // modifiers must come before the key, but order among modifiers is free
    ['Alt+Shift+K', 'Alt+Shift+K'],
    ['Shift+Alt+k', 'Alt+Shift+K'],
    ['Option+Command+F12', 'Command+Alt+F12'],
    ['Ctrl+Alt+Plus', 'Control+Alt+Plus'],
    ['Command+Shift+/', 'Command+Shift+/'],
    ['Super+Esc', 'Super+Escape'],
    ['Control+Return', 'Control+Enter']
  ])('%s', (input, expected) => {
    const r = validateAccelerator(input)
    if (expected === null) expect(r.ok).toBe(true)
    else expect(r).toEqual({ ok: true, accelerator: expected })
  })

  it.each([
    [''],
    ['   '],
    ['K'],
    ['Shift+K'], // Shift alone would hijack typing
    ['Command'],
    ['Command+Shift'],
    ['Command+K+J'],
    ['Command+Command+K'],
    ['K+Command'],
    ['Command++'],
    ['Command+ K'],
    ['Command+F25'],
    ['Command+Ä'],
    ['CommandOrControl+Command+K'],
    ['Command+Q'],
    ['CmdOrCtrl+C'],
    ['Command+Space'],
    ['Command+Shift+4'],
    ['A'.repeat(65)]
  ])('rejects %j', (input) => {
    const r = validateAccelerator(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
  })

  it('rejects non-strings', () => {
    expect(validateAccelerator(42).ok).toBe(false)
    expect(validateAccelerator(null).ok).toBe(false)
  })
})

describe('Quick Box intent routing', () => {
  it('routes by selected mode', () => {
    expect(routeQuickInput('ask', '  上周的决定  ')).toEqual({ kind: 'ask', query: '上周的决定' })
    expect(routeQuickInput('remember', '我偏好本地优先')).toEqual({ kind: 'remember', content: '我偏好本地优先' })
    expect(routeQuickInput('open', 'het')).toMatchObject({ kind: 'open', page: 'het' })
  })

  it('a leading prefix overrides the mode', () => {
    expect(routeQuickInput('ask', '+ 记住这个')).toEqual({ kind: 'remember', content: '记住这个' })
    expect(routeQuickInput('remember', '? 找一下')).toEqual({ kind: 'ask', query: '找一下' })
    expect(routeQuickInput('ask', '>采集')).toMatchObject({ kind: 'open', page: 'capture' })
    expect(routeQuickInput('ask', '/settings')).toMatchObject({ kind: 'open', page: 'settings' })
    expect(splitPrefix('ask', '＋全角')).toEqual({ mode: 'remember', text: '全角' })
  })

  it('empty / oversize / unmatched inputs are invalid, never sent', () => {
    expect(routeQuickInput('ask', '   ')).toMatchObject({ kind: 'invalid', mode: 'ask' })
    expect(routeQuickInput('remember', '+')).toMatchObject({ kind: 'invalid', mode: 'remember' })
    expect(routeQuickInput('ask', 'x'.repeat(2001))).toMatchObject({ kind: 'invalid' })
    expect(routeQuickInput('remember', 'x'.repeat(20_001))).toMatchObject({ kind: 'invalid' })
    expect(routeQuickInput('remember', 'x'.repeat(20_000))).toMatchObject({ kind: 'remember' })
    expect(routeQuickInput('open', 'zzzz-nope')).toMatchObject({ kind: 'invalid', mode: 'open' })
  })

  it('page matching ranks exact > prefix > substring and keeps nav order', () => {
    expect(matchPages('')).toEqual(QUICK_OPEN_PAGE_IDS)
    expect(matchPages('设置')[0]).toBe('settings')
    expect(matchPages('Card')[0]).toBe('card')
    expect(matchPages('rew')).toEqual(['rewind'])
    expect(matchPages('today')[0]).toBe('today')
    expect(matchPages('暂停')).toEqual(['capture'])
    expect(matchPages('performance')[0]).toBe('performance')
  })

  it('every Quick Box page exists in the renderer Page union and the App NAV', () => {
    const nav = fs.readFileSync(path.join(__dirname, '../../src/renderer/src/lib/nav.ts'), 'utf8')
    const union = nav.slice(nav.indexOf('export type Page'), nav.indexOf('/** Optional'))
    const pages = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    const navData = fs.readFileSync(path.join(__dirname, '../../src/renderer/src/lib/navigation.tsx'), 'utf8')
    for (const id of QUICK_OPEN_PAGE_IDS) {
      expect(pages).toContain(id)
      expect(navData).toContain(`id: '${id}'`)
    }
    expect(isQuickOpenPage('settings')).toBe(true)
    expect(isQuickOpenPage('../etc')).toBe(false)
    expect(isQuickOpenPage(3)).toBe(false)
  })
})

describe('tray menu model', () => {
  const ids = (m: ReturnType<typeof buildTrayMenuModel>) => m.flatMap((i) => (i.kind === 'action' ? [i.id] : []))

  it('running capture → 暂停采集', () => {
    const m = buildTrayMenuModel({ capture: { started: true, paused: false, until: null }, shortcut: null })
    expect(ids(m)).toEqual(['open', 'quickbox', 'capture-pause', 'quit'])
    expect(m[0]).toMatchObject({ label: 'Open Navalia', enabled: true })
    expect(m.find((i) => i.kind === 'info')).toEqual({ kind: 'info', label: 'Capture: running' })
    expect(m.find((i) => i.kind === 'action' && i.id === 'quickbox')).not.toHaveProperty('accelerator')
  })

  it('paused capture → 恢复采集; shortcut hint shown', () => {
    const m = buildTrayMenuModel({
      capture: { started: true, paused: true, until: '2026-11-06T00:00:00.000Z' },
      shortcut: 'CommandOrControl+Shift+Space'
    })
    expect(ids(m)).toEqual(['open', 'quickbox', 'capture-resume', 'quit'])
    expect(m.find((i) => i.kind === 'action' && i.id === 'quickbox')).toMatchObject({
      accelerator: 'CommandOrControl+Shift+Space'
    })
    expect(captureLine({ started: true, paused: true, until: null })).toBe('Capture: paused')
  })

  it('unknown capture status disables pause; inactive capture can still be paused', () => {
    const unknown = buildTrayMenuModel({ capture: { started: null, paused: false, until: null }, shortcut: null })
    expect(unknown.find((i) => i.kind === 'action' && i.id === 'capture-pause')).toMatchObject({ enabled: false })
    const inactive = buildTrayMenuModel({ capture: { started: false, paused: false, until: null }, shortcut: null })
    expect(inactive.find((i) => i.kind === 'info')).toEqual({ kind: 'info', label: 'Capture: off' })
    expect(inactive.find((i) => i.kind === 'action' && i.id === 'capture-pause')).toMatchObject({ enabled: true })
  })

  it('glyph: ◐ shape in alpha only, colour channels zero', () => {
    const size = 32
    const g = renderTrayGlyph(size)
    expect(g.length).toBe(size * size * 4)
    const a = (x: number, y: number) => g[(y * size + x) * 4 + 3]
    expect(a(0, 0)).toBe(0) // corner
    expect(a(10, 16)).toBe(255) // left half filled
    expect(a(22, 16)).toBe(0) // right half hollow
    expect(a(16 + 13, 16)).toBeGreaterThan(128) // right ring
    for (let i = 0; i < g.length; i += 4) expect(g[i] | g[i + 1] | g[i + 2]).toBe(0)
    expect(() => renderTrayGlyph(4)).toThrow()
  })
})
