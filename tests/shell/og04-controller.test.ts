// OG-04 controller + IPC + Quick Box window config, with fakes. No real Electron objects,
// no real Lens Store (settings are kept in memory), no network.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  screen: {},
  shell: { openExternal: async () => undefined },
  ipcMain: { handle: () => undefined },
  net: { fetch: async () => new Response('') },
  protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined }
}))

const { createShellController, residentDecision } = await import('../../src/main/shell/controller')
const { registerShellIpc } = await import('../../src/main/shell/ipc')
const { quickBoxPosition, quickBoxUrl, quickBoxWindowOptions } = await import('../../src/main/shell/quickbox')
const { SHELL_CHANNELS, SHELL_NAVIGATE_EVENT } = await import('../../src/main/shell/api')
const { DEFAULT_SHELL_SETTINGS } = await import('../../src/main/shell/settings')
type ShellSettings = import('../../src/main/shell/api').ShellSettings
type TrayMenuItem = import('../../src/main/shell/trayModel').TrayMenuItem

class FakeWindow {
  destroyed = false
  visible = true
  minimized = false
  focused = true
  loading = false
  calls: string[] = []
  sent: unknown[][] = []
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  private loadListeners: Array<() => void> = []
  webContents = {
    isLoading: () => this.loading,
    once: (_e: string, fn: () => void) => void this.loadListeners.push(fn),
    send: (...a: unknown[]) => void this.sent.push(a)
  }
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isMinimized = () => this.minimized
  isFocused = () => this.focused
  restore = () => void ((this.minimized = false), this.calls.push('restore'))
  show = () => void ((this.visible = true), this.calls.push('show'))
  hide = () => void ((this.visible = false), this.calls.push('hide'))
  focus = () => void this.calls.push('focus')
  on(event: string, fn: (...a: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
    return this
  }
  /** Simulate the user closing the window; returns true if it was prevented. */
  userClose(): boolean {
    let prevented = false
    for (const fn of this.listeners.get('close') ?? []) fn({ preventDefault: () => (prevented = true) })
    if (!prevented) this.close()
    return prevented
  }
  close = () => {
    if (this.destroyed) return
    this.destroyed = true
    this.calls.push('close')
    for (const fn of this.listeners.get('closed') ?? []) fn()
  }
  finishLoad() {
    this.loading = false
    for (const fn of this.loadListeners.splice(0)) fn()
  }
}

function setup(opts: { initial?: Partial<ShellSettings>; registerOk?: boolean; trayThrows?: boolean; captureStarted?: boolean } = {}) {
  let stored: ShellSettings = { ...DEFAULT_SHELL_SETTINGS, ...opts.initial }
  const writes: ShellSettings[] = []
  const trays: Array<{ destroyed: boolean; tooltip: string; handlers: Map<string, () => void>; popped: unknown[] }> = []
  const registered = new Map<string, () => void>()
  const shortcutLog: string[] = []
  const captureLog: string[] = []
  let paused = false
  const mains: FakeWindow[] = []
  const boxes: FakeWindow[] = []
  let quits = 0
  let lastMenu: { items: TrayMenuItem[]; onAction: (id: never) => void } | null = null
  const controller = createShellController({
    readSettings: () => ({ settings: { ...stored }, error: null }),
    writeSettings: (s) => {
      writes.push(s)
      stored = s
      return s
    },
    createTray: () => {
      if (opts.trayThrows) throw new Error('no status area')
      const t = { destroyed: false, tooltip: '', handlers: new Map<string, () => void>(), popped: [] as unknown[] }
      trays.push(t)
      return {
        setToolTip: (s: string) => void (t.tooltip = s),
        on: (e: string, fn: () => void) => void t.handlers.set(e, fn),
        popUpContextMenu: (m: unknown) => void t.popped.push(m),
        destroy: () => void (t.destroyed = true)
      }
    },
    buildMenu: (items, onAction) => {
      lastMenu = { items, onAction: onAction as never }
      return { items }
    },
    shortcuts: {
      register: (acc, cb) => {
        shortcutLog.push(`register:${acc}`)
        if (opts.registerOk === false) return false
        registered.set(acc, cb)
        return true
      },
      unregister: (acc) => {
        shortcutLog.push(`unregister:${acc}`)
        registered.delete(acc)
      }
    },
    createMainWindow: () => {
      const w = new FakeWindow()
      w.loading = true
      mains.push(w)
      return w
    },
    createQuickBoxWindow: () => {
      const w = new FakeWindow()
      boxes.push(w)
      return w
    },
    capture: {
      status: () => ({ started: opts.captureStarted ?? true, pause: { paused, until: null } }),
      pause: (m) => void (captureLog.push(`pause:${m}`), (paused = true)),
      resume: () => void (captureLog.push('resume'), (paused = false))
    },
    quit: () => void quits++
  })
  return {
    controller,
    writes,
    trays,
    registered,
    shortcutLog,
    captureLog,
    mains,
    boxes,
    quits: () => quits,
    menu: () => lastMenu,
    stored: () => stored
  }
}

describe('shell controller: defaults', () => {
  it('creates nothing and registers nothing with default settings', () => {
    const t = setup()
    const s = t.controller.state()
    expect(s.settings).toEqual(DEFAULT_SHELL_SETTINGS)
    expect(s.tray).toEqual({ active: false, error: null })
    expect(s.shortcut.state).toBe('off')
    expect(s.resident.effective).toBe(false)
    expect(t.trays).toHaveLength(0)
    expect(t.shortcutLog).toEqual([])
    expect(t.boxes).toHaveLength(0)
    expect(t.writes).toEqual([])
  })

  it('restores persisted toggles at startup', () => {
    const t = setup({ initial: { trayEnabled: true, shortcutEnabled: true } })
    expect(t.trays).toHaveLength(1)
    expect(t.shortcutLog).toEqual(['register:CommandOrControl+Shift+Space'])
    expect(t.controller.state().shortcut.state).toBe('registered')
  })
})

describe('shell controller: tray', () => {
  it('toggle on creates, toggle off destroys', () => {
    const t = setup()
    t.controller.update((s) => ({ ...s, trayEnabled: true }))
    expect(t.trays).toHaveLength(1)
    expect(t.trays[0].tooltip).toBe('Navalia')
    expect(t.controller.state().tray.active).toBe(true)
    t.controller.update((s) => ({ ...s, trayEnabled: false }))
    expect(t.trays[0].destroyed).toBe(true)
    expect(t.controller.state().tray.active).toBe(false)
    expect(t.writes.map((w) => w.trayEnabled)).toEqual([true, false])
  })

  it('tray creation failure is reported, not hidden', () => {
    const t = setup({ trayThrows: true })
    const s = t.controller.update((x) => ({ ...x, trayEnabled: true }))
    expect(s.tray.active).toBe(false)
    expect(s.tray.error).toMatch(/no status area/)
    expect(s.resident.effective).toBe(false)
  })

  it('click builds the menu from live capture state; pause/resume reuse the capture API', () => {
    const t = setup({ initial: { trayEnabled: true } })
    t.trays[0].handlers.get('click')!()
    const ids1 = t.menu()!.items.flatMap((i) => (i.kind === 'action' ? [i.id] : []))
    expect(ids1).toContain('capture-pause')
    t.menu()!.onAction('capture-pause' as never)
    expect(t.captureLog).toEqual(['pause:now'])
    t.trays[0].handlers.get('right-click')!()
    const ids2 = t.menu()!.items.flatMap((i) => (i.kind === 'action' ? [i.id] : []))
    expect(ids2).toContain('capture-resume')
    t.controller.trayAction('capture-resume')
    expect(t.captureLog).toEqual(['pause:now', 'resume'])
    expect(t.trays[0].popped).toHaveLength(2)
  })

  it('open / quickbox / quit actions', () => {
    const t = setup({ initial: { trayEnabled: true } })
    t.controller.trayAction('open')
    expect(t.mains).toHaveLength(1)
    t.controller.trayAction('quickbox')
    expect(t.boxes).toHaveLength(1)
    t.controller.trayAction('quit')
    expect(t.quits()).toBe(1)
  })
})

describe('shell controller: global shortcut', () => {
  it('registers, re-registers on change, unregisters on disable and on dispose', () => {
    const t = setup()
    t.controller.update((s) => ({ ...s, shortcutEnabled: true }))
    expect(t.controller.state().shortcut).toEqual({ state: 'registered', accelerator: 'CommandOrControl+Shift+Space', message: null })
    t.controller.update((s) => ({ ...s, shortcutAccelerator: 'Alt+Shift+K' }))
    expect(t.shortcutLog).toEqual([
      'register:CommandOrControl+Shift+Space',
      'unregister:CommandOrControl+Shift+Space',
      'register:Alt+Shift+K'
    ])
    t.controller.update((s) => ({ ...s, shortcutEnabled: false }))
    expect(t.registered.size).toBe(0)
    expect(t.controller.state().shortcut.state).toBe('off')
    t.controller.update((s) => ({ ...s, shortcutEnabled: true }))
    t.controller.dispose()
    expect(t.registered.size).toBe(0)
    expect(t.shortcutLog.at(-1)).toBe('unregister:Alt+Shift+K')
  })

  it('registration failure is reported honestly and keeps the user choice', () => {
    const t = setup({ registerOk: false })
    const s = t.controller.update((x) => ({ ...x, shortcutEnabled: true }))
    expect(s.shortcut.state).toBe('failed')
    expect(s.shortcut.message).toMatch(/taken by the system/)
    expect(s.settings.shortcutEnabled).toBe(true)
    t.controller.dispose()
    expect(t.shortcutLog.filter((l) => l.startsWith('unregister'))).toEqual([])
  })

  it('the shortcut toggles Quick Box', () => {
    const t = setup({ initial: { shortcutEnabled: true } })
    const fire = t.registered.get('CommandOrControl+Shift+Space')!
    fire()
    expect(t.boxes).toHaveLength(1)
    fire() // visible + focused → close
    expect(t.boxes[0].destroyed).toBe(true)
    fire()
    expect(t.boxes).toHaveLength(2)
    t.boxes[1].focused = false
    fire() // open but not focused → bring to front, no new window
    expect(t.boxes).toHaveLength(2)
    expect(t.boxes[1].calls).toContain('focus')
  })

  it('a corrupt stored accelerator never reaches register()', () => {
    const t = setup({ initial: { shortcutEnabled: true, shortcutAccelerator: 'Shift+A' } })
    expect(t.shortcutLog).toEqual([])
    expect(t.controller.state().shortcut.state).toBe('failed')
  })
})

describe('shell controller: residency', () => {
  it('residentDecision requires both the toggle and a visible tray', () => {
    expect(residentDecision(DEFAULT_SHELL_SETTINGS, true).effective).toBe(false)
    expect(residentDecision({ ...DEFAULT_SHELL_SETTINGS, keepResidentOnClose: true }, false).effective).toBe(false)
    expect(residentDecision({ ...DEFAULT_SHELL_SETTINGS, keepResidentOnClose: true }, true).effective).toBe(true)
  })

  it('default: closing the main window really closes it', () => {
    const t = setup()
    const w = t.controller.attachMainWindow(new FakeWindow())
    expect(w.userClose()).toBe(false)
    expect(w.destroyed).toBe(true)
  })

  it('keep-resident without tray does nothing (no invisible residency)', () => {
    const t = setup({ initial: { keepResidentOnClose: true } })
    const w = t.controller.attachMainWindow(new FakeWindow())
    expect(w.userClose()).toBe(false)
  })

  it('keep-resident + tray hides on close; quitting still closes; tray off reveals the window', () => {
    const t = setup({ initial: { keepResidentOnClose: true, trayEnabled: true } })
    const w = t.controller.attachMainWindow(new FakeWindow())
    expect(w.userClose()).toBe(true)
    expect(w.visible).toBe(false)
    t.controller.update((s) => ({ ...s, trayEnabled: false }))
    expect(w.visible).toBe(true)
    t.controller.update((s) => ({ ...s, trayEnabled: true }))
    t.controller.markQuitting()
    expect(w.userClose()).toBe(false)
  })

  it('onActivate creates a main window when none, shows a hidden one otherwise', () => {
    const t = setup()
    t.controller.onActivate()
    expect(t.mains).toHaveLength(1)
    t.mains[0].visible = false
    t.controller.onActivate()
    expect(t.mains).toHaveLength(1)
    expect(t.mains[0].visible).toBe(true)
  })
})

describe('shell controller: Quick Box → open page', () => {
  it('navigates the existing main window and closes Quick Box', () => {
    const t = setup()
    const w = t.controller.attachMainWindow(new FakeWindow())
    t.controller.openQuickBox()
    t.controller.openPage('capture')
    expect(w.sent).toEqual([[SHELL_NAVIGATE_EVENT, 'capture']])
    expect(w.calls).toContain('focus')
    expect(t.boxes[0].destroyed).toBe(true)
  })

  it('creates a main window if needed and waits for it to load before navigating', () => {
    const t = setup()
    t.controller.openPage('het')
    expect(t.mains).toHaveLength(1)
    expect(t.mains[0].sent).toEqual([])
    t.mains[0].finishLoad()
    expect(t.mains[0].sent).toEqual([[SHELL_NAVIGATE_EVENT, 'het']])
  })
})

describe('shell IPC', () => {
  function ipcSetup(clip = 'hello') {
    const t = setup()
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<unknown>>()
    let clipboardReads = 0
    registerShellIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, t.controller, {
      readClipboardText: () => (clipboardReads++, clip)
    })
    const invoke = (ch: string, raw?: unknown) => handlers.get(ch)!(null, raw) as Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>
    return { t, handlers, invoke, clipboardReads: () => clipboardReads }
  }

  it('registers exactly the declared channels and never reads the clipboard on registration', () => {
    const { handlers, clipboardReads } = ipcSetup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(SHELL_CHANNELS).sort())
    expect(clipboardReads()).toBe(0)
  })

