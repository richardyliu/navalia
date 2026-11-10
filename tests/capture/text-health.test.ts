import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TRIGGERS } from '../../src/main/capture/coordinator'
import { buildCaptureDiagnostics, readRuntimeConfigSummary } from '../../src/main/capture/diagnostics'
import { buildFrame } from '../../src/main/capture/frame'
import type { LensNative, NativeEvent } from '../../src/main/capture/native'
import { createCaptureService } from '../../src/main/capture/service'
import {
  computeTextHealth,
  noTextBanner,
  TextHealthTracker,
  type TextSample
} from '../../src/main/capture/textHealth'
import { FakeClock } from './fake-clock'
import { startMockRuntime, type MockRuntime } from './mock-ingest-runtime'

const PREFIX = 'lens-captext-'
const dirs: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  dirs.push(d)
  return d
}
function cleanup(): void {
  for (const d of dirs.splice(0)) {
    // Guard: only ever remove our own mkdtemp dirs, never $TMPDIR itself.
    if (path.basename(d).startsWith(PREFIX) && path.resolve(d) !== path.resolve(os.tmpdir())) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }
}

const MIN = 60_000
const sample = (at: number, over: Partial<TextSample> = {}): TextSample => ({
  at,
  axTextChars: 0,
  axAvailable: false,
  screenshot: false,
  ocr: false,
  shotReason: 'screen_recording_denied',
  ...over
})

describe('computeTextHealth (P0-1)', () => {
  const now = 100 * MIN

  it('frames>0 and no text frames → red no_text banner with the exact copy', () => {
    const v = computeTextHealth([sample(now - MIN), sample(now - 2 * MIN), sample(now - 3 * MIN)], now, 30)
    expect(v).toMatchObject({ frames: 3, textFrames: 0, screenshotFrames: 0, coverage: 0, verdict: 'no_text' })
    expect(v.banner).toBe(
      'Capture is sending frames but no text. TCC may have broken after a repackage: re-grant Accessibility / Screen Recording, then restart Navalia.'
    )
    expect(v.banner).toBe(noTextBanner())
  })

  it('frames=0 → idle, no banner, coverage null', () => {
    const v = computeTextHealth([], now, 30)
    expect(v).toMatchObject({ frames: 0, textFrames: 0, coverage: null, verdict: 'idle', banner: null })
    // Frames outside the window do not count either.
    const old = computeTextHealth([sample(now - 31 * MIN)], now, 30)
    expect(old).toMatchObject({ frames: 0, verdict: 'idle', banner: null })
  })

  it('partial coverage → partial (warn), not red; majority coverage → ok', () => {
    const samples = [
      sample(now - MIN, { axAvailable: true, axTextChars: 64, shotReason: 'not_needed' }),
      sample(now - 2 * MIN),
      sample(now - 3 * MIN),
      sample(now - 4 * MIN)
    ]
    const v = computeTextHealth(samples, now, 30)
    expect(v).toMatchObject({ frames: 4, textFrames: 1, axTextFrames: 1, coverage: 0.25, verdict: 'partial', banner: null })
    const ok = computeTextHealth(samples.slice(0, 2), now, 30)
    expect(ok).toMatchObject({ frames: 2, textFrames: 1, coverage: 0.5, verdict: 'ok' })
  })

  it('an OCR JPEG counts as text-bearing; an AX tree with no element text does not', () => {
    const v = computeTextHealth(
      [
        sample(now - MIN, { axAvailable: true, axTextChars: 0, ocr: true, screenshot: true, shotReason: 'attached' }),
        sample(now - 2 * MIN, { axAvailable: true, axTextChars: 0, shotReason: 'sck_error' })
      ],
      now,
      30
    )
    expect(v).toMatchObject({ frames: 2, textFrames: 1, ocrFrames: 1, axTextFrames: 0, screenshotFrames: 1, verdict: 'ok' })
  })

  it('tracker surfaces the latest screenshot issue and ignores attached / not_needed', () => {
    const t = new TextHealthTracker()
    t.record(sample(now - 5 * MIN, { shotReason: 'sck_error' }))
    t.record(sample(now - 4 * MIN, { shotReason: 'attached', screenshot: true }))
    expect(t.view(now).lastShotIssue).toMatchObject({ reason: 'sck_error' })
    t.noteIssue('paused', now - MIN)
    t.noteIssue('not_needed', now)
    expect(t.view(now).lastShotIssue).toMatchObject({ reason: 'paused', at: new Date(now - MIN).toISOString() })
  })
})

// --- screenshot-failure reasons from buildFrame -------------------------------

const trigger = { event_type: 'AXApplicationActivated', app_name: 'Notes', bundle_id: 'com.apple.Notes', window_title: '' }

