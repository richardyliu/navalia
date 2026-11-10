import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecFn } from '../../src/main/import/cli'
import { createImportService } from '../../src/main/import/service'
import { registerImportHandlers } from '../../src/main/import/ipc'
import { CLAUDE_FILE, CLAUDE_KEY, CODEX_FILE, CODEX_KEY, FIXTURE_HOME, listAll, tempDir } from './helpers'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

interface Call {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  staged: string[]
}

function setup(opts: { code?: number; stdout?: string; stderr?: string; bin?: string | null; onStagedWrite?: (f: string) => void } = {}) {
  const storeRoot = tempDir('store')
  const runtimeRoot = tempDir('runtime')
  const calls: Call[] = []
  const exec: ExecFn = async (file, args, o) => {
    const path = args[args.indexOf('--path') + 1]
    calls.push({ file, args, env: o.env, staged: listAll(path) })
    return { code: opts.code ?? 0, signal: null, stdout: opts.stdout ?? '✓ Imported 2 new/changed document(s); 0 unchanged, 0 skipped.\n', stderr: opts.stderr ?? '' }
  }
  const svc = createImportService({
    storeRoot,
    runtimeRoot: () => runtimeRoot,
    homeDir: () => FIXTURE_HOME,
    persomeBin: () => (opts.bin === undefined ? '/opt/fake/persome' : opts.bin),
    exec,
    onStagedWrite: opts.onStagedWrite
  })
  return { svc, storeRoot, runtimeRoot, calls }
}

const mode = (p: string): number => statSync(p).mode & 0o777

