import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { micCheckDecision, micPermissionDecision } from './cloud/meetings-mic-gate'
import { tr } from '../shared/i18n'

/**
 * Trust boundary helpers for the Electron shell.
 *
 * - Only the app's own renderer document may navigate, open, or call IPC.
 * - Every `ipcMain.handle` registered after `installIpcSenderGuard()` rejects
 *   calls whose sender frame is not the app document (e.g. a dropped local
 *   .html file that the preload would otherwise also run on).
 */

/** Packaged/built renderer is served from `app://lens/` (lets the GrantFileProtocolExtraPrivileges fuse stay off). */
export const APP_SCHEME = 'app'
export const APP_HOST = 'lens'
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

function rendererRoot(): string {
  return path.join(__dirname, '../renderer')
}

/** Must run before `app` is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** Resolve an `app://lens/...` URL to a file inside the renderer dir, or null if it escapes it. */
export function resolveAppPath(url: string, root = rendererRoot()): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  const file = path.normalize(path.join(root, pathname))
  if (!file.startsWith(root + path.sep)) return null
  return file
}

/** Must run after `app` is ready, before the first window loads. */
export function handleAppProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const file = resolveAppPath(request.url)
    if (!file) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port']

/** Packaged builds refuse Chromium/Node debugging switches (fuses do not cover Chromium switches). */
export function refuseDebugSwitchesWhenPackaged(): void {
  if (!app.isPackaged) return
  for (const sw of DEBUG_SWITCHES) {
    if (app.commandLine.hasSwitch(sw)) {
      console.error(`[lens] refusing --${sw} in a packaged build`)
      app.exit(1)
      return
    }
  }
}

/** Test-only env overrides that must not redirect a packaged build's agent configs, transcript roots, or ports. */
// NAVALIA_NATIVE would load an arbitrary .node into main, defeating the fuses.
const TEST_ONLY_ENV = ['NAVALIA_NATIVE', 'LENS_AGENT_HOME', 'LENS_AGENT_APPS', 'LENS_HET_CLAUDE_ROOT', 'LENS_HET_CODEX_ROOT', 'LENS_BROKER_PORT', 'LENS_E2E_SAVE_DIR', 'LENS_HET_FAKE_ASSESSOR', 'LENS_IMPORT_HOME', 'LENS_E2E_OPEN_FILE', 'LENS_E2E_PICK_DIR']

export function stripTestOverridesWhenPackaged(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): void {
  if (!packaged) return
  for (const key of TEST_ONLY_ENV) delete env[key]
}

/** True when `url` is the app's own renderer document (dev server or packaged file). */
export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      return new URL(url).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST
  } catch {
    return false
  }
}

export class UntrustedSenderError extends Error {
  constructor(channel: string) {
    super(`IPC ${channel} rejected: sender is not the app renderer`)
    this.name = 'UntrustedSenderError'
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame) return false
  // Only the top-level frame of the app document; never subframes.
  if (frame.parent) return false
  return isAppUrl(frame.url)
}

/**
 * OG8: the Quick Box window gets a reduced preload and may invoke only these channels. Every
 * other channel rejects a Quick Box sender even though it loads the same app document.
 */
export const QUICKBOX_CHANNELS: ReadonlySet<string> = new Set([
  'lens:shell:quickbox-close',
  'lens:i18n:get',
  'lens:shell:open-page',
  'lens:shell:read-clipboard',
  'lens:mcp:search',
  'lens:mcp:remember'
])

/** Channels only a Quick Box sender may invoke (the main window has no clipboard read path). */
export const QUICKBOX_ONLY_CHANNELS: ReadonlySet<string> = new Set(['lens:shell:read-clipboard'])

let quickBoxSenderCheck: (event: IpcMainInvokeEvent) => boolean = () => false

/** Wired by the shell plane: true when the event comes from a Quick Box window. */
export function setQuickBoxSenderCheck(check: (event: IpcMainInvokeEvent) => boolean): void {
  quickBoxSenderCheck = check
}

/** Per-window channel allowlist on top of the app-document check. */
export function senderMayInvoke(channel: string, isQuickBox: boolean): boolean {
  if (isQuickBox) return QUICKBOX_CHANNELS.has(channel)
  return !QUICKBOX_ONLY_CHANNELS.has(channel)
}

let guardInstalled = false

/**
 * Wrap `ipcMain.handle` so every handler registered afterwards checks the sender.
 * Must be called before any plane registers its IPC.
 */
export function installIpcSenderGuard(): void {
  if (guardInstalled) return
  guardInstalled = true
  const rawHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    rawHandle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new UntrustedSenderError(channel)
      let quickBox = false
      try {
        quickBox = quickBoxSenderCheck(event)
      } catch {
        quickBox = false
      }
      if (!senderMayInvoke(channel, quickBox)) throw new UntrustedSenderError(channel)
      return listener(event, ...args)
    })) as typeof ipcMain.handle
}

/** Open only plain https URLs without embedded credentials. Everything else is dropped. */
export function safeOpenExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'https:') return
  if (parsed.username || parsed.password) return
  void shell.openExternal(parsed.href)
}

/** OG1: the only web permission the renderer may hold. Peers copies via main, so this is belt-and-braces. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

export function permissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

type PermissionSession = Pick<
  Session,
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler' | 'setDisplayMediaRequestHandler'
>

/**
 * OG1: Electron grants every web permission by default. Deny all (clipboard read, camera / mic,
 * screen capture, geolocation, notifications, HID / USB / serial, ...) except sanitized clipboard
 * write. Must run after `ready`, before the first window loads.
 */
export function installSessionPermissionHandlers(ses: PermissionSession, opts: { micArmed?: () => boolean } = {}): void {
  // S1-FULL C12: the only media exception is audio-only, from the app document, while a consented meeting is armed.
  const armed = (): boolean => {
    try {
      return opts.micArmed?.() === true
    } catch {
      return false
    }
  }
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'media') {
      const d = details as { mediaTypes?: unknown[]; requestingUrl?: string }
      return callback(micPermissionDecision({ permission, mediaTypes: d?.mediaTypes, requestingUrl: d?.requestingUrl, isAppUrl, armed: armed() }))
    }
    callback(permissionAllowed(permission))
  })
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission === 'media') {
      return micCheckDecision({ permission, mediaType: (details as { mediaType?: unknown })?.mediaType, requestingOrigin, isAppUrl, armed: armed() })
    }
    return permissionAllowed(permission)
  })
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    try {
      // No video / audio stream = getDisplayMedia rejects in the page.
      callback({})
    } catch {
      // nothing granted either way
    }
  })
}

export interface NativeConfirmOptions {
  message: string
  detail: string
  /** Label of the destructive button; Cancel is always the default and the cancel button. */
  confirmLabel: string
}

/**
 * Main-owned confirmation for destructive actions (same shape as identity reset, security
 * review #9): Cancel is default + cancelId, parented to the sender's window. The renderer
 * cannot answer it, so a compromised page cannot complete a destructive flow on its own.
 */
export async function nativeConfirm(sender: WebContents | null | undefined, opts: NativeConfirmOptions): Promise<boolean> {
  const box = {
    type: 'warning' as const,
    buttons: [tr('Cancel', '取消'), opts.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: opts.message,
    detail: opts.detail
  }
  const parent = (sender ? BrowserWindow.fromWebContents(sender) : null) ?? BrowserWindow.getFocusedWindow()
  const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box)
  return response === 1
}
