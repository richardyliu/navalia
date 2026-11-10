import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadNative } from '../../src/main/capture/native'
import { FakeClock } from './fake-clock'
import { canvasTree, cleanupRoots, epochClock, FAKE_JPEG, fakeNative, runPipeline, safariTree, type Posted } from './og02-harness'

/**
 * OG-02 cross-boundary check: the exact bytes Lens POSTs are run through the
 * OSS Runtime's own CaptureIngestBody model and ingest pipeline
 * (build_ingest_capture -> _finalize_capture -> S1 enrich -> _write_capture,
 * cleanup_buffer) from the read-only personal-model checkout, with a fresh
 * /tmp/persome-test root and a throwaway screenshot key. Skips when the
 * checkout or its venv is absent. Never uses ~/.persome.
 */

const OSS = path.join(os.homedir(), 'Documents/GitHub/personal-model')
const PY = path.join(OSS, '.venv/bin/python')
const ORACLE = path.join(__dirname, 'runtime_ingest_oracle.py')
const available = fs.existsSync(PY) && fs.existsSync(path.join(OSS, 'src/persome/capture/scheduler.py'))
const EPOCH = Date.UTC(2026, 10, 5, 18, 0, 0)
const JPEG_B64 = FAKE_JPEG.toString('base64')
const URL_ = 'https://example.com/'
const FIX = path.resolve(__dirname, '../../native/fixtures/ax')

const tempRoots: string[] = []
afterAll(() => {
  cleanupRoots()
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true })
})

function runOracle(job: unknown, withKey: boolean): Record<string, any> {
  fs.mkdirSync('/tmp/persome-test', { recursive: true })
  const root = fs.mkdtempSync('/tmp/persome-test/og02-oracle-')
  tempRoots.push(root)
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root, // nothing in the Runtime may resolve the real home
    PERSOME_ROOT: root,
    PERSOME_LLM_MOCK: '1',
    TMPDIR: root
  }
  if (withKey) env.PERSOME_SCREENSHOT_KEY = randomBytes(32).toString('hex')
  const run = spawnSync(PY, ['-I', ORACLE], { input: JSON.stringify(job), env, encoding: 'utf8', timeout: 120_000 })
  if (run.status !== 0) throw new Error(`oracle failed (${run.status}): ${run.stderr.slice(-2000)}`)
  const lines = run.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

async function lensBody(front: { pid: number; name: string; bundleId: string }, tree: string | null, toml = ''): Promise<Posted> {
  const fake = new FakeClock()
  const n = fakeNative({ front, tree, url: URL_, urlHandlers: ['com.apple.Safari'] })
  const { handle, posted } = runPipeline({ native: n.native, captureToml: `source = "ingest"\n${toml}`, clock: epochClock(fake, EPOCH) })
  await fake.advance(600)
  handle.stop()
  expect(posted).toHaveLength(1)
  return posted[0]
}

const native = loadNative(path.resolve(__dirname, '../..')).native
function addonTree(fixture: string): string {
  // Pure serializer over a recorded fixture: no AX, no TCC.
  return native!._axTreeFromFixture(fs.readFileSync(path.join(FIX, `${fixture}.input.json`), 'utf8'), { focusedWindowOnly: true, maxDepth: 100, timeout: 3 })
}

