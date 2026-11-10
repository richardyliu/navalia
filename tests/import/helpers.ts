import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileScopedTempDirs } from '../_support/tmpdir'

export const FIXTURE_HOME = join(__dirname, '..', 'fixtures', 'import', 'home')
export const CLAUDE_KEY = 'claude-code:aaaaaaaa-1111-4111-8111-111111111111'
export const CODEX_KEY = 'codex:bbbbbbbb-2222-4222-8222-222222222222'

// B17: `<tmpdir>/lens-import-<label>-XXXXXX`, removed (prefix-guarded) after the file.
const temps = fileScopedTempDirs('lens-import')
export function tempDir(prefix: string): string {
  return temps.make(prefix)
}

/** Every file under `root` (relative paths), recursively. */
export function listAll(root: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e)
      const r = rel ? `${rel}/${e}` : e
      if (statSync(p).isDirectory()) {
        out.push(`${r}/`)
        walk(p, r)
      } else out.push(r)
    }
  }
  walk(root, '')
  return out.sort()
}

import { fileStem } from '../../src/main/import/markdown'
export const CLAUDE_FILE = `claude-code/${fileStem('aaaaaaaa-1111-4111-8111-111111111111')}.md`
export const CODEX_FILE = `codex/${fileStem('bbbbbbbb-2222-4222-8222-222222222222')}.md`
