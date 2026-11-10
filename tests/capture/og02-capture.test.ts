import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRIGGERS } from '../../src/main/capture/coordinator'
import { AX_POOR_MAX_CHARS, axTextChars, isSecureInputFocused } from '../../src/main/capture/frame'
import { FakeClock } from './fake-clock'
import { canvasTree, cleanupRoots, epochClock, FAKE_JPEG, fakeNative, runPipeline, safariTree, TEST_TOKEN } from './og02-harness'

/**
 * OG-02 automatable parts of CAP-02/03/07/08/09/10, through the real pipeline
 * (coordinator -> buildFrame -> IngestClient) with a fake addon and fake clock.
 * Runtime-side behaviour (encryption, retention, secure suppression, URL
 * derivation, capture_source stamping) is checked against the OSS Runtime's own
 * code in runtime-oracle.test.ts.
 */

const EPOCH = Date.UTC(2026, 10, 5, 18, 0, 0)
const URL_ = 'https://example.com/'
const SAFARI = { pid: 700, name: 'Safari', bundleId: 'com.apple.Safari' }
const CANVAS = { pid: 710, name: 'Canvas', bundleId: 'com.example.canvas' }
const INGEST_BODY_FIELDS = new Set(['timestamp', 'trigger', 'window_meta', 'ax_tree', 'ax_metadata', 'screenshot', 'ocr_jpeg_b64', 'ocr_tier'])
const JPEG_B64 = FAKE_JPEG.toString('base64')

afterEach(() => cleanupRoots())

function secureTree(): string {
  return JSON.stringify({
    apps: [
      {
        bundle_id: 'dev.navalia.edge',
        focused_element: { is_editable: true, role: 'AXTextField', subrole: 'AXSecureTextField', title: 'Password', value: '[REDACTED]', value_length: 10 },
        is_frontmost: true,
        name: 'Edge Case',
        pid: 720,
        windows: [{ elements: [{ role: 'AXTextField', subrole: 'AXSecureTextField', title: 'Password', value: '[REDACTED]' }], focused: true, title: 'Sign in' }]
      }
    ],
    timestamp: '2026-11-05T18:00:00Z'
  })
}
const EDGE = { pid: 720, name: 'Edge Case', bundleId: 'dev.navalia.edge' }

describe('CAP-09 source metadata in the ingest body', () => {
  it('carries timestamp, trigger, app, bundle, window title and AX (URL inside AX); Bearer auth; Runtime-only fields absent', async () => {
    const fake = new FakeClock()
    const n = fakeNative({ front: SAFARI, tree: safariTree(URL_), url: URL_, urlHandlers: ['com.apple.Safari'] })
    const { handle, posted, records } = runPipeline({ native: n.native, captureToml: 'source = "ingest"', clock: epochClock(fake, EPOCH) })
    await fake.advance(600)
    handle.stop()

    expect(posted).toHaveLength(1)
    const p = posted[0]
    expect(p.url).toBe('http://127.0.0.1:8761/captures/ingest')
    expect(p.authorization).toBe(`Bearer ${TEST_TOKEN}`)
    for (const key of Object.keys(p.json)) expect(INGEST_BODY_FIELDS.has(key), `unexpected body key ${key}`).toBe(true)
    // capture_source / url are derived by the Runtime (build_ingest_capture + S1 enrich), not sent.
    expect(p.json).not.toHaveProperty('capture_source')
    expect(p.json).not.toHaveProperty('source')
    expect(p.json).not.toHaveProperty('url')
    expect(p.json.timestamp).toBe(new Date(EPOCH + 500).toISOString())
    expect(p.json.trigger).toEqual({ event_type: 'startup', app_name: 'Safari', bundle_id: 'com.apple.Safari', window_title: '' })
    expect(p.json.window_meta).toEqual({ app_name: 'Safari', title: 'Example Domain', bundle_id: 'com.apple.Safari' })
    expect(p.json.ax_metadata).toMatchObject({ mode: 'frontmost', depth: 100, platform: 'macos', producer: 'navalia-native' })
    expect(p.body).toContain(`"value":"${URL_}"`)
    expect(p.json.screenshot).toMatchObject({ mime_type: 'image/jpeg', width: 800, height: 600, image_base64: JPEG_B64 })

    // Lens-local record (Capture page): URL from AXURL, never pixels or the token.
    expect(records[0]).toMatchObject({ trigger: 'startup', appName: 'Safari', bundleId: 'com.apple.Safari', windowTitle: 'Example Domain', url: URL_, axAvailable: true, screenshot: 'attached', outcome: 'written' })
    const recordText = JSON.stringify(records)
    expect(recordText).not.toContain(TEST_TOKEN)
    expect(recordText).not.toContain(JPEG_B64)
  })

  it('only browsers are asked for a URL', async () => {
    const fake = new FakeClock()
    const n = fakeNative({ front: CANVAS, tree: canvasTree(), url: 'https://should-not-be-read/', urlHandlers: ['com.apple.Safari'] })
    const { handle, records } = runPipeline({ native: n.native, captureToml: 'source = "ingest"', clock: epochClock(fake, EPOCH) })
    await fake.advance(600)
    handle.stop()
    expect(n.calls.some((c) => c.startsWith('browserUrl'))).toBe(false)
    expect(records[0].url).toBeNull()
  })

  it('nothing is posted unless the Runtime config says source = "ingest"', async () => {
    for (const toml of ['source = "daemon"', '# no source key']) {
      const fake = new FakeClock()
      const n = fakeNative({ front: SAFARI, tree: safariTree(URL_) })
      const { handle, posted } = runPipeline({ native: n.native, captureToml: toml, clock: epochClock(fake, EPOCH) })
      await fake.advance(30 * 60_000)
      expect(handle.status().started).toBe(false)
      expect(posted).toHaveLength(0)
      expect(n.calls).toEqual([])
    }
  })
})

