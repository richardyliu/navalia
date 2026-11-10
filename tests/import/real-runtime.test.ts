import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createImportService } from '../../src/main/import/service'
import { CODEX_KEY, FIXTURE_HOME, tempDir } from './helpers'

/**
 * Opt-in acceptance against a REAL installed `persome` CLI, always with a fresh temp
 * PERSOME_ROOT (never ~/.persome). Run:
 *   LENS_IMPORT_REAL_PERSOME=$HOME/.local/bin/persome npx vitest run tests/import/real-runtime.test.ts
 * Only the `--no-build` import runs (no LLM). Output is printed for the S1-07 log.
 */
const BIN = process.env.LENS_IMPORT_REAL_PERSOME

describe.skipIf(!BIN)('real persome import-data (temp PERSOME_ROOT)', () => {
  it('imports one fixture session', { timeout: 300_000 }, async () => {
    const runtimeRoot = tempDir('real-runtime')
    expect(runtimeRoot.startsWith(join(process.env.HOME ?? '/nonexistent', '.persome'))).toBe(false)
    const svc = createImportService({
      storeRoot: tempDir('real-store'),
      homeDir: () => FIXTURE_HOME,
      runtimeRoot: () => runtimeRoot,
      persomeBin: () => BIN!
    })
    await svc.scan()
    const staged = await svc.prepare([CODEX_KEY])
    const before = existsSync(runtimeRoot) ? readdirSync(runtimeRoot) : []
    const run = await svc.commit(staged.runId)
    console.log(JSON.stringify({ runtimeRoot, before, after: readdirSync(runtimeRoot), importCli: run.importCli, status: run.status }, null, 2))
    // Whatever happened, status must match the real exit code.
    expect(run.status).toBe(run.importCli?.exitCode === 0 ? 'imported' : 'import_failed')
  })

  it('C20: importing the same session twice (ledger wiped in between) → second run all unchanged', { timeout: 300_000 }, async () => {
    const runtimeRoot = tempDir('real-runtime-c20')
    const storeRoot = tempDir('real-store-c20')
    const mk = () => createImportService({ storeRoot, homeDir: () => FIXTURE_HOME, runtimeRoot: () => runtimeRoot, persomeBin: () => BIN! })
    const a = mk()
    await a.scan()
    const r1 = await a.commit((await a.prepare([CODEX_KEY])).runId)
    expect(r1.status).toBe('imported')
    rmSync(a.paths.ledgerPath)
    const b = mk()
    await b.scan()
    const r2 = await b.commit((await b.prepare([CODEX_KEY])).runId)
    console.log(JSON.stringify({ first: r1.importCli?.counts, second: r2.importCli?.counts }))
    expect(r2.importCli?.counts).toEqual({ imported: 0, unchanged: r2.documents.length, skipped: 0 })
  })
})
