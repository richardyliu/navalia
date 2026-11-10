import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { sandboxExecProbe, warnSkip } from '../_support/host-probe'
import { fileScopedTempDirs } from '../_support/tmpdir'

/**
 * Real upstream Runtime on a TEMP root, for S1-R3-06 / S1-R3-07 acceptance tests.
 *
 *   - Binary: $LENS_UPSTREAM_PERSOME or ~/Documents/GitHub/personal-model-og/.venv/bin/persome
 *     (tests skip when it is missing). Its venv python applies the daemon-owned schema in-process
 *     (`fts.initialize_runtime_schema()`, what `persome start` does) — no daemon, no capture.
 *   - Every upstream process runs under `sandbox-exec` with outbound network denied except
 *     loopback, so any egress attempt by the Runtime fails instead of leaving the machine.
 *   - Roots come from mkdtemp under the OS temp dir and are asserted not to be ~/.persome.
 */

export const UPSTREAM_BIN =
  process.env.LENS_UPSTREAM_PERSOME ?? path.join(os.homedir(), 'Documents', 'GitHub', 'personal-model-og', '.venv', 'bin', 'persome')
export const UPSTREAM_PY = path.join(path.dirname(UPSTREAM_BIN), 'python')
export const NO_EGRESS_PROFILE =
  '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))'

// S1-R4-11: existence is not enough — in a restricted sandbox nested `sandbox-exec` is not
// permitted. Probe once (applying the real profile); skip with the reason.
const HAVE_UPSTREAM_FILES = fs.existsSync(UPSTREAM_BIN) && fs.existsSync(UPSTREAM_PY) && fs.existsSync('/usr/bin/sandbox-exec')
const UPSTREAM_PROBE = HAVE_UPSTREAM_FILES ? sandboxExecProbe(NO_EGRESS_PROFILE) : { ok: false, reason: 'upstream persome / sandbox-exec not installed' }
/** Why the real-upstream suites are skipped (null when they run). */
export const UPSTREAM_SKIP_REASON: string | null = UPSTREAM_PROBE.ok ? null : UPSTREAM_PROBE.reason
export const HAVE_UPSTREAM = UPSTREAM_SKIP_REASON === null
if (HAVE_UPSTREAM_FILES) warnSkip('real-upstream Runtime suites (sandbox-exec probe)', UPSTREAM_PROBE)

const REAL_ROOT = path.join(os.homedir(), '.persome')

// B17: `<realpath tmpdir>/lens-upstream-<label>-XXXXXX`, removed (prefix-guarded) after the file.
const temps = fileScopedTempDirs('lens-upstream')
export function tempRoot(label: string): string {
  const d = temps.make(label, { realpath: true })
  if (d === REAL_ROOT || d.startsWith(`${REAL_ROOT}/`) || d.includes('/.persome')) throw new Error(`refusing non-temp root ${d}`)
  return d
}

const runtimeEnv = (root: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PERSOME_')) env[k] = v
  return { ...env, PERSOME_ROOT: root, PERSOME_LLM_MOCK: '1' }
}

/** A wrapper `persome` that runs the real binary inside the no-egress sandbox. */
export function sandboxedBin(dir: string): string {
  const p = path.join(dir, 'persome-sandboxed')
  fs.writeFileSync(p, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${NO_EGRESS_PROFILE}' '${UPSTREAM_BIN}' "$@"\n`, { mode: 0o755 })
  return p
}

/** Create config + schema on a fresh temp root (what the daemon does at startup). */
export function initRoot(root: string): string {
  const code =
    'from persome import config, paths\npaths.ensure_dirs()\nconfig.write_default_if_missing()\nfrom persome.store import fts\nprint(fts.initialize_runtime_schema())\n'
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', NO_EGRESS_PROFILE, UPSTREAM_PY, '-I', '-c', code], { env: runtimeEnv(root), encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0) throw new Error(`schema init failed: ${r.stderr}`)
  return r.stdout.trim()
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

export interface RestServer {
  port: number
  close(): Promise<void>
}

/**
 * Serve the Runtime REST API for `root` on 127.0.0.1:<port> (owner token in `<root>/env`, port in
 * `config.toml [mcp]` so Lens' own resolvePort/readLocalToken find it). Auth stays enabled.
 */
export async function startRest(root: string): Promise<RestServer> {
  const port = await freePort()
  const token = randomBytes(24).toString('base64url')
  fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${token}\n`, { mode: 0o600 })
  fs.chmodSync(path.join(root, 'env'), 0o600)
  const cfgPath = path.join(root, 'config.toml')
  const cfg = fs.readFileSync(cfgPath, 'utf8')
  const lines = cfg.split('\n')
  let inMcp = false
  let replaced = false
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('[')) inMcp = t === '[mcp]'
    else if (inMcp && /^port\s*=/.test(t)) {
      lines[i] = `port = ${port}`
      replaced = true
    }
  }
  if (!replaced) throw new Error('config.toml has no [mcp] port line')
  fs.writeFileSync(cfgPath, lines.join('\n'))
  const code = [
    'import asyncio',
    'from persome import config',
    'cfg = config.load()',
    `cfg.mcp.host = "127.0.0.1"; cfg.mcp.port = ${port}; cfg.mcp.transport = "streamable-http"`,
    'from persome.mcp import server',
    'asyncio.run(server.run_async(cfg, transport="streamable-http"))'
  ].join('\n')
  const log = fs.openSync(path.join(root, 'lens-test-rest.log'), 'w')
  const child: ChildProcess = spawn('/usr/bin/sandbox-exec', ['-p', NO_EGRESS_PROFILE, UPSTREAM_PY, '-I', '-c', code], {
    env: { ...runtimeEnv(root), PERSOME_LOCAL_API_TOKEN: token },
    stdio: ['ignore', log, log]
  })
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) break
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`REST server exited: ${fs.readFileSync(path.join(root, 'lens-test-rest.log'), 'utf8').slice(-2000)}`)
    if (Date.now() > deadline) {
      child.kill()
      throw new Error('REST server did not come up')
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000)
      })
  }
}

/** Record every TCP connect made by THIS process (Lens code under test) so tests can assert loopback only. */
export function recordConnects(): { hosts: string[]; restore(): void } {
  const hosts: string[] = []
  const orig = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // net.connect() passes its normalized [options, cb] array as the single argument.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]
    const a = first as { host?: string; path?: string; port?: number } | number | string
    // No host given → Node defaults to localhost; anything else unexpected is recorded verbatim (fails the check).
    if (typeof a === 'object' && a) hosts.push(a.path ? `unix:${a.path}` : a.host === undefined ? 'localhost' : String(a.host))
    else if (typeof a === 'number') hosts.push(typeof args[1] === 'string' ? args[1] : 'localhost')
    else if (typeof a === 'string') hosts.push(`unix:${a}`)
    return (orig as (...x: unknown[]) => net.Socket).apply(this, args)
  } as typeof orig
  return { hosts, restore: () => void (net.Socket.prototype.connect = orig) }
}

export const isLoopback = (h: string): boolean => h.startsWith('unix:') || h === '127.0.0.1' || h === 'localhost' || h === '::1'
