import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TRIGGERS } from '../../src/main/capture/coordinator'
import type { LensNative, NativeEvent } from '../../src/main/capture/native'
import { createCaptureService, type CaptureService } from '../../src/main/capture/service'
import { FakeClock } from './fake-clock'
import { startMockRuntime, type MockRuntime } from './mock-ingest-runtime'

const SELF_PID = 4242
const EXCLUDED = 'com.1password.1password'
const SELF_APP = '/Users/x/navalia/node_modules/electron/dist/Electron.app'

const originalTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles'
})
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

interface Fake {
  native: LensNative
  emit(e: Partial<NativeEvent> & { bundleId: string }): void
  setFront(bundleId: string, name?: string, pid?: number, bundlePath?: string | null): void
  axCalls: number
  shotCalls: number
}

function fakeNative(axDelayMs = 0): Fake {
  let listener: ((e: NativeEvent) => void) | null = null
  let front: { pid: number; name: string; bundleId: string; bundlePath: string | null } = {
    pid: 10,
    name: 'Notes',
    bundleId: 'com.apple.Notes',
    bundlePath: '/System/Applications/Notes.app'
  }
  const f: Fake = {
    axCalls: 0,
    shotCalls: 0,
    native: {} as LensNative,
    emit: (e) => listener?.({ eventType: TRIGGERS.applicationActivated, pid: 10, appName: e.bundleId, ...e } as NativeEvent),
    setFront: (bundleId, name = bundleId, pid = 10, bundlePath = null) => (front = { pid, name, bundleId, bundlePath })
  }
  f.native = {
    permissions: () => ({ accessibility: false, screenRecording: false }),
    frontmost: () => ({ ...front, windowTitle: 'Window' }),
    selfBundle: () => ({ bundleId: 'com.github.Electron', bundlePath: SELF_APP }),
    observe: (cb: (e: NativeEvent) => void) => ((listener = cb), { accessibilityObservers: false }),
    stopObserving: () => (listener = null),
    urlHandlers: () => [],
    browserUrl: () => null,
    axTree: async () => {
      f.axCalls++
      if (axDelayMs) await new Promise((r) => setTimeout(r, axDelayMs))
      throw Object.assign(new Error('untrusted'), { code: 'ERR_AX_NOT_TRUSTED' })
    },
    screenshot: async () => (f.shotCalls++, null),
    requestAccessibility: () => false,
    requestScreenRecording: () => false
  } as unknown as LensNative
  return f
}

let rt: MockRuntime
let fetchCalls: number
const dirs: string[] = []
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}

function runtimeRoot(source: string, port: number): string {
  const root = tmp('lens-capture-runtime-')
  fs.writeFileSync(path.join(root, 'config.toml'), `[capture]\nsource = "${source}"\n\n[mcp]\nport = ${port}\n`)
  return root
}

function make(opts: { storeRoot: string; root: string; clock: FakeClock; fake: Fake }): CaptureService {
  return createCaptureService({
    appPath: '/nonexistent',
    storeRoot: opts.storeRoot,
    locate: () => ({ root: opts.root, port: rt.port }),
    getToken: () => rt.token,
    lockSource: new EventEmitter(),
    selfPid: SELF_PID,
    native: opts.fake.native,
    clock: opts.clock,
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      fetchCalls++
      return fetch(...args)
    }) as typeof fetch
  })
}

async function realWait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