function native(opts: { ax: 'text' | 'empty' | 'denied'; screenRecording: boolean; shot: 'ok' | 'null' | 'throw' }) {
  const calls: string[] = []
  const elements = opts.ax === 'text' ? [{ role: 'AXStaticText', value: 'x'.repeat(80) }] : []
  const tree = { apps: [{ name: 'Notes', bundle_id: 'com.apple.Notes', is_frontmost: true, pid: 1, windows: [{ title: 'Doc', focused: true, elements }] }] }
  const n = {
    frontmost: () => ({ pid: 1, name: 'Notes', bundleId: 'com.apple.Notes', bundlePath: null, windowTitle: null }),
    axTree: async () => {
      if (opts.ax === 'denied') throw Object.assign(new Error('untrusted'), { code: 'ERR_AX_NOT_TRUSTED' })
      return JSON.stringify(tree)
    },
    permissions: () => ({ accessibility: opts.ax !== 'denied', screenRecording: opts.screenRecording }),
    browserUrl: () => null,
    screenshot: async () => {
      calls.push('screenshot')
      if (opts.shot === 'throw') throw new Error('SCK failed')
      return opts.shot === 'ok'
        ? { data: Buffer.from([0xff, 0xd8, 0xff]), width: 10, height: 5, mimeType: 'image/jpeg' as const, backend: 'screencapturekit' as const }
        : null
    }
  } as unknown as LensNative
  return { native: n, calls }
}

describe('screenshot-failure reason (OCR fallback audit)', () => {
  it('AX denied + no Screen Recording (the TCC-lost case) → screen_recording_denied, no pixels, no AX text', async () => {
    const { native: n, calls } = native({ ax: 'denied', screenRecording: false, shot: 'ok' })
    const r = await buildFrame(n, trigger, { includeScreenshot: true, ocrFallback: true })
    expect(r.frame!.ax_tree).toBeUndefined()
    expect(r.frame!.screenshot).toBeUndefined()
    expect(r.frame!.ocr_jpeg_b64).toBeUndefined()
    expect(r.local).toMatchObject({ axTextChars: 0, ocr: false, shotReason: 'screen_recording_denied', screenshot: 'not_granted' })
    expect(calls).toEqual([])
  })

  it('include_screenshot=false but OCR wanted and not granted → still screen_recording_denied (not "disabled")', async () => {
    const { native: n } = native({ ax: 'empty', screenRecording: false, shot: 'ok' })
    const r = await buildFrame(n, trigger, { includeScreenshot: false, ocrFallback: true })
    expect(r.local).toMatchObject({ shotReason: 'screen_recording_denied' })
  })

  it('AX empty + granted → OCR JPEG still sent (fallback works) → attached', async () => {
    const { native: n } = native({ ax: 'empty', screenRecording: true, shot: 'ok' })
    const r = await buildFrame(n, trigger, { includeScreenshot: false, ocrFallback: true })
    expect(r.frame!.ocr_jpeg_b64).toBeTruthy()
    expect(r.local).toMatchObject({ ocr: true, shotReason: 'attached', axTextChars: 0 })
  })

  it('AX denied but Screen Recording granted → OCR JPEG sent for the frontmost window', async () => {
    const { native: n } = native({ ax: 'denied', screenRecording: true, shot: 'ok' })
    const r = await buildFrame(n, trigger, { includeScreenshot: true, ocrFallback: true })
    expect(r.frame!.ocr_jpeg_b64).toBeTruthy()
    expect(r.local).toMatchObject({ ocr: true, shotReason: 'attached' })
  })

  it('granted but the grab returns null or throws → sck_error', async () => {
    for (const shot of ['null', 'throw'] as const) {
      const { native: n } = native({ ax: 'empty', screenRecording: true, shot })
      const r = await buildFrame(n, trigger, { includeScreenshot: true, ocrFallback: true })
      expect(r.frame!.ocr_jpeg_b64).toBeUndefined()
      expect(r.local).toMatchObject({ ocr: false, shotReason: 'sck_error' })
    }
  })

  it('AX-rich with screenshots off → not_needed; everything off → disabled', async () => {
    const { native: n, calls } = native({ ax: 'text', screenRecording: true, shot: 'ok' })
    const r = await buildFrame(n, trigger, { includeScreenshot: false, ocrFallback: true })
    expect(r.local).toMatchObject({ shotReason: 'not_needed', ocr: false })
    expect(r.local!.axTextChars).toBeGreaterThan(0)
    const off = await buildFrame(n, trigger, { includeScreenshot: false, ocrFallback: false })
    expect(off.local).toMatchObject({ shotReason: 'disabled' })
    expect(calls).toEqual([])
  })

  it('secure input focused → secure_input', async () => {
    const tree = { apps: [{ name: 'Notes', bundle_id: 'com.apple.Notes', is_frontmost: true, windows: [], focused_element: { role: 'AXTextField', subrole: 'AXSecureTextField' } }] }
    const { native: n } = native({ ax: 'empty', screenRecording: true, shot: 'ok' })
    ;(n as unknown as { axTree: () => Promise<string> }).axTree = async () => JSON.stringify(tree)
    const r = await buildFrame(n, trigger, { includeScreenshot: true, ocrFallback: true })
    expect(r.local).toMatchObject({ shotReason: 'secure_input' })
  })
})

// --- service end to end: the observed TCC-lost state -----------------------

