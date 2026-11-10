import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { locate } from '../../src/main/runtime/paths'
import { RECOVERY_CHANNELS, type ConfirmChallenge, type DestructiveRunResult, type DoctorResult, type RecoveryReport } from '../../src/main/recovery/api'
import { createConfirmGate } from '../../src/main/recovery/confirm'
import { parseDoctorLines, redactCliOutput } from '../../src/main/recovery/exec'
import { registerRecoveryIpc } from '../../src/main/recovery/ipc'
import { createRecoveryService, type RecoveryDeps } from '../../src/main/recovery/service'
import { checkLensStore } from '../../src/main/recovery/store-check'
import type { CaptureStatusView } from '../../src/main/capture/api'
import type { LensResult } from '../../src/shared/types'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` test(s) in this file.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

// OG-06 Recovery. Fixtures sit at the transport/process boundary only: a real loopback HTTP server
// stands in for the Runtime REST API, and a real executable stands in for the `persome` CLI
// (tests/fixtures/recovery/fake-persome.cjs). Temp roots only; the real ~/.persome is never touched.

const FIXTURE_CLI = path.resolve(__dirname, '../fixtures/recovery/fake-persome.cjs')
const TOKEN = 'tok_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
const SCREENSHOT_KEY = 'ab'.repeat(32)

const cleanups: Array<() => void | Promise<void>> = []
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ['PERSOME_ROOT', 'PERSOME_BIN']) savedEnv[k] = process.env[k]
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

interface Fx {
  root: string
  store: string
  port: number
  bin: string
}

async function fixture(opts: { token?: boolean; bin?: boolean; mode?: string } = {}): Promise<Fx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-recovery-'))
  cleanups.push(() => {
    if (base.startsWith(path.join(os.tmpdir(), 'lens-recovery-'))) fs.rmSync(base, { recursive: true, force: true })
  })
  const root = path.join(base, 'lens-recovery-runtime')
  const store = path.join(base, 'store')
  fs.mkdirSync(root, { mode: 0o700 })
  fs.mkdirSync(store, { mode: 0o700 })
  expect(root.startsWith(path.join(os.homedir(), '.persome'))).toBe(false)
  const port = await freePort()
  fs.writeFileSync(path.join(root, 'config.toml'), `[mcp]\nport = ${port}\n`)
  if (opts.token !== false) {
    fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${TOKEN}\nPERSOME_SCREENSHOT_KEY=${SCREENSHOT_KEY}\n`, { mode: 0o600 })
  }
  if (opts.mode) fs.writeFileSync(path.join(root, 'fixture-mode'), opts.mode)
  const bin = path.join(base, 'persome')
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_CLI}" "$@"\n`, { mode: 0o755 })
  process.env.PERSOME_ROOT = root
  if (opts.bin !== false) process.env.PERSOME_BIN = bin
  else process.env.PERSOME_BIN = path.join(base, 'missing-persome')
  cleanups.push(() => killPidFile(path.join(root, 'runtime.pid')))
  return { root, store, port, bin }
}