beforeAll(async () => {
  rt = await startMockRuntime()
})
afterAll(async () => rt.close())
afterEach(() => {
  rt.received.length = 0
  rt.script.length = 0
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('capture service (E1.6)', () => {
  it('shows the daemon-mode reason and stays inert', () => {
    fetchCalls = 0
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('daemon', rt.port), clock: new FakeClock(), fake: fakeNative() })
    expect(svc.status()).toMatchObject({ started: false, reason: 'Runtime capture.source is "daemon", not "ingest"' })
    expect(svc.status().runtime.source).toBe('daemon')
    svc.stop()
  })

  it('100 switches into an excluded app: 0 frames and 0 ingest calls', async () => {
    fetchCalls = 0
    const clock = new FakeClock()
    const fake = fakeNative()
    fake.setFront(EXCLUDED, '1Password')
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
    svc.addExclusion('bundleId', EXCLUDED)
    for (let i = 0; i < 100; i++) {
      fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: EXCLUDED, appName: '1Password' })
      await clock.advance(50)
      fake.emit({ eventType: TRIGGERS.focusedWindowChanged, bundleId: EXCLUDED, appName: '1Password' })
      fake.emit({ eventType: TRIGGERS.valueChanged, bundleId: EXCLUDED, appName: '1Password' })
      await clock.advance(2500)
    }
    // A heartbeat while the excluded app is frontmost is also refused before AX.
    await clock.advance(15 * 60_000)
    await realWait(100)
    expect(fetchCalls).toBe(0)
    expect(rt.received).toHaveLength(0)
    expect(fake.axCalls).toBe(0)
    expect(fake.shotCalls).toBe(0)
    expect(svc.status().recentFrames).toHaveLength(0)
    svc.stop()
  })

  it('ingests a normal app switch end to end and aggregates it per app', async () => {
    fetchCalls = 0
    const clock = new FakeClock()
    const fake = fakeNative()
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
    expect(svc.status()).toMatchObject({ started: true, degraded: expect.stringContaining('Accessibility') })
    await clock.advance(600) // startup trigger for the frontmost app
    await realWait(200)
    fake.setFront('com.apple.Safari', 'Safari', 11)
    fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.apple.Safari', appName: 'Safari', pid: 11 })
    await clock.advance(600)
    await realWait(200)
    const st = svc.status()
    expect(rt.received).toHaveLength(2)
    expect(st.recentFrames.map((f) => [f.appName, f.outcome, f.axAvailable])).toEqual([
      ['Safari', 'written', false],
      ['Notes', 'written', false]
    ])
    expect(st.perApp.map((r) => [r.bundleId, r.written])).toEqual(
      expect.arrayContaining([
        ['com.apple.Safari', 1],
        ['com.apple.Notes', 1]
      ])
    )
    expect(st.ingest.written).toBe(2)
    expect(JSON.stringify(st)).not.toContain(rt.token)
    svc.stop()
  })

  it('ignores events and frames from Lens itself', async () => {
    fetchCalls = 0
    const clock = new FakeClock()
    const fake = fakeNative()
    fake.setFront('dev.navalia.app', 'Navalia', SELF_PID)
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
    for (let i = 0; i < 20; i++) {
      fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'dev.navalia.app', pid: SELF_PID })
      await clock.advance(3000)
    }
    await clock.advance(11 * 60_000) // heartbeat while Lens is frontmost
    await realWait(100)
    expect(fetchCalls).toBe(0)
    expect(fake.axCalls).toBe(0)
    svc.stop()
  })

  it('pause survives a restart: 0 frames until resumed', async () => {
    fetchCalls = 0
    const storeRoot = tmp('lens-store-')
    const root = runtimeRoot('ingest', rt.port)
    const clock = new FakeClock()
    const first = make({ storeRoot, root, clock, fake: fakeNative() })
    first.pause('now')
    first.stop()

    const fake = fakeNative()
    const second = make({ storeRoot, root, clock, fake }) // "app restart"
    expect(second.status().pause).toMatchObject({ paused: true, mode: 'indefinite' })
    for (let i = 0; i < 50; i++) {
      fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: `com.example.${i % 4}` })
      await clock.advance(3000)
    }
    await clock.advance(20 * 60_000)
    await realWait(100)
    expect(fetchCalls).toBe(0)
    second.resume()
    fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.example.x' })
    await clock.advance(600)
    await realWait(200)
    expect(rt.received.length).toBe(1)
    second.stop()
  })

  it('pause until next local midnight resumes by itself at midnight (injected clock)', async () => {
    fetchCalls = 0
    const clock = new FakeClock()
    await clock.advance(Date.parse('2026-11-04T23:50:00-08:00'))
    const fake = fakeNative()
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
    await clock.advance(600) // startup frame
    await realWait(150)
    const before = rt.received.length
    expect(svc.pause('untilMidnight')).toMatchObject({ paused: true, until: '2026-11-05T08:00:00.000Z' })
    fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.example.during' })
    await clock.advance(9 * 60_000) // 23:59:xx
    await realWait(100)
    expect(rt.received.length).toBe(before)
    await clock.advance(60_000) // past 00:00
    expect(svc.status().pause.paused).toBe(false)
    fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.example.after' })
    await clock.advance(600)
    await realWait(200)
    expect(rt.received.length).toBe(before + 1)
    svc.stop()
  })

  it('R5: a frame already in 5xx retries when pause begins is never delivered after it', async () => {
    fetchCalls = 0
    rt.fallback = { status: 503, delayMs: 30 }
    try {
      const clock = new FakeClock()
      const fake = fakeNative()
      const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
      await clock.advance(600) // startup frame built and pushed; Runtime answers 503
      await realWait(120) // first 503 back, client sleeping 250 ms before retry
      expect(rt.arrivals.length).toBeGreaterThanOrEqual(1)
      svc.pause('now')
      const pausedAt = Date.now()
      await realWait(4500) // longer than the whole 250/1000/3000 schedule
      expect(rt.arrivals.filter((t) => t > pausedAt)).toEqual([])
      const st = svc.status()
      expect(st.decisions['dropped:paused']).toBe(1)
      expect(st.ingest.dropped.paused).toBe(1)
      expect(st.recentFrames[0]).toMatchObject({ outcome: 'dropped' })
      svc.stop()
    } finally {
      rt.fallback = { status: 200, result: 'written' }
      rt.arrivals.length = 0
    }
  }, 10_000)

  it('R5: a frame still being built when pause begins is dropped before its first attempt', async () => {
    fetchCalls = 0
    const clock = new FakeClock()
    const fake = fakeNative(200) // AX read takes 200 ms
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
    await clock.advance(600) // startup capture begins building
    await realWait(50)
    svc.pause('now')
    await realWait(400)
    expect(fetchCalls).toBe(0)
    expect(svc.status().decisions['dropped:paused']).toBe(1)
    svc.stop()
  })

  it('R5: excluding the app of a parked frame withdraws it', async () => {
    rt.script.push({ status: 200, raw: '{}' }) // malformed 200: parked once
    const clock = new FakeClock()
    const fake = fakeNative()
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
    await clock.advance(600)
    await realWait(150)
    expect(svc.status().ingest.parked).toBe(1)
    svc.addExclusion('bundleId', 'com.apple.Notes')
    expect(svc.status().ingest).toMatchObject({ parked: 0, dropped: { excluded_app: 1 } })
    svc.stop()
  })

  it('built-in: other Lens instances and this repo’s dev Electron are never captured, generic Electron apps are', async () => {
    fetchCalls = 0
    const clock = new FakeClock()
    const fake = fakeNative()
    fake.setFront('dev.navalia.app', 'Navalia', 501, '/Applications/Navalia.app')
    const svc = make({ storeRoot: tmp('lens-store-'), root: runtimeRoot('ingest', rt.port), clock, fake })
    expect(svc.status().excluded.builtIn).toEqual([
      { label: 'Navalia', bundleIds: ['dev.navalia.app'], bundlePaths: [SELF_APP] }
    ])
    // Not removable through the user list.
    svc.removeExclusion('bundleId', 'dev.navalia.app')
    for (let i = 0; i < 50; i++) {
      fake.setFront('dev.navalia.app', 'Navalia', 501, '/Applications/Navalia.app')
      fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'dev.navalia.app', pid: 501 })
      await clock.advance(1500)
      fake.setFront('com.github.Electron', 'Electron', 502, SELF_APP) // a second dev Lens of this checkout
      fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.github.Electron', pid: 502, bundlePath: SELF_APP })
      await clock.advance(1500)
    }
    await clock.advance(11 * 60_000) // heartbeat while a Lens instance is frontmost
    await realWait(150)
    expect(fetchCalls).toBe(0)
    expect(fake.axCalls).toBe(0)

    const OTHER = '/Users/x/other-app/node_modules/electron/dist/Electron.app'
    fake.setFront('com.github.Electron', 'Electron', 503, OTHER)
    fake.emit({ eventType: TRIGGERS.applicationActivated, bundleId: 'com.github.Electron', pid: 503, bundlePath: OTHER })
    await clock.advance(600)
    await realWait(200)
    expect(rt.received).toHaveLength(1)
    expect(rt.received[0].body.window_meta).toMatchObject({ bundle_id: 'com.github.Electron' })
    svc.stop()
  })
})
