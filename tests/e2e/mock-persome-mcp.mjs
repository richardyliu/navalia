#!/usr/bin/env node
// [mock] `persome` CLI stand-in. Synthetic data only.
//   persome mcp                        stdio, newline-delimited JSON-RPC (Broker backend + lens:mcp:*)
//   persome model export --out <file>  writes a small synthetic, already-redacted snapshot (backup E2E)
// Lens main spawns PERSOME_BIN (execFile, no shell).
import fs from 'node:fs'
import readline from 'node:readline'

if (process.argv[2] === 'model' && process.argv[3] === 'export') {
  const i = process.argv.indexOf('--out')
  const out = i > 0 ? process.argv[i + 1] : null
  if (!out || process.argv.includes('--raw')) {
    process.stderr.write('mock-persome: model export needs --out and never --raw here\n')
    process.exit(2)
  }
  const snapshot = { format: 'persome.model-export', mock: true, redacted: true, model: { points: 2, faces: 2, root: 'E2E 合成 Root' } }
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(`exported to ${out}\n`)
  process.exit(0)
}
if (process.argv[2] !== 'mcp') {
  process.stderr.write('mock-persome-mcp: only "mcp" and "model export" are supported\n')
  process.exit(2)
}
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const TOOLS = {
  search: (args) =>
    text({
      query: args.query,
      results: [
        { id: 'pt-demo-1', path: 'demo/preferences.md', content: 'Demo: prefers small, verifiable steps.', score: 0.9 },
        { id: 'pt-demo-2', path: 'demo/project.md', content: 'Demo: Lens is a local, login-free viewer.', score: 0.8 }
      ]
    }),
  current_context: () => text({ app: 'Demo Editor', window: 'demo.md', activity: 'editing' }),
  // Today brief: one entry timestamped "now" with an open checkbox -> 下一步 has a record item.
  recent_activity: () =>
    text({
      count: 1,
      entries: [
        { id: 'ent-e2e-1', path: 'events/e2e-demo.md', timestamp: new Date().toISOString(), content: 'E2E 合成记录\n- [ ] E2E 合成待办：整理测试报告' }
      ]
    }),
  behavior_patterns: () =>
    text({
      root: { signature: 'E2E 合成 Root：一个重视证据链的本地优先构建者。', confidence: 0.75 },
      faces: [{ signature: 'E2E 合成画像 A：偏好本地优先工具。', observations: 9, confidence: 0.8 }],
      skills: [],
      rendered: ''
    })
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // notification
  if (msg.method === 'initialize') {
    return out({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-persome', version: '0.0.0' } } })
  }
  if (msg.method === 'tools/list') return out({ id: msg.id, result: { tools: Object.keys(TOOLS).map((name) => ({ name, inputSchema: { type: 'object' } })) } })
  if (msg.method === 'tools/call') {
    const fn = TOOLS[msg.params?.name]
    if (!fn) return out({ id: msg.id, error: { code: -32601, message: `unknown tool ${msg.params?.name}` } })
    return out({ id: msg.id, result: fn(msg.params?.arguments ?? {}) })
  }
  out({ id: msg.id, error: { code: -32601, message: `unsupported ${msg.method}` } })
})
