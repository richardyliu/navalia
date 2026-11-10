// OG4 (output volume never kills a destructive CLI run) + OG5 (one shared Runtime maintenance
// lock across Recovery, Privacy and runtime start). Real fixture CLI at the process boundary
// (tests/fixtures/recovery/fake-persome.cjs), temp roots only; ~/.persome is never touched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, beforeEach } from 'vitest'
import { HeadTailBuffer, runCli } from '../../src/main/recovery/exec'
import { createRecoveryService } from '../../src/main/recovery/service'
import { createPrivacyService } from '../../src/main/privacy/service'
import { createPrivacyConfirmGate } from '../../src/main/privacy/confirm'
import { createMaintenanceLock, MaintenanceBusyError, runtimeMaintenanceLock } from '../../src/main/runtime/maintenance-lock'
import type { RuntimeLocation } from '../../src/main/runtime/paths'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` test(s) in this file.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FIXTURE_CLI = path.resolve(__dirname, '../fixtures/recovery/fake-persome.cjs')
const TOKEN = 'tok_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function fixture(mode?: string): { root: string; bin: string; loc: RuntimeLocation & { bin: string } } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-recovery-'))
  cleanups.push(() => {
    if (base.startsWith(path.join(os.tmpdir(), 'lens-recovery-'))) fs.rmSync(base, { recursive: true, force: true })
  })
  const root = path.join(base, 'lens-recovery-runtime')
  fs.mkdirSync(root, { mode: 0o700 })
  expect(root.startsWith(path.join(os.homedir(), '.persome'))).toBe(false)
  fs.writeFileSync(path.join(root, 'config.toml'), '[mcp]\nport = 1\n')
  fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${TOKEN}\n`, { mode: 0o600 })
  if (mode) fs.writeFileSync(path.join(root, 'fixture-mode'), mode)
  const bin = path.join(base, 'persome')
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_CLI}" "$@"\n`, { mode: 0o755 })
  const loc = { root, bin, port: 1, rootExists: true, envPath: path.join(root, 'env'), configPath: path.join(root, 'config.toml') } as unknown as RuntimeLocation & {
    bin: string
  }
  return { root, bin, loc }
}

describe('OG4: HeadTailBuffer', () => {
  test('under the cap: verbatim, not truncated', () => {
    const b = new HeadTailBuffer(4096)
    b.push(Buffer.from('a\nb\n'))
    expect(b.text()).toBe('a\nb\n')
    expect(b.truncated).toBe(false)
  })

  test('over the cap: keeps head + tail on line boundaries, bounded, counts dropped bytes', () => {
    const b = new HeadTailBuffer(1024)
    b.push(Buffer.from('FIRST LINE\n'))
    for (let i = 0; i < 1000; i++) b.push(Buffer.from(`line ${i} ${'z'.repeat(40)}\n`))
    b.push(Buffer.from('LAST LINE\n'))
    const t = b.text()
    expect(b.truncated).toBe(true)
    expect(b.droppedBytes).toBeGreaterThan(40_000)
    expect(t.startsWith('FIRST LINE\n')).toBe(true)
    expect(t.endsWith('LAST LINE\n')).toBe(true)
    expect(t).toContain('输出过长')
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1024)
    // No half line at either boundary.
    for (const line of t.split('\n').filter((l) => l.startsWith('line '))) expect(line).toMatch(/^line \d+ z{40}$/)
  })
})

