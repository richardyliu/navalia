import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecFn } from '../../src/main/import/cli'
import { createImportService } from '../../src/main/import/service'
import { scanTranscripts } from '../../src/main/import/transcripts'
import { CODEX_KEY, FIXTURE_HOME, listAll, tempDir } from './helpers'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

/** Security-review fixes S1-07 #1 (bounded scan), #6 (staging lifecycle), #9 (file-name collisions). */

/** Temp home with `n` Codex rollouts (one session each); file i gets mtime base + i seconds. */
function manyFileHome(n: number, ids?: string[]): { home: string; keys: string[] } {
  const home = tempDir('many-home')
  const keys: string[] = []
  const list = ids ?? Array.from({ length: n }, (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`)
  list.forEach((id, i) => {
    const dir = join(home, '.codex', 'sessions', '2025', '10', String(1 + (i % 28)).padStart(2, '0'))
    mkdirSync(dir, { recursive: true })
    const f = join(dir, `rollout-2025-10-01T00-00-00-${i}.jsonl`)
    const ts = new Date(Date.UTC(2025, 9, 1, 0, 0, i)).toISOString()
    writeFileSync(
      f,
      [
        { timestamp: ts, type: 'session_meta', payload: { id, cwd: '/work/many' } },
        { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `SECRET_BODY_${i} hello` }] } },
        { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply ${i}` }] } }
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n'
    )
    const t = 1_700_000_000 + i
    utimesSync(f, t, t)
    keys.push(`codex:${id}`)
  })
  return { home, keys }
}

const okExec: ExecFn = async () => ({ code: 0, signal: null, stdout: '✓ Imported 1 new/changed document(s); 0 unchanged, 0 skipped.', stderr: '' })