function killPidFile(file: string): void {
  try {
    process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL')
  } catch {
    // gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Real loopback HTTP server shaped like the Runtime's /health + bearer-protected /status. */
async function runtimeServer(port: number, opts: { index?: string; acceptToken?: string } = {}): Promise<void> {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/health') {
      return send(200, { success: true, data: { status: 'ok', index: opts.index ?? 'ok', capture_pipeline: 'ok', ocr: 'disabled' } })
    }
    if (req.headers.authorization !== `Bearer ${opts.acceptToken ?? TOKEN}`) return send(401, { success: false, data: null })
    if (req.url?.startsWith('/status')) {
      return send(200, { success: true, data: { version: '0.4.2', root: '/x', index_health: { status: 'ok', index: { status: opts.index ?? 'ok' } } } })
    }
    send(404, { success: false, data: null })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
}

const CAPTURE_OK = {
  started: true,
  reason: null,
  degraded: null,
  pause: { paused: false },
  permissions: { accessibility: true, screenRecording: true }
} as unknown as CaptureStatusView

function service(fx: Fx, extra: Partial<RecoveryDeps> = {}) {
  return createRecoveryService({
    locate,
    storeRoot: fx.store,
    captureStatus: () => CAPTURE_OK,
    brokerStatus: () => ({ url: 'http://127.0.0.1:8750/mcp', running: true, error: null }),
    homeDir: os.homedir(),
    ...extra
  })
}

const byId = (r: RecoveryReport, id: string) => r.checks.find((c) => c.id === id)!

function assertNoSecrets(payload: unknown): void {
  const text = JSON.stringify(payload)
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(SCREENSHOT_KEY)
  expect(text).not.toContain('sk-ant-api03')
}

describe('health aggregation (fixture transports)', () => {
  test('runtime down: reachable fails with start action; dependent checks unknown', async () => {
    const fx = await fixture()
    const r = await service(fx).health()
    expect(byId(r, 'runtime_bin').status).toBe('ok')
    expect(byId(r, 'token').status).toBe('ok')
    const reach = byId(r, 'runtime_reachable')
    expect(reach.status).toBe('fail')
    expect(reach.detail).toContain(`127.0.0.1:${fx.port}`)
    expect(reach.next.some((n) => n.kind === 'action' && n.action === 'start-runtime')).toBe(true)
    for (const id of ['runtime_version', 'index', 'capture_pipeline']) expect(byId(r, id).status).toBe('unknown')
    expect(r.overall).toBe('fail')
    // every non-ok check offers a next step
    for (const c of r.checks) if (c.status === 'fail' || c.status === 'warn') expect(c.next.length).toBeGreaterThan(0)
    assertNoSecrets(r)
  })

  test('runtime up: version from /status with bearer, index ok, overall ok', async () => {
    const fx = await fixture()
    await runtimeServer(fx.port)
    const r = await service(fx).health()
    expect(byId(r, 'runtime_reachable').status).toBe('ok')
    expect(byId(r, 'runtime_version')).toMatchObject({ status: 'ok', detail: '0.4.2' })
    expect(r.runtime.version).toBe('0.4.2')
    expect(byId(r, 'index').status).toBe('ok')
    expect(byId(r, 'capture_plane').status).toBe('ok')
    expect(byId(r, 'broker').status).toBe('ok')
    expect(byId(r, 'lens_store').status).toBe('ok')
    expect(['ok', 'warn', 'fail']).toContain(byId(r, 'disk').status)
    assertNoSecrets(r)
  })

  test('token missing: token fails with restart action; version unknown; never echoes a token', async () => {
    const fx = await fixture({ token: false })
    await runtimeServer(fx.port)
    const r = await service(fx).health()
    const tok = byId(r, 'token')
    expect(tok.status).toBe('fail')
    expect(tok.next.some((n) => n.kind === 'action' && n.action === 'restart-runtime')).toBe(true)
    expect(byId(r, 'runtime_version').status).toBe('unknown')
    expect(byId(r, 'runtime_reachable').status).toBe('ok')
  })

  test('token mismatch (401) is reported as fail with restart action', async () => {
    const fx = await fixture()
    await runtimeServer(fx.port, { acceptToken: 'other-token-0000000000000000' })
    const r = await service(fx).health()
    const v = byId(r, 'runtime_version')
    expect(v.status).toBe('fail')
    expect(v.detail).toContain('401')
    expect(v.next).toContainEqual(expect.objectContaining({ action: 'restart-runtime' }))
    assertNoSecrets(r)
  })

  test('token file too permissive → manual chmod step', async () => {
    const fx = await fixture()
    fs.chmodSync(path.join(fx.root, 'env'), 0o644)
    const r = await service(fx).health()
    const tok = byId(r, 'token')
    expect(tok.status).toBe('fail')
    expect(tok.next[0]).toMatchObject({ kind: 'manual' })
    expect((tok.next[0] as { command?: string }).command).toContain('chmod 600')
  })

  test('degraded index → doctor + rebuild actions; missing bin → install guidance', async () => {
    const fx = await fixture({ bin: false })
    await runtimeServer(fx.port, { index: 'degraded' })
    const r = await service(fx).health()
    const idx = byId(r, 'index')
    expect(idx.status).toBe('warn')
    expect(idx.next.map((n) => (n.kind === 'action' ? n.action : n.kind))).toEqual(['run-doctor', 'rebuild-captures-index', 'open-logs'])
    expect(byId(r, 'runtime_bin').status).toBe('fail')
    expect(byId(r, 'runtime_bin').next[0].kind).toBe('manual')
  })

  test('capture/broker failures and low disk surface next actions', async () => {
    const fx = await fixture()
    const r = await service(fx, {
      captureStatus: () => ({ ...CAPTURE_OK, started: false, reason: 'native addon unavailable' }) as CaptureStatusView,
      brokerStatus: () => ({ url: 'http://127.0.0.1:8750/mcp', running: false, error: 'listen EADDRINUSE 127.0.0.1:8750' }),
      statfs: () => ({ bavail: 100, bsize: 4096, blocks: 1_000_000 })
    }).health()
    expect(byId(r, 'capture_plane')).toMatchObject({ status: 'warn' })
    expect(byId(r, 'capture_plane').next[0]).toMatchObject({ action: 'goto-capture' })
    expect(byId(r, 'broker').status).toBe('fail')
    expect(byId(r, 'disk').status).toBe('fail')
    expect(byId(r, 'disk').next.length).toBeGreaterThan(0)
  })

  test('manual procedures are listed, not implemented', async () => {
    const fx = await fixture()
    const r = await service(fx).health()
    expect(r.manual.map((m) => m.id).sort()).toEqual(['clear-capture-buffer', 'full-index-rebuild', 'reset-lens-store'])
    for (const m of r.manual) expect(m.steps.length).toBeGreaterThan(0)
  })
})

describe('Lens Store integrity (read-only)', () => {
  test('detects corrupt JSON and non-SQLite db without modifying anything', async () => {
    const fx = await fixture()
    fs.writeFileSync(path.join(fx.store, 'settings.json'), '{not json', { mode: 0o600 })
    fs.writeFileSync(path.join(fx.store, 'audit.db'), 'garbage-not-sqlite', { mode: 0o600 })
    fs.writeFileSync(path.join(fx.store, 'het.db'), Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(84)]), { mode: 0o600 })
    const before = fs.readdirSync(fx.store).map((n) => [n, fs.statSync(path.join(fx.store, n)).mtimeMs])
    const res = checkLensStore(fx.store)
    expect(res.findings.map((f) => f.message)).toEqual(expect.arrayContaining(['settings.json 不是合法 JSON', 'audit.db 文件头不是 SQLite 数据库']))
    expect(res.findings.some((f) => f.message.startsWith('het.db'))).toBe(false)
    const after = fs.readdirSync(fx.store).map((n) => [n, fs.statSync(path.join(fx.store, n)).mtimeMs])
    expect(after).toEqual(before)
    const r = await service(fx).health()
    expect(byId(r, 'lens_store').status).toBe('fail')
  })

  test('missing store reports fail and does not create it', () => {
    const missing = path.join(os.tmpdir(), `lens-recovery-nostore-${process.pid}-${Date.now()}`)
    expect(checkLensStore(missing).exists).toBe(false)
    expect(fs.existsSync(missing)).toBe(false)
  })
})

