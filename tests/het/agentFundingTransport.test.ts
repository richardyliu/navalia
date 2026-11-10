// X3 (DECISIONS-ROUND4 R4-1): Runtime `[agent_funding]` assessor transport.
// Every test here uses a FAKE execFile (no process, no LLM) except the one integration test at the
// bottom, which runs the real fixed script with the real Runtime venv python against a temp
// PERSOME_ROOT whose config has `[agent_funding] enabled = false` (zero LLM calls by construction).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, test } from 'vitest'
import {
  AGENT_FUNDING_SCRIPT,
  AGENT_FUNDING_TRANSPORT_NAME,
  childEnv,
  createAgentFundingTransport,
  KILL_GRACE_MS,
  parseScriptOutput,
  readAgentFundingMeta,
  type ExecFileLike
} from '../../src/main/het/agentFundingTransport'
import { HET_CHANNELS, type HetAssessorInfo } from '../../src/main/het/api'
import { setLocale } from '../../src/shared/i18n'
import { registerHetIpc, SEND_SUMMARIES_CONFIRM } from '../../src/main/het/ipc'
import { createHetService, type HetBudgetState } from '../../src/main/het/service'
import { readHetSettings } from '../../src/main/het/settings'

const FIX = path.join(__dirname, '..', 'fixtures', 'het')
const A = 'het_0ebde115074148232698' // signals git_commit, pr_link
const B = 'het_c6321821a6a457af5367'
const C = 'het_cf6caafab90e4f757cc3'
const PREFIX = 'lens-x3-'
const TMP = fs.realpathSync(os.tmpdir())
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) {
    // Guard: only remove our own mkdtemp dirs directly under the OS temp dir.
    if (path.dirname(d) === TMP && path.basename(d).startsWith(PREFIX)) fs.rmSync(d, { recursive: true, force: true })
  }
})
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(TMP, PREFIX)))
  dirs.push(d)
  return d
}

const PROMPT_MARKER = 'You classify one completed AI-agent work session'

const VERDICTS: Record<string, unknown> = {
  [A]: { kind: 'coding', size: 'm', complexity: 'medium', agent_share: 0.9, adoption: 'strong', evidence: ['signal:git_commit', 'signal:pr_link'] },
  [B]: { kind: 'research', size: 'xs', complexity: 'low', agent_share: 1, adoption: 'unknown', evidence: [] },
  [C]: { kind: 'writing', size: 's', complexity: 'low', agent_share: 1, adoption: 'unknown', evidence: [] }
}

interface Spawn {
  file: string
  args: readonly string[]
  opts: Parameters<ExecFileLike>[2]
  stdin: string
}

/** Fake execFile: decodes the stdin request like the real script would, answers via `reply`. */
function fakeExec(
  reply: (taskId: string, req: { messages: Array<{ role: string; content: string }>; max_tokens: number }) =>
    | { stdout: string; stderr?: string; error?: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null }
): ExecFileLike & { spawns: Spawn[] } {
  const spawns: Spawn[] = []
  const fn = ((file, args, opts, cb) => ({
    stdin: {
      end(data: string) {
        spawns.push({ file, args, opts, stdin: data })
        const req = JSON.parse(data)
        const id = /"id":"(het_[0-9a-f]{20})"/.exec(req.messages[0].content)?.[1] ?? ''
        const r = reply(id, req)
        setImmediate(() => cb(r.error ?? null, r.stdout, r.stderr ?? ''))
      }
    }
  })) as ExecFileLike & { spawns: Spawn[] }
  fn.spawns = spawns
  return fn
}

const okReply = (id: string) => ({ stdout: JSON.stringify({ content: JSON.stringify(VERDICTS[id]), client: 'claude-code', model: 'test-model' }) })

/** A temp Runtime root with a fake (never executed) venv python + config.toml. */
function fakeRuntime(config = '[agent_funding]\nenabled = true\nclient = "claude-code"\nmodel = "cfg-model"\n'): { root: string; python: string } {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true })
  const python = path.join(root, 'venv', 'bin', 'python')
  fs.writeFileSync(python, '#!/bin/sh\necho "fake python must never run" >&2\nexit 99\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'config.toml'), config)
  return { root, python }
}

