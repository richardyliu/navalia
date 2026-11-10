// S1-FULL Phase 3 gate: Lens meetings service against the REAL `cloud/` server (child process,
// CLOUD_STT_MODE=mock). 2 × 30 s chunks ("1 minute") → transcript → Markdown → `persome import-data`
// into a TEMP PERSOME_ROOT → delete on both sides. No microphone (chunk bytes are synthetic; mock
// STT does not decode audio), no real STT key.
//
// The import uses a CLI test double by default. Opt in to the real installed CLI (still a temp
// PERSOME_ROOT, never ~/.persome, `--no-build`, no LLM):
//   LENS_IMPORT_REAL_PERSOME=$HOME/.local/bin/persome npx vitest run tests/cloud/e2e-meetings-real-server.test.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMeetingsService } from '../../src/main/cloud/meetings'
import { createMicArm, micPermissionDecision } from '../../src/main/cloud/meetings-mic-gate'
import { createCloudService } from '../../src/main/cloud/service'
import { fakeBox, testIdentity } from './helpers'

const PREFIX = 'lens-meet-gate-'
const REAL_BIN = process.env.LENS_IMPORT_REAL_PERSOME
const TITLE = '周会 Gate-3 机密标题'
const roots: string[] = []
let child: ChildProcess
let origin: string
let audioDir: string
let serverOut = ''

function temp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${label}-`))
  roots.push(d)
  return d
}

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

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
}

/** Test double of the `persome` CLI: records argv + PERSOME_ROOT + staged files, prints a real-format receipt. */
function fakePersome(dir: string): string {
  const bin = path.join(dir, 'persome')
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > "$PERSOME_ROOT/argv.txt"
dir=""; prev=""
for a in "$@"; do if [ "$prev" = "--path" ]; then dir="$a"; fi; prev="$a"; done
cat "$dir"/*.md > "$PERSOME_ROOT/imported.md"
n=$(find "$dir" -name '*.md' | wc -l | tr -d ' ')
printf 'Imported %s new/changed document(s); 0 unchanged, 0 skipped.\\n' "$n"
`
  )
  fs.chmodSync(bin, 0o755)
  return bin
}