describe('#1 bounded, async scan', () => {
  it('processes files one at a time, yielding between files, and retains no message text', async () => {
    const { home } = manyFileHome(150)
    let yields = 0
    const r = await scanTranscripts(home, undefined, async () => {
      yields++
    })
    expect(r.sessions).toHaveLength(150)
    expect(yields).toBe(150)
    expect(JSON.stringify(r)).not.toMatch(/SECRET_BODY_|reply \d/)
    expect(r.sessions.every((s) => s.messageCount === 2)).toBe(true)
  })

  it('lets other event-loop work run while scanning (real setImmediate yield)', async () => {
    const { home } = manyFileHome(60)
    let done = false
    let ranDuringScan = false
    const p = scanTranscripts(home).then(() => {
      done = true
    })
    setImmediate(() => {
      ranDuringScan = !done
    })
    await p
    expect(ranDuringScan).toBe(true)
  })

  it('no per-file text retention structures in the scanner (static)', () => {
    const src = readFileSync(join(__dirname, '../../src/main/import/transcripts.ts'), 'utf8')
    expect(src).not.toMatch(/rowsByFile/)
    expect(src.match(/readTextReadOnly\(/g)).toHaveLength(1) // only inside processFile
  })

  it('file cap: newest files only + Chinese warning', async () => {
    const { home, keys } = manyFileHome(30)
    const r = await scanTranscripts(home, { maxFiles: 10, maxBytes: 1 << 30 }, async () => {})
    expect(r.sessions).toHaveLength(10)
    expect(r.capped).toMatchObject({ scannedFiles: 10, totalFiles: 30, limitFiles: 10 })
    // newest mtimes are the last generated files
    expect(r.sessions.map((s) => s.key).sort()).toEqual(keys.slice(20).sort())
    const svc = createImportService({
      storeRoot: tempDir('store'),
      homeDir: () => home,
      runtimeRoot: () => tempDir('rt'),
      persomeBin: () => null,
      scanLimits: { maxFiles: 10, maxBytes: 1 << 30 }
    })
    const scan = await svc.scan()
    expect(scan.capWarning).toMatch(/只扫描了最近的 10 \/ 30 个文件/)
    expect(scan.capWarning).toMatch(/更早的会话没有列出/)
  })

  it('byte cap stops the scan and warns; no cap → null warning', async () => {
    const { home } = manyFileHome(20)
    const r = await scanTranscripts(home, { maxFiles: 1000, maxBytes: 2000 }, async () => {})
    expect(r.capped).not.toBeNull()
    expect(r.capped!.scannedBytes).toBeLessThanOrEqual(2000)
    expect(r.sessions.length).toBeLessThan(20)
    const svc = createImportService({ storeRoot: tempDir('store'), homeDir: () => home, runtimeRoot: () => tempDir('rt'), persomeBin: () => null })
    expect((await svc.scan()).capWarning).toBeNull()
  })

  it('prepare refuses selections above the byte cap, writing nothing', async () => {
    const { home, keys } = manyFileHome(5)
    const svc = createImportService({ storeRoot: tempDir('store'), homeDir: () => home, runtimeRoot: () => tempDir('rt'), persomeBin: () => null, prepareMaxBytes: 100 })
    await svc.scan()
    await expect(svc.prepare(keys)).rejects.toThrow(/超过单次导入上限/)
    expect(listAll(svc.paths.stagingRoot)).toEqual([])
  })
})

describe('#6 staging lifecycle', () => {
  it('sweeps .tmp-* leftovers, orphan staging and expired staging on service creation', async () => {
    const storeRoot = tempDir('store')
    let t = Date.parse('2026-01-01T00:00:00Z')
    const mk = () =>
      createImportService({ storeRoot, homeDir: () => FIXTURE_HOME, runtimeRoot: () => tempDir('rt'), persomeBin: () => '/x', exec: okExec, now: () => t, stagingTtlMs: 24 * 3600_000 })
    const svc = mk()
    await svc.scan()
    const old = await svc.prepare([CODEX_KEY])
    await svc.commit(old.runId) // imported, not built
    t += 2 * 24 * 3600_000
    const fresh = await svc.prepare([CODEX_KEY].concat()) // already imported → no docs but staging dir exists
    mkdirSync(join(svc.paths.stagingRoot, '.tmp-imp-20260101T000000-abcdef', 'codex'), { recursive: true })
    writeFileSync(join(svc.paths.stagingRoot, '.tmp-imp-20260101T000000-abcdef', 'codex', 'half.md'), 'partial')
    mkdirSync(join(svc.paths.stagingRoot, 'imp-20250101T000000-aaaaaa'), { recursive: true }) // no manifest → orphan

    const svc2 = mk()
    expect(listAll(svc2.paths.stagingRoot)).toEqual([`${fresh.runId}/`])
    const oldRun = JSON.parse(readFileSync(join(svc2.paths.runsRoot, `${old.runId}.json`), 'utf8'))
    expect(oldRun).toMatchObject({ status: 'imported', stagingDeleted: true })
    await expect(svc2.build(old.runId)).rejects.toThrow(/暂存目录不存在/)
  })

  it('a successful build deletes the staging dir; a failed build keeps it for retry', async () => {
    let code = 1
    const exec: ExecFn = async (_f, args) => ({ code: args.includes('--build') ? code : 0, signal: null, stdout: '', stderr: 'degraded' })
    const svc = createImportService({ storeRoot: tempDir('store'), homeDir: () => FIXTURE_HOME, runtimeRoot: () => tempDir('rt'), persomeBin: () => '/x', exec })
    await svc.scan()
    const run = await svc.prepare([CODEX_KEY])
    await svc.commit(run.runId)
    const failed = await svc.build(run.runId)
    expect(failed.status).toBe('build_failed')
    expect(existsSync(svc.paths.stagingDir(run.runId))).toBe(true)
    code = 0
    const built = await svc.build(run.runId)
    expect(built).toMatchObject({ status: 'built', stagingDeleted: true })
    expect(existsSync(svc.paths.stagingDir(run.runId))).toBe(false)
    expect(existsSync(join(svc.paths.runsRoot, `${run.runId}.ledger.json`))).toBe(false)
  })
})

describe('#9 staged file-name collisions', () => {
  it('ids that sanitise/truncate alike or look like part names stage to distinct files', async () => {
    const long = 'p'.repeat(130)
    const ids = ['a/b', 'a_b', 'a:b', 'X', 'X.part-1', 'X.part-2', `${long}1`, `${long}2`]
    const { home, keys } = manyFileHome(0, ids)
    const svc = createImportService({ storeRoot: tempDir('store'), homeDir: () => home, runtimeRoot: () => tempDir('rt'), persomeBin: () => null })
    const scan = await svc.scan()
    expect(scan.sessions).toHaveLength(ids.length)
    const run = await svc.prepare(keys)
    const files = run.documents.map((d) => d.file)
    expect(new Set(files).size).toBe(ids.length)
    for (const f of files) expect(f).toMatch(/^codex\/[A-Za-z0-9._-]{1,80}-[0-9a-f]{10}\.md$/)
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('prepare errors default to English', async () => {
    const { home, keys } = manyFileHome(5)
    const svc = createImportService({ storeRoot: tempDir('store'), homeDir: () => home, runtimeRoot: () => tempDir('rt'), persomeBin: () => null, prepareMaxBytes: 100 })
    await svc.scan()
    await expect(svc.prepare(keys)).rejects.toThrow(/over the per-import limit/)
  })
})