function makeService(o: {
  exec: ExecFileLike
  root: string
  settings?: Record<string, unknown>
  budget?: () => HetBudgetState
  pythonPath?: () => string
}) {
  const d = tmp()
  const settingsFile = path.join(d, 'het-settings.json')
  if (o.settings) fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, ...o.settings }))
  const logs: string[] = []
  const transport = createAgentFundingTransport({
    runtimeRoot: () => o.root,
    pythonPath: o.pythonPath,
    execFileImpl: o.exec,
    log: (m) => logs.push(m),
    baseEnv: { PATH: '/usr/bin:/bin', HOME: o.root, ANTHROPIC_API_KEY: 'sk-ant-should-not-pass', CLAUDE_CODE_OAUTH_TOKEN: 'tok', NODE_OPTIONS: '--inspect', LC_CTYPE: 'UTF-8' }
  })
  let t = Date.UTC(2025, 8, 2)
  const dbFile = path.join(d, 'het.db')
  const svc = createHetService({
    dbFile,
    settingsFile,
    transport,
    budget: o.budget ?? (() => ({ available: true })),
    env: { LENS_HET_CLAUDE_ROOT: path.join(FIX, 'claude'), LENS_HET_CODEX_ROOT: '' },
    now: () => (t += 60_000),
    log: (m) => logs.push(m)
  })
  return { svc, logs, dbFile, settingsFile, transport }
}

