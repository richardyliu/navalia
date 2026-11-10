import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NATIVE_FILENAME, nativeCandidates } from '../../src/main/capture/native'

const saved = process.env.NAVALIA_NATIVE
afterEach(() => {
  if (saved === undefined) delete process.env.NAVALIA_NATIVE
  else process.env.NAVALIA_NATIVE = saved
})

describe('native loader candidates (SECURITY R6)', () => {
  it('ignores NAVALIA_NATIVE unless the caller opts in', () => {
    process.env.NAVALIA_NATIVE = '/tmp/evil.node'
    const packaged = nativeCandidates('/App/Resources/app.asar', '/App/Resources')
    expect(packaged).toEqual([
      path.join('/App/Resources', 'native', NATIVE_FILENAME),
      path.join('/App/Resources/app.asar', 'native', 'build', 'Release', NATIVE_FILENAME)
    ])
    expect(nativeCandidates('/repo', undefined, true)[0]).toBe('/tmp/evil.node')
  })
})
