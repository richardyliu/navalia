import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanOutput, defaultExec, parseReceipt } from '../../src/main/import/cli'
import { createImportService } from '../../src/main/import/service'
import { CLAUDE_KEY, CODEX_KEY, FIXTURE_HOME, tempDir } from './helpers'

/**
 * TEST DOUBLE of the external `persome` CLI (not the Runtime). It records argv + PERSOME_ROOT
 * and prints a receipt line in the real CLI's format (personal-model src/persome/cli.py
 * `import_data`). It exercises the real execFile path (no shell, args array, env).
 */
function fakePersome(dir: string, behaviour: 'ok' | 'fail'): string {
  const bin = join(dir, 'persome')
  const body =
    behaviour === 'ok'
      ? `#!/bin/sh
printf '%s\\n' "$@" > "$PERSOME_ROOT/fake-persome-argv.txt"
printf '%s\\n' "$PERSOME_ROOT" > "$PERSOME_ROOT/fake-persome-root.txt"
dir=""; prev=""
for a in "$@"; do if [ "$prev" = "--path" ]; then dir="$a"; fi; prev="$a"; done
n=$(find "$dir" -name '*.md' | wc -l | tr -d ' ')
printf '\\033[32m✓ Imported %s new/changed document(s)\\033[0m; 0 unchanged, 0 skipped.\\n' "$n"
`
      : `#!/bin/sh
echo "Import failed: the Persome data directory cannot be used as an import source; key sk-ant-api03-LEAKLEAKLEAK1234567" >&2
exit 3
`
  writeFileSync(bin, body)
  chmodSync(bin, 0o755)
  return bin
}

describe('persome CLI integration (fake CLI test double)', () => {
  it('imports a fixture session into a temp PERSOME_ROOT through execFile', async () => {
    const binDir = tempDir('bin')
    const runtimeRoot = tempDir('runtime')
    const bin = fakePersome(binDir, 'ok')
    const svc = createImportService({
      storeRoot: tempDir('store'),
      homeDir: () => FIXTURE_HOME,
      runtimeRoot: () => runtimeRoot,
      persomeBin: () => bin
    })
    await svc.scan()
    const staged = await svc.prepare([CLAUDE_KEY, CODEX_KEY])
    const run = await svc.commit(staged.runId)
    expect(run.status).toBe('imported')
    expect(run.importCli?.exitCode).toBe(0)
    expect(run.importCli?.counts).toEqual({ imported: 2, unchanged: 0, skipped: 0 })
    expect(run.importCli?.stdout).not.toContain('\u001b[')
    expect(readFileSync(join(runtimeRoot, 'fake-persome-argv.txt'), 'utf8').trim().split('\n')).toEqual([
      'import-data',
      '--source',
      'folder',
      '--path',
      svc.paths.sourceDir,
      '--no-build'
    ])
    expect(readFileSync(join(runtimeRoot, 'fake-persome-root.txt'), 'utf8').trim()).toBe(runtimeRoot)
  })

  it('reports the real non-zero exit code and redacted stderr', async () => {
    const bin = fakePersome(tempDir('bin'), 'fail')
    const svc = createImportService({
      storeRoot: tempDir('store'),
      homeDir: () => FIXTURE_HOME,
      runtimeRoot: () => tempDir('runtime'),
      persomeBin: () => bin
    })
    await svc.scan()
    const run = await svc.commit((await svc.prepare([CODEX_KEY])).runId)
    expect(run.status).toBe('import_failed')
    expect(run.importCli?.exitCode).toBe(3)
    expect(run.importCli?.stderr).toContain('cannot be used as an import source')
    expect(run.importCli?.stderr).not.toContain('LEAKLEAK')
  })

  it('a missing binary is a failure (exit code null), never success', async () => {
    const r = await defaultExec('/nonexistent/persome', ['import-data'], { env: process.env, timeoutMs: 5000 })
    expect(r.code).toBeNull()
    expect(r.stderr).toMatch(/ENOENT/)
  })

  it('parseReceipt / cleanOutput', () => {
    expect(parseReceipt('\u001b[32m✓ Imported 3 new/changed document(s)\u001b[0m; 1 unchanged, 2 skipped.')).toEqual({ imported: 3, unchanged: 1, skipped: 2 })
    expect(parseReceipt('nothing')).toBeNull()
    expect(cleanOutput('\u001b[31mBearer abcdefghijklmnopqrstu\u001b[0m')).toBe('Bearer [redacted]')
  })
})