describe.skipIf(!available)('Lens ingest bodies through the OSS Runtime ingest code (temp root)', () => {
  it('CAP-09 / CAP-03 / CAP-07 / CAP-02: metadata, encryption at rest, secure suppression, OCR hand-off', async () => {
    const safari = await lensBody({ pid: 700, name: 'Safari', bundleId: 'com.apple.Safari' }, safariTree(URL_))
    const notes = await lensBody({ pid: 501, name: 'Notes', bundleId: 'com.apple.Notes' }, native ? addonTree('native-notes') : safariTree(URL_))
    const canvasOcr = await lensBody({ pid: 710, name: 'Canvas', bundleId: 'com.example.canvas' }, canvasTree(), 'enable_ocr_fallback = true')
    const cases: Record<string, unknown> = {
      safari: { body: safari.body, write: true, needles: [JPEG_B64, 'OG02-FAKE-PIXELS', JPEG_B64.slice(0, 16)] },
      notes: { body: notes.body, write: true, needles: ['hunter2'] },
      canvas_ocr: { body: canvasOcr.body, config: { source: 'ingest', enable_ocr_fallback: true } },
      // The body Lens sent before OG-02 (no ocr_jpeg_b64): the Runtime has nothing to OCR.
      canvas_ocr_legacy: { body: JSON.stringify({ ...canvasOcr.json, ocr_jpeg_b64: undefined }), config: { source: 'ingest', enable_ocr_fallback: true } }
    }
    let secureBody: Posted | null = null
    if (native) {
      secureBody = await lensBody({ pid: 9001, name: 'Edge Case', bundleId: 'dev.navalia.edge' }, addonTree('edge-cases'), 'enable_ocr_fallback = true')
      // The addon redacts the secure value before it reaches Lens's body.
      expect(secureBody.body).not.toContain('p@ssw0rd')
      cases.secure = { body: secureBody.body, write: true, config: { source: 'ingest', enable_ocr_fallback: true }, needles: ['p@ssw0rd', 'OG02-FAKE-PIXELS', JPEG_B64] }
    }
    const out = runOracle({ cases }, true)
    expect(out.key_loaded).toBe(true)

    // CAP-09: every body validates; the Runtime stamps capture_source and derives url from AX.
    const s = out.cases.safari
    expect(s.built).toBe(true)
    expect(s.stored.capture_source).toBe('ingest')
    expect(s.stored.timestamp).toBe(new Date(EPOCH + 500).toISOString().replace('Z', '000+00:00'))
    expect(s.stored.window_meta).toEqual({ app_name: 'Safari', title: 'Example Domain', bundle_id: 'com.apple.Safari' })
    expect(s.stored.trigger).toMatchObject({ event_type: 'startup', bundle_id: 'com.apple.Safari' })
    expect(s.stored.url).toBe(URL_)
    expect(s.stored.ax_unavailable).toBe(false)
    expect(s.stored.visible_text).toContain('illustrative examples')
    // CAP-03: AES-GCM envelope at rest, owner-only file, no plaintext pixels, round-trips with the key.
    expect(s.stored.screenshot_enc).toBe(true)
    expect(s.stored.screenshot_prefix).toBe('PSOMEGCM1:')
    expect(s.file_mode).toBe('0o600')
    expect(s.contains).toEqual({ [JPEG_B64]: false, 'OG02-FAKE-PIXELS': false, [JPEG_B64.slice(0, 16)]: false })
    expect(s.decrypted_b64).toBe(JPEG_B64)

    const n = out.cases.notes
    expect(n.stored.capture_source).toBe('ingest')
    expect(n.stored.window_meta.bundle_id).toBe('com.apple.Notes')
    expect(n.stored.window_meta.title.length).toBeGreaterThan(0)
    expect(n.stored.url).toBeNull()
    expect(n.contains.hunter2).toBe(false) // secure field in a non-focused element: addon redaction

    // CAP-02: the Runtime queues exactly Lens's JPEG for OCR; without the field nothing is queued.
    expect(out.cases.canvas_ocr.ocr_pending_b64).toBe(JPEG_B64)
    expect(out.cases.canvas_ocr_legacy.ocr_pending_b64).toBeNull()

    if (native) {
      const sec = out.cases.secure
      expect(sec.stored.secure_input_suppressed).toBe(true)
      expect(sec.stored.has_ax_tree).toBe(false)
      expect(sec.stored.screenshot_prefix).toBeNull()
      expect(sec.ocr_pending_b64).toBeNull()
      expect(sec.contains).toEqual({ 'p@ssw0rd': false, 'OG02-FAKE-PIXELS': false, [JPEG_B64]: false })
      expect(JSON.parse(secureBody!.body)).not.toHaveProperty('screenshot')
    }
  }, 180_000)

  it('CAP-03 fail-closed: encrypt_screenshots on but no key -> screenshot omitted, text kept', async () => {
    const safari = await lensBody({ pid: 700, name: 'Safari', bundleId: 'com.apple.Safari' }, safariTree(URL_))
    const out = runOracle({ cases: { safari: { body: safari.body, write: true, needles: [JPEG_B64, 'OG02-FAKE-PIXELS'] } } }, false)
    expect(out.key_loaded).toBe(false)
    const s = out.cases.safari
    expect(s.stored.screenshot_prefix).toBeNull()
    expect(s.stored.visible_text).toContain('illustrative examples')
    expect(s.contains).toEqual({ [JPEG_B64]: false, 'OG02-FAKE-PIXELS': false })
  }, 180_000)

  it('CAP-04 retention: >7 d deleted, >24 h screenshot stripped with text kept, fresh untouched', async () => {
    const safari = await lensBody({ pid: 700, name: 'Safari', bundleId: 'com.apple.Safari' }, safariTree(URL_))
    const frame = (ts: string, age: number) => ({ body: JSON.stringify({ ...safari.json, timestamp: ts }), age_hours: age })
    const out = runOracle(
      {
        retention: {
          buffer_retention_hours: 168,
          screenshot_retention_hours: 24,
          frames: {
            fresh: frame('2026-11-05T17:00:00Z', 1),
            day_old: frame('2026-11-04T16:00:00Z', 25),
            week_old: frame('2026-10-27T16:00:00Z', 8 * 24)
          }
        }
      },
      true
    )
    const a = out.retention.after
    expect(a.week_old).toEqual({ exists: false })
    expect(a.day_old).toMatchObject({ exists: true, has_screenshot: false, screenshot_stripped: true })
    expect(a.day_old.visible_text).toContain('illustrative examples')
    expect(a.fresh).toMatchObject({ exists: true, has_screenshot: true, screenshot_stripped: false })
    expect(out.retention.stats).toMatchObject({ deleted: 1, stripped: 1 })
  }, 180_000)
})