describe('CAP-08 dedup and heartbeat (pipeline level, fake clock)', () => {
  it('60 s of typing (300 keystrokes) yields a handful of frames, then a heartbeat every 10 min of silence', async () => {
    const fake = new FakeClock()
    const n = fakeNative({ front: SAFARI, tree: safariTree(URL_) })
    const { handle, posted } = runPipeline({ native: n.native, captureToml: 'source = "ingest"', clock: epochClock(fake, EPOCH) })
    await fake.advance(600) // startup frame
    expect(posted).toHaveLength(1)

    for (let i = 0; i < 300; i++) {
      n.emit({ eventType: TRIGGERS.valueChanged })
      await fake.advance(200)
    }
    await fake.advance(6_000) // let the final deferred trigger flush
    const typing = posted.slice(1)
    // Upper bound from the 5 s same-surface window over 66 s; far below 300.
    expect(typing.length).toBeGreaterThanOrEqual(2)
    expect(typing.length).toBeLessThanOrEqual(14)
    expect(typing.every((p) => (p.json.trigger as { event_type: string }).event_type === TRIGGERS.valueChanged)).toBe(true)
    // No two frames of one surface closer than 5 s.
    const times = posted.map((p) => Date.parse(p.json.timestamp as string))
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(5_000)

    const lastTyping = times[times.length - 1]
    const before = posted.length
    await fake.advance(31 * 60_000)
    const beats = posted.slice(before)
    expect(beats).toHaveLength(3)
    for (const [i, b] of beats.entries()) {
      expect((b.json.trigger as { event_type: string }).event_type).toBe('heartbeat')
      // Heartbeat frames still carry the frontmost app's metadata.
      expect(b.json.window_meta).toEqual({ app_name: 'Safari', title: 'Example Domain', bundle_id: 'com.apple.Safari' })
      expect(Date.parse(b.json.timestamp as string) - lastTyping).toBe((i + 1) * 10 * 60_000)
    }
    handle.stop()
  })

  it('no heartbeat while the screen is locked or capture is paused', async () => {
    const fake = new FakeClock()
    const n = fakeNative({ front: SAFARI, tree: safariTree(URL_) })
    const { handle, posted } = runPipeline({ native: n.native, captureToml: 'source = "ingest"', clock: epochClock(fake, EPOCH) })
    await fake.advance(600)
    handle.coordinator!.setLocked(true)
    await fake.advance(45 * 60_000)
    expect(posted).toHaveLength(1)
    handle.coordinator!.setLocked(false)
    handle.setPaused(true)
    await fake.advance(45 * 60_000)
    expect(posted).toHaveLength(1)
    handle.setPaused(false)
    await fake.advance(10 * 60_000)
    expect(posted).toHaveLength(2)
    expect((posted[1].json.trigger as { event_type: string }).event_type).toBe('heartbeat')
    handle.stop()
  })
})

