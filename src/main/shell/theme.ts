// Window background that matches the renderer's --bg token, so there is no light/dark flash before
// first paint and the window follows a live macOS appearance switch. Values mirror styles/app.css.
import * as electron from 'electron'

export const WINDOW_BG = { light: '#f5f2eb', dark: '#1c1b18' } as const

function nativeTheme(): Electron.NativeTheme | undefined {
  // A namespace read inside try: unit-test mocks of 'electron' may not define nativeTheme.
  try {
    return electron.nativeTheme
  } catch {
    return undefined
  }
}

export function windowBackground(): string {
  return nativeTheme()?.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light
}

let tracking = false

/** Re-tint every open window when the system appearance changes. Idempotent. */
export function trackWindowBackgrounds(): void {
  const theme = nativeTheme()
  if (tracking || !theme) return
  tracking = true
  theme.on('updated', () => {
    const color = windowBackground()
    for (const win of electron.BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(color)
    }
  })
}