function rows<T>(dbFile: string, sql: string): T[] {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

describe('X3 agent_funding transport: success path (fake exec)', () => {
  test('verdict → anchors → minutes end-to-end through the service tick; provenance recorded, no prompt stored', async () => {
    const { root, python } = fakeRuntime()
    const exec = fakeExec(okReply)
    const { svc, logs, dbFile } = makeService({ exec, root, settings: { assessorEnabled: true } })
    expect(svc.status().transport).toBe(AGENT_FUNDING_TRANSPORT_NAME)
    await svc.tickNow()
    const byId = Object.fromEntries(svc.tasks(10).map((t) => [t.id, t]))
    expect(byId[A]).toMatchObject({ status: 'assessed', kind: 'coding', minutes: 38.3, counted: true, anchor_version: 1 })
    expect(byId[B]).toMatchObject({ status: 'assessed', minutes: 1.1 })
    expect(byId[C]).toMatchObject({ status: 'assessed', minutes: 3.4 })
    expect(svc.summary(366).total_minutes_tenths).toBe(383 + 11 + 34)
    const info = svc.assessorInfo()
    expect(info).toMatchObject({ state: 'ready', transport: 'agent_funding', anchor_version: 1, calls_today: 3, send_summaries: false })
    await svc.stop()

    // spawn shape: runtime python, isolated, fixed script, no shell, minimal env
    expect(exec.spawns).toHaveLength(3)
    for (const s of exec.spawns) {
      expect(s.file).toBe(python)
      expect(s.args).toEqual(['-I', '-B', '-c', AGENT_FUNDING_SCRIPT])
      expect(s.opts.shell).toBe(false)
      expect(s.opts.timeout).toBe(180_000 + KILL_GRACE_MS)
      expect(s.opts.maxBuffer).toBeLessThanOrEqual(1024 * 1024)
      expect(s.opts.env.PERSOME_ROOT).toBe(root)
      expect(s.opts.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(s.opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(s.opts.env.NODE_OPTIONS).toBeUndefined()
      expect(s.opts.env.LC_CTYPE).toBe('UTF-8')
      expect(s.opts.env.HOME).toBe(root)
      const req = JSON.parse(s.stdin)
      expect(Object.keys(req).sort()).toEqual(['max_tokens', 'messages'])
      expect(req.max_tokens).toBe(800)
      expect(req.messages).toHaveLength(1)
      expect(req.messages[0].role).toBe('user')
      expect(req.messages[0].content).toContain(PROMPT_MARKER)
      // P1 default: no titles / project paths / file paths / summaries
      expect(req.messages[0].content).not.toMatch(/\/work\/|"title"|"summary"|"project"/)
      // the prompt never appears in argv
      expect(s.args.join(' ')).not.toContain(PROMPT_MARKER)
    }

    const calls = rows<{ transport: string; outcome: string; client: string; model: string; anchor_version: number }>(
      dbFile,
      'SELECT transport, outcome, client, model, anchor_version FROM agent_calls ORDER BY id'
    )
    expect(calls).toEqual(Array(3).fill({ transport: 'agent_funding', outcome: 'ok', client: 'claude-code', model: 'test-model', anchor_version: 1 }))
    const assessed = rows<{ payload: string }>(dbFile, "SELECT payload FROM het_events WHERE kind = 'assessed'")
    expect(assessed).toHaveLength(3)
    for (const a of assessed) expect(JSON.parse(a.payload)).toMatchObject({ client: 'claude-code', model: 'test-model', anchor_version: 1 })
    // het.db never stores the prompt or the raw model text
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
      for (const t of tables) {
        const dump = JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())
        expect(dump, t).not.toContain(PROMPT_MARKER)
        expect(dump, t).not.toContain('"agent_share":0.9,"adoption":"strong","evidence":["signal:git_commit","signal:pr_link"]}"') // raw text form
      }
    } finally {
      db.close()
    }
    for (const l of logs) expect(l).not.toContain(PROMPT_MARKER)
  })

  test('fallback provenance: missing client/model in the script output → config.toml values', async () => {
    const { root } = fakeRuntime()
    const t = createAgentFundingTransport({
      runtimeRoot: () => root,
      execFileImpl: fakeExec((id) => ({ stdout: JSON.stringify({ content: JSON.stringify(VERDICTS[id] ?? VERDICTS[B]) }) }))
    })
    expect(t.available()).toBe(true)
    expect(t.meta()).toEqual({ client: 'claude-code', model: 'cfg-model' })
    const r = await t.complete({ taskId: B, prompt: `{"id":"${B}"}` })
    expect(r).toMatchObject({ outcome: 'ok', client: 'claude-code', model: 'cfg-model' })
  })
})

describe('X3: invalid verdicts never produce minutes', () => {
  for (const [name, verdict, reason] of [
    ['minutes key', { ...(VERDICTS[B] as object), minutes: 30 }, 'invalid:minutes_forbidden'],
    ['unknown key', { ...(VERDICTS[B] as object), confidence: 0.9 }, 'invalid:schema'],
    ['not json', 'about 30 minutes', 'invalid:not_json']
  ] as const) {
    test(`${name} → invalid, 0 minutes`, async () => {
      const { root } = fakeRuntime()
      const exec = fakeExec(() => ({ stdout: JSON.stringify({ content: typeof verdict === 'string' ? verdict : JSON.stringify(verdict), client: 'claude-code', model: '' }) }))
      const { svc, logs } = makeService({ exec, root, settings: { assessorEnabled: true } })
      await svc.tickNow()
      const tasks = svc.tasks(10)
      expect(tasks.every((t) => t.status === 'needs_assessment' && t.minutes === null && !t.counted)).toBe(true)
      expect(tasks.map((t) => t.last_error)).toEqual([reason, reason, reason])
      expect(svc.summary(366).total_minutes_tenths).toBe(0)
      await svc.stop()
      for (const l of logs) expect(l).not.toContain(PROMPT_MARKER)
    })
  }
})

describe('X3: failure outcomes → no minutes, backoff, no retry loop', () => {
  const cases: Array<[string, Parameters<typeof fakeExec>[0], string]> = [
    ['quota (AgentFundingBudgetExceeded)', () => ({ stdout: JSON.stringify({ error: 'quota', message: 'AgentFundingBudgetExceeded: limit reached (20/20)', client: 'claude-code', model: '' }) }), 'quota'],
    ['budget_unavailable (AgentFundingUnavailable)', () => ({ stdout: JSON.stringify({ error: 'budget_unavailable', message: 'AgentFundingUnavailable: agent funding is not enabled' }) }), 'budget_unavailable'],
    ['offline (AgentFundingTimeout)', () => ({ stdout: JSON.stringify({ error: 'offline', message: 'AgentFundingTimeout: deadline' }) }), 'offline'],
    ['error (other exception)', () => ({ stdout: JSON.stringify({ error: 'error', message: 'TypeError' }) }), 'error'],
    ['child killed at the Node deadline → offline', () => ({ stdout: '', error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) }), 'offline'],
    ['garbage stdout → error', () => ({ stdout: 'Traceback (most recent call last): ...', stderr: 'boom ANTHROPIC_API_KEY=sk-ant-abcdefabcdefabcdefabcdef', error: Object.assign(new Error('exit 1'), { code: 1 }) }), 'error'],
    ['stdout with an unknown error kind → error', () => ({ stdout: JSON.stringify({ error: 'weird' }) }), 'error'],
    ['stdout overflow → error', () => ({ stdout: '', error: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }) }), 'error']
  ]
  for (const [name, reply, outcome] of cases) {
    test(name, async () => {
      const { root } = fakeRuntime()
      const exec = fakeExec(reply)
      const { svc, logs, dbFile } = makeService({ exec, root, settings: { assessorEnabled: true } })
      await svc.tickNow()
      expect(exec.spawns).toHaveLength(1) // stops on the first failure
      expect(svc.summary(366).total_minutes_tenths).toBe(0)
      const tasks = svc.tasks(10)
      expect(tasks.every((t) => t.minutes === null && !t.counted)).toBe(true)
      expect(tasks.filter((t) => t.last_error === outcome)).toHaveLength(1)
      await svc.tickNow() // next tick inside backoff: no spawn
      expect(exec.spawns).toHaveLength(1)
      await svc.stop()
      const meta = rows<{ value: string }>(dbFile, "SELECT value FROM het_meta WHERE key = 'assessor_blocked_until'")
      expect(meta).toHaveLength(1)
      const calls = rows<{ outcome: string }>(dbFile, 'SELECT outcome FROM agent_calls')
      expect(calls).toEqual([{ outcome }])
      for (const l of logs) {
        expect(l).not.toContain(PROMPT_MARKER)
        expect(l).not.toContain('sk-ant-abcdefabcdefabcdefabcdef')
      }
    })
  }
})