describe('CAP-07 secure input', () => {
  it('detects a focused secure field with the Runtime predicate', () => {
    expect(isSecureInputFocused(JSON.parse(secureTree()))).toBe(true)
    expect(isSecureInputFocused({ apps: [{ is_frontmost: true, focused_element: { role: 'AXTextField', value: '[REDACTED]' } }] })).toBe(true)
    expect(isSecureInputFocused({ apps: [{ is_frontmost: true, focused_element: { role: 'AXTextField', value: 'hello' } }] })).toBe(false)
    expect(isSecureInputFocused(JSON.parse(safariTree(URL_)))).toBe(false)
    expect(isSecureInputFocused(undefined)).toBe(false)
  })

  it('grabs no pixels while a password field is focused, even with OCR on', async () => {
    const fake = new FakeClock()
    const n = fakeNative({ front: EDGE, tree: secureTree() })
    const { handle, posted, records } = runPipeline({
      native: n.native,
      captureToml: 'source = "ingest"\nenable_ocr_fallback = true',
      clock: epochClock(fake, EPOCH)
    })
    await fake.advance(600)
    handle.stop()
    expect(n.calls.some((c) => c.startsWith('screenshot'))).toBe(false)
    expect(posted).toHaveLength(1)
    expect(posted[0].json).not.toHaveProperty('screenshot')
    expect(posted[0].json).not.toHaveProperty('ocr_jpeg_b64')
    // The AX tree still goes so the Runtime records secure_input_suppressed; the value is the addon's redaction.
    expect(posted[0].body).toContain('[REDACTED]')
    expect(records[0].screenshot).toBe('secure_input')
  })

  it('suppress_secure_input = false (user opt-out) leaves the screenshot to the Runtime as before', async () => {
    const fake = new FakeClock()
    const n = fakeNative({ front: EDGE, tree: secureTree() })
    const { handle, posted } = runPipeline({ native: n.native, captureToml: 'source = "ingest"\nsuppress_secure_input = false', clock: epochClock(fake, EPOCH) })
    await fake.advance(600)
    handle.stop()
    expect(posted[0].json).toHaveProperty('screenshot')
  })
})

describe('CAP-02 OCR fallback payload', () => {
  async function one(toml: string, front: typeof SAFARI, tree: string | null, extra: { screenRecording?: boolean } = {}) {
    const fake = new FakeClock()
    const n = fakeNative({ front, tree, ...extra })
    const r = runPipeline({ native: n.native, captureToml: `source = "ingest"\n${toml}`, clock: epochClock(fake, EPOCH) })
    await fake.advance(600)
    r.handle.stop()
    return { ...r, calls: n.calls }
  }

  it('AX-poor window + OCR on: the focused-window JPEG goes as ocr_jpeg_b64', async () => {
    const { posted, records } = await one('enable_ocr_fallback = true', CANVAS, canvasTree())
    expect(posted[0].json.ocr_jpeg_b64).toBe(JPEG_B64)
    expect(posted[0].json.screenshot).toMatchObject({ image_base64: JPEG_B64 })
    expect(records[0].screenshot).toBe('attached')
  })

  it('AX unavailable + OCR on: OCR JPEG attached (Runtime records ax_unavailable)', async () => {
    const { posted } = await one('enable_ocr_fallback = true', CANVAS, null)
    expect(posted[0].json).not.toHaveProperty('ax_tree')
    expect(posted[0].json.ocr_jpeg_b64).toBe(JPEG_B64)
  })

  it('AX-rich window, or OCR off (OSS default): no OCR JPEG', async () => {
    expect((await one('enable_ocr_fallback = true', SAFARI, safariTree(URL_))).posted[0].json).not.toHaveProperty('ocr_jpeg_b64')
    expect((await one('', CANVAS, canvasTree())).posted[0].json).not.toHaveProperty('ocr_jpeg_b64')
    expect((await one('enable_ocr_fallback = false', CANVAS, canvasTree())).posted[0].json).not.toHaveProperty('ocr_jpeg_b64')
  })

  it('include_screenshot = false: no screenshot field; pixels are grabbed only when OCR needs them', async () => {
    const off = await one('include_screenshot = false', CANVAS, canvasTree())
    expect(off.calls.some((c) => c.startsWith('screenshot'))).toBe(false)
    expect(off.posted[0].json).not.toHaveProperty('screenshot')
    expect(off.records[0].screenshot).toBe('disabled')

    const ocr = await one('include_screenshot = false\nenable_ocr_fallback = true', CANVAS, canvasTree())
    expect(ocr.calls.filter((c) => c.startsWith('screenshot'))).toHaveLength(1)
    expect(ocr.posted[0].json).not.toHaveProperty('screenshot')
    expect(ocr.posted[0].json.ocr_jpeg_b64).toBe(JPEG_B64)
  })

  it('no Screen Recording: no grab, no OCR JPEG', async () => {
    const r = await one('enable_ocr_fallback = true', CANVAS, canvasTree(), { screenRecording: false })
    expect(r.calls.some((c) => c.startsWith('screenshot'))).toBe(false)
    expect(r.posted[0].json).not.toHaveProperty('ocr_jpeg_b64')
    expect(r.records[0].screenshot).toBe('not_granted')
  })

  it('honours screenshot_max_width / screenshot_jpeg_quality from the Runtime config', async () => {
    const r = await one('screenshot_max_width = 1280\nscreenshot_jpeg_quality = 70', SAFARI, safariTree(URL_))
    expect(r.calls).toContain(`screenshot:${JSON.stringify({ scope: 'frontmostWindow', pid: 700, maxWidth: 1280, quality: 70 })}`)
  })

  it('AX-poor threshold counts element text of the frontmost app only', () => {
    expect(axTextChars(JSON.parse(canvasTree()))).toBe(0)
    expect(axTextChars(JSON.parse(safariTree(URL_)))).toBeGreaterThanOrEqual(AX_POOR_MAX_CHARS)
    expect(axTextChars(undefined)).toBe(0)
  })
})

