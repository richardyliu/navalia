// B17: the temp-dir cleanup guard never touches os.tmpdir() itself or anything without the prefix.
// Every path removed here is a dir this test created with the `lens-tmpguard-` prefix.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempDirTracker, isOwnTempDir, removeOwnTempDir } from '../_support/tmpdir'

const P = 'lens-tmpguard'

describe('tests/_support/tmpdir guard', () => {
  it('refuses os.tmpdir() itself (plain, trailing slash, realpath)', () => {
    const t = os.tmpdir()
    for (const d of [t, `${t}/`, fs.realpathSync(t), path.join(t, '.')]) {
      expect(isOwnTempDir(d, P)).toBe(false)
      expect(removeOwnTempDir(d, P)).toBe(false)
    }
    expect(fs.existsSync(t)).toBe(true)
  })

  it('refuses dirs without the prefix, nested dirs, parents, and bad prefixes', () => {
    const t = os.tmpdir()
    expect(isOwnTempDir(path.join(t, 'other-dir'), P)).toBe(false)
    expect(isOwnTempDir(path.join(t, `${P}x-abc`), P)).toBe(false) // prefix must be followed by '-'
    expect(isOwnTempDir(path.join(t, 'x', `${P}-abc`), P)).toBe(false) // not directly under tmpdir
    expect(isOwnTempDir(path.dirname(t), P)).toBe(false)
    expect(isOwnTempDir(path.join(t, `${P}-abc`), '')).toBe(false)
    expect(isOwnTempDir(path.join(t, `${P}-abc`), '../x')).toBe(false)
    expect(() => createTempDirTracker('')).toThrow()
    expect(() => createTempDirTracker('../x')).toThrow()
  })

  it('a non-prefixed sibling survives; tracked dirs are removed', () => {
    const tr = createTempDirTracker(P)
    const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-tmpguard_keep-'))
    try {
      const a = tr.make('a')
      const b = tr.make(undefined, { realpath: true })
      fs.writeFileSync(path.join(a, 'f.txt'), 'x')
      expect(path.basename(a).startsWith(`${P}-a-`)).toBe(true)
      expect(isOwnTempDir(a, P)).toBe(true)
      expect(isOwnTempDir(keep, P)).toBe(false)
      expect(removeOwnTempDir(keep, P)).toBe(false)
      tr.cleanup()
      expect(fs.existsSync(a)).toBe(false)
      expect(fs.existsSync(b)).toBe(false)
      expect(fs.existsSync(keep)).toBe(true)
      expect(fs.existsSync(os.tmpdir())).toBe(true)
    } finally {
      // own sibling, removed with an explicit prefix guard
      if (path.basename(keep).startsWith('lens-tmpguard_keep-') && path.resolve(keep) !== path.resolve(os.tmpdir())) {
        fs.rmSync(keep, { recursive: true, force: true })
      }
    }
  })
})
