// Fixture `persome` CLI for OG-06 Recovery tests (process boundary). Only ever run against a temp
// PERSOME_ROOT. Behaviour per subcommand; `<root>/fixture-mode` selects doctor variants.
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const root = process.env.PERSOME_ROOT
if (!root || !root.includes('lens-recovery-')) {
  process.stderr.write('refusing: PERSOME_ROOT is not a recovery test root\n')
  process.exit(3)
}
const cmd = process.argv[2]
const read = (f) => {
  try {
    return fs.readFileSync(path.join(root, f), 'utf8')
  } catch {
    return ''
  }
}
const token = (read('env').match(/PERSOME_LOCAL_API_TOKEN=(\S+)/) || [])[1] || ''
const port = Number((read('config.toml').match(/port\s*=\s*(\d+)/) || [])[1] || 0)
const mode = read('fixture-mode').trim()
fs.appendFileSync(path.join(root, 'calls.log'), `${cmd} ${process.argv.slice(3).join(' ')}\n`)

// OG4: write `lines` KiB to stdout honouring backpressure (so a parent that stops reading, or
// kills on volume, keeps us from ever reaching `done`), then call `done`.
function flood(lines, done) {
  const line = 'y'.repeat(1023) + '\n'
  let n = 0
  ;(function next() {
    while (n < lines) {
      n++
      if (!process.stdout.write(line)) return void process.stdout.once('drain', next)
    }
    done()
  })()
}

if (cmd === 'doctor') {
  fs.writeFileSync(path.join(root, 'doctor.pid'), String(process.pid))
  if (mode === 'hang') {
    process.stdout.write('✓ env file  present\n')
    setInterval(() => {}, 1000)
  } else if (mode === 'flood') {
    const line = 'x'.repeat(1023) + '\n'
    for (let i = 0; i < 1024; i++) process.stdout.write(line)
  } else {
    process.stdout.write('\u001b[32m✓\u001b[0m env file  present (0600)\n')
    process.stdout.write(`✓ PERSOME_LOCAL_API_TOKEN  set (owner-local bearer token)\n`)
    process.stdout.write(`✗ provider  Authorization: Bearer ${token}\n`)
    process.stdout.write(`⚠ leaked  PERSOME_LOCAL_API_TOKEN=${token} raw=${token} key=sk-ant-api03-AAAABBBBCCCCDDDDEEEE\n`)
    process.stderr.write(`debug token ${token}\n`)
    process.exit(1)
  }
} else if (cmd === 'start') {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/health') return send(200, { success: true, data: { status: 'ok', index: 'ok', capture_pipeline: 'ok' } })
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { success: false, data: null })
    if (req.url.startsWith('/status')) return send(200, { success: true, data: { version: '9.9.9-fixture', index_health: { status: 'ok' } } })
    send(404, { success: false, data: null })
  })
  server.listen(port, '127.0.0.1', () => fs.writeFileSync(path.join(root, 'runtime.pid'), String(process.pid)))
} else if (cmd === 'stop') {
  const pid = Number(read('runtime.pid'))
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
    fs.rmSync(path.join(root, 'runtime.pid'), { force: true })
  }
  process.stdout.write('stopped\n')
} else if (cmd === 'rebuild-captures-index') {
  if (read('runtime.pid')) {
    process.stderr.write('Runtime is running; stop it first\n')
    process.exit(1)
  }
  fs.appendFileSync(path.join(root, 'rebuild.log'), `${process.argv.slice(3).join(' ')}\n`)
  if (mode === 'flood-rebuild') {
    process.stdout.write(`start auth=Bearer ${token}\n`)
    // > 1 MiB, then the marker: proves the run was not killed for output volume.
    flood(1536, () => {
      fs.writeFileSync(path.join(root, 'rebuild.marker'), 'done')
      process.stdout.write(`Indexed 3 captures (auth=Bearer ${token})\n`)
    })
  } else {
    process.stdout.write(`Indexed 3 captures (auth=Bearer ${token})\n`)
  }
} else if (cmd === 'clean') {
  if (read('runtime.pid')) {
    process.stderr.write('Runtime is running; stop it first\n')
    process.exit(1)
  }
  process.stdout.write(`cleaning ${process.argv[3]} token=${token}\n`)
  flood(1536, () => {
    fs.writeFileSync(path.join(root, 'clean.marker'), process.argv.slice(3).join(' '))
    process.stderr.write(`cleaned ${process.argv[3]} (auth=Bearer ${token})\n`)
  })
} else {
  process.stderr.write(`unknown command ${cmd}\n`)
  process.exit(2)
}