describe('doctor via execFile (fixture CLI)', () => {
  test('output is ANSI-stripped and redacted; lines parsed; exit 1 is a result, not an error', async () => {
    const fx = await fixture()
    const d = await service(fx).doctor()
    expect(d.ran).toBe(true)
    expect(d.exitCode).toBe(1)
    expect(d.timedOut).toBe(false)
    expect(d.output).not.toContain('\u001b[')
    assertNoSecrets(d)
    expect(d.summary).toEqual({ ok: 2, fail: 1, warn: 1 })
    expect(d.lines[0]).toEqual({ status: 'ok', text: 'env file  present (0600)' })
    expect(d.output).toContain('[已隐藏]')
    expect(fs.readFileSync(path.join(fx.root, 'calls.log'), 'utf8').trim()).toBe('doctor')
  })

  test('timeout kills the child and reports timedOut', async () => {
    const fx = await fixture({ mode: 'hang' })
    const d = await service(fx, { doctorTimeoutMs: 700 }).doctor()
    expect(d.timedOut).toBe(true)
    expect(d.output).toContain('超时')
    const pid = Number(fs.readFileSync(path.join(fx.root, 'doctor.pid'), 'utf8'))
    await new Promise((r) => setTimeout(r, 100))
    expect(alive(pid)).toBe(false)
  })

  test('output size is capped', async () => {
    const fx = await fixture({ mode: 'flood' })
    const d = await service(fx, { doctorMaxBytes: 16 * 1024 }).doctor()
    expect(d.truncated).toBe(true)
    expect(d.output.length).toBeLessThanOrEqual(16 * 1024)
  })

  test('missing CLI is a sanitized runtime_missing error over IPC', async () => {
    const fx = await fixture({ bin: false })
    const ipc = fakeIpc()
    registerRecoveryIpc(ipc.ipc, { locate, storeRoot: fx.store })
    const res = await ipc.call<DoctorResult>(RECOVERY_CHANNELS.doctor)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('runtime_missing')
  })

  test('redactCliOutput handles known secrets and patterns', () => {
    const out = redactCliOutput(`a ${TOKEN} b\nAuthorization: Bearer xyz123456789\nPERSOME_SCREENSHOT_KEY=${SCREENSHOT_KEY}`, [TOKEN], '/Users/someone')
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain('xyz123456789')
    expect(out).not.toContain(SCREENSHOT_KEY)
    expect(parseDoctorLines('✓ a\n✗ b\n⚠ c\nplain').map((l) => l.status)).toEqual(['ok', 'fail', 'warn', 'info'])
  })
})