describe('capture service text health (P0-1)', () => {
  let rt: MockRuntime
  const tz = process.env.TZ
  beforeAll(async () => {
    process.env.TZ = 'America/Los_Angeles'
    rt = await startMockRuntime()
  })
  afterAll(async () => {
    await rt.close()
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })
  afterEach(() => {
    rt.received.length = 0
    cleanup()
  })

  function fake(excludedFront = false) {
    let listener: ((e: NativeEvent) => void) | null = null
    const n = {
      permissions: () => ({ accessibility: false, screenRecording: false }),
      frontmost: () =>
        excludedFront
          ? { pid: 12, name: '1Password', bundleId: 'com.1password.1password', bundlePath: null, windowTitle: '' }
          : { pid: 10, name: 'Notes', bundleId: 'com.apple.Notes', bundlePath: null, windowTitle: '' },
      selfBundle: () => ({ bundleId: 'com.github.Electron', bundlePath: '/x/Electron.app' }),
      observe: (cb: (e: NativeEvent) => void) => ((listener = cb), { accessibilityObservers: false }),
      stopObserving: () => (listener = null),
      urlHandlers: () => [],
      browserUrl: () => null,
      axTree: async () => {
        throw Object.assign(new Error('untrusted'), { code: 'ERR_AX_NOT_TRUSTED' })
      },
      screenshot: async () => null,
      requestAccessibility: () => false,
      requestScreenRecording: () => false
    } as unknown as LensNative
    return { native: n, emit: (e: Partial<NativeEvent>) => listener?.({ eventType: TRIGGERS.applicationActivated, pid: 10, appName: 'Notes', bundleId: 'com.apple.Notes', ...e } as NativeEvent) }
  }

  function service(clock: FakeClock, n: LensNative) {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'config.toml'), `[capture]\nsource = "ingest"\nenable_ocr_fallback = true\nocr_policy = "enabled"\n`)
    return createCaptureService({
      appPath: '/nonexistent',
      storeRoot: tmp(),
      locate: () => ({ root, port: rt.port }),
      getToken: () => rt.token,
      lockSource: new EventEmitter(),
      selfPid: 4242,
      native: n,
      clock
    })
  }

  it('AX and Screen Recording lost: frames reach ingest with no text → no_text banner + screen_recording_denied', async () => {
    const clock = new FakeClock()
    const f = fake()
    const svc = service(clock, f.native)
    expect(svc.status().textHealth).toMatchObject({ frames: 0, verdict: 'idle', banner: null })
    await clock.advance(600)
    await new Promise((r) => setTimeout(r, 200))
    f.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.apple.Safari', appName: 'Safari', pid: 11 })
    await clock.advance(600)
    await new Promise((r) => setTimeout(r, 200))
    const st = svc.status()
    expect(rt.received.length).toBeGreaterThan(0)
    expect(st.textHealth).toMatchObject({ frames: rt.received.length, textFrames: 0, screenshotFrames: 0, coverage: 0, verdict: 'no_text' })
    expect(st.textHealth!.banner).toBe(noTextBanner())
    expect(st.textHealth!.lastShotIssue).toMatchObject({ reason: 'screen_recording_denied' })
    expect(st.recentFrames[0]).toMatchObject({ axAvailable: false, axTextChars: 0, ocr: false, shotReason: 'screen_recording_denied' })

    // Diagnostics text carries the counts and reason, never titles/token.
    const config = readRuntimeConfigSummary(st.runtime.root)
    const diag = buildCaptureDiagnostics({ status: st, config, runtimeOcr: null, now: clock.now(), knownSecrets: [rt.token] })
    expect(diag.text).toContain('verdict no_text')
    expect(diag.text).toContain('Last no-screenshot reason: screen_recording_denied')
    expect(diag.text).not.toContain(rt.token)
    svc.stop()
  })

  it('pause → latest reason is paused, no frames, verdict idle (not red)', async () => {
    const clock = new FakeClock()
    const f = fake()
    const svc = service(clock, f.native)
    svc.pause('now')
    f.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.apple.Safari', appName: 'Safari', pid: 11 })
    await clock.advance(5000)
    await new Promise((r) => setTimeout(r, 100))
    const st = svc.status()
    expect(rt.received).toHaveLength(0)
    expect(st.textHealth).toMatchObject({ frames: 0, verdict: 'idle', banner: null })
    expect(st.textHealth!.lastShotIssue).toMatchObject({ reason: 'paused' })
    svc.stop()
  })

  it('excluded frontmost app → latest reason is excluded', async () => {
    const clock = new FakeClock()
    const f = fake(true)
    const svc = service(clock, f.native)
    svc.addExclusion('bundleId', 'com.1password.1password')
    f.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.1password.1password', appName: '1Password', pid: 12 })
    await clock.advance(5000)
    await new Promise((r) => setTimeout(r, 100))
    const st = svc.status()
    expect(rt.received).toHaveLength(0)
    expect(st.textHealth!.lastShotIssue).toMatchObject({ reason: 'excluded' })
    svc.stop()
  })
})
