import { execFile as nodeExecFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactForDisplay } from '../import/redact'
import type { AssessorRequest, AssessorTransport, TransportOutcome, TransportResponse } from './assessor'

/**
 * X3 (DECISIONS-ROUND4 R4-1, option C): the production HET assessor transport.
 *
 * Lens main runs the Runtime's OWN interpreter `<root>/venv/bin/python -I -B -c <SCRIPT>`.
 * The fixed script calls `persome.writer.agent_cli.complete(cfg.agent_funding, …)`, so every
 * call goes through the Runtime's fcntl-locked daily_call_limit and its client flags. Lens
 * never spawns `claude` / `codex` itself; if the venv python is missing, every call is
 * `budget_unavailable` without any spawn.
 *
 * Data handling: the prompt goes to the child on stdin only (never argv, never logged).
 * stdout must be exactly one JSON object; stderr is used only for the main-process log, last
 * 2 KB, through `redactForDisplay`. Nothing here writes het.db; the tick records outcome,
 * char counts, client / model and anchor version.
 */

export const AGENT_FUNDING_TRANSPORT_NAME = 'agent_funding'

/**
 * Fixed script. No caller data is interpolated; the request arrives as JSON on stdin.
 * `persome.config.load()` reads `paths.config_file()` = `paths.root()/config.toml`, and
 * `paths.root()` is `$PERSOME_ROOT` (expanded + resolved) when set, else `~/.persome`.
 * Main always sets PERSOME_ROOT to the located Runtime root.
 * Output: {"content": str, "client", "model"} or {"error": outcome, "message", "client", "model"}.
 * Never prints the prompt or the model text on error.
 */
export const AGENT_FUNDING_SCRIPT = String.raw`
import json, sys

def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

def short(exc):
    text = str(exc).splitlines()[0] if str(exc) else ""
    return (type(exc).__name__ + (": " + text if text else ""))[:200]

try:
    req = json.loads(sys.stdin.read())
    messages = req["messages"]
    max_tokens = int(req["max_tokens"])
    if not isinstance(messages, list) or not messages or not (1 <= max_tokens <= 4000):
        raise ValueError("bad request")
except Exception:
    emit({"error": "error", "message": "bad_request"})
    sys.exit(0)

meta = {"client": None, "model": None}
try:
    from persome import config as persome_config
    from persome.writer import agent_cli
except Exception as exc:
    emit({"error": "budget_unavailable", "message": "runtime_import: " + type(exc).__name__})
    sys.exit(0)

try:
    funding = persome_config.load().agent_funding
    try:
        meta["client"] = agent_cli.normalize_client(funding.client) if funding.client else ""
    except Exception:
        meta["client"] = str(funding.client)[:40]
    meta["model"] = str(funding.model or "")[:80]
except Exception as exc:
    out = {"error": "budget_unavailable", "message": "config: " + type(exc).__name__}
    out.update(meta)
    emit(out)
    sys.exit(0)

def fail(kind, exc):
    out = {"error": kind, "message": short(exc)}
    out.update(meta)
    emit(out)

try:
    response = agent_cli.complete(funding, messages=messages, tools=None, max_tokens=max_tokens)
    content = response.choices[0].message.content
    if not isinstance(content, str):
        raise TypeError("completion has no text content")
    out = {"content": content}
    out.update(meta)
    emit(out)
except agent_cli.AgentFundingBudgetExceeded as exc:
    fail("quota", exc)
except agent_cli.AgentFundingTimeout as exc:
    fail("offline", exc)
except agent_cli.AgentFundingUnavailable as exc:
    fail("budget_unavailable", exc)
except Exception as exc:
    out = {"error": "error", "message": type(exc).__name__}
    out.update(meta)
    emit(out)
`

/** Narrow execFile shape so tests can inject a fake (no real process, no LLM). */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    cwd: string
    timeout: number
    maxBuffer: number
    shell: false
    windowsHide: true
    encoding: 'utf8'
    killSignal: NodeJS.Signals
  },
  callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string) => void
) => { stdin?: { end(data: string): void; on?(ev: 'error', fn: (e: Error) => void): unknown } | null }

export interface AgentFundingMeta {
  client: string | null
  model: string | null
}

