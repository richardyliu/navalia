#!/usr/bin/env node
// Lens offline E2E. Zero dependencies (Node >= 22).
//
//   node tests/e2e/smoke.e2e.mjs            # dev build: electron from node_modules + out/ (run `npm run build` first)
//
// Every step is labelled [real] (real Lens main process, addon, Broker, ledger) or
// [mock] (fixture stand-in). Isolation, all under one temp dir:
//   PERSOME_ROOT      temp (config + env token) pointing at a [mock] Runtime on a random port
//   LENS_STORE_ROOT   temp Lens Store;  --user-data-dir temp
//   LENS_AGENT_HOME / LENS_AGENT_APPS   temp agent configs (Claude Code is "installed" there)
//   LENS_HET_CLAUDE_ROOT / LENS_HET_CODEX_ROOT   tests/fixtures/het (read-only)
//   PERSOME_BIN       tests/e2e/mock-persome-mcp.mjs ([mock] Broker backend)
// The real ~/.persome, ~/.claude.json and ~/.claude/projects are never passed in.
//
// Exit: 1 on any FAIL; with E2E_STRICT=1 also 2 when a step is SKIP or PENDING.
// The Broker runs on an ephemeral port (LENS_BROKER_PORT=0, honoured only by unpackaged
// builds), so a parallel Lens on 8750 does not interfere. With E2E_BROKER_PORT=8750 the
// fixed port is used and, if taken, the Broker steps report SKIP naming the holder.
//
// Two extra HET passes run in fresh instances with the unpackaged-only fixture assessor
// (LENS_HET_FAKE_ASSESSOR): tests/fixtures/het/fake-assessor.json and the invalid variant.
//
// The capture steps briefly bring a blank window (tests/e2e/focus-target, built with
// swiftc into the temp dir, bundle id dev.navalia.e2e.focus) to the front, once per
// step. Set E2E_NO_FOCUS=1 to skip them. The [mock] Runtime keeps only frame metadata.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectPage, waitForDevToolsPort, waitForPage } from './cdp.mjs'
import { startMockRuntime } from './mock-runtime-e2e.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
// E2E_APP_DIR: run another app dir (package.json + out/) with this repo's Electron, e.g. a patched build.
const APP_DIR = path.resolve(process.env.E2E_APP_DIR ?? REPO)
let BROKER = 'http://127.0.0.1:8750/mcp' // replaced by the URL the running Broker reports
const EGRESS_SECONDS = Number(process.env.E2E_EGRESS_SECONDS ?? 15)
// E2E_BROKER_PORT=8750 tests the fixed production port (SKIPs the Broker steps if it is taken).
const BROKER_PORT = process.env.E2E_BROKER_PORT ?? '0'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- isolation ----------
const tmp = fs.mkdtempSync(path.join(process.env.E2E_TMP ?? os.tmpdir(), 'navalia-e2e-'))
const dirs = {
  persomeRoot: path.join(tmp, 'persome-root'),
  store: path.join(tmp, 'store'),
  userData: path.join(tmp, 'user-data'),
  agentHome: path.join(tmp, 'agent-home'),
  agentApps: path.join(tmp, 'agent-apps'),
  exports: path.join(tmp, 'exports'),
  // S2: LENS_E2E_PICK_DIR (subscription folder AND backup parent: the seam is one fixed dir per process)
  pick: path.join(tmp, 'pick'),
  // S2: LENS_E2E_OPEN_FILE points at <open>/import.navaliaskill (copied in before importSkill)
  open: path.join(tmp, 'open'),
  // S2: the "friend" pre-pass (fresh store: onboarding + a second identity that signs cards / a skill)
  friendStore: path.join(tmp, 'friend', 'store'),
  friendUserData: path.join(tmp, 'friend', 'user-data'),
  friendExports: path.join(tmp, 'friend', 'exports')
}
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(dirs.agentHome, '.claude'), { mode: 0o700 }) // Claude Code counts as installed
const OPEN_FILE = path.join(dirs.open, 'import.navaliaskill')
// [fixture] transcript home for Import (synthetic, FAKE secrets; read-only, staging goes to the temp store)
const IMPORT_HOME = path.join(REPO, 'tests/fixtures/import/home')

// S2-01: a fresh LENS_STORE_ROOT shows the onboarding overlay over the shell. The main pass
// pre-seeds a "skipped" record; the friend pre-pass keeps a fresh store to test the overlay.
function seedOnboardingSkipped(store) {
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(store, 'onboarding.json'),
    JSON.stringify({ version: 1, outcome: 'skipped', lastStep: 'welcome', completedAt: null, skippedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }) + '\n',
    { mode: 0o600 }
  )
}
seedOnboardingSkipped(dirs.store)

// [fixture] one Runtime skill file (copied from the workflows unit-test fixture) -> rt-weekly-report
const SKILL_ID = 'rt-weekly-report'
fs.mkdirSync(path.join(dirs.persomeRoot, 'memory', 'skills'), { recursive: true, mode: 0o700 })
fs.copyFileSync(
  path.join(REPO, 'tests/workflows/fixtures/runtime/memory/skills/skill-weekly-report.md'),
  path.join(dirs.persomeRoot, 'memory', 'skills', 'skill-weekly-report.md')
)

const runtimeToken = randomBytes(24).toString('hex')
const runtime = await startMockRuntime({ token: runtimeToken })
fs.writeFileSync(
  path.join(dirs.persomeRoot, 'config.toml'),
  `[capture]\nsource = "ingest"\n\n[mcp]\nport = ${runtime.port}\n`
)
fs.writeFileSync(path.join(dirs.persomeRoot, 'env'), `PERSOME_LOCAL_API_TOKEN=${runtimeToken}\n`, { mode: 0o600 })

// ---------- reporting ----------
const results = []
const marks = []
let failed = false
function record(status, label, detail) {
  results.push({ status, label, detail, at: Date.now() })
  if (status === 'FAIL') failed = true
  console.log(`${status} ${label}${detail ? ` -- ${detail}` : ''}`)
}
async function step(label, fn, { skip } = {}) {
  if (skip) return record(skip.startsWith('PENDING') ? 'PENDING' : 'SKIP', label, skip.replace(/^(PENDING|SKIP):\s*/, ''))
  try {
    record('PASS', label, await fn())
  } catch (error) {
    record('FAIL', label, error.message)
  }
}
const ok = (r, what) => {
  if (!r || r.ok !== true) throw new Error(`${what}: ${JSON.stringify(r?.error ?? r)}`)
  return r.data
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

// ---------- helpers ----------
function portHolder(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' })
    const pid = out.match(/^p(\d+)/m)?.[1]
    const cmd = out.match(/^c(.+)$/m)?.[1]
    return pid ? `pid ${pid} (${cmd})` : null
  } catch {
    return null // lsof exits 1 when nothing listens
  }
}

