// B17: prefix-guarded temp dirs for tests. A previous run wiped $TMPDIR, so removal is refused
// unless ALL of these hold:
//   - the basename starts with `<prefix>-` (the prefix this tracker created it with);
//   - the dir is not the OS temp dir itself (nor its realpath);
//   - the dir sits directly under the OS temp dir (or its realpath).
// Only dirs this tracker created are ever considered.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

function tmpRoots(): string[] {
  const t = path.resolve(os.tmpdir())
  let real = t
  try {
    real = fs.realpathSync(t)
  } catch {
    // keep t
  }
  return [...new Set([t, real])]
}

/** True only for `<tmpdir>/<prefix>-…` (never tmpdir itself, never anything else). */
export function isOwnTempDir(dir: string, prefix: string): boolean {
  if (!prefix || prefix.includes('/') || prefix.includes(path.sep)) return false
  const abs = path.resolve(dir)
  const roots = tmpRoots()
  if (roots.includes(abs)) return false
  if (!path.basename(abs).startsWith(`${prefix}-`)) return false
  return roots.includes(path.dirname(abs))
}

/** Guarded recursive remove. Returns false (and removes nothing) when the guard refuses. */
export function removeOwnTempDir(dir: string, prefix: string): boolean {
  if (!isOwnTempDir(dir, prefix)) return false
  if (path.resolve(dir) === path.resolve(os.tmpdir())) return false // belt and braces
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    // best effort: a child process may still hold the dir; never fail a test on cleanup
  }
  return true
}

export interface TempDirTracker {
  /** mkdtemp `<tmpdir>/<prefix>-<label>-XXXXXX` (or `<prefix>-XXXXXX` without a label). */
  make(label?: string, opts?: { realpath?: boolean }): string
  /** Remove every dir made so far (guarded). */
  cleanup(): void
}

export function createTempDirTracker(prefix: string): TempDirTracker {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix)) throw new Error(`bad temp prefix ${prefix}`)
  const made: string[] = []
  return {
    make(label, opts) {
      const base = opts?.realpath ? fs.realpathSync(os.tmpdir()) : os.tmpdir()
      const d = fs.mkdtempSync(path.join(base, label ? `${prefix}-${label}-` : `${prefix}-`))
      made.push(d)
      return d
    },
    cleanup() {
      for (const d of made.splice(0).reverse()) removeOwnTempDir(d, prefix)
    }
  }
}

/**
 * Tracker whose dirs are removed after the importing test file finishes (file-level afterAll, so
 * dirs made in beforeAll / at collection time stay valid for every test in the file).
 */
export function fileScopedTempDirs(prefix: string): TempDirTracker {
  const t = createTempDirTracker(prefix)
  afterAll(() => t.cleanup())
  return t
}
