#!/usr/bin/env node
// [mock] Runtime as a standalone process for shell-driven checks.
//   node tests/e2e/mock-runtime-cli.mjs <persome-root dir> <summary.json>
// Writes <root>/config.toml (source = "ingest", [mcp] port) and <root>/env (token), then
// serves until SIGTERM/SIGINT, when it writes request and frame counts to <summary.json>.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { startMockRuntime } from './mock-runtime-e2e.mjs'

const [root, summaryFile] = process.argv.slice(2)
if (!root || !summaryFile) {
  console.error('usage: mock-runtime-cli.mjs <persome-root> <summary.json>')
  process.exit(2)
}
const token = randomBytes(24).toString('hex')
const rt = await startMockRuntime({ token })
fs.mkdirSync(root, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(root, 'config.toml'), `[capture]\nsource = "ingest"\n\n[mcp]\nport = ${rt.port}\n`)
fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${token}\n`, { mode: 0o600 })
console.log(`MOCK_RUNTIME_READY ${rt.port}`)
const done = async () => {
  const byRoute = {}
  for (const r of rt.requests) byRoute[r] = (byRoute[r] ?? 0) + 1
  // Only bundle ids the checks reason about are kept; anything else on the desktop is redacted.
  const KEEP = new Set(['dev.navalia.e2e.focus', 'dev.navalia.app', 'com.github.Electron', 'com.apple.finder'])
  const frames = rt.frames.map((f) => ({ trigger: f.trigger, bundle_id: KEEP.has(f.bundle_id) ? f.bundle_id : '<other app>' }))
  fs.writeFileSync(summaryFile, JSON.stringify({ port: rt.port, byRoute, frames }, null, 2))
  await rt.close()
  process.exit(0)
}
process.on('SIGTERM', done)
process.on('SIGINT', done)
