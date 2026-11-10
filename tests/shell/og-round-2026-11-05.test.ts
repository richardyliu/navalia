// OG round 2026-11-05: session permission handlers (OG1), Quick Box reduced preload + per-window
// IPC allowlist (OG8), fixed shell IPC error messages (OG9), native confirm helper (OG3 wiring).
// Fakes only: no real Electron session, window, clipboard or dialog.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const exposed: Record<string, unknown> = {}
const invoked: Array<{ channel: string; args: unknown[] }> = []
const dialogCalls: Array<{ parent: unknown; opts: Record<string, unknown> }> = []
let dialogResponse = 0
const windowsByContents = new Map<unknown, unknown>()

vi.mock('electron', () => ({
  app: { isPackaged: false, commandLine: { hasSwitch: () => false }, exit: () => undefined },
  net: { fetch: async () => new Response('') },
  protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  shell: { openExternal: async () => undefined },
  BrowserWindow: {
    fromWebContents: (wc: unknown) => windowsByContents.get(wc) ?? null,
    getFocusedWindow: () => null
  },
  dialog: {
    showMessageBox: async (a: unknown, b?: unknown) => {
      const [parent, opts] = b === undefined ? [null, a] : [a, b]
      dialogCalls.push({ parent, opts: opts as Record<string, unknown> })
      return { response: dialogResponse }
    }
  },
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void (exposed[key] = api) },
  ipcRenderer: { invoke: async (channel: string, ...args: unknown[]) => void invoked.push({ channel, args }) }
}))

const security = await import('../../src/main/security')
const { SHELL_CHANNELS } = await import('../../src/main/shell/api')
const { registerShellIpc, SHELL_ERROR_MESSAGES } = await import('../../src/main/shell/ipc')

const ROOT = path.resolve(__dirname, '../..')
const appFrame = { senderFrame: { url: 'app://lens/index.html#quickbox', parent: null }, sender: {} }

afterEach(() => {
  dialogCalls.length = 0
  invoked.length = 0
  dialogResponse = 0
})

describe('OG1: session permission handlers deny by default', () => {
  function fakeSession() {
    const h: Record<string, (...a: never[]) => unknown> = {}
    const ses = {
      setPermissionRequestHandler: (fn: never) => void (h.request = fn),
      setPermissionCheckHandler: (fn: never) => void (h.check = fn),
      setDevicePermissionHandler: (fn: never) => void (h.device = fn),
      setDisplayMediaRequestHandler: (fn: never) => void (h.display = fn)
    }
    security.installSessionPermissionHandlers(ses as never)
    return h as Record<string, (...a: unknown[]) => unknown>
  }

  test('request handler: only clipboard-sanitized-write is granted', () => {
    const h = fakeSession()
    const ask = (p: string) => {
      let granted: boolean | undefined
      h.request(null, p, (g: boolean) => (granted = g), {})
      return granted
    }
    for (const p of ['clipboard-read', 'media', 'display-capture', 'geolocation', 'notifications', 'openExternal', 'fileSystem', 'unknown', 'window-management']) {
      expect(ask(p)).toBe(false)
    }
    expect(ask('clipboard-sanitized-write')).toBe(true)
  })

  test('check handler matches the request handler', () => {
    const h = fakeSession()
    expect(h.check(null, 'clipboard-read', 'app://lens', {})).toBe(false)
    expect(h.check(null, 'deprecated-sync-clipboard-read', 'app://lens', {})).toBe(false)
    expect(h.check(null, 'media', 'app://lens', {})).toBe(false)
    expect(h.check(null, 'hid', 'app://lens', {})).toBe(false)
    expect(h.check(null, 'clipboard-sanitized-write', 'app://lens', {})).toBe(true)
  })

  test('device permissions and display media are always refused', () => {
    const h = fakeSession()
    expect(h.device({ deviceType: 'usb', origin: 'app://lens' })).toBe(false)
    let streams: unknown = 'unset'
    h.display({ frame: null }, (s: unknown) => (streams = s))
    expect(streams).toEqual({})
  })

  test('index.ts installs the handlers in whenReady before any window', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')
    const ready = src.indexOf('app.whenReady()')
    // S1-FULL C12: the call now also passes the meetings mic-arm state.
    const install = src.indexOf('installSessionPermissionHandlers(session.defaultSession')
    const firstWindow = src.indexOf('desktopShell.attachMainWindow(createWindow())')
    expect(ready).toBeGreaterThan(0)
    expect(install).toBeGreaterThan(ready)
    expect(install).toBeLessThan(firstWindow)
  })

  test('renderer never uses navigator.clipboard; mediaDevices only in the gated meetings recorder', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(tsx?|jsx?)$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8')
          const recorder = p.endsWith(path.join('components', 'meetings', 'recorder.ts'))
          if (/navigator\.clipboard/.test(src) || (!recorder && /navigator\.mediaDevices/.test(src))) offenders.push(p)
        }
      }
    }
    walk(path.join(ROOT, 'src/renderer'))
    expect(offenders).toEqual([])
  })
})

