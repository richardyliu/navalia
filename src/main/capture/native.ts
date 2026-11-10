import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Options accepted by `axTree()`; names mirror mac-ax-helper's CLI flags. */
export interface AXTreeOptions {
  allVisible?: boolean // --all-visible
  appName?: string // --app-name NAME
  focusedWindowOnly?: boolean // --focused-window-only
  raw?: boolean // --raw
  maxDepth?: number // --depth N (0 = unlimited; helper default 100)
  timeout?: number // --timeout SECS (default 3)
  forceAppAccessibility?: boolean // false = --no-force-app-ax
}

export interface NativePermissions {
  accessibility: boolean
  screenRecording: boolean
}

export interface FrontmostApp {
  pid: number
  name: string | null
  bundleId: string | null
  bundlePath: string | null
  windowTitle: string | null
}

export interface NativeScreenshot {
  data: Buffer
  width: number
  height: number
  mimeType: 'image/jpeg'
  backend: 'screencapturekit' | 'cgwindowlist'
}

export interface NativeEvent {
  eventType: string
  pid: number
  appName: string
  bundleId: string
  /** Path of the app bundle that emitted the event. */
  bundlePath?: string
  windowTitle?: string
}

/** Surface of navalia-native.node (native/src/addon.mm). */
export interface LensNative {
  /** Resolves to the exact JSON text mac-ax-helper prints (minus trailing newline). */
  axTree(options?: AXTreeOptions): Promise<string>
  /** Test seam: same traversal/serialization fed by a recorded fixture. */
  _axTreeFromFixture(fixtureJson: string, options?: AXTreeOptions): string
  /** Non-prompting probe (AXIsProcessTrusted + CGPreflightScreenCaptureAccess). */
  permissions(): NativePermissions
  requestAccessibility(): boolean
  requestScreenRecording(): boolean
  /** SCShareableContent probe; registers the app in TCC. Only after explicit consent. */
  probeScreenRecording(): Promise<{ granted: boolean; displays: number }>
  frontmost(): FrontmostApp | null
  /**
   * Default scope is the frontmost window (only that window's pixels; never a
   * display fallback). `pid` pins the window owner the caller already vetted.
   */
  screenshot(options?: {
    scope?: 'display' | 'frontmostWindow'
    pid?: number
    maxWidth?: number
    quality?: number
  }): Promise<NativeScreenshot | null>
  /** AXURL of the focused window's web area (Accessibility only, no Apple Events). */
  browserUrl(pid?: number): string | null
  /** Bundle ids registered for http/https (LaunchServices; no permission). */
  urlHandlers(): string[]
  /** The bundle this process runs from (CFBundleIdentifier + path). */
  selfBundle(): { bundleId: string | null; bundlePath: string | null }
  observe(callback: (event: NativeEvent) => void): { accessibilityObservers: boolean }
  stopObserving(): void
}

export const NATIVE_FILENAME = 'navalia-native.node'

/**
 * Candidate locations, most specific first. `NAVALIA_NATIVE` is honoured
 * only when the caller opts in (dev/test): in a packaged app an env setter
 * must not be able to load an arbitrary .node into main (SECURITY R6; main
 * also strips the variable when packaged).
 */
export function nativeCandidates(appPath: string, resourcesPath?: string, allowEnvOverride = false): string[] {
  const out: string[] = []
  const override = allowEnvOverride ? process.env.NAVALIA_NATIVE?.trim() : undefined
  if (override) out.push(path.resolve(override))
  if (resourcesPath) out.push(path.join(resourcesPath, 'native', NATIVE_FILENAME))
  out.push(path.join(appPath, 'native', 'build', 'Release', NATIVE_FILENAME))
  return out
}

export interface NativeLoadResult {
  native: LensNative | null
  path: string | null
  error: string | null
}

/**
 * Load the addon in the main process. Never throws: a missing addon must not
 * stop the app from opening, but the reason must be visible.
 */
export function loadNative(
  appPath: string,
  resourcesPath?: string,
  options: { allowEnvOverride?: boolean } = {}
): NativeLoadResult {
  if (process.platform !== 'darwin') {
    return { native: null, path: null, error: 'native capture is macOS-only' }
  }
  const req = createRequire(path.join(appPath, 'package.json'))
  let lastError = 'navalia-native.node not found (run native/scripts/build.sh)'
  for (const candidate of nativeCandidates(appPath, resourcesPath, options.allowEnvOverride === true)) {
    if (!fs.existsSync(candidate)) continue
    try {
      return { native: req(candidate) as LensNative, path: candidate, error: null }
    } catch (error) {
      lastError = `failed to load ${candidate}: ${(error as Error).message}`
    }
  }
  return { native: null, path: null, error: lastError }
}