function electronBin() {
  return execFileSync(process.execPath, ['-p', 'require("electron")'], { cwd: REPO, encoding: 'utf8' }).trim()
}

/** Launch a dev Lens. `opts.store` / `opts.userData` default to the main pass dirs; `opts.env` overrides. */
function launchLens(opts = {}) {
  const userData = opts.userData ?? dirs.userData
  const env = {
    ...process.env,
    PERSOME_ROOT: dirs.persomeRoot,
    PERSOME_BIN: path.join(HERE, 'mock-persome-mcp.mjs'),
    LENS_STORE_ROOT: opts.store ?? dirs.store,
    LENS_AGENT_HOME: dirs.agentHome,
    LENS_AGENT_APPS: dirs.agentApps,
    LENS_HET_CLAUDE_ROOT: path.join(REPO, 'tests/fixtures/het/claude'),
    LENS_HET_CODEX_ROOT: path.join(REPO, 'tests/fixtures/het/codex'),
    LENS_E2E_SAVE_DIR: dirs.exports,
    // S2 dialog seams (unpackaged only): directory picker, open-file picker, transcript home.
    LENS_E2E_PICK_DIR: dirs.pick,
    LENS_E2E_OPEN_FILE: OPEN_FILE,
    LENS_IMPORT_HOME: IMPORT_HOME,
    // Ephemeral Broker port (unpackaged builds only), so a parallel Lens on 8750 does not matter.
    LENS_BROKER_PORT: BROKER_PORT,
    ...(opts.env ?? {})
  }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LENS_SCREENSHOT', 'NODE_OPTIONS']) delete env[k]
  if (!opts.env?.LENS_HET_FAKE_ASSESSOR) delete env.LENS_HET_FAKE_ASSESSOR
  const child = spawn(electronBin(), [APP_DIR, `--user-data-dir=${userData}`, '--remote-debugging-port=0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (b) => (log += b))
  child.stderr.on('data', (b) => (log += b))
  return { child, log: () => log }
}

async function stopLens(inst) {
  inst.child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolve) => (inst.child.exitCode !== null ? resolve(true) : inst.child.once('exit', () => resolve(true)))),
    sleep(10000).then(() => false)
  ])
  if (!exited) inst.child.kill('SIGKILL')
  return exited
}

function launchFocusTarget(appBundle) {
  const child = spawn(path.join(appBundle, 'Contents/MacOS/LensE2EFocus'), ['6'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('focus target did not start')), 15000)
    child.stdout.on('data', (b) => {
      if (String(b).includes('FOCUS_TARGET_READY')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return { child, ready }
}

/** One stateless MCP JSON-RPC POST to the Broker. Returns { status, body }. */
async function brokerRpc(token, method, params, id = 1) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BROKER, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}
async function brokerTool(token, name, args = {}) {
  const init = await brokerRpc(token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'lens-e2e', version: '0' }
  })
  if (init.status !== 200) return init
  return brokerRpc(token, 'tools/call', { name, arguments: args }, 2)
}
const toolText = (r) => r.body?.result?.content?.[0]?.text ?? ''