describe('destructive confirmation (nonce + typed phrase)', () => {
  test('gate: wrong phrase, expired nonce, replay, forged nonce all rejected', () => {
    let t = 1_000_000
    const gate = createConfirmGate({ now: () => t, ttlMs: 60_000 })
    const a = gate.issue('rebuild-captures-index')
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(() => gate.consume('rebuild-captures-index', a.nonce, '错误短语')).toThrow(/不正确/)
    // the wrong attempt burned it
    expect(() => gate.consume('rebuild-captures-index', a.nonce, a.phrase)).toThrow(/失效/)

    const b = gate.issue('rebuild-captures-index')
    t += 60_001
    expect(() => gate.consume('rebuild-captures-index', b.nonce, b.phrase)).toThrow(/过期/)

    const c = gate.issue('rebuild-captures-index')
    expect(() => gate.consume('rebuild-captures-index', c.nonce, ` ${c.phrase} `)).not.toThrow()
    expect(() => gate.consume('rebuild-captures-index', c.nonce, c.phrase)).toThrow(/失效/) // replay
    expect(() => gate.consume('rebuild-captures-index', 'f'.repeat(32), c.phrase)).toThrow(/失效/) // forged
    expect(gate.outstanding()).toBe(0)
  })

  test('IPC flow: wrong phrase does not run; correct runs once (stop → rebuild --merge → start); replay rejected', async () => {
    const fx = await fixture()
    const ipc = fakeIpc()
    registerRecoveryIpc(ipc.ipc, { locate, storeRoot: fx.store, homeDir: os.homedir() })
    const rebuildLog = path.join(fx.root, 'rebuild.log')

    // Bad args never reach the gate.
    const bad = await ipc.call(RECOVERY_CHANNELS.confirmRun, { action: 'rebuild-captures-index', nonce: 'nope', phrase: 'x' })
    expect(bad.ok).toBe(false)
    const unknownAction = await ipc.call(RECOVERY_CHANNELS.confirmIssue, { action: 'reset-lens-store' })
    expect(unknownAction.ok).toBe(false)

    const c1 = await ipc.call<ConfirmChallenge>(RECOVERY_CHANNELS.confirmIssue, { action: 'rebuild-captures-index' })
    expect(c1.ok).toBe(true)
    if (!c1.ok) return
    const wrong = await ipc.call(RECOVERY_CHANNELS.confirmRun, { action: 'rebuild-captures-index', nonce: c1.data.nonce, phrase: '重建' })
    expect(wrong.ok).toBe(false)
    expect(fs.existsSync(rebuildLog)).toBe(false)

    const c2 = await ipc.call<ConfirmChallenge>(RECOVERY_CHANNELS.confirmIssue, { action: 'rebuild-captures-index' })
    if (!c2.ok) throw new Error('issue failed')
    // Runtime is running before the rebuild (started by the real supervisor via the fixture CLI).
    const started = await ipc.call<RecoveryReport>(RECOVERY_CHANNELS.startRuntime)
    expect(started.ok).toBe(true)
    if (started.ok) expect(byId(started.data, 'runtime_version').detail).toBe('9.9.9-fixture')

    const ran = await ipc.call<DestructiveRunResult>(RECOVERY_CHANNELS.confirmRun, {
      action: 'rebuild-captures-index',
      nonce: c2.data.nonce,
      phrase: c2.data.phrase
    })
    expect(ran.ok).toBe(true)
    if (!ran.ok) return
    expect(ran.data).toMatchObject({ ok: true, exitCode: 0, runtimeRestarted: true })
    assertNoSecrets(ran)
    expect(fs.readFileSync(rebuildLog, 'utf8').trim().split('\n')).toEqual(['--merge'])
    const calls = fs.readFileSync(path.join(fx.root, 'calls.log'), 'utf8').trim().split('\n').map((l) => l.trim())
    expect(calls).toEqual(['start', 'stop', 'rebuild-captures-index --merge', 'start'])

    const replay = await ipc.call(RECOVERY_CHANNELS.confirmRun, { action: 'rebuild-captures-index', nonce: c2.data.nonce, phrase: c2.data.phrase })
    expect(replay.ok).toBe(false)
    expect(fs.readFileSync(rebuildLog, 'utf8').trim().split('\n')).toHaveLength(1)
  }, 60_000)
})

