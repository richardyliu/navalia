import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { psProbe, warnSkip } from '../_support/host-probe'

/**
 * The OG-02 manual-check helper must only READ and must REDACT. Run it against
 * a synthetic temp root and prove: no file changes, no token / key / title /
 * pixel bytes in the output, and non-temp roots are refused by default.
 */

const SCRIPT = path.resolve(__dirname, 'fixtures/og02_cap_readonly.py')
const hasPython = spawnSync('python3', ['-I', '-c', 'print(1)']).status === 0
// S1-R4-11: `all` includes the `ps` subcommand (/bin/ps -axo). Restricted sandboxes deny it; probe once.
const PS = psProbe()
warnSkip("og02_cap_readonly.py 'all' (runs /bin/ps)", PS)
const TOKEN = `tok_${randomBytes(24).toString('hex')}`
const KEY = randomBytes(32).toString('hex')
const TITLE = 'Quarterly Secret Plan — Draft'
const roots: string[] = []
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function makeRoot(): string {
  fs.mkdirSync('/tmp/persome-test', { recursive: true })
  const root = fs.mkdtempSync('/tmp/persome-test/og02-script-')
  roots.push(root)
  fs.writeFileSync(path.join(root, 'config.toml'), '[capture]\nsource = "ingest"\nscreenshot_retention_hours = 24\n[mcp]\nport = 8761\n')
  fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${TOKEN}\nPERSOME_SCREENSHOT_KEY=${KEY}\n`, { mode: 0o600 })
  fs.writeFileSync(
    path.join(root, '.runtime-state.json'),
    JSON.stringify({ capture_mode: 'ingest', permissions: { accessibility: 'not_applicable', screen_recording: 'not_applicable' }, phase: 'ready' })
  )
  fs.mkdirSync(path.join(root, 'logs'))
  fs.writeFileSync(
    path.join(root, 'logs/capture.log'),
    `{"message": "capture source=ingest — OS capture disabled (no watcher / no screenshot grab); Authorization: Bearer ${TOKEN} PERSOME_SCREENSHOT_KEY=${KEY}"}\n`
  )
  const buf = path.join(root, 'capture-buffer')
  fs.mkdirSync(buf)
  const frame = (ts: string, event: string, shot: Record<string, unknown> | null, url: string | null) => ({
    timestamp: ts,
    capture_source: 'ingest',
    trigger: { event_type: event },
    window_meta: { app_name: 'Safari', title: TITLE, bundle_id: 'com.apple.Safari' },
    url,
    visible_text: `private body text ${TITLE}`,
    ...(shot ? { screenshot: shot } : {})
  })
  const write = (name: string, d: unknown) => fs.writeFileSync(path.join(buf, name), JSON.stringify(d), { mode: 0o600 })
  write('2026-11-05T18-00-00.000000p00-00.json', frame('2026-11-05T18:00:00+00:00', 'AXApplicationActivated', { image_base64: 'PSOMEGCM1:AAAA', screenshot_enc: true }, 'https://example.com/private/path?q=secret'))
  write('2026-11-05T18-10-00.000000p00-00.json', frame('2026-11-05T18:10:00+00:00', 'heartbeat', { image_base64: '/9j/4AAQSkZJRgABAQ' }, null))
  write('2026-11-05T18-20-00.000000p00-00.json', frame('2026-11-05T18:20:00+00:00', 'heartbeat', null, null))
  return root
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const st = fs.statSync(p)
        out[path.relative(root, p)] = `${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:${st.mtimeMs}:${st.mode}`
      }
    }
  }
  walk(root)
  return out
}

function run(args: string[]) {
  return spawnSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 })
}

describe.skipIf(!hasPython)('og02_cap_readonly.py', () => {
  it('reads without modifying anything and redacts secrets, titles, paths and pixels', () => {
    const root = makeRoot()
    const before = snapshot(root)
    const outputs: string[] = []
    // `all` (= every subcommand incl. /bin/ps) runs in its own test below so a denied ps skips only that.
    for (const cmd of ['config', 'frames', 'heartbeat', 'crypto', 'retention']) {
      const r = run([cmd, '--root', root])
      expect(r.status, `${cmd}: ${r.stderr}`).toBe(0)
      outputs.push(r.stdout)
    }
    expect(snapshot(root)).toEqual(before)
    const text = outputs.join('\n')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(TITLE)
    expect(text).not.toContain('private body text')
    expect(text).not.toContain('/private/path')
    expect(text).not.toContain('/9j/4AAQ')
    expect(text).toContain('https://example.com')
    expect(text).toContain('capture source=ingest')
    expect(text).toContain('PERSOME_SCREENSHOT_KEY present=True')
    expect(text).toContain("mode=0o600")

    const crypto = JSON.parse(run(['crypto', '--root', root]).stdout)
    expect(crypto).toMatchObject({ frames: 3, with_screenshot: 2, encrypted_PSOMEGCM1: 1, plaintext_screenshots: 1, files_with_plaintext_jpeg_base64: 1, files_not_0600: 0 })
    const frames = JSON.parse(run(['frames', '--root', root]).stdout)
    expect(frames).toMatchObject({ frames: 3, by_trigger: { AXApplicationActivated: 1, heartbeat: 2 }, capture_source_values: { ingest: 3 }, frames_missing_app_bundle_title_or_timestamp: [] })
    const hb = JSON.parse(run(['heartbeat', '--root', root]).stdout)
    expect(hb.seconds_since_previous_frame).toEqual([600, 600])
  })

  it.skipIf(!PS.ok)(`'all' (includes /bin/ps) also exits 0 and redacts${PS.ok ? '' : ` — skipped: ${PS.reason}`}`, () => {
    const root = makeRoot()
    const before = snapshot(root)
    const r = run(['all', '--root', root])
    expect(r.status, r.stderr).toBe(0)
    expect(snapshot(root)).toEqual(before)
    for (const secret of [TOKEN, KEY, TITLE, 'private body text', '/private/path', '/9j/4AAQ']) expect(r.stdout).not.toContain(secret)
    expect(r.stdout).toContain('capture source=ingest')
    expect(r.stdout).toContain('CAP-01 part 1: process view')
  })

  it('refuses a non-temp root unless --real-root-readonly is given', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'og02-not-temp-'))
    roots.push(other)
    const r = run(['config', '--root', other])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('refusing root')
  })
})