  it('get / set validate with zod; invalid set writes nothing', async () => {
    const { t, invoke } = ipcSetup()
    expect(await invoke(SHELL_CHANNELS.get)).toMatchObject({ ok: true })
    expect(await invoke(SHELL_CHANNELS.get, { x: 1 })).toMatchObject({ ok: false })
    expect(await invoke(SHELL_CHANNELS.set, { patch: { shortcutAccelerator: 'Command+Q' } })).toMatchObject({ ok: false })
    expect(await invoke(SHELL_CHANNELS.set, { patch: { trayEnabled: 1 } })).toMatchObject({ ok: false })
    expect(await invoke(SHELL_CHANNELS.set, { patch: { evil: true } })).toMatchObject({ ok: false })
    expect(await invoke(SHELL_CHANNELS.set, { trayEnabled: true })).toMatchObject({ ok: false })
    expect(t.writes).toEqual([])
    const r = await invoke(SHELL_CHANNELS.set, { patch: { shortcutEnabled: true, shortcutAccelerator: 'alt+shift+j' } })
    expect(r).toMatchObject({ ok: true, data: { shortcut: { state: 'registered', accelerator: 'Alt+Shift+J' } } })
    expect(t.stored().shortcutAccelerator).toBe('Alt+Shift+J')
  })

