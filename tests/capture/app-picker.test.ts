import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pickApp, readAppBundleInfo } from '../../src/main/capture/app-picker'

const CALC = '/System/Applications/Calculator.app'

describe('app picker', () => {
  it.skipIf(!fs.existsSync(CALC))('reads CFBundleIdentifier from Info.plist (binary or XML)', () => {
    expect(readAppBundleInfo(CALC)).toMatchObject({ bundleId: 'com.apple.calculator', path: CALC })
  })

  it('rejects non-.app paths', () => {
    expect(() => readAppBundleInfo('/tmp')).toThrow()
  })

  it('returns null when the dialog is cancelled and passes .app filters to NSOpenPanel', async () => {
    let seen: unknown = null
    const r = await pickApp({
      showOpenDialog: async (o) => ((seen = o), { canceled: true, filePaths: [] })
    })
    expect(r).toBeNull()
    expect(seen).toMatchObject({ properties: ['openFile'], filters: [{ extensions: ['app'] }] })
  })
})