describe('import service', () => {
  it('scan previews sessions and writes nothing anywhere', async () => {
    const { svc, storeRoot, runtimeRoot } = setup()
    const r = await svc.scan()
    expect(r.sessions.map((s) => [s.key, s.messageCount, s.importState]).sort()).toEqual(
      [
        [CLAUDE_KEY, 5, 'new'],
        [CODEX_KEY, 2, 'new']
      ].sort()
    )
    const c = r.sessions.find((s) => s.key === CLAUDE_KEY)!
    expect(c.title).toBe('Fix login flow')
    expect(c.files).toEqual(['~/.claude/projects/-work-secret-app/aaaaaaaa-1111-4111-8111-111111111111.jsonl'])
    expect(c.startTs).toBe(Date.parse('2025-10-01T09:00:00.000Z'))
    expect(r.cli.available).toBe(true)
    expect(listAll(storeRoot)).toEqual([])
    expect(listAll(runtimeRoot)).toEqual([])
  })

  it('dry run (prepare) stages owner-only Markdown and never touches the Runtime', async () => {
    const { svc, runtimeRoot, calls } = setup()
    await svc.scan()
    const run = await svc.prepare([CLAUDE_KEY, CODEX_KEY])
    expect(run.status).toBe('staged')
    expect(run.totals.documents).toBe(2)
    expect(run.totals.messages).toBe(7)
    expect(run.totals.redactions).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
    expect(listAll(runtimeRoot)).toEqual([])
    const dir = svc.paths.stagingDir(run.runId)
    expect(listAll(dir)).toEqual([
      'claude-code/',
      CLAUDE_FILE,
      'codex/',
      CODEX_FILE
    ])
    expect(mode(dir)).toBe(0o700)
    expect(mode(svc.paths.root)).toBe(0o700)
    expect(mode(join(dir, 'claude-code'))).toBe(0o700)
    expect(mode(join(dir, CLAUDE_FILE))).toBe(0o600)
    const md = readFileSync(join(dir, CLAUDE_FILE), 'utf8')
    expect(md).not.toContain('sk-ant-api03-FAKE')
    expect(md).not.toContain('AKIAIOSFODNN7EXAMPLE')
    // dry run leaves the ledger untouched
    expect(existsSync(svc.paths.ledgerPath)).toBe(false)
  })

  it('a failure while staging leaves no partial staging dir and no run manifest', async () => {
    let n = 0
    const { svc } = setup({
      onStagedWrite: () => {
        if (++n === 2) throw new Error('disk full (injected)')
      }
    })
    await svc.scan()
    await expect(svc.prepare([CLAUDE_KEY, CODEX_KEY])).rejects.toThrow(/暂存失败/)
    expect(listAll(svc.paths.stagingRoot)).toEqual([])
    expect(listAll(svc.paths.runsRoot)).toEqual([])
  })

  it('commit invokes persome with the exact args and PERSOME_ROOT, then records the ledger', async () => {
    const { svc, calls, runtimeRoot } = setup()
    await svc.scan()
    const staged = await svc.prepare([CLAUDE_KEY, CODEX_KEY])
    const run = await svc.commit(staged.runId)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/opt/fake/persome')
    expect(calls[0].args).toEqual(['import-data', '--source', 'folder', '--path', svc.paths.sourceDir, '--no-build'])
    expect(calls[0].env.PERSOME_ROOT).toBe(runtimeRoot)
    expect(calls[0].staged).toContain(CODEX_FILE)
    expect(run.status).toBe('imported')
    expect(run.importCli?.exitCode).toBe(0)
    expect(run.importCli?.args).toEqual(['import-data', '--source', 'folder', '--path', '<staging>', '--no-build'])
    expect(run.importCli?.counts).toEqual({ imported: 2, unchanged: 0, skipped: 0 })
    // preview now shows both sessions as imported; preparing again stages nothing
    const again = await svc.scan()
    expect(again.sessions.every((s) => s.importState === 'imported')).toBe(true)
    const second = await svc.prepare([CLAUDE_KEY])
    expect(second.documents).toEqual([])
    expect(second.skippedAlreadyImported).toEqual([CLAUDE_KEY])
    await expect(svc.commit(second.runId)).rejects.toThrow(/没有需要导入/)
  })

  it('CLI failure → import_failed with real exit code + redacted stderr; ledger not written; retry allowed', async () => {
    const { svc } = setup({ code: 1, stdout: 'Import failed: boom', stderr: 'Traceback… token=sk-ant-api03-SHOULDNOTLEAK123456 failed' })
    await svc.scan()
    const staged = await svc.prepare([CODEX_KEY])
    const run = await svc.commit(staged.runId)
    expect(run.status).toBe('import_failed')
    expect(run.importCli?.exitCode).toBe(1)
    expect(run.importCli?.stderr).toContain('failed')
    expect(run.importCli?.stderr).not.toContain('SHOULDNOTLEAK')
    expect(run.importCli?.counts).toBeNull()
    expect(existsSync(svc.paths.ledgerPath)).toBe(false)
    expect((await svc.scan()).sessions.find((s) => s.key === CODEX_KEY)?.importState).toBe('new')
    // staging is complete (not half-written) and kept for a retry
    expect(listAll(svc.paths.stagingDir(staged.runId))).toContain(CODEX_FILE)
    expect((await svc.commit(staged.runId)).status).toBe('import_failed')
  })

  it('no persome CLI → runtime_missing error, run stays staged', async () => {
    const { svc, calls } = setup({ bin: null })
    await svc.scan()
    const staged = await svc.prepare([CODEX_KEY])
    await expect(svc.commit(staged.runId)).rejects.toMatchObject({ code: 'runtime_missing' })
    expect(calls).toHaveLength(0)
    expect((await svc.scan()).cli.available).toBe(false)
  })

  it('build requires a successful import and runs import-data --build on the same path', async () => {
    const { svc, calls } = setup()
    await svc.scan()
    const staged = await svc.prepare([CODEX_KEY])
    await expect(svc.build(staged.runId)).rejects.toThrow(/先成功导入/)
    await svc.commit(staged.runId)
    const built = await svc.build(staged.runId)
    expect(calls[1].args).toEqual(['import-data', '--source', 'folder', '--path', svc.paths.sourceDir, '--build'])
    expect(built.status).toBe('built')
    expect(built.buildCli?.exitCode).toBe(0)
  })

  it('discard removes the staging dir', async () => {
    const { svc } = setup()
    await svc.scan()
    const staged = await svc.prepare([CODEX_KEY])
    const d = await svc.discard(staged.runId)
    expect(d.status).toBe('discarded')
    expect(existsSync(svc.paths.stagingDir(staged.runId))).toBe(false)
  })

  it('unknown keys and run ids are rejected', async () => {
    const { svc } = setup()
    await svc.scan()
    await expect(svc.prepare(['codex:nope'])).rejects.toThrow(/重新扫描/)
    await expect(svc.commit('imp-20250101T000000-abcdef')).rejects.toMatchObject({ code: 'not_found' })
    await expect(svc.commit('../../etc')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('import IPC', () => {
  function ipc() {
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
    const { svc } = setup()
    registerImportHandlers({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, svc)
    return (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw) as Promise<{ ok: boolean; data?: any; error?: any }>
  }

  it('registers lens:import:* channels and validates payloads with zod', async () => {
    const call = ipc()
    expect((await call('lens:import:scan')).ok).toBe(true)
    expect((await call('lens:import:scan', { x: 1 })).ok).toBe(false)
    expect((await call('lens:import:prepare', { keys: [] })).ok).toBe(false)
    expect((await call('lens:import:prepare', { keys: ['evil:../x'] })).ok).toBe(false)
    expect((await call('lens:import:prepare', { keys: [CODEX_KEY], extra: 1 })).ok).toBe(false)
    const prep = await call('lens:import:prepare', { keys: [CODEX_KEY] })
    expect(prep.ok).toBe(true)
    expect((await call('lens:import:commit', { runId: '../x' })).ok).toBe(false)
    // build demands an explicit confirm: true
    expect((await call('lens:import:build', { runId: prep.data.runId })).ok).toBe(false)
    const b = await call('lens:import:build', { runId: prep.data.runId, confirm: true })
    expect(b.ok).toBe(false)
    expect(b.error.message).toMatch(/先成功导入/)
    expect((await call('lens:import:commit', { runId: prep.data.runId })).data.status).toBe('imported')
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('service errors default to English', async () => {
    const { svc } = setup()
    await expect(svc.prepare([])).rejects.toThrow('Select at least one session.')
  })
})
