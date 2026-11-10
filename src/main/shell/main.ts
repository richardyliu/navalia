// OG-04 production wiring: real Electron objects → ShellController. Thin on purpose; the logic
// lives in controller.ts / trayModel.ts / settings.ts / accelerator.ts and is unit-tested there.
import {
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type BrowserWindow,
  type MenuItemConstructorOptions
} from 'electron'
import { createShellController, type CaptureControl, type ShellController } from './controller'
import { registerShellIpc } from './ipc'
import { createQuickBoxWindow } from './quickbox'
import { readShellSettings, shellSettingsFile, writeShellSettings } from './settings'
import { renderTrayGlyph, type TrayAction, type TrayMenuItem } from './trayModel'

export function toMenuTemplate(items: TrayMenuItem[], onAction: (id: TrayAction) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.kind === 'separator') return { type: 'separator' }
    if (item.kind === 'info') return { label: item.label, enabled: false }
    return {
      label: item.label,
      enabled: item.enabled,
      // Display hint only: the real binding is the global shortcut, not a menu accelerator.
      ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
      click: () => onAction(item.id)
    }
  })
}

function trayImage(): Electron.NativeImage {
  // 16pt template icon rendered at 2x (32px) from the ◐ brand mark; no binary asset needed.
  const img = nativeImage.createFromBitmap(renderTrayGlyph(32), { width: 32, height: 32, scaleFactor: 2 })
  img.setTemplateImage(true)
  return img
}

export interface SetupShellDeps {
  storeRoot: string
  createMainWindow(): BrowserWindow
  capture: CaptureControl | null
}

/** Call once after `ready`, before the first main window is created. */
export function setupShell(deps: SetupShellDeps): ShellController {
  const file = shellSettingsFile(deps.storeRoot)
  const controller = createShellController({
    readSettings: () => readShellSettings(file),
    writeSettings: (s) => writeShellSettings(file, s),
    createTray: () => new Tray(trayImage()),
    buildMenu: (items, onAction) => Menu.buildFromTemplate(toMenuTemplate(items, onAction)),
    shortcuts: globalShortcut,
    createMainWindow: deps.createMainWindow,
    createQuickBoxWindow,
    capture: deps.capture,
    quit: () => app.quit(),
    log: (m) => console.warn(m)
  })
  registerShellIpc(ipcMain, controller, { readClipboardText: () => clipboard.readText() })
  app.on('before-quit', () => controller.markQuitting())
  app.on('will-quit', () => controller.dispose())
  return controller
}