  it('open-page accepts only known pages', async () => {
    const { t, invoke } = ipcSetup()
    expect(await invoke(SHELL_CHANNELS.openPage, { page: 'file:///etc/passwd' })).toMatchObject({ ok: false })
    expect(await invoke(SHELL_CHANNELS.openPage, { page: 'settings', extra: 1 })).toMatchObject({ ok: false })
    expect(t.mains).toHaveLength(0)
    expect(await invoke(SHELL_CHANNELS.openPage, { page: 'settings' })).toMatchObject({ ok: true })
    expect(t.mains).toHaveLength(1)
  })

  it('read-clipboard reads once per call and truncates', async () => {
    const { invoke, clipboardReads } = ipcSetup('x'.repeat(20_005))
    const r = (await invoke(SHELL_CHANNELS.readClipboard)) as { ok: true; data: { text: string; truncated: boolean } }
    expect(r.data.text.length).toBe(20_000)
    expect(r.data.truncated).toBe(true)
    expect(clipboardReads()).toBe(1)
    expect(await invoke(SHELL_CHANNELS.readClipboard, { all: true })).toMatchObject({ ok: false })
  })

  it('quickbox open / close', async () => {
    const { t, invoke } = ipcSetup()
    expect(await invoke(SHELL_CHANNELS.quickBoxOpen)).toMatchObject({ ok: true })
    expect(t.boxes).toHaveLength(1)
    expect(await invoke(SHELL_CHANNELS.quickBoxClose)).toMatchObject({ ok: true })
    expect(t.boxes[0].destroyed).toBe(true)
  })
})