describe('OG4: runCli never kills a run for output volume', () => {
  test('clean printing > 1 MiB runs to completion (marker written), truncated=true, output bounded + redacted', async () => {
    const fx = fixture()
    const run = await runCli(fx.bin, ['clean', 'captures', '--yes'], { root: fx.root, timeoutMs: 60_000, maxBytes: 256 * 1024, knownSecrets: [TOKEN] })
    expect(fs.readFileSync(path.join(fx.root, 'clean.marker'), 'utf8')).toBe('captures --yes')
    expect(run).toMatchObject({ exitCode: 0, timedOut: false, truncated: true, spawnFailed: false })
    expect(run.output.length).toBeLessThanOrEqual(256 * 1024)
    expect(run.output).toContain('cleaning captures')
    expect(run.output).toContain('cleaned captures')
    expect(run.output).not.toContain(TOKEN)
  }, 30_000)

  test('missing binary → spawnFailed, no throw', async () => {
    const fx = fixture()
    const run = await runCli(path.join(fx.root, 'nope'), ['doctor'], { root: fx.root, timeoutMs: 5_000, maxBytes: 1024, knownSecrets: [] })
    expect(run.spawnFailed).toBe(true)
    expect(run.output).toMatch(/无法启动 persome 命令/)
  })

  test('recovery rebuild printing > 1 MiB completes; DestructiveRunResult.truncated=true', async () => {
    const fx = fixture('flood-rebuild')
    const svc = createRecoveryService({
      locate: () => fx.loc,
      storeRoot: fx.root,
      homeDir: os.homedir(),
      startRuntime: async () => undefined,
      lock: createMaintenanceLock()
    })
    const ch = svc.confirmIssue('rebuild-captures-index')
    const r = await svc.confirmRun('rebuild-captures-index', ch.nonce, ch.phrase)
    expect(fs.readFileSync(path.join(fx.root, 'rebuild.marker'), 'utf8')).toBe('done')
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false, truncated: true, runtimeRestarted: true })
    expect(r.output).toContain('Indexed 3 captures')
    expect(r.output).not.toContain(TOKEN)
  }, 60_000)

  test('privacy delete printing > 1 MiB completes; DeleteRunResult.truncated=true', async () => {
    const fx = fixture()
    const svc = createPrivacyService({
      locate: () => fx.loc,
      grants: {} as never,
      agents: {} as never,
      appVersion: () => null,
      homeDir: os.homedir(),
      knownSecrets: () => [TOKEN],
      isUp: async () => false,
      confirmDialog: async () => true,
      confirm: createPrivacyConfirmGate(),
      lock: createMaintenanceLock()
    })
    const ch = svc.confirmIssue('delete-timeline')
    const r = await svc.deleteRun('timeline', ch.nonce, ch.phrase, false)
    expect(fs.readFileSync(path.join(fx.root, 'clean.marker'), 'utf8')).toBe('timeline --yes')
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false, truncated: true })
    expect(r.output).not.toContain(TOKEN)
  }, 60_000)
})