beforeAll(async () => {
  const dir = temp('server')
  audioDir = path.join(dir, 'audio')
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve('cloud'),
    env: { PATH: process.env.PATH, PORT: String(port), CLOUD_DB_PATH: path.join(dir, 'db', 'cloud.db'), CLOUD_PUBLIC_ORIGIN: origin, CLOUD_STT_MODE: 'mock', CLOUD_AUDIO_DIR: audioDir },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b) => (serverOut += String(b)))
  child.stderr?.on('data', (b) => (serverOut += String(b)))
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`cloud server did not start:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}, 30_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  for (const d of roots.splice(0)) {
    if (!path.basename(d).startsWith(PREFIX)) throw new Error(`refusing to delete ${d}`)
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('Phase 3 gate: meeting 1 min → transcript → Runtime import → delete (real server, mock STT)', () => {
  it('consent required; mic gated; chunks uploaded; audio deleted server + local; imported; deleted both sides', { timeout: 120_000 }, async () => {
    const store = path.join(temp('store'), 'store')
    const runtimeRoot = temp('runtime')
    expect(runtimeRoot.startsWith(path.join(os.homedir(), '.persome'))).toBe(false)
    const bin = REAL_BIN ?? fakePersome(temp('bin'))

    const id = testIdentity()
    const cloud = createCloudService({ storeRoot: store, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true, nativeConfirm: async () => true })
    await cloud.configure({ enabled: true, baseUrl: origin, confirm: true })
    await cloud.signIn()

    let confirmAnswer = false
    const confirms: string[] = []
    const micArm = createMicArm()
    const isAppUrl = (u: string | undefined | null): boolean => u === 'app://lens/index.html'
    const published: Array<{ id: string; items: Array<{ id: string; evidence: string }> }> = []
    const svc = createMeetingsService({
      storeRoot: store,
      cloud,
      micArm,
      nativeConfirm: async (_s, o) => (confirms.push(o.message), confirmAnswer),
      askForMediaAccess: async () => true,
      runtimeRoot: () => runtimeRoot,
      persomeBin: () => bin,
      tmpRoot: temp('import'),
      timeZone: 'UTC',
      pollInitialMs: 50,
      pollMaxMs: 200,
      pollMaxAttempts: 200,
      onTranscriptReady: (id, items) => published.push({ id, items })
    })
    const mic = (types: string[]): boolean => micPermissionDecision({ permission: 'media', mediaTypes: types, requestingUrl: 'app://lens/index.html', isAppUrl, armed: micArm.isArmed() })

    // No consent ⇒ nothing created, mic stays denied.
    expect(mic(['audio'])).toBe(false)
    await expect(svc.start({ title: TITLE, participantsInformed: false as unknown as true })).rejects.toBeTruthy()
    await expect(svc.start({ title: TITLE, participantsInformed: true })).rejects.toBeTruthy() // native dialog declined
    expect(mic(['audio'])).toBe(false)
    expect(svc.list()).toHaveLength(0)

    confirmAnswer = true
    const started = await svc.start({ title: TITLE, participantsInformed: true, languageHints: ['zh'] })
    const mid = started.meetingId ?? (started as unknown as { meta: { id: string } }).meta?.id
    expect(typeof mid).toBe('string')
    expect(mic(['audio'])).toBe(true)
    expect(mic(['video'])).toBe(false)
    expect(mic(['audio', 'video'])).toBe(false)
    expect(micPermissionDecision({ permission: 'media', mediaTypes: ['audio'], requestingUrl: 'https://evil.example', isAppUrl, armed: micArm.isArmed() })).toBe(false)

    // "1 minute": two self-contained 30 s chunks.
    for (const seq of [0, 1]) svc.chunk({ meetingId: mid, seq, mime: 'audio/webm;codecs=opus', durationMs: 30_000, data: new Uint8Array(randomBytes(48_000)) })
    svc.stop({ meetingId: mid, chunks: 2 })
    expect(mic(['audio'])).toBe(false)
    await svc.idle(mid)

    const d = svc.get(mid)
    expect(d.meta.localStatus).toBe('ready')
    // C17 publisher: once, ids + time spans only (no title / text).
    expect(published).toEqual([{ id: mid, items: [{ id: '0', evidence: '0-30000' }, { id: '1', evidence: '30000-60000' }] }])
    expect(d.meta.durationMs).toBe(60_000)
    expect(d.transcript?.segments.map((s) => [s.start_ms, s.end_ms])).toEqual([
      [0, 30_000],
      [30_000, 60_000]
    ])
    // Audio deleted on the server after transcription, and locally once ready.
    expect(filesUnder(audioDir)).toEqual([])
    expect(d.meta.audioDeleted).toBe(true)
    expect(filesUnder(path.join(store, 'meetings', mid)).some((f) => /\.(webm|ogg|wav)$/.test(f))).toBe(false)

    // Transcript → Markdown → persome import-data (temp PERSOME_ROOT).
    const md = svc.markdownPreview(mid)
    expect(md.markdown).toContain('第 2 段')
    const imp = await svc.importToRuntime(md.previewId)
    console.log(JSON.stringify({ realCli: Boolean(REAL_BIN), imp, runtimeRootFiles: filesUnder(runtimeRoot).slice(0, 20) }, null, 2))
    expect(imp.ok).toBe(true)
    expect(imp.exitCode).toBe(0)
    if (!REAL_BIN) {
      expect(fs.readFileSync(path.join(runtimeRoot, 'argv.txt'), 'utf8').trim().split('\n').slice(0, 3)).toEqual(['import-data', '--source', 'folder'])
      expect(fs.readFileSync(path.join(runtimeRoot, 'imported.md'), 'utf8')).toBe(md.markdown)
    }
    expect(imp.counts?.imported).toBe(1)

    // Delete: server 404 afterwards, local folder gone, honest note about what stays in the Runtime.
    const del = await svc.delete({ meetingId: mid })
    expect(del).toMatchObject({ serverDeleted: true, localDeleted: true, runtimeRemains: true })
    expect(del.runtimeNote).toBeTruthy()
    expect(fs.existsSync(path.join(store, 'meetings', mid))).toBe(false)
    await expect(cloud.client.requestJson('GET', `/v1/meetings/${mid}`, undefined, z.unknown())).rejects.toMatchObject({ code: expect.any(String) })
    const list = await cloud.client.requestJson('GET', '/v1/meetings', undefined, z.unknown())
    expect(JSON.stringify(list)).not.toContain(mid)

    await new Promise((r) => setTimeout(r, 200))
    expect(serverOut.includes(TITLE)).toBe(false)
    expect(serverOut.includes('mock 转写')).toBe(false)
  })
})