describe('OG8: Quick Box channel allowlist in the IPC sender guard', () => {
  test('senderMayInvoke: Quick Box limited to its six channels; read-clipboard is Quick Box only', () => {
    expect([...security.QUICKBOX_CHANNELS].sort()).toEqual(
      [SHELL_CHANNELS.quickBoxClose, SHELL_CHANNELS.openPage, SHELL_CHANNELS.readClipboard, 'lens:mcp:search', 'lens:mcp:remember', 'lens:i18n:get'].sort()
    )
    for (const ch of security.QUICKBOX_CHANNELS) expect(security.senderMayInvoke(ch, true)).toBe(true)
    for (const ch of ['lens:privacy:delete-run', 'lens:identity:reset', 'lens:mcp:correct', 'lens:app:copy', SHELL_CHANNELS.set, 'lens:recovery:confirm-run']) {
      expect(security.senderMayInvoke(ch, true)).toBe(false)
      expect(security.senderMayInvoke(ch, false)).toBe(true)
    }
    expect(security.senderMayInvoke(SHELL_CHANNELS.readClipboard, false)).toBe(false)
  })

  test('installed guard enforces it using the injected Quick Box check', async () => {
    security.installIpcSenderGuard()
    const quickBoxSender = { id: 'qb' }
    security.setQuickBoxSenderCheck((e) => (e as unknown as { sender: unknown }).sender === quickBoxSender)
    const { ipcMain } = await import('electron')
    ipcMain.handle(SHELL_CHANNELS.readClipboard, () => 'clip')
    ipcMain.handle('lens:mcp:search', () => 'hits')
    ipcMain.handle('lens:privacy:delete-run', () => 'deleted')
    const qb = { ...appFrame, sender: quickBoxSender }
    const main = { ...appFrame, senderFrame: { url: 'app://lens/index.html', parent: null }, sender: { id: 'main' } }
    expect(handlers.get(SHELL_CHANNELS.readClipboard)!(qb)).toBe('clip')
    expect(handlers.get('lens:mcp:search')!(qb)).toBe('hits')
    expect(() => handlers.get('lens:privacy:delete-run')!(qb)).toThrow(/sender is not the app/)
    expect(handlers.get('lens:privacy:delete-run')!(main)).toBe('deleted')
    expect(() => handlers.get(SHELL_CHANNELS.readClipboard)!(main)).toThrow(/sender is not the app/)
    // A throwing check fails towards "not Quick Box", which still cannot read the clipboard.
    security.setQuickBoxSenderCheck(() => {
      throw new Error('x')
    })
    expect(() => handlers.get(SHELL_CHANNELS.readClipboard)!(qb)).toThrow(/sender is not the app/)
    security.setQuickBoxSenderCheck(() => false)
  })
})