describe('OG5: one Runtime maintenance lock', () => {
  test('unit: second caller refused immediately with the holder name; released on failure', async () => {
    const lock = createMaintenanceLock()
    let release!: () => void
    const held = lock.run('删除数据', () => new Promise<void>((r) => (release = r)))
    expect(lock.holder()).toBe('删除数据')
    await expect(lock.run('启动 Runtime', async () => 1)).rejects.toBeInstanceOf(MaintenanceBusyError)
    await expect(lock.run('x', async () => 1, (h) => new Error(`busy:${h}`))).rejects.toThrow('busy:删除数据')
    release()
    await held
    expect(lock.holder()).toBeNull()
    await expect(lock.run('boom', async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
    expect(lock.holder()).toBeNull()
  })

  test('privacy clean in progress → recovery start / restart / rebuild refused; nothing started', async () => {
    const lock = createMaintenanceLock()
    const fx = fixture()
    let releaseClean!: () => void
    const starts: string[] = []
    const privacy = createPrivacyService({
      locate: () => fx.loc,
      grants: {} as never,
      agents: {} as never,
      appVersion: () => null,
      homeDir: os.homedir(),
      isUp: async () => false,
      confirmDialog: async () => true,
      lock,
      exec: () =>
        new Promise((r) => (releaseClean = () => r({ exitCode: 0, timedOut: false, truncated: false, durationMs: 1, output: '', spawnFailed: false })))
    })
    const recovery = createRecoveryService({ locate: () => fx.loc, storeRoot: fx.root, homeDir: os.homedir(), lock, startRuntime: async () => void starts.push('start') })

    const ch = privacy.confirmIssue('delete-all')
    const deleting = privacy.deleteRun('all', ch.nonce, ch.phrase, false)
    await new Promise((r) => setImmediate(r))
    expect(lock.holder()).toBe('删除数据')
    await expect(recovery.startRuntime()).rejects.toThrow(/正在执行「删除数据」/)
    await expect(recovery.restartRuntime()).rejects.toThrow(/正在执行「删除数据」/)
    await expect(recovery.doctor()).rejects.toThrow(/正在执行「删除数据」/)
    const rc = recovery.confirmIssue('rebuild-captures-index')
    await expect(recovery.confirmRun('rebuild-captures-index', rc.nonce, rc.phrase)).rejects.toThrow(/正在执行「删除数据」/)
    expect(starts).toEqual([])
    expect(fs.existsSync(path.join(fx.root, 'calls.log'))).toBe(false)

    releaseClean()
    await deleting
    expect(lock.holder()).toBeNull()
  })

  test('recovery start in progress → privacy delete and withdraw refused (after confirmation, nothing run)', async () => {
    const lock = createMaintenanceLock()
    const fx = fixture()
    let releaseStart!: () => void
    const execs: string[][] = []
    const recovery = createRecoveryService({
      locate: () => fx.loc,
      storeRoot: fx.root,
      homeDir: os.homedir(),
      lock,
      startRuntime: () => new Promise<void>((r) => (releaseStart = r))
    })
    const privacy = createPrivacyService({
      locate: () => fx.loc,
      grants: { list: () => [] } as never,
      agents: { list: () => [] } as never,
      appVersion: () => null,
      homeDir: os.homedir(),
      isUp: async () => false,
      confirmDialog: async () => true,
      lock,
      exec: async (_b, args) => (execs.push([...args]), { exitCode: 0, timedOut: false, truncated: false, durationMs: 1, output: '', spawnFailed: false })
    })
    const starting = recovery.startRuntime()
    await new Promise((r) => setImmediate(r))
    const d = privacy.confirmIssue('delete-captures')
    await expect(privacy.deleteRun('captures', d.nonce, d.phrase, false)).rejects.toThrow(/正在执行「启动 Runtime」/)
    const w = privacy.confirmIssue('withdraw-all')
    await expect(privacy.withdrawRun(w.nonce, w.phrase)).rejects.toThrow(/正在执行「启动 Runtime」/)
    expect(execs).toEqual([])
    releaseStart()
    await starting
  })

  test('services default to the single process-wide lock', async () => {
    const fx = fixture()
    let release!: () => void
    const recovery = createRecoveryService({ locate: () => fx.loc, storeRoot: fx.root, homeDir: os.homedir(), startRuntime: () => new Promise<void>((r) => (release = r)) })
    const privacy = createPrivacyService({
      locate: () => fx.loc,
      grants: {} as never,
      agents: {} as never,
      appVersion: () => null,
      isUp: async () => false,
      confirmDialog: async () => true,
      exec: async () => ({ exitCode: 0, timedOut: false, truncated: false, durationMs: 1, output: '', spawnFailed: false })
    })
    const starting = recovery.startRuntime()
    await new Promise((r) => setImmediate(r))
    expect(runtimeMaintenanceLock.holder()).toBe('启动 Runtime')
    const d = privacy.confirmIssue('delete-captures')
    await expect(privacy.deleteRun('captures', d.nonce, d.phrase, false)).rejects.toThrow(/启动 Runtime/)
    release()
    await starting
    expect(runtimeMaintenanceLock.holder()).toBeNull()
  })
})

describe('en: English UI text', () => {
  test('en: truncation marker and spawn failure read in English', async () => {
    setLocale('en')
    const b = new HeadTailBuffer(64)
    for (let i = 0; i < 50; i++) b.push(Buffer.from(`line ${i}\n`))
    expect(b.text()).toContain('output too long')
    const fx = fixture()
    const run = await runCli(path.join(fx.root, 'nope'), ['doctor'], { root: fx.root, timeoutMs: 5_000, maxBytes: 1024, knownSecrets: [] })
    expect(run.output).toMatch(/Cannot start the persome command/)
  })
})
