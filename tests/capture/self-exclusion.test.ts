import { describe, expect, it } from 'vitest'
import { LENS_BUNDLE_ID, lensSelfExclusion, matchesBuiltIn } from '../../src/main/capture/self-exclusion'

const DEV_APP = '/Users/x/navalia/node_modules/electron/dist/Electron.app'

describe('built-in Lens self exclusion', () => {
  it('dev: excludes dev.navalia.app and this repo’s Electron.app path, never the generic id', () => {
    const ex = lensSelfExclusion({ bundleId: 'com.github.Electron', bundlePath: DEV_APP })
    expect(ex).toEqual({ label: 'Navalia', bundleIds: [LENS_BUNDLE_ID], bundlePaths: [DEV_APP] })
    expect(matchesBuiltIn(ex, 'dev.navalia.app')).toBe(true) // another (packaged) Lens instance
    expect(matchesBuiltIn(ex, 'DEV.Navalia.app')).toBe(true)
    expect(matchesBuiltIn(ex, 'com.github.Electron', DEV_APP)).toBe(true) // another dev Lens of this checkout
    expect(matchesBuiltIn(ex, 'com.github.Electron', `${DEV_APP}/`)).toBe(true)
    expect(matchesBuiltIn(ex, 'com.github.Electron', '/Users/x/other-project/node_modules/electron/dist/Electron.app')).toBe(false)
    expect(matchesBuiltIn(ex, 'com.github.Electron')).toBe(false)
    expect(matchesBuiltIn(ex, 'com.google.Chrome', '/Applications/Google Chrome.app')).toBe(false)
  })

  it('packaged: own CFBundleIdentifier and bundle path', () => {
    const ex = lensSelfExclusion({ bundleId: 'dev.navalia.app', bundlePath: '/Applications/Navalia.app' })
    expect(ex.bundleIds).toEqual([LENS_BUNDLE_ID])
    expect(ex.bundlePaths).toEqual(['/Applications/Navalia.app'])
    const renamed = lensSelfExclusion({ bundleId: 'dev.navalia.app.beta', bundlePath: '/Applications/Lens Beta.app' })
    expect(renamed.bundleIds).toEqual([LENS_BUNDLE_ID, 'dev.navalia.app.beta'])
  })

  it('without native info still excludes the Lens bundle id', () => {
    expect(lensSelfExclusion(null)).toEqual({ label: 'Navalia', bundleIds: [LENS_BUNDLE_ID], bundlePaths: [] })
  })
})