describe('Quick Box window config', () => {
  it('has the same hardening as the main window', () => {
    const o = quickBoxWindowOptions('/x/preload/index.js')
    expect(o.webPreferences).toEqual({
      preload: '/x/preload/index.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
    expect(o).toMatchObject({ frame: false, alwaysOnTop: true, show: false, skipTaskbar: true })
  })

  it('loads the app document with #quickbox', () => {
    expect(quickBoxUrl(undefined)).toBe('app://lens/index.html#quickbox')
    expect(quickBoxUrl('http://localhost:5173/')).toBe('http://localhost:5173/#quickbox')
  })

  it('positions in the upper third of the work area', () => {
    expect(quickBoxPosition({ x: 0, y: 25, width: 1440, height: 875 })).toEqual({ x: 410, y: 139 })
    expect(quickBoxPosition({ x: 1440, y: 0, width: 600, height: 300 })).toEqual({ x: 1430, y: 0 })
  })
})

describe('tray menu template', () => {
  it('maps the pure model to Electron menu options; accelerator is display-only', async () => {
    const { toMenuTemplate } = await import('../../src/main/shell/main')
    const { buildTrayMenuModel } = await import('../../src/main/shell/trayModel')
    const fired: string[] = []
    const tpl = toMenuTemplate(
      buildTrayMenuModel({ capture: { started: true, paused: false, until: null }, shortcut: 'Alt+Shift+K' }),
      (id) => void fired.push(id)
    )
    expect(tpl.map((i) => i.type ?? i.label)).toEqual(['Open Navalia', 'Quick Box', 'separator', 'Capture: running', 'Pause capture', 'separator', 'Quit Navalia'])
    expect(tpl[1]).toMatchObject({ accelerator: 'Alt+Shift+K', registerAccelerator: false })
    expect(tpl[3]).toMatchObject({ enabled: false })
    ;(tpl[4].click as () => void)()
    ;(tpl[6].click as () => void)()
    expect(fired).toEqual(['capture-pause', 'quit'])
  })
})
