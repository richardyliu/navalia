import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** mkdtemp under the OS temp dir with the `lens-conn-` prefix (C19 tests). */
export function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lens-conn-${label}-`))
}

/**
 * Remove a directory created by tmpDir — and nothing else: the basename must carry the prefix and
 * its parent must be the OS temp dir itself (never the temp dir, never a parent of it).
 */
export function rmTmp(dir: string): void {
  const real = fs.realpathSync(dir)
  const tmpRoot = fs.realpathSync(os.tmpdir())
  if (!path.basename(real).startsWith('lens-conn-') || path.dirname(real) !== tmpRoot || real === tmpRoot) {
    throw new Error(`refusing to remove ${dir}`)
  }
  fs.rmSync(real, { recursive: true, force: true })
}