function pidTree(root) {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  const kids = new Map()
  for (const line of out.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!kids.has(ppid)) kids.set(ppid, [])
    kids.get(ppid).push(pid)
  }
  const all = [root]
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) ?? []))
  return all
}
function sampleSockets(rootPid) {
  let out = ''
  try {
    out = execFileSync('lsof', ['-nP', '-a', '-p', pidTree(rootPid).join(','), '-i'], { encoding: 'utf8' })
  } catch (error) {
    out = error.stdout?.toString() ?? ''
  }
  const bad = []
  const seen = new Set()
  for (const row of out.trim().split('\n').slice(1).filter(Boolean)) {
    const name = row.split(/\s+/).slice(8).join(' ')
    seen.add(name)
    const endpoints = name.replace(/\s*\(.*\)$/, '').split('->')
    if (!endpoints.every((e) => /^(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(e))) bad.push(name)
  }
  return { bad, seen }
}

async function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

// ---------- run ----------
// Who holds 8750 before Lens starts (another Lens instance, e.g. a parallel audit run)?
const brokerHolder =
  BROKER_PORT === '8750' && !(await canListen(8750)) ? portHolder(8750) ?? 'unknown process' : null
let brokerSkip
const hetSeam = fs.readFileSync(path.join(APP_DIR, 'out/main/index.js'), 'utf8').includes('LENS_E2E_SAVE_DIR')

// ---------- friend pre-pass: fresh store (onboarding) + a second identity ----------
// Runs before the main pass so its signed cards / skill exist when the main pass imports them.
const friendArtifacts = { cards: [], skill: null }
{
  const inst = launchLens({
    store: dirs.friendStore,
    userData: dirs.friendUserData,
    env: { LENS_E2E_SAVE_DIR: dirs.friendExports, LENS_HET_CLAUDE_ROOT: '', LENS_HET_CODEX_ROOT: '' }
  })
  let pg = null
  try {
    pg = await connectPage(await waitForPage(await waitForDevToolsPort(dirs.friendUserData)))
    await pg.waitFor(`typeof window.lens === 'object' && document.querySelector('.nav-item') !== null`)
    const call = (expr) => pg.evaluate(`window.lens.${expr}`)
    const overlayShown = `document.querySelector('[data-testid=onboarding-overlay]') !== null`

    await step('[real] onboarding (fresh store): overlay visible -> skip onboarding -> gone, status not shown (reason skipped)', async () => {
      assert(!fs.existsSync(path.join(dirs.friendStore, 'onboarding.json')), 'friend store was not fresh')
      const before = ok(await call('onboarding.status()'), 'onboarding.status')
      assert(before.show === true && before.reason === 'first_run', `status before ${JSON.stringify(before)}`)
      await pg.waitFor(overlayShown, 15000)
      const stepName = await pg.evaluate(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step ?? null`)
      await pg.evaluate(`document.querySelector('[data-testid=onboarding-skip-all]').click(), true`)
      await pg.waitFor(`document.querySelector('[data-testid=onboarding-overlay]') === null`, 10000)
      const after = ok(await call('onboarding.status()'), 'onboarding.status')
      assert(after.show === false && after.reason === 'skipped', `status after ${JSON.stringify(after)}`)
      const mode = fs.statSync(path.join(dirs.friendStore, 'onboarding.json')).mode & 0o777
      assert(mode === 0o600, `onboarding.json mode ${mode.toString(8)}`)
      return `first step ${stepName}; after skip: show=false reason=${after.reason}; onboarding.json 0600`
    })

    await step('[real] onboarding: reset -> reload -> overlay back (reopened) -> skip again', async () => {
      ok(await call('onboarding.reset()'), 'onboarding.reset')
      await pg.evaluate(`location.reload(), true`)
      await sleep(500)
      await pg.waitFor(`typeof window.lens === 'object' && document.querySelector('.nav-item') !== null`)
      await pg.waitFor(overlayShown, 15000)
      const st = ok(await call('onboarding.status()'), 'onboarding.status')
      assert(st.show === true && st.reason === 'reopened', `status ${JSON.stringify(st)}`)
      await pg.evaluate(`document.querySelector('[data-testid=onboarding-skip-all]').click(), true`)
      await pg.waitFor(`document.querySelector('[data-testid=onboarding-overlay]') === null`, 10000)
      return 'reopened -> skipped'
    })

    await step('[real] friend identity (second temp store) signs two cards and a .navaliaskill', async () => {
      ok(await call('identity.init()'), 'identity.init')
      const c1 = ok(await call('card.create()'), 'card.create #1')
      await sleep(1100) // distinct issued_at
      const c2 = ok(await call('card.create()'), 'card.create #2')
      for (const c of [c1, c2]) friendArtifacts.cards.push({ text: fs.readFileSync(c.file, 'utf8'), id: c.signed.card.card_id, fp: c.signed.card.issuer.fingerprint })
      const ex = ok(await call(`workflows.exportSkill(${JSON.stringify(SKILL_ID)})`), 'workflows.exportSkill (friend)')
      assert(ex.path && ex.path.startsWith(dirs.friendExports) && fs.existsSync(ex.path), `friend skill path ${ex.path}`)
      friendArtifacts.skill = ex.path
      return `fingerprint ${c1.signed.card.issuer.fingerprint}; cards ${c1.signed.card.card_id}, ${c2.signed.card.card_id}; skill ${path.basename(ex.path)}`
    })
  } catch (error) {
    record('FAIL', '[real] friend pre-pass: instance', error.message)
  } finally {
    pg?.close()
    const exited = await stopLens(inst)
    fs.writeFileSync(path.join(tmp, 'friend', 'log.txt'), inst.log())
    if (!exited) console.log('friend pre-pass: Lens ignored SIGTERM for 10 s; SIGKILL sent')
  }
}

const app = launchLens()
let page = null
let focus = null
const lens = (expr) => page.evaluate(`window.lens.${expr}`)

try {
  await step('[real] app boots (dev build) with temp Runtime root, Lens Store, user-data-dir, agent home', async () => {
    const port = await waitForDevToolsPort(dirs.userData)
    page = await connectPage(await waitForPage(port))
    await page.waitFor(`typeof window.lens === 'object' && document.querySelector('.nav-item') !== null`)
    return `pid ${app.child.pid}, mock runtime :${runtime.port}`
  })

  await step('[real] capture started against the [mock] Runtime (source = "ingest", addon loaded)', async () => {
    const s = ok(await lens('capture.status()'), 'capture.status')
    assert(s.nativeLoaded === true, `nativeLoaded=${s.nativeLoaded} reason=${s.reason}`)
    assert(s.started === true, `not started: ${s.reason}`)
    return `degraded=${s.degraded ?? 'no'}; screenRecording=${s.permissions?.screenRecording}`
  })

  await step('[real] Broker state is known (running, or the port holder is named)', async () => {
    const broker = ok(await lens('connections.list()'), 'connections.list').broker
    if (broker.running) {
      BROKER = broker.url
      assert(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(BROKER), `unexpected Broker url ${BROKER}`)
      return `running at ${BROKER}`
    }
    brokerSkip = `SKIP: Broker not running (${broker.error ?? 'no error'})${brokerHolder ? `; 127.0.0.1:8750 was already held by ${brokerHolder} before launch` : ''}`
    assert(brokerHolder, `Broker not running (port ${BROKER_PORT}): ${broker.error}`)
    return `not running: 8750 held by ${brokerHolder}`
  })

  // ---- Card ----
  let issued = null
  await step('[real] Card: create identity, sign a card from the [mock] share-card, verify it', async () => {
    ok(await lens('identity.init()'), 'identity.init')
    issued = ok(await lens('card.create()'), 'card.create')
    assert(issued.file && fs.existsSync(issued.file), `card file missing: ${issued.file}`)
    const text = fs.readFileSync(issued.file, 'utf8')
    const v = ok(await lens(`card.verify(${JSON.stringify(text)})`), 'card.verify')
    assert(v.valid === true, `verify: ${JSON.stringify(v)}`)
    return `card ${issued.signed.card.card_id}, fingerprint ${issued.signed.card.issuer.fingerprint}`
  })

  await step('[real] Card: a tampered card fails verification', async () => {
    assert(issued, 'no card from previous step')
    const parsed = JSON.parse(fs.readFileSync(issued.file, 'utf8'))
    const target = parsed.card ?? parsed
    target.issued_at = '2000-01-01T00:00:00.000Z'
    const v = ok(await lens(`card.verify(${JSON.stringify(JSON.stringify(parsed))})`), 'card.verify')
    assert(v.valid === false, 'tampered card verified')
    return `reason=${v.reason}`
  })

  // ---- Connections / Access log / Broker ----
  let grant = null
  let token = null
  await step('[real] Broker rejects an unauthenticated MCP call with 401', async () => {
    const r = await brokerRpc(null, 'initialize', {})
    assert(r.status === 401, `status ${r.status}`)
    return 'status 401'
  }, { skip: brokerSkip })

  await step('[real] connect Claude Code: entry written to the temp agent home only', async () => {
    const r = ok(await lens(`connections.connect('claude-code')`), 'connect')
    grant = r.agent.grant
    assert(r.agent.state === 'connected', `state ${r.agent.state}`)
    const cfg = JSON.parse(fs.readFileSync(path.join(dirs.agentHome, '.claude.json'), 'utf8'))
    const entry = cfg.mcpServers?.['navalia']
    assert(entry?.url === BROKER, `entry url ${entry?.url}`)
    token = String(entry.headers?.Authorization ?? '').replace(/^Bearer /, '')
    assert(token.length >= 16, 'no bearer token in written config')
    return `grant ${grant?.id}, config ${path.join(dirs.agentHome, '.claude.json')}`
  }, { skip: brokerSkip })

  await step('[real] read through the Broker: card_get returns the signed card', async () => {
    const r = await brokerTool(token, 'card_get')
    assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`)
    assert(toolText(r).includes(issued.signed.card.card_id), 'card id not in card_get result')
    return 'status 200'
  }, { skip: brokerSkip })

  await step('[real] Broker + [mock] backend: search returns the mock results', async () => {
    const r = await brokerTool(token, 'search', { query: 'demo', top_k: 2 })
    assert(r.status === 200 && !r.body?.result?.isError, `status ${r.status} ${toolText(r)}`)
    assert(toolText(r).includes('pt-demo-1'), `unexpected result ${toolText(r).slice(0, 200)}`)
    return 'pt-demo-1, pt-demo-2'
  }, { skip: brokerSkip })

  await step('[real] Access log has rows for both reads', async () => {
    const rows = ok(await lens('accessLog.list({ days: 1 })'), 'accessLog.list')
    const caps = rows.filter((x) => x.client === grant.client && x.outcome === 'ok').map((x) => x.capability)
    assert(caps.includes('card_get') && caps.includes('search'), `capabilities ${JSON.stringify(caps)}`)
    return `${rows.length} rows`
  }, { skip: brokerSkip })

  await step('[real] clear Access log -> empty, agent still connected, token still works', async () => {
    const cleared = ok(await lens(`accessLog.clear('CLEAR_ACCESS_LOG')`), 'accessLog.clear')
    const rows = ok(await lens('accessLog.list({ days: 1 })'), 'accessLog.list')
    assert(rows.length === 0, `${rows.length} rows after clear`)
    const overview = ok(await lens('connections.list()'), 'connections.list')
    const agent = overview.agents.find((a) => a.id === 'claude-code')
    assert(agent?.state === 'connected', `state after clear ${agent?.state}`)
    const r = await brokerTool(token, 'card_get')
    assert(r.status === 200, `read after clear: ${r.status}`)
    return `removed ${cleared.removed}`
  }, { skip: brokerSkip })

  // ---- Workflow (S2-07) over IPC and the Broker ----
  await step('[real] Workflow: [fixture] Runtime skill file -> workflows.list() has rt-weekly-report with parsed steps', async () => {
    const cat = ok(await lens('workflows.list()'), 'workflows.list')
    const wf = cat.workflows.find((w) => w.id === SKILL_ID)
    assert(wf, `ids ${JSON.stringify(cat.workflows.map((w) => w.id))}; sources ${JSON.stringify(cat.sources)}`)
    assert(wf.provenance.kind === 'observed', `provenance ${wf.provenance.kind}`)
    assert(Array.isArray(wf.steps) && wf.steps.length === 4, `steps ${JSON.stringify(wf.steps)}`)
    return `${cat.workflows.length} workflow(s); ${SKILL_ID}: ${wf.steps.length} steps; sources ${JSON.stringify(cat.sources)}`
  })

  await step('[real] Broker get_workflow returns the [fixture] skill; search_workflows finds it', async () => {
    const r = await brokerTool(token, 'get_workflow', { id: SKILL_ID })
    assert(r.status === 200 && !r.body?.result?.isError, `status ${r.status} ${toolText(r).slice(0, 200)}`)
    const body = JSON.parse(toolText(r))
    assert(body.workflow?.id === SKILL_ID, `workflow ${JSON.stringify(body).slice(0, 200)}`)
    assert(body.workflow.steps.length === 4, `steps ${body.workflow.steps.length}`)
    const s = await brokerTool(token, 'search_workflows', { query: 'weekly' })
    assert(s.status === 200 && toolText(s).includes(SKILL_ID), `search_workflows ${s.status} ${toolText(s).slice(0, 200)}`)
    return `get_workflow 200 (${body.workflow.steps.length} steps, provenance ${body.workflow.provenance.kind}); search_workflows hit`
  }, { skip: brokerSkip })

  await step('[real] revoke grant (Lens extension) -> Broker answers 403', async () => {
    ok(await lens(`connections.revokeGrant(${JSON.stringify(grant.id)})`), 'revokeGrant')
    const r = await brokerRpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } })
    assert(r.status === 403, `status ${r.status}`)
    return 'status 403'
  }, { skip: brokerSkip })

  // ---- Capture: control / pause / exclusion ----
  // One fresh focus-target process per step: its launch is an app activation, and its
  // bundle id (dev.navalia.e2e.focus) separates its frames from the rest of the desktop.
  const focusSkip = process.env.E2E_NO_FOCUS === '1' ? 'SKIP: E2E_NO_FOCUS=1' : undefined
  const FOCUS_BUNDLE = 'dev.navalia.e2e.focus'
  let focusApp = null
  const targetFrames = () => runtime.frames.filter((f) => f.bundle_id === FOCUS_BUNDLE).length
  async function activateAndCount(label, waitMs = 4500) {
    if (!focusApp) {
      focusApp = execFileSync('bash', [path.join(HERE, 'focus-target/build.sh'), path.join(tmp, 'focus-build')], { encoding: 'utf8' }).trim()
    }
    const allBefore = runtime.frames.length
    const before = targetFrames()
    marks.push({ at: Date.now(), label: `${label}: launch focus target` })
    focus = launchFocusTarget(focusApp)
    await focus.ready
    await sleep(waitMs)
    marks.push({ at: Date.now(), label: `${label}: counted` })
    return { target: targetFrames() - before, all: runtime.frames.length - allBefore }
  }

  await step('[real] capture control: activating the focus target produces a frame at the [mock] Runtime', async () => {
    const d = await activateAndCount('control')
    assert(d.target >= 1, `no frame for ${FOCUS_BUNDLE} (all new frames: ${d.all})`)
    return `${d.target} frame(s) for the target, ${d.all} in total`
  }, { skip: focusSkip })

  /** Wait until the trailing (deferred) captures of the previous step have landed. */
  async function quiesce(quietMs = 4000, maxMs = 20000) {
    const deadline = Date.now() + maxMs
    let last = runtime.frames.length
    let quietSince = Date.now()
    while (Date.now() < deadline) {
      await sleep(250)
      if (runtime.frames.length !== last) {
        last = runtime.frames.length
        quietSince = Date.now()
      } else if (Date.now() - quietSince >= quietMs) return true
    }
    return false
  }

  await step('[real] pause -> activation -> 0 frames from any app', async () => {
    const quiet = await quiesce()
    marks.push({ at: Date.now(), label: `pause: quiesced=${quiet}` })
    const before = ok(await lens('capture.status()'), 'capture.status').decisions
    ok(await lens(`capture.pause('now')`), 'capture.pause')
    marks.push({ at: Date.now(), label: 'pause: paused' })
    const d = await activateAndCount('paused')
    const after = ok(await lens('capture.status()'), 'capture.status').decisions
    ok(await lens('capture.resume()'), 'capture.resume')
    const dropped = (after['dropped:paused'] ?? 0) - (before['dropped:paused'] ?? 0)
    assert(d.all === 0, `${d.all} frame(s) while paused (${d.target} for the target; quiesced=${quiet}; decisions ${JSON.stringify(before)} -> ${JSON.stringify(after)})`)
    return `0 frames; ${dropped} event(s) dropped as paused`
  }, { skip: focusSkip })

  await step('[real] exclude the focus-target bundle -> activation -> 0 frames for it', async () => {
    ok(await lens(`capture.excludeAdd('bundleId', ${JSON.stringify(FOCUS_BUNDLE)})`), 'excludeAdd')
    const d = await activateAndCount('excluded')
    ok(await lens(`capture.excludeRemove('bundleId', ${JSON.stringify(FOCUS_BUNDLE)})`), 'excludeRemove')
    assert(d.target === 0, `${d.target} frame(s) for an excluded bundle`)
    return `0 frames for the target, ${d.all} for other apps`
  }, { skip: focusSkip })

  await step('[real] remove exclusion -> activation -> frames resume (control)', async () => {
    const d = await activateAndCount('control-2')
    assert(d.target >= 1, `no frame after removing the exclusion (all: ${d.all})`)
    return `${d.target} frame(s)`
  }, { skip: focusSkip })
  if (focus) {
    focus.child.kill('SIGTERM')
    focus = null
  }

  // ---- HET ----
  let tasks = []
  await step('[real] HET: tasks from tests/fixtures/het appear in the ledger', async () => {
    await page.waitFor(`window.lens.het.status().then((r) => r.ok && r.data.lastTickAt !== null && !r.data.running)`, 30000)
    tasks = ok(await lens('het.tasks(200)'), 'het.tasks')
    assert(tasks.length > 0, 'no HET tasks')
    const agents = [...new Set(tasks.map((t) => t.agent))]
    return `${tasks.length} tasks, agents ${agents.join(',')}`
  })

  await step('[real] HET: unassessed tasks are excluded from the total (assessor transport disabled)', async () => {
    const st = ok(await lens('het.status()'), 'het.status')
    // X3: main injects the agent_funding transport, but the assessor stays off by default.
    assert(st.transport === 'agent_funding' && st.assessor?.state === 'disabled', `transport ${st.transport} state ${st.assessor?.state}`)
    assert(tasks.every((t) => !t.counted && t.minutes === null), 'a task is counted without assessment')
    const p = ok(await lens(`het.period('2000-01-01T00:00:00.000Z', new Date().toISOString(), null, 200)`), 'het.period')
    assert(p.total_minutes_tenths === 0, `total ${p.total_minutes_tenths}`)
    assert(p.counts.counted === 0 && p.counts.tasks === tasks.length, `counts ${JSON.stringify(p.counts)}`)
    return `counts ${JSON.stringify(p.counts)}`
  })

  await step('[real] HET: correction not_agent moves a task to excluded and recomputes counts', async () => {
    const before = ok(await lens(`het.period('2000-01-01T00:00:00.000Z', new Date().toISOString(), null, 200)`), 'het.period').counts
    const t = tasks[0]
    const r = ok(await lens(`het.correct(${JSON.stringify(t.id)}, 'not_agent')`), 'het.correct')
    assert(r.changed === true, 'correction reported no change')
    const after = ok(await lens(`het.period('2000-01-01T00:00:00.000Z', new Date().toISOString(), null, 200)`), 'het.period').counts
    assert(after.excluded === before.excluded + 1, `excluded ${before.excluded} -> ${after.excluded}`)
    return `excluded ${before.excluded} -> ${after.excluded}`
  })

  await step('[real] Weekly Review export writes Markdown to the save dir', async () => {
    const monday = new Date(tasks[0].start)
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)) // local Monday 00:00
    monday.setHours(0, 0, 0, 0)
    const weekStart = monday.toISOString() // IPC schema: ISO datetime with offset
    const r = ok(await lens(`het.exportWeekly(${JSON.stringify(weekStart)})`), 'het.exportWeekly')
    assert(r.markdownPath && r.markdownPath.startsWith(dirs.exports) && fs.existsSync(r.markdownPath), `markdownPath ${r.markdownPath}`)
    const md = fs.readFileSync(r.markdownPath, 'utf8')
    assert(md.includes('Human Equivalent Time'), 'export lacks the HET definition')
    assert(r.total_minutes_tenths === 0, `unassessed work counted in the export: ${r.total_minutes_tenths}`)
    return `${path.basename(r.markdownPath)}, rows ${r.rows}`
  }, { skip: hetSeam ? undefined : 'PENDING: no LENS_E2E_SAVE_DIR seam in out/main/index.js (export would open a native save dialog)' })

  // ---- Round 2 pages / features ----
  // Navigation = a click on the sidebar button (no focus needed). Copy buttons are only checked
  // for presence: clicking them would write to the real system clipboard.
  const goPage = async (id) => {
    await page.evaluate(`document.querySelector('.nav-item[data-page=${id}]').click(), true`)
    await page.waitFor(`document.querySelector('.nav-item[data-page=${id}]')?.classList.contains('active')`)
  }
  const buttonsByText = (texts) =>
    page.evaluate(`(() => { const b = [...document.querySelectorAll('main button')].map((x) => x.textContent.trim()); return ${JSON.stringify(texts)}.map((t) => b.includes(t)) })()`)

  await step('[real] Today + [mock] recent_activity/behavior_patterns: page renders Next steps with the open checkbox; Copy / Export .md buttons present', async () => {
    await goPage('today')
    await page.waitFor(`[...document.querySelectorAll('main h3')].some((h) => h.textContent.trim() === 'Next steps')`, 20000)
    const has = await buttonsByText(['Copy', 'Export .md'])
    assert(has.every(Boolean), `buttons Copy/Export .md present: ${JSON.stringify(has)}`)
    const next = await page.evaluate(`document.querySelector('.lib-next')?.textContent ?? ''`)
    assert(next.includes('E2E 合成待办：整理测试报告'), `Next steps lacks the [mock] open item: ${next.slice(0, 200)}`)
    assert(next.includes('ent-e2e-1'), 'Next steps item lacks its source entry id')
    return 'Next steps lists the [mock] "- [ ]" item with source ⟨ent-e2e-1⟩'
  })

  await step('[real] Today: Export .md (button click) writes the brief into LENS_E2E_SAVE_DIR', async () => {
    const before = new Set(fs.readdirSync(dirs.exports))
    await page.evaluate(`[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Export .md').click(), true`)
    await page.waitFor(`[...document.querySelectorAll('.banner.ok')].some((b) => b.textContent.includes('Exported'))`, 10000)
    const added = fs.readdirSync(dirs.exports).filter((f) => !before.has(f))
    const md = added.find((f) => /^persome-brief-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    assert(md, `new files ${JSON.stringify(added)}`)
    const text = fs.readFileSync(path.join(dirs.exports, md), 'utf8')
    assert(text.includes('## 下一步') && text.includes('E2E 合成待办'), 'exported brief lacks 下一步 / the item')
    const mode = fs.statSync(path.join(dirs.exports, md)).mode & 0o777
    return `${md} (${text.length} chars, mode ${mode.toString(8)})`
  })

  await step('[real] Ask: 4 prompt cards with a copy button each and the no-LLM note (no network: see egress step)', async () => {
    await goPage('ask')
    await page.waitFor(`document.querySelectorAll('[data-testid^=ask-card-]').length > 0`)
    const r = await page.evaluate(`({
      cards: [...document.querySelectorAll('[data-testid^=ask-card-]')].map((e) => e.dataset.testid.replace('ask-card-', '')),
      copies: document.querySelectorAll('[data-testid^=ask-copy-]').length,
      notes: document.querySelectorAll('[data-testid=ask-llm-note]').length
    })`)
    assert(r.cards.length === 4 && r.copies === 4 && r.notes === 4, JSON.stringify(r))
    return `cards ${r.cards.join(', ')}`
  })

  await step('[real] Library + [mock] graph fixture: counts, Profile (Root + Faces in Runtime order), Skills (rt-weekly-report) render', async () => {
    const o = ok(await lens('library.overview()'), 'library.overview')
    assert(!o.graphError && !o.workflowError && !o.skillsError, `section errors ${JSON.stringify([o.graphError, o.workflowError, o.skillsError])}`)
    assert(o.counts.people === 1 && o.counts.projects === 1, `counts ${JSON.stringify(o.counts)}`)
    assert(o.portrait?.root?.signature?.startsWith('E2E 合成 Root'), `root ${JSON.stringify(o.portrait?.root)}`)
    assert(o.portrait.topFaces.map((f) => f.id).join(',') === 'face-e2e-a,face-e2e-b', `faces ${JSON.stringify(o.portrait.topFaces)}`)
    assert(o.skills.some((s) => s.id === SKILL_ID && s.origin === 'observed'), `skills ${JSON.stringify(o.skills.map((s) => [s.id, s.origin]))}`)
    await goPage('library')
    await page.waitFor(`[...document.querySelectorAll('main h3')].some((h) => h.textContent.trim() === 'Skills') && document.querySelector('.lib-skill-link') !== null`, 20000)
    const dom = await page.evaluate(`(() => {
      const cols = [...document.querySelectorAll('.lib-col')].map((c) => ({ h: c.querySelector('h3')?.textContent.trim(), chip: c.querySelector('.card-head .chip')?.textContent.trim(), text: c.textContent }))
      return { heads: cols.map((c) => c.h), cols }
    })()`)
    for (const h of ['Profile', 'Skills']) assert(dom.heads.includes(h), `columns ${JSON.stringify(dom.heads)}`)
    const portrait = dom.cols.find((c) => c.h === 'Profile').text
    assert(portrait.includes('E2E 合成 Root') && portrait.includes('E2E 合成画像 A') && portrait.includes('Points 2'), `Profile text ${portrait.slice(0, 300)}`)
    const skills = dom.cols.find((c) => c.h === 'Skills')
    assert(skills.text.includes(SKILL_ID), `Skills text ${skills.text.slice(0, 300)}`)
    return `columns ${dom.heads.join('/')}; counts ${JSON.stringify(o.counts)}; skill chip ${skills.chip}`
  })

  await step('[real] Import + [fixture] home (LENS_IMPORT_HOME): scan finds Claude Code + Codex; prepare stages redacted Markdown (dry run, no commit)', async () => {
    const scan = ok(await lens('importer.scan()'), 'importer.scan')
    assert(scan.roots.claudeCode && scan.roots.codex, `roots ${JSON.stringify(scan.roots)}`)
    const sources = new Set(scan.sessions.map((s) => s.source))
    assert(sources.has('claude-code') && sources.has('codex'), `sessions ${JSON.stringify(scan.sessions.map((s) => s.key))}`)
    const keys = scan.sessions.map((s) => s.key)
    const run = ok(await lens(`importer.prepare(${JSON.stringify(keys)})`), 'importer.prepare')
    assert(run.status === 'staged' && run.importCli === null, `run ${run.status} importCli ${JSON.stringify(run.importCli)}`)
    assert(run.documents.length === keys.length, `documents ${run.documents.length} for ${keys.length} keys`)
    const stagingDir = path.join(dirs.store, 'import', 'staging', run.runId)
    const staged = run.documents.map((d) => fs.readFileSync(path.join(stagingDir, d.file), 'utf8')).join('\n')
    for (const leak of ['sk-ant-api03-FAKE', 'AKIAIOSFODNN7EXAMPLE', 'ghp_FAKE', 'BEGIN OPENSSH PRIVATE KEY', 'PRIVATE THOUGHT', 'REASONING_MARKER', 'SIDECHAIN_MARKER']) {
      assert(!staged.includes(leak), `staged Markdown contains ${leak}`)
    }
    const d = ok(await lens(`importer.discard(${JSON.stringify(run.runId)})`), 'importer.discard')
    return `${scan.sessions.length} sessions; staged ${run.documents.length} docs, ${run.totals.redactions} redactions, no CLI call; discarded (stagingDeleted=${d.stagingDeleted})`
  })

  const [friendCard1, friendCard2] = friendArtifacts.cards
  const friendSkip = friendCard2 ? undefined : 'SKIP: friend pre-pass produced no signed cards'
  await step('[real] Peers: a card signed by the [real] friend identity verifies and is added via peers.importText', async () => {
    const r = ok(await lens(`peers.importText(${JSON.stringify(friendCard1.text)})`), 'peers.importText')
    assert(r.ok === true && r.outcome === 'added', `result ${JSON.stringify(r).slice(0, 300)}`)
    assert(r.peer.fingerprint === friendCard1.fp, `fingerprint ${r.peer.fingerprint}`)
    const list = ok(await lens('peers.list()'), 'peers.list')
    assert(list.peers.some((p) => p.fingerprint === friendCard1.fp), 'peer not listed')
    return `added ${friendCard1.fp}, verification ${r.peer.verification}`
  }, { skip: friendSkip })

  await step('[real] Peers: tampered copy of the friend card is rejected and not stored', async () => {
    const parsed = JSON.parse(friendCard2.text)
    const target = parsed.card ?? parsed
    target.issued_at = '2001-01-01T00:00:00.000Z'
    const r = ok(await lens(`peers.importText(${JSON.stringify(JSON.stringify(parsed))})`), 'peers.importText')
    assert(r.ok === false && r.reason === 'tampered', `result ${JSON.stringify(r).slice(0, 300)}`)
    const peer = ok(await lens(`peers.get(${JSON.stringify(friendCard1.fp)})`), 'peers.get')
    assert(peer.cardId === friendCard1.id, `stored card changed to ${peer.cardId}`)
    return `reason ${r.reason}`
  }, { skip: friendSkip })

  await step('[real] Peers subscription: LENS_E2E_PICK_DIR folder with the friend\'s newer card + skill -> sub-choose / sub-refresh imports; 2nd refresh -> duplicate', async () => {
    fs.writeFileSync(path.join(dirs.pick, 'friend.navaliacard'), friendCard2.text, { mode: 0o600 })
    if (friendArtifacts.skill) fs.copyFileSync(friendArtifacts.skill, path.join(dirs.pick, 'friend-skill.navaliaskill'))
    const st = ok(await lens('peers.subChoose()'), 'peers.subChoose')
    assert(st && st.enabled && fs.realpathSync(st.folder) === fs.realpathSync(dirs.pick), `status ${JSON.stringify(st)}`)
    const r1 = ok(await lens('peers.subRefresh()'), 'peers.subRefresh #1')
    const card1 = r1.files.find((f) => f.kind === 'card')
    assert(card1?.outcome === 'updated', `card outcome ${JSON.stringify(card1)}`)
    const skill1 = r1.files.find((f) => f.kind === 'skill')
    if (friendArtifacts.skill) assert(skill1 && skill1.outcome !== 'rejected' && skill1.outcome !== 'skipped', `skill ${JSON.stringify(skill1)}`)
    const peer = ok(await lens(`peers.get(${JSON.stringify(friendCard1.fp)})`), 'peers.get')
    assert(peer.cardId === friendCard2.id, `peer card ${peer.cardId}, expected ${friendCard2.id}`)
    const r2 = ok(await lens('peers.subRefresh()'), 'peers.subRefresh #2')
    const nonDup = r2.files.filter((f) => f.outcome !== 'duplicate')
    assert(r2.files.length === r1.files.length && nonDup.length === 0, `2nd refresh ${JSON.stringify(r2.files)}`)
    return `#1 card ${card1.outcome}, skill ${skill1 ? `${skill1.outcome}${skill1.reason ? `/${skill1.reason}` : ''} (${skill1.detail})` : 'n/a'}; #2 all ${r2.files.length} duplicate`
  }, { skip: friendSkip })

  await step('[real] .navaliaskill: exportSkill (own identity) -> LENS_E2E_SAVE_DIR -> importSkill via LENS_E2E_OPEN_FILE -> outcome reported', async () => {
    const ex = ok(await lens(`workflows.exportSkill(${JSON.stringify(SKILL_ID)})`), 'workflows.exportSkill')
    assert(ex.path && ex.path.startsWith(dirs.exports) && ex.path.endsWith('.navaliaskill') && fs.existsSync(ex.path), `path ${ex.path}`)
    fs.copyFileSync(ex.path, OPEN_FILE)
    const imp = await lens('workflows.importSkill()')
    if (!imp.ok) return `export ok (${path.basename(ex.path)}); import refused: ${imp.error.code} ${imp.error.message}`
    const it = imp.data.item
    assert(it.outcome === 'duplicate' || it.outcome === 'imported', `item ${JSON.stringify(it)}`)
    assert(imp.data.fingerprint === issued.signed.card.issuer.fingerprint, 'signer is not the own identity')
    // A second import of the same file must be a duplicate (package hash).
    const again = ok(await lens('workflows.importSkill()'), 'workflows.importSkill #2')
    assert(again.item.outcome === 'duplicate', `2nd import ${JSON.stringify(again.item)}`)
    return `export ${path.basename(ex.path)} (redacted=${JSON.stringify(ex.redacted)}); import #1 ${it.outcome} (id ${it.id}, detail ${it.detail}); import #2 ${again.item.outcome}`
  })

  await step('[real] backup + [mock] `persome model export`: LENS_E2E_PICK_DIR -> manifest; no key / grants / audit.db; Runtime token absent', async () => {
    const r = ok(await lens('backup.exportBackup({ withoutModel: false })'), 'backup.exportBackup')
    assert(!r.cancelled && r.path && fs.existsSync(path.join(r.path, 'manifest.json')), `result ${JSON.stringify(r).slice(0, 300)}`)
    assert(path.dirname(r.path) === dirs.pick || fs.realpathSync(path.dirname(r.path)) === fs.realpathSync(dirs.pick), `parent ${r.path}`)
    const manifest = JSON.parse(fs.readFileSync(path.join(r.path, 'manifest.json'), 'utf8'))
    const files = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(r.path)
    const rels = files.map((f) => path.relative(r.path, f))
    for (const bad of [/ed25519\.key\.enc$/, /(^|\/)grants\.json$/, /(^|\/)audit\.db/, /(^|\/)identity\//, /(^|\/)het\.db/]) {
      assert(!rels.some((x) => bad.test(x)), `forbidden file ${bad}: ${JSON.stringify(rels)}`)
    }
    const all = Buffer.concat(files.map((f) => fs.readFileSync(f)))
    assert(!all.includes(Buffer.from(runtimeToken)), 'Runtime token value found in the backup')
    assert(!all.includes(Buffer.from(token ?? 'no-broker-token-xx')), 'Broker bearer token found in the backup')
    assert(!all.includes(Buffer.from('PRIVATE KEY')), 'PEM private key header in the backup')
    assert(manifest.model_snapshot?.status && rels.includes('model-snapshot.json'), `model snapshot ${JSON.stringify(manifest.model_snapshot)}`)
    const modes = files.map((f) => fs.statSync(f).mode & 0o777)
    assert(modes.every((m) => m === 0o600), `file modes ${modes.map((m) => m.toString(8))}`)
    return `${path.basename(r.path)}: ${rels.length} files (${rels.filter((x) => x.startsWith('lens/')).length} under lens/), model_snapshot ${manifest.model_snapshot.status}; excluded ${r.excluded.map((e) => e.path ?? e).join(', ')}`
  })

  await step('[real] backup restore into the same store', async () => 'n/a', {
    skip: 'SKIP: optional; LENS_E2E_PICK_DIR is one fixed dir per process and is the export PARENT, while inspect() needs the backup dir itself (restore is covered by tests/backup/backup.test.ts)'
  })

  // ---- Egress ----
  await step(`[real] no non-loopback sockets over ${EGRESS_SECONDS} s (lsof, whole process tree, 0.5 s sampling)`, async () => {
    const deadline = Date.now() + EGRESS_SECONDS * 1000
    const bad = new Set()
    const seen = new Set()
    let samples = 0
    while (Date.now() < deadline) {
      const s = sampleSockets(app.child.pid)
      s.bad.forEach((b) => bad.add(b))
      s.seen.forEach((b) => seen.add(b))
      samples++
      await sleep(500)
    }
    assert(bad.size === 0, `non-loopback: ${[...bad].join(' | ')}`)
    return `${samples} samples; ${seen.size} distinct loopback endpoints`
  })
} finally {
  if (focus) focus.child.kill('SIGTERM')
  page?.close()
  const mainExited = await stopLens(app)
  fs.writeFileSync(
    path.join(tmp, 'results.json'),
    JSON.stringify({ results, marks, frames: runtime.frames.map((f) => (f.bundle_id === 'dev.navalia.e2e.focus' ? f : { ...f, app_name: '<other app>', bundle_id: '<other app>' })), runtimeRequests: runtime.requests, log: app.log() }, null, 2)
  )
  console.log(`main pass done${mainExited ? '' : ' (Lens ignored SIGTERM for 10 s; SIGKILL sent)'}`)
}

// ---------- HET passes with the [fixture] assessor ----------
const FIX = path.join(REPO, 'tests/fixtures/het')
const ALL_TIME = `'2000-01-01T00:00:00.000Z', new Date().toISOString(), null, 200`

async function withHetInstance(name, fixture, body) {
  const d = { store: path.join(tmp, name, 'store'), userData: path.join(tmp, name, 'user-data') }
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true, mode: 0o700 })
  const inst = launchLens({
    ...d,
    env: { LENS_HET_FAKE_ASSESSOR: path.join(FIX, fixture), LENS_HET_CLAUDE_ROOT: path.join(FIX, 'claude'), LENS_HET_CODEX_ROOT: '' }
  })
  let pg = null
  try {
    pg = await connectPage(await waitForPage(await waitForDevToolsPort(d.userData)))
    await pg.waitFor(`typeof window.lens === 'object'`)
    await pg.waitFor(`window.lens.het.status().then((r) => r.ok && r.data.lastTickAt !== null && !r.data.running)`, 30000)
    const call = (expr) => pg.evaluate(`window.lens.${expr}`)
    await body(call)
  } finally {
    pg?.close()
    const exited = await stopLens(inst)
    fs.writeFileSync(path.join(tmp, name, 'log.txt'), inst.log())
    if (!exited) console.log(`${name}: Lens ignored SIGTERM for 10 s; SIGKILL sent`)
  }
}
const tenths = async (call) => ok(await call(`het.period(${ALL_TIME})`), 'het.period')