export interface AgentFundingTransport extends AssessorTransport {
  /** True iff `<root>/venv/bin/python` exists and is executable. No spawn. */
  available(): boolean
  /** client / model from `[agent_funding]` in `<root>/config.toml` (display only; no spawn). */
  meta(): AgentFundingMeta
}

export interface AgentFundingTransportOptions {
  runtimeRoot: () => string
  /** Override the interpreter path (tests). Default `<root>/venv/bin/python`. */
  pythonPath?: () => string
  execFileImpl?: ExecFileLike
  /** Model-call budget. The child is killed at timeoutMs + KILL_GRACE_MS (see below). */
  timeoutMs?: number
  maxTokens?: number
  log?: (msg: string) => void
  /** Source of inherited env (default process.env). */
  baseEnv?: NodeJS.ProcessEnv
}

/**
 * The Runtime enforces its own `timeout_seconds` (default 180 s) on the CLI subprocess and
 * kills it cleanly. Killing python first would orphan the CLI, so the Node deadline is the
 * model budget plus a grace period.
 */
export const KILL_GRACE_MS = 15_000
const MAX_STDOUT = 1024 * 1024
const STDERR_TAIL = 2048

/**
 * Env passed to the Python child. Same allow-list the Runtime itself forwards to the CLI
 * (`agent_cli._PASSTHROUGH_ENV_NAMES` + LC_*): HOME / USER / LOGNAME (the CLI finds its own
 * login: ~/.claude, ~/.codex, macOS keychain), PATH (`shutil.which('claude')`), TMPDIR
 * (tempfile workdir), LANG / LC_* (encoding), proxy / CA vars (network as the user configured).
 * Explicitly NOT passed: API keys / OAuth tokens (the Runtime strips them too; subscription
 * auth stays in the CLI), PYTHON* (ignored by -I anyway), NODE_* / ELECTRON_*, Lens secrets.
 * PERSOME_ROOT is always set to the located root so config + usage ledger match readBudget().
 * PATH gets the usual user bin dirs appended because a Finder-launched app has a bare PATH.
 */
const PASSTHROUGH = [
  'ALL_PROXY',
  'CODEX_CA_CERTIFICATE',
  'CODEX_HOME',
  'CURSOR_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'SHELL',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'USER',
  'XDG_CONFIG_HOME'
]

export function childEnv(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (PASSTHROUGH.includes(k) || k.startsWith('LC_')) env[k] = v
  }
  const home = env.HOME || os.homedir()
  env.HOME = home
  const extra = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const parts = (env.PATH ?? '').split(':').filter(Boolean)
  for (const p of extra) if (!parts.includes(p)) parts.push(p)
  env.PATH = parts.join(':')
  env.PERSOME_ROOT = root
  return env
}

/** Parse client / model from `[agent_funding]` (display only; the script's report is authoritative). */
export function readAgentFundingMeta(configPath: string): AgentFundingMeta {
  try {
    const text = fs.readFileSync(configPath, 'utf8')
    let inSection = false
    const out: AgentFundingMeta = { client: null, model: null }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (t.startsWith('[')) {
        inSection = t === '[agent_funding]'
        continue
      }
      if (!inSection || !t || t.startsWith('#')) continue
      const m = /^(\w+)\s*=\s*(.+)$/.exec(t)
      if (!m) continue
      const raw = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
      if (m[1] === 'client') out.client = raw.slice(0, 40)
      if (m[1] === 'model') out.model = raw.slice(0, 80)
    }
    return out
  } catch {
    return { client: null, model: null }
  }
}

const OUTCOMES: ReadonlySet<string> = new Set(['quota', 'offline', 'budget_unavailable', 'error'])
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