describe('X3: gate — no spawn unless enabled + python + budget', () => {
  test('default off (no settings file) → no spawn, 0 minutes, state disabled', async () => {
    const { root } = fakeRuntime()
    const exec = fakeExec(okReply)
    const { svc, settingsFile } = makeService({ exec, root })
    await svc.tickNow()
    expect(readHetSettings(settingsFile).assessorEnabled).toBe(false)
    expect(exec.spawns).toHaveLength(0)
    expect(svc.status().assessor.state).toBe('disabled')
    expect(svc.tasks(10).every((t) => t.last_error === 'assessor_disabled')).toBe(true)
    expect(svc.summary(366).total_minutes_tenths).toBe(0)
    await svc.stop()
  })

  test('budget exhausted / not enabled → no spawn, budget_unavailable with the reason', async () => {
    for (const reason of ['exhausted', 'not_enabled']) {
      const { root } = fakeRuntime()
      const exec = fakeExec(okReply)
      const { svc } = makeService({ exec, root, settings: { assessorEnabled: true }, budget: () => ({ available: false, reason }) })
      await svc.tickNow()
      expect(exec.spawns).toHaveLength(0)
      expect(svc.status().assessor).toMatchObject({ state: 'budget_unavailable', reason })
      expect(svc.tasks(10).every((t) => t.last_error === `budget_unavailable:${reason}`)).toBe(true)
      await svc.stop()
    }
  })

  test('python missing → complete() is budget_unavailable without any spawn (never falls back to claude)', async () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'config.toml'), '[agent_funding]\nenabled = true\nclient = "claude-code"\n')
    const exec = fakeExec(okReply)
    const logs: string[] = []
    const t = createAgentFundingTransport({ runtimeRoot: () => root, execFileImpl: exec, log: (m) => logs.push(m) })
    expect(t.available()).toBe(false)
    const r = await t.complete({ taskId: A, prompt: `${PROMPT_MARKER} {"id":"${A}"}` })
    expect(r.outcome).toBe('budget_unavailable')
    expect(exec.spawns).toHaveLength(0)
    expect(logs.join('\n')).not.toContain(PROMPT_MARKER)
    // main's probe (index.ts) checks available() first → the service never calls the transport
    const svcExec = fakeExec(okReply)
    const { svc } = makeService({
      exec: svcExec,
      root,
      settings: { assessorEnabled: true },
      budget: () => (t.available() ? { available: true } : { available: false, reason: 'runtime_python_missing' })
    })
    await svc.tickNow()
    expect(svcExec.spawns).toHaveLength(0)
    expect(svc.status().assessor).toMatchObject({ state: 'budget_unavailable', reason: 'runtime_python_missing' })
    await svc.stop()
  })

  test('the transport source never names claude/codex as the spawned file', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src/main/het/agentFundingTransport.ts'), 'utf8')
    expect(src).not.toMatch(/exec(File)?(Impl)?\(\s*['"`](claude|codex)/)
    expect(src).not.toMatch(/spawn\(/)
    // the fixed script contains no interpolation slots
    expect(AGENT_FUNDING_SCRIPT).not.toContain('${')
  })
})

describe('X3 helpers', () => {
  test('parseScriptOutput is strict', () => {
    expect(parseScriptOutput('{"content":"x","client":"codex","model":"m"}')).toEqual({ outcome: 'ok', text: 'x', client: 'codex', model: 'm' })
    expect(parseScriptOutput('{"error":"quota","message":"m"}')).toMatchObject({ outcome: 'quota', message: 'm' })
    expect(parseScriptOutput('noise\n{"content":"x"}').outcome).toBe('error')
    expect(parseScriptOutput('[1]').outcome).toBe('error')
    expect(parseScriptOutput('{"content":"x","error":"quota"}').outcome).toBe('quota')
    expect(parseScriptOutput('{"content":1}').outcome).toBe('error')
  })

  test('childEnv: allow-list + PERSOME_ROOT; PATH gains user bin dirs', () => {
    const env = childEnv('/r', { PATH: '/usr/bin', HOME: '/h', OPENAI_API_KEY: 'x', PYTHONPATH: '/evil', ELECTRON_RUN_AS_NODE: '1', HTTPS_PROXY: 'http://p' })
    expect(env.PERSOME_ROOT).toBe('/r')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.HTTPS_PROXY).toBe('http://p')
    expect(env.PATH!.split(':')).toEqual(['/usr/bin', '/h/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/bin'])
  })

  test('readAgentFundingMeta reads only [agent_funding]', () => {
    const d = tmp()
    const f = path.join(d, 'config.toml')
    fs.writeFileSync(f, '[models.default]\nmodel = "other"\n[agent_funding]\nenabled = true\nclient = "codex" # c\nmodel = "gpt-x"\n[mcp]\nport = 1\n')
    expect(readAgentFundingMeta(f)).toEqual({ client: 'codex', model: 'gpt-x' })
    expect(readAgentFundingMeta(path.join(d, 'missing.toml'))).toEqual({ client: null, model: null })
  })
})