describe('CAP-03 Lens side: pixels stay in memory', () => {
  const ROOT = path.resolve(__dirname, '../..')

  it('a run with screenshots writes nothing into the Runtime root', async () => {
    const fake = new FakeClock()
    const n = fakeNative({ front: SAFARI, tree: safariTree(URL_) })
    const { handle, posted, root } = runPipeline({ native: n.native, captureToml: 'source = "ingest"', clock: epochClock(fake, EPOCH) })
    await fake.advance(600)
    handle.stop()
    expect(posted[0].json).toHaveProperty('screenshot')
    expect(fs.readdirSync(root)).toEqual(['config.toml'])
  })

  it('capture main-process code has no file write other than the settings file', () => {
    const dir = path.join(ROOT, 'src/main/capture')
    const writers: string[] = []
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      if (/\b(writeFile|writeFileSync|appendFile|createWriteStream|writeFileSecure|atomicWrite)\b/.test(text)) writers.push(f)
    }
    expect(writers).toEqual(['settings.ts'])
    const settings = fs.readFileSync(path.join(dir, 'settings.ts'), 'utf8')
    expect(settings).not.toMatch(/screenshot|image_base64|ax_tree/)
  })

  it('capture code never logs frames or the token', () => {
    const dir = path.join(ROOT, 'src/main/capture')
    for (const f of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/console\.(log|info|warn|error|debug)/)
    }
  })
})

describe('CAP-10 no Full Disk Access (static)', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { build: Record<string, unknown> & { mac: Record<string, unknown> } }

  it('build config declares no entitlements or extra usage strings', () => {
    const mac = pkg.build.mac
    for (const k of ['entitlements', 'entitlementsInherit', 'provisioningProfile']) expect(mac, k).not.toHaveProperty(k)
    expect(pkg.build).not.toHaveProperty('extendInfo')
    // S1-FULL C12: the only extra usage string is the Meetings microphone (DECISIONS S1F-6).
    expect(Object.keys((mac.extendInfo as Record<string, unknown> | undefined) ?? {})).toEqual(['NSMicrophoneUsageDescription'])
    expect(JSON.stringify(pkg.build).match(/\w+UsageDescription/g)).toEqual(['NSMicrophoneUsageDescription'])
    expect(JSON.stringify(pkg.build)).not.toMatch(/SystemPolicyAllFiles|AllFiles/)
  })

  it('afterPack strips Electron default camera / Bluetooth / audio-capture strings (microphone kept for Meetings)', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'build/after-pack.cjs'), 'utf8')
    for (const key of ['NSCameraUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSAudioCaptureUsageDescription']) {
      expect(hook).toContain(`'${key}'`)
    }
    expect(hook).not.toContain("'NSMicrophoneUsageDescription'")
  })

  it('main process and addon request only Accessibility and Screen Recording', () => {
    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|mm|h|cc|cpp)$/.test(e.name)) files.push(p)
      }
    }
    walk(path.join(ROOT, 'src/main'))
    walk(path.join(ROOT, 'native/src'))
    const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    expect(all).not.toMatch(/Privacy_AllFiles|kTCCServiceSystemPolicyAllFiles|Full Disk Access|NSAppleScript|osascript|AVCaptureDevice|requestAccessForMediaType/)
    expect(all).toMatch(/AXIsProcessTrustedWithOptions/)
    expect(all).toMatch(/CGRequestScreenCaptureAccess/)
  })

  it('packaged Info.plist (when built) has no privacy usage strings and no ATS blanket opt-out', async () => {
    const plist = path.join(ROOT, 'dist/mac-arm64/Navalia.app/Contents/Info.plist')
    if (!fs.existsSync(plist)) return
    const { execFileSync } = await import('node:child_process')
    const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })) as Record<string, unknown>
    // A DMG built before S1-FULL C12 has none; after it, only the Lens microphone string.
    const usage = Object.keys(info).filter((k) => /UsageDescription$/.test(k))
    expect(usage.every((k) => k === 'NSMicrophoneUsageDescription')).toBe(true)
    if (usage.length) expect(String(info.NSMicrophoneUsageDescription)).toMatch(/会议/)
    expect((info.NSAppTransportSecurity as Record<string, unknown> | undefined)?.NSAllowsArbitraryLoads).toBeUndefined()
  })
})