describe('OG8: reduced Quick Box preload', () => {
  test('exposes exactly shell.{closeQuickBox,openPage,readClipboard} + mcp.{search,remember} + i18n.get, same call shapes', async () => {
    const mod = await import('../../src/preload/quickbox')
    const api = exposed.lens as typeof mod.quickBoxApi
    expect(Object.keys(exposed)).toEqual(['lens'])
    expect(Object.keys(api).sort()).toEqual(['i18n', 'mcp', 'shell'])
    expect(Object.keys(api.i18n)).toEqual(['get'])
    expect(Object.keys(api.shell).sort()).toEqual(['closeQuickBox', 'openPage', 'readClipboard'])
    expect(Object.keys(api.mcp).sort()).toEqual(['remember', 'search'])
    await api.shell.closeQuickBox()
    await api.shell.openPage('settings')
    await api.shell.readClipboard()
    await api.mcp.search('q', 8)
    await api.mcp.remember('note', undefined)
    await api.i18n.get()
    expect(invoked).toEqual([
      { channel: SHELL_CHANNELS.quickBoxClose, args: [] },
      { channel: SHELL_CHANNELS.openPage, args: [{ page: 'settings' }] },
      { channel: SHELL_CHANNELS.readClipboard, args: [] },
      { channel: 'lens:mcp:search', args: [{ query: 'q', topK: 8 }] },
      { channel: 'lens:mcp:remember', args: [{ content: 'note', tags: undefined }] },
      { channel: 'lens:i18n:get', args: [] }
    ])
    // Literal channel names stay in sync with main's allowlist.
    expect(new Set(Object.values(mod.QUICKBOX_PRELOAD_CHANNELS))).toEqual(new Set(security.QUICKBOX_CHANNELS))
  })

  test('preload imports nothing local at runtime (sandboxed preload cannot require a shared chunk)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/preload/quickbox.ts'), 'utf8')
    const runtimeImports = [...src.matchAll(/^import (?!type )[^\n]* from '([^']+)'/gm)].map((m) => m[1])
    expect(runtimeImports).toEqual(['electron'])
  })

  test('Quick Box window loads preload/quickbox.js; build config has the entry', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/main/shell/quickbox.ts'), 'utf8')).toContain("'../preload/quickbox.js'")
    const cfg = fs.readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(cfg).toContain("quickbox: resolve(__dirname, 'src/preload/quickbox.ts')")
    expect(cfg).toContain('isolatedEntries: true')
  })

  test('the Quick Box component only uses what the reduced preload exposes', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/quickbox/QuickBox.tsx'), 'utf8')
    const direct = new Set([...src.matchAll(/window\.lens\.(\w+)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`))
    expect([...direct].every((k) => ['shell.closeQuickBox', 'shell.openPage', 'shell.readClipboard'].includes(k))).toBe(true)
    const viaApi = new Set([...src.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]))
    expect([...viaApi].sort()).toEqual(['remember', 'search'])
  })
})

describe('OG9: shell IPC returns fixed messages, never raw error text', () => {
  test('controller / clipboard failures map to fixed Chinese messages', async () => {
    const raw = "EACCES: permission denied, open '/Users/alice/Library/Application Support/Navalia/shell-settings.json'"
    const h = new Map<string, (e: unknown, raw?: unknown) => Promise<{ ok: boolean; error?: { message: string } }>>()
    const boom = () => {
      throw new Error(raw)
    }
    registerShellIpc({ handle: (ch: string, fn: never) => void h.set(ch, fn) } as never, { state: boom, update: boom, openQuickBox: boom, closeQuickBox: boom, openPage: boom } as never, {
      readClipboardText: boom
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cases: Array<[string, unknown, string]> = [
      [SHELL_CHANNELS.get, undefined, SHELL_ERROR_MESSAGES.get],
      [SHELL_CHANNELS.set, { patch: {} }, SHELL_ERROR_MESSAGES.set],
      [SHELL_CHANNELS.quickBoxOpen, undefined, SHELL_ERROR_MESSAGES.quickBoxOpen],
      [SHELL_CHANNELS.quickBoxClose, undefined, SHELL_ERROR_MESSAGES.quickBoxClose],
      [SHELL_CHANNELS.openPage, { page: 'settings' }, SHELL_ERROR_MESSAGES.openPage],
      [SHELL_CHANNELS.readClipboard, undefined, SHELL_ERROR_MESSAGES.readClipboard]
    ]
    for (const [ch, args, msg] of cases) {
      const r = await h.get(ch)!(null, args)
      expect(r).toEqual({ ok: false, error: { code: 'unknown', message: msg } })
      expect(JSON.stringify(r)).not.toContain('/Users/')
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/')
    warn.mockRestore()
  })
})

describe('OG3: nativeConfirm (main-owned destructive dialog)', () => {
  test('Cancel is default + cancelId, parented to the sender window; only button 1 confirms', async () => {
    const sender = { id: 1 }
    const win = { id: 'win' }
    windowsByContents.set(sender, win)
    dialogResponse = 0
    expect(await security.nativeConfirm(sender as never, { message: 'm', detail: 'd', confirmLabel: '删除' })).toBe(false)
    dialogResponse = 1
    expect(await security.nativeConfirm(sender as never, { message: 'm', detail: 'd', confirmLabel: '删除' })).toBe(true)
    expect(dialogCalls[0].parent).toBe(win)
    expect(dialogCalls[0].opts).toMatchObject({ buttons: ['Cancel', '删除'], defaultId: 0, cancelId: 0, type: 'warning', message: 'm', detail: 'd' })
  })

  test('index.ts wires privacy to nativeConfirm', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')
    expect(src).toMatch(/nativeConfirm: \(sender, opts\) => nativeConfirm\(/)
  })
})