describe('X3 IPC: assessor info + sendSummariesToAssessor confirm', () => {
  function ipc(confirm?: (sender: unknown, opts: { message: string; detail: string; confirmLabel: string }) => Promise<boolean>) {
    const { root } = fakeRuntime()
    const { svc, settingsFile } = makeService({ exec: fakeExec(okReply), root })
    const handlers = new Map<string, (e: unknown, raw?: unknown) => unknown>()
    registerHetIpc({ handle: (ch: string, fn: (e: unknown, raw?: unknown) => unknown) => void handlers.set(ch, fn) } as never, {
      service: svc,
      chooseExportPath: async () => null,
      confirm
    })
    const call = <T>(ch: string, raw?: unknown) => handlers.get(ch)!({ sender: 'wc' }, raw) as Promise<{ ok: boolean; data?: T }>
    return { svc, settingsFile, call }
  }

  test('assessor-info: default off, minimal fields, budget/meta from the injected probe', async () => {
    const { svc, call } = ipc()
    const r = await call<HetAssessorInfo>(HET_CHANNELS.assessorInfo)
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ enabled: false, state: 'disabled', transport: 'agent_funding', send_summaries: false, per_day_cap: 20, per_tick_cap: 5 })
    expect(r.data!.sent_fields.join(' ')).not.toMatch(/路径|标题|摘要/)
    expect((await call(HET_CHANNELS.assessorInfo, { x: 1 })).ok).toBe(false)
    await svc.stop()
  })

  test('turning ON asks the native confirm; cancel keeps it off; OFF needs no confirm; no confirm dep refuses', async () => {
    const asked: Array<{ sender: unknown; message: string }> = []
    let answer = false
    const { svc, settingsFile, call } = ipc(async (sender, o) => {
      asked.push({ sender, message: o.message })
      return answer
    })
    expect((await call(HET_CHANNELS.setSendSummaries, { enabled: 'yes' })).ok).toBe(false)
    expect((await call(HET_CHANNELS.setSendSummaries, { enabled: true, x: 1 })).ok).toBe(false)
    expect((await call(HET_CHANNELS.setSendSummaries, { enabled: true })).data).toEqual({ send_summaries: false, confirmed: false })
    expect(readHetSettings(settingsFile).sendSummariesToAssessor).toBe(false)
    answer = true
    expect((await call(HET_CHANNELS.setSendSummaries, { enabled: true })).data).toEqual({ send_summaries: true, confirmed: true })
    expect(readHetSettings(settingsFile).sendSummariesToAssessor).toBe(true)
    expect(asked).toEqual([
      { sender: 'wc', message: SEND_SUMMARIES_CONFIRM.message },
      { sender: 'wc', message: SEND_SUMMARIES_CONFIRM.message }
    ])
    expect((await call<HetAssessorInfo>(HET_CHANNELS.assessorInfo)).data!.sent_fields.join(' ')).toMatch(/summaries/)
    expect((await call(HET_CHANNELS.setSendSummaries, { enabled: false })).data).toEqual({ send_summaries: false, confirmed: true })
    expect(asked).toHaveLength(2)
    expect(SEND_SUMMARIES_CONFIRM.detail).toMatch(/cannot be recalled/)
    expect(SEND_SUMMARIES_CONFIRM.detail).toMatch(/CLI provider/)
    setLocale('zh')
    try {
      expect(SEND_SUMMARIES_CONFIRM.detail).toMatch(/无法撤回/)
      expect(SEND_SUMMARIES_CONFIRM.detail).toMatch(/CLI 提供方/)
      expect((await call<HetAssessorInfo>(HET_CHANNELS.assessorInfo)).data!.sent_fields).toContain('任务 id')
    } finally {
      setLocale('en')
    }
    await svc.stop()

    const noConfirm = ipc(undefined)
    expect((await noConfirm.call(HET_CHANNELS.setSendSummaries, { enabled: true })).data).toEqual({ send_summaries: false, confirmed: false })
    await noConfirm.svc.stop()
  })
})

