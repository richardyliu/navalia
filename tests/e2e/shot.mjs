#!/usr/bin/env node
// Ad-hoc visual check: boots Lens against the e2e [mock] Runtime, visits a few pages and writes
// full-window screenshots to /tmp/lens-shots. Not part of the test suite; run after `npm run build`.
//   node tests/e2e/shot.mjs
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectPage, waitForDevToolsPort, waitForPage } from './cdp.mjs'
import { startMockRuntime } from './mock-runtime-e2e.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const OUT = path.join('/tmp', 'lens-shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-shots-'))
const persomeRoot = path.join(tmp, 'persome')
const store = path.join(tmp, 'store')
const userData = path.join(tmp, 'user-data')
const agentHome = path.join(tmp, 'agent-home')
const agentApps = path.join(tmp, 'agent-apps')
for (const d of [persomeRoot, store, userData, agentHome, agentApps]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(persomeRoot, 'memory', 'skills'), { recursive: true })
fs.copyFileSync(
  path.join(REPO, 'tests/workflows/fixtures/runtime/memory/skills/skill-weekly-report.md'),
  path.join(persomeRoot, 'memory', 'skills', 'skill-weekly-report.md')
)
fs.writeFileSync(
  path.join(store, 'onboarding.json'),
  JSON.stringify({ version: 1, outcome: 'skipped', lastStep: 'welcome', completedAt: null, skippedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }) + '\n',
  { mode: 0o600 }
)

const token = randomBytes(24).toString('hex')
const runtime = await startMockRuntime({ token })
fs.writeFileSync(path.join(persomeRoot, 'config.toml'), `[capture]\nsource = "ingest"\n\n[mcp]\nport = ${runtime.port}\n`)
fs.writeFileSync(path.join(persomeRoot, 'env'), `PERSOME_LOCAL_API_TOKEN=${token}\n`, { mode: 0o600 })

const electron = execFileSync(process.execPath, ['-p', 'require("electron")'], { cwd: REPO, encoding: 'utf8' }).trim()
const env = { ...process.env, PERSOME_ROOT: persomeRoot, PERSOME_BIN: path.join(HERE, 'mock-persome-mcp.mjs'), LENS_STORE_ROOT: store, LENS_AGENT_HOME: agentHome, LENS_AGENT_APPS: agentApps }
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LENS_SCREENSHOT', 'NODE_OPTIONS']) delete env[k]
const child = spawn(electron, [REPO, `--user-data-dir=${userData}`, '--remote-debugging-port=0'], { env, stdio: 'ignore', detached: false })
const cleanup = () => {
  try { child.kill('SIGTERM') } catch {}
  void runtime.close?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
process.on('exit', cleanup)

const port = await waitForDevToolsPort(userData)
const page = await waitForPage(port)
const pg = await connectPage(page)
await pg.waitFor(`typeof window.lens === 'object' && document.querySelector('.nav-item') !== null`)
// Host theme is the developer's macOS setting; pin light for the base shots.
await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

async function shot(name) {
  await sleep(700)
  const { data } = await pg.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
  console.log('shot', name)
}

async function go(id) {
  await pg.evaluate(`document.querySelector('.nav-item[data-page=${id}]').click(), true`)
  await pg.waitFor(`document.querySelector('.nav-item[data-page=${id}]')?.classList.contains('active')`)
}

await shot('01-home-light')
await go('today')
await shot('02-today')
await go('model')
await shot('03-model')
await go('settings')
await shot('04-settings')
await go('overview')
await shot('05-overview')

// Command palette
await pg.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 4, commands: [] })
await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 4, commands: [] })
await sleep(500)
await shot('06-palette')
await pg.evaluate(`document.querySelector('.palette') && (document.querySelector('.palette').closest('[data-base-ui-portal]')?.click(), true)`)
await pg.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })

// Dark theme on Home
await go('home')
await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await shot('07-home-dark')

pg.close()
console.log('done ->', OUT)
process.exit(0)