try {
  await withHetInstance('het-fixture', 'fake-assessor.json', async (call) => {
    await step('[real] ledger + [fixture] assessor: transport is "fixture"', async () => {
      const st = ok(await call('het.status()'), 'het.status')
      assert(st.transport === 'fixture', `transport ${st.transport}`)
      return `transport ${st.transport}`
    })
    await step('[real] ledger + [fixture] assessor: total after the tick is 42.8 min', async () => {
      const p = await tenths(call)
      assert(p.total_minutes_tenths === 428, `total ${p.total_minutes_tenths / 10} min, counts ${JSON.stringify(p.counts)}`)
      return `42.8 min, counts ${JSON.stringify(p.counts)}`
    })
    await step('[real] ledger + [fixture] assessor: accepted on het_0ebde115074148232698 -> 49.5 min', async () => {
      ok(await call(`het.correct('het_0ebde115074148232698', 'accepted')`), 'het.correct')
      const p = await tenths(call)
      assert(p.total_minutes_tenths === 495, `total ${p.total_minutes_tenths / 10} min`)
      return '49.5 min'
    })
    await step('[real] ledger + [fixture] assessor: not_agent on het_cf6caafab90e4f757cc3 -> 46.1 min', async () => {
      ok(await call(`het.correct('het_cf6caafab90e4f757cc3', 'not_agent')`), 'het.correct')
      const p = await tenths(call)
      assert(p.total_minutes_tenths === 461, `total ${p.total_minutes_tenths / 10} min`)
      const sum = p.tasks.filter((t) => t.counted).reduce((a, t) => a + t.minutes_tenths, 0)
      assert(sum === p.total_minutes_tenths, `row sum ${sum} != total ${p.total_minutes_tenths}`)
      return `46.1 min (= sum of counted rows)`
    })
  })
} catch (error) {
  record('FAIL', '[real] ledger + [fixture] assessor: instance', error.message)
}