/** Strict parse of the script's stdout. Anything else → error. */
export function parseScriptOutput(stdout: string): TransportResponse & { message?: string } {
  let obj: unknown
  try {
    obj = JSON.parse(stdout.trim())
  } catch {
    return { outcome: 'error', message: 'stdout_not_json' }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { outcome: 'error', message: 'stdout_not_object' }
  const o = obj as Record<string, unknown>
  const prov = { client: str(o.client, 40), model: str(o.model, 80) }
  if (typeof o.content === 'string' && o.error === undefined) return { outcome: 'ok', text: o.content, ...prov }
  if (typeof o.error === 'string' && OUTCOMES.has(o.error))
    return { outcome: o.error as TransportOutcome, message: str(o.message, 200) ?? undefined, ...prov }
  return { outcome: 'error', message: 'stdout_bad_shape', ...prov }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function createAgentFundingTransport(opts: AgentFundingTransportOptions): AgentFundingTransport {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const maxTokens = opts.maxTokens ?? 800
  const exec: ExecFileLike = opts.execFileImpl ?? (nodeExecFile as unknown as ExecFileLike)
  const log = opts.log ?? (() => undefined)
  const python = (): string => (opts.pythonPath ? opts.pythonPath() : path.join(opts.runtimeRoot(), 'venv', 'bin', 'python'))

  const meta = (): AgentFundingMeta => readAgentFundingMeta(path.join(opts.runtimeRoot(), 'config.toml'))

  function run(req: AssessorRequest): Promise<TransportResponse> {
    const py = python()
    const fallbackMeta = meta()
    if (!isExecutable(py)) {
      log('[het] agent_funding: runtime python missing; budget_unavailable (no spawn)')
      return Promise.resolve({ outcome: 'budget_unavailable', ...fallbackMeta })
    }
    const root = opts.runtimeRoot()
    const input = JSON.stringify({ messages: [{ role: 'user', content: req.prompt }], max_tokens: maxTokens })
    return new Promise<TransportResponse>((resolve) => {
      let settled = false
      const done = (r: TransportResponse): void => {
        if (settled) return
        settled = true
        resolve({ ...r, client: r.client ?? fallbackMeta.client, model: r.model ?? fallbackMeta.model })
      }
      let child: ReturnType<ExecFileLike>
      try {
        child = exec(
          py,
          ['-I', '-B', '-c', AGENT_FUNDING_SCRIPT],
          {
            env: childEnv(root, opts.baseEnv),
            cwd: os.tmpdir(),
            timeout: timeoutMs + KILL_GRACE_MS,
            maxBuffer: MAX_STDOUT,
            shell: false,
            windowsHide: true,
            encoding: 'utf8',
            killSignal: 'SIGTERM'
          },
          (error, stdout, stderr) => {
            const tail = redactForDisplay(String(stderr ?? '').slice(-STDERR_TAIL)).replace(/\s+/g, ' ').trim()
            if (error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              log('[het] agent_funding: child output exceeded the buffer limit; error')
              return done({ outcome: 'error' })
            }
            if (error && (error.killed || error.signal)) {
              log(`[het] agent_funding: child killed (deadline ${timeoutMs + KILL_GRACE_MS} ms)${tail ? ` stderr: ${tail}` : ''}`)
              return done({ outcome: 'offline' })
            }
            const r = parseScriptOutput(String(stdout ?? ''))
            if (r.outcome !== 'ok') {
              const msg = r.message ? redactForDisplay(r.message) : ''
              log(`[het] agent_funding: task ${req.taskId} → ${r.outcome}${msg ? ` (${msg})` : ''}${error ? ` exit=${String(error.code ?? '?')}` : ''}${tail && r.outcome === 'error' ? ` stderr: ${tail}` : ''}`)
              return done({ outcome: r.outcome, client: r.client, model: r.model })
            }
            log(`[het] agent_funding: task ${req.taskId} → ok (${r.text?.length ?? 0} chars)`)
            done({ outcome: 'ok', text: r.text, client: r.client, model: r.model })
          }
        )
      } catch (e) {
        log(`[het] agent_funding: spawn failed: ${e instanceof Error ? e.name : 'error'}`)
        return done({ outcome: 'budget_unavailable' })
      }
      try {
        child.stdin?.on?.('error', () => undefined)
        child.stdin?.end(input)
      } catch {
        // the exec callback reports the failure
      }
    })
  }

  return {
    name: AGENT_FUNDING_TRANSPORT_NAME,
    available: () => isExecutable(python()),
    meta,
    async complete(req) {
      try {
        return await run(req)
      } catch {
        return { outcome: 'error' }
      }
    }
  }
}
