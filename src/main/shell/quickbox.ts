// OG-04 Quick Box window: small, frameless, always-on-top. Same hardening as the main window
// (contextIsolation, sandbox, no nodeIntegration, webSecurity, same app:// document and CSP,
// navigation + window.open denied). OG8: it loads a reduced preload (preload/quickbox.js) and the
// IPC sender guard limits Quick Box senders to QUICKBOX_CHANNELS (src/main/security.ts).
import path from 'node:path'
import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron'
import { APP_INDEX_URL, isAppUrl, safeOpenExternal } from '../security'
import { QUICKBOX_HASH } from './api'
import { windowBackground } from './theme'

export const QUICKBOX_SIZE = { width: 620, height: 420 } as const

const quickBoxIds = new Set<number>()

/** True for Quick Box windows. Main-window lookups (second-instance, activate) must skip these. */
export function isQuickBoxWindow(win: { id: number }): boolean {
  return quickBoxIds.has(win.id)
}

export function quickBoxUrl(devUrl: string | undefined): string {
  if (devUrl) {
    const u = new URL(devUrl)
    u.hash = QUICKBOX_HASH
    return u.toString()
  }
  return `${APP_INDEX_URL}${QUICKBOX_HASH}`
}

export function quickBoxWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    ...QUICKBOX_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'Quick Box',
    backgroundColor: windowBackground(),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  }
}

/** Horizontally centred, upper third of the work area of the display under the cursor. */
export function quickBoxPosition(
  workArea: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number } = QUICKBOX_SIZE
): { x: number; y: number } {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - size.height) / 4))
  }
}

export function createQuickBoxWindow(): BrowserWindow {
  const win = new BrowserWindow(quickBoxWindowOptions(path.join(__dirname, '../preload/quickbox.js')))
  quickBoxIds.add(win.id)
  const id = win.id
  win.on('closed', () => quickBoxIds.delete(id))
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const pos = quickBoxPosition(display.workArea)
    win.setPosition(pos.x, pos.y)
  } catch {
    win.center()
  }
  win.setAlwaysOnTop(true, 'floating')

  win.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  // Transient panel: losing focus dismisses it (Esc does too, from the renderer).
  win.on('blur', () => {
    if (!win.isDestroyed()) win.close()
  })

  void win.loadURL(quickBoxUrl(process.env.ELECTRON_RENDERER_URL))
  return win
}