try {
  await withHetInstance('het-fixture-invalid', 'fake-assessor-invalid.json', async (call) => {
    await step('[real] ledger + [fixture] assessor (invalid verdicts): 0 min, all needs_assessment, invalid:minutes_forbidden', async () => {
      const st = ok(await call('het.status()'), 'het.status')
      assert(st.transport === 'fixture', `transport ${st.transport}`)
      const p = await tenths(call)
      assert(p.tasks.length > 0, 'no tasks')
      assert(p.total_minutes_tenths === 0, `total ${p.total_minutes_tenths / 10} min`)
      const bad = p.tasks.filter((t) => t.status !== 'needs_assessment' || t.last_error !== 'invalid:minutes_forbidden')
      assert(bad.length === 0, `unexpected rows ${JSON.stringify(bad.map((t) => [t.id, t.status, t.last_error]))}`)
      return `${p.tasks.length} tasks, 0 min, last_error invalid:minutes_forbidden`
    })
  })
} catch (error) {
  record('FAIL', '[real] ledger + [fixture] assessor (invalid): instance', error.message)
}

await runtime.close()
console.log(`artifacts: ${tmp}`)
const tally = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})
console.log(`summary: ${JSON.stringify(tally)}`)
const incomplete = (tally.SKIP ?? 0) + (tally.PENDING ?? 0) > 0
process.exit(failed ? 1 : incomplete && process.env.E2E_STRICT === '1' ? 2 : 0)
