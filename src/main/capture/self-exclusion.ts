import fs from 'node:fs'
import path from 'node:path'

/**
 * Lens never captures itself, including other running Lens instances: its UI
 * shows the user's model and evidence, so a frame of it would feed the model
 * its own output. This exclusion is built in and cannot be removed.
 *
 * Matching:
 *   - bundle id `dev.navalia.app` (packaged Lens), plus this process's own
 *     CFBundleIdentifier when it is specific to Lens;
 *   - bundle path of this process's own .app. In dev that is this repo's
 *     node_modules/electron/dist/Electron.app, so any dev Lens started from
 *     this checkout (or a copy sharing its node_modules) is matched.
 * Not matched: the generic dev id `com.github.Electron` by itself, because
 * every unpackaged Electron app (other projects, other checkouts with their
 * own node_modules) shares it. A dev Lens from a different checkout is
 * therefore NOT excluded by this rule.
 */

export const LENS_BUNDLE_ID = 'dev.navalia.app'
export const GENERIC_ELECTRON_BUNDLE_ID = 'com.github.Electron'

export interface BuiltInExclusion {
  label: string
  bundleIds: string[]
  bundlePaths: string[]
}

function canonical(p: string): string {
  const resolved = path.resolve(p).replace(/\/+$/, '')
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function lensSelfExclusion(self: { bundleId: string | null; bundlePath: string | null } | null): BuiltInExclusion {
  const bundleIds = [LENS_BUNDLE_ID]
  const ownId = self?.bundleId?.trim()
  if (ownId && ownId.toLowerCase() !== GENERIC_ELECTRON_BUNDLE_ID.toLowerCase() && ownId !== LENS_BUNDLE_ID) {
    bundleIds.push(ownId)
  }
  const bundlePaths: string[] = []
  if (self?.bundlePath && self.bundlePath.endsWith('.app')) bundlePaths.push(canonical(self.bundlePath))
  return { label: 'Navalia', bundleIds, bundlePaths }
}

export function matchesBuiltIn(ex: BuiltInExclusion, bundleId: string, bundlePath?: string | null): boolean {
  const id = bundleId.trim().toLowerCase()
  if (id && ex.bundleIds.some((b) => b.toLowerCase() === id)) return true
  if (bundlePath && ex.bundlePaths.length > 0) {
    const p = path.resolve(bundlePath).replace(/\/+$/, '')
    if (ex.bundlePaths.includes(p) || ex.bundlePaths.includes(canonical(p))) return true
  }
  return false
}
