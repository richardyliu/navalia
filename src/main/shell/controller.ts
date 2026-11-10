// OG-04 shell controller: applies ShellSettings to the menu bar Tray, the global shortcut, the
// Quick Box window and main-window residency. Electron objects are injected through the minimal
// interfaces below, so this file is unit-testable with fakes (see tests/shell/og04-controller.test.ts).
//
// Invariants:
// - Nothing is created at startup unless the user turned it on (all defaults off).
// - The app never becomes invisibly resident: close→hide only while the tray icon is actually
//   visible; if the tray goes away, a hidden main window is shown again.
// - Registration failures are reported in ShellState, never swallowed.
import { validateAccelerator } from './accelerator'
import type { QuickOpenPage, ShellSettings, ShellState, ShortcutStatus } from './api'
import { SHELL_NAVIGATE_EVENT } from './api'
import { buildTrayMenuModel, type TrayAction, type TrayCaptureState, type TrayMenuItem } from './trayModel'
import { tr } from '../../shared/i18n'

export interface WindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  restore(): void
  show(): void
  hide(): void
  focus(): void
  close(): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  on(event: 'closed', listener: () => void): unknown
  webContents: {
    isLoading(): boolean
    once(event: 'did-finish-load', listener: () => void): unknown
    send(channel: string, ...args: unknown[]): void
  }
}

export interface TrayLike {
  setToolTip(text: string): void
  on(event: 'click' | 'right-click', listener: () => void): unknown
  popUpContextMenu(menu: unknown): void
  destroy(): void
}

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface CaptureControl {
  status(): { started: boolean; pause: { paused: boolean; until: string | null } }
  pause(mode: 'now'): unknown
  resume(): unknown
}

export interface ShellControllerDeps {
  readSettings(): { settings: ShellSettings; error: string | null }
  writeSettings(settings: ShellSettings): ShellSettings
  createTray(): TrayLike
  /** Turns a pure menu model into a native menu (Menu.buildFromTemplate in production). */
  buildMenu(items: TrayMenuItem[], onAction: (id: TrayAction) => void): unknown
  shortcuts: ShortcutRegistry
  createMainWindow(): WindowLike
  createQuickBoxWindow(): WindowLike
  capture: CaptureControl | null
  quit(): void
  log?(message: string): void
}

export function residentDecision(settings: ShellSettings, trayActive: boolean): ShellState['resident'] {
  if (!settings.keepResidentOnClose) return { effective: false, reason: tr('Closing the window uses the system default', '关闭窗口按系统默认处理') }
  if (!trayActive) return { effective: false, reason: tr("Turn on the menu bar icon first: Navalia won't stay resident without a visible entry point", '需要先开启菜单栏图标：没有可见入口时不会常驻') }
  return { effective: true, reason: tr('Closing the main window only hides it; reopen it from the menu bar icon', '关闭主窗口只隐藏，可从菜单栏图标重新打开') }
}

export interface ShellController {
  state(): ShellState
  /** Validate + persist a patch, then re-apply. Throws (ZodError) on invalid input; nothing is written. */
  update(apply: (current: ShellSettings) => ShellSettings): ShellState
  attachMainWindow<W extends WindowLike>(win: W): W
  /** Existing main window (shown + focused) or a newly created one. */
  showMainWindow(): WindowLike
  /** Dock click / app re-activation. */
  onActivate(): void
  openPage(page: QuickOpenPage): void
  openQuickBox(): void
  closeQuickBox(): void
  toggleQuickBox(): void
  trayAction(id: TrayAction): void
  /** C17: extra proactive tray items + their action handler. */
  setExtraTrayMenu(items: () => TrayMenuItem[], onAction: (id: 'proactive_open_log' | 'proactive_pause_all') => void): void
  markQuitting(): void
  /** will-quit: unregister the global shortcut, destroy the tray, close Quick Box. */
  dispose(): void
}