describe('runtime restart + diagnostics', () => {
  test('restart reuses supervisor: stop, wait for down, start, report healthy', async () => {
    const fx = await fixture()
    const svc = service(fx)
    await svc.startRuntime()
    const pid1 = Number(fs.readFileSync(path.join(fx.root, 'runtime.pid'), 'utf8'))
    const r = await svc.restartRuntime()
    const pid2 = Number(fs.readFileSync(path.join(fx.root, 'runtime.pid'), 'utf8'))
    expect(pid2).not.toBe(pid1)
    expect(byId(r, 'runtime_reachable').status).toBe('ok')
    assertNoSecrets(r)
  }, 60_000)

  test('diagnostics text is redacted and copied in main only', async () => {
    const fx = await fixture()
    await runtimeServer(fx.port)
    const copied: string[] = []
    const svc = service(fx, { copyToClipboard: (t) => copied.push(t), brokerStatus: () => ({ url: 'x', running: false, error: `boom Bearer ${TOKEN}` }) })
    await svc.doctor()
    const d = await svc.diagnostics(true)
    expect(d.copied).toBe(true)
    expect(copied).toEqual([d.text])
    expect(d.text).toContain('Navalia 恢复诊断')
    expect(d.text).toContain('doctor（上次）')
    assertNoSecrets(d)
    assertNoSecrets(copied)
  })

  test('IPC health payload carries no secrets and rejects unexpected args', async () => {
    const fx = await fixture()
    await runtimeServer(fx.port)
    const ipc = fakeIpc()
    registerRecoveryIpc(ipc.ipc, { locate, storeRoot: fx.store })
    const ok = await ipc.call<RecoveryReport>(RECOVERY_CHANNELS.health)
    expect(ok.ok).toBe(true)
    assertNoSecrets(ok)
    const bad = await ipc.call(RECOVERY_CHANNELS.health, { path: '/etc' })
    expect(bad.ok).toBe(false)
    const badDiag = await ipc.call(RECOVERY_CHANNELS.diagnostics, { copy: 'yes' })
    expect(badDiag.ok).toBe(false)
  })
})

function fakeIpc() {
  const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
  return {
    ipc: { handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => void handlers.set(ch, fn) },
    call: async <T>(ch: string, raw?: unknown) => (await handlers.get(ch)!({}, raw)) as LensResult<T>
  }
}

describe('en: English UI text', () => {
  test('en: confirmation gate phrase and errors read in English', () => {
    setLocale('en')
    const gate = createConfirmGate()
    const a = gate.issue('rebuild-captures-index')
    expect(a.phrase).toBe('rebuild capture index')
    expect(a.warning).toMatch(/Runtime is stopped first/)
    expect(() => gate.consume('rebuild-captures-index', a.nonce, 'rebuild')).toThrow(/phrase is incorrect/)
    expect(() => gate.consume('rebuild-captures-index', a.nonce, a.phrase)).toThrow(/no longer valid/)
  })
})