// ── integration: the REAL fixed script with the REAL Runtime venv python ────────────────────
const REAL_PY = path.join(os.homedir(), '.persome', 'venv', 'bin', 'python')
const HAS_PY = (() => {
  try {
    fs.accessSync(REAL_PY, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!HAS_PY)('X3 integration: real script, temp PERSOME_ROOT, agent_funding disabled', () => {
  test('→ budget_unavailable, zero LLM calls, nothing written to the temp root or ~/.persome', async () => {
    const root = tmp()
    const home = tmp()
    fs.writeFileSync(path.join(root, 'config.toml'), '[agent_funding]\nenabled = false\nclient = "claude-code"\nmodel = "x3-test"\n')
    const realUsage = path.join(os.homedir(), '.persome', '.agent-funding-usage.json')
    const statOf = (p: string) => {
      try {
        const s = fs.statSync(p)
        return `${s.size}:${s.mtimeMs}`
      } catch {
        return 'absent'
      }
    }
    const before = statOf(realUsage)
    const beforeLock = statOf(path.join(os.homedir(), '.persome', '.agent-funding-usage.lock'))
    const logs: string[] = []
    const t = createAgentFundingTransport({
      runtimeRoot: () => root,
      pythonPath: () => REAL_PY,
      timeoutMs: 20_000,
      log: (m) => logs.push(m),
      baseEnv: { PATH: '/usr/bin:/bin', HOME: home }
    })
    expect(t.available()).toBe(true)
    const r = await t.complete({ taskId: A, prompt: `${PROMPT_MARKER} {"id":"${A}"}` })
    expect(r).toMatchObject({ outcome: 'budget_unavailable', client: 'claude-code', model: 'x3-test' })
    expect(logs.join('\n')).toContain('not enabled')
    expect(logs.join('\n')).not.toContain(PROMPT_MARKER)
    // no usage ledger / lock reserved in the temp root (Unavailable is raised before _reserve_daily_call)
    expect(fs.readdirSync(root).sort()).toEqual(['config.toml'])
    expect(fs.readdirSync(home)).toEqual([])
    expect(statOf(realUsage)).toBe(before)
    expect(statOf(path.join(os.homedir(), '.persome', '.agent-funding-usage.lock'))).toBe(beforeLock)
  }, 30_000)

  test('enabled but configured executable missing → budget_unavailable, no LLM call', async () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'config.toml'), `[agent_funding]\nenabled = true\nclient = "claude-code"\nexecutable = "${path.join(root, 'no-such-claude')}"\n`)
    const t = createAgentFundingTransport({ runtimeRoot: () => root, pythonPath: () => REAL_PY, baseEnv: { PATH: '/usr/bin:/bin', HOME: tmp() } })
    const r = await t.complete({ taskId: A, prompt: 'x' })
    expect(r.outcome).toBe('budget_unavailable')
    expect(fs.readdirSync(root).sort()).toEqual(['config.toml'])
  }, 30_000)
})