export function createShellController(deps: ShellControllerDeps): ShellController {
  const log = deps.log ?? (() => undefined)
  const initial = deps.readSettings()
  let settings = initial.settings
  const settingsError = initial.error
  let tray: TrayLike | null = null
  let trayError: string | null = null
  let registered: string | null = null
  let shortcut: ShortcutStatus = { state: 'off', accelerator: settings.shortcutAccelerator, message: null }
  let mainWin: WindowLike | null = null
  let quickBox: WindowLike | null = null
  let quitting = false

  const live = (w: WindowLike | null): w is WindowLike => w !== null && !w.isDestroyed()
  const resident = (): ShellState['resident'] => residentDecision(settings, tray !== null)

  function captureState(): TrayCaptureState {
    if (!deps.capture) return { started: null, paused: false, until: null }
    try {
      const s = deps.capture.status()
      return { started: s.started, paused: s.pause.paused, until: s.pause.until }
    } catch {
      return { started: null, paused: false, until: null }
    }
  }

  let extraMenu: (() => TrayMenuItem[]) | null = null
  let extraAction: ((id: 'proactive_open_log' | 'proactive_pause_all') => void) | null = null

  function popUpMenu(): void {
    if (!tray) return
    let extra: TrayMenuItem[] = []
    try {
      extra = extraMenu?.() ?? []
    } catch {
      extra = []
    }
    const model = buildTrayMenuModel({ capture: captureState(), shortcut: registered, extra })
    tray.popUpContextMenu(deps.buildMenu(model, (id) => controller.trayAction(id)))
  }

  function applyTray(): void {
    if (settings.trayEnabled && !tray) {
      try {
        const t = deps.createTray()
        t.setToolTip('Navalia')
        t.on('click', popUpMenu)
        t.on('right-click', popUpMenu)
        tray = t
        trayError = null
      } catch (error) {
        tray = null
        trayError = tr(`Cannot create the menu bar icon: ${(error as Error).message}`, `无法创建菜单栏图标：${(error as Error).message}`)
        log(`[shell] ${trayError}`)
      }
    } else if (!settings.trayEnabled) {
      if (tray) tray.destroy()
      tray = null
      trayError = null
    }
  }

  function applyShortcut(): void {
    const wanted = settings.shortcutEnabled ? settings.shortcutAccelerator : null
    if (registered && registered !== wanted) {
      try {
        deps.shortcuts.unregister(registered)
      } catch {
        // already gone
      }
      registered = null
    }
    if (!wanted) {
      shortcut = { state: 'off', accelerator: settings.shortcutAccelerator, message: null }
      return
    }
    if (registered === wanted) return
    const check = validateAccelerator(wanted)
    if (!check.ok) {
      shortcut = { state: 'failed', accelerator: wanted, message: check.reason }
      return
    }
    let ok = false
    let message = tr(
      'Registration failed: the shortcut may be taken by the system or another app. Try another combination.',
      '注册失败：快捷键可能已被系统或其他应用占用，请换一个组合'
    )
    try {
      ok = deps.shortcuts.register(check.accelerator, () => controller.toggleQuickBox())
    } catch (error) {
      message = tr(`Registration failed: ${(error as Error).message}`, `注册失败：${(error as Error).message}`)
    }
    if (ok) {
      registered = check.accelerator
      shortcut = { state: 'registered', accelerator: check.accelerator, message: null }
    } else {
      shortcut = { state: 'failed', accelerator: check.accelerator, message }
      log(`[shell] global shortcut ${check.accelerator}: ${message}`)
    }
  }

  function applyResidency(): void {
    // Never leave a hidden main window behind without a visible way back.
    if (!resident().effective && live(mainWin) && !mainWin.isVisible()) mainWin.show()
  }

  function applyAll(): void {
    applyTray()
    applyShortcut()
    applyResidency()
  }

  function sendNavigate(win: WindowLike, page: QuickOpenPage): void {
    const send = (): void => {
      if (!win.isDestroyed()) win.webContents.send(SHELL_NAVIGATE_EVENT, page)
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }

  const controller: ShellController = {
    state() {
      return {
        settings: { ...settings },
        tray: { active: tray !== null, error: trayError },
        shortcut: { ...shortcut },
        resident: resident(),
        settingsError
      }
    },
    update(apply) {
      const next = apply({ ...settings })
      settings = deps.writeSettings(next)
      applyAll()
      return controller.state()
    },
    attachMainWindow(win) {
      mainWin = win
      win.on('close', (event) => {
        if (quitting || !resident().effective) return
        event.preventDefault()
        win.hide()
      })
      win.on('closed', () => {
        if (mainWin === win) mainWin = null
      })
      return win
    },
    showMainWindow() {
      if (live(mainWin)) {
        if (mainWin.isMinimized()) mainWin.restore()
        mainWin.show()
        mainWin.focus()
        return mainWin
      }
      // New window shows itself on ready-to-show.
      return controller.attachMainWindow(deps.createMainWindow())
    },
    onActivate() {
      if (!live(mainWin)) controller.attachMainWindow(deps.createMainWindow())
      else if (!mainWin.isVisible()) mainWin.show()
    },
    openPage(page) {
      const win = controller.showMainWindow()
      sendNavigate(win, page)
      controller.closeQuickBox()
    },
    openQuickBox() {
      if (live(quickBox)) {
        quickBox.show()
        quickBox.focus()
        return
      }
      const win = deps.createQuickBoxWindow()
      quickBox = win
      win.on('closed', () => {
        if (quickBox === win) quickBox = null
      })
    },
    closeQuickBox() {
      if (live(quickBox)) quickBox.close()
      quickBox = null
    },
    toggleQuickBox() {
      if (live(quickBox) && quickBox.isVisible() && quickBox.isFocused()) controller.closeQuickBox()
      else controller.openQuickBox()
    },
    trayAction(id) {
      switch (id) {
        case 'open':
          controller.showMainWindow()
          return
        case 'quickbox':
          controller.openQuickBox()
          return
        case 'capture-pause':
          deps.capture?.pause('now')
          return
        case 'capture-resume':
          deps.capture?.resume()
          return
        case 'quit':
          quitting = true
          deps.quit()
          return
        case 'proactive_open_log':
        case 'proactive_pause_all':
          extraAction?.(id)
          return
      }
    },
    setExtraTrayMenu(items, onAction) {
      extraMenu = items
      extraAction = onAction
    },
    markQuitting() {
      quitting = true
    },
    dispose() {
      quitting = true
      if (registered) {
        try {
          deps.shortcuts.unregister(registered)
        } catch {
          // ignore
        }
        registered = null
      }
      if (tray) tray.destroy()
      tray = null
      controller.closeQuickBox()
    }
  }

  applyAll()
  return controller
}
