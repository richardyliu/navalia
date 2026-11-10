import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Clock } from '../../src/main/capture/clock'
import type { LensNative, NativeEvent } from '../../src/main/capture/native'
import { startCapture, type CaptureHandle, type FrameRecord } from '../../src/main/capture/pipeline'
import { FakeClock } from './fake-clock'

/**
 * OG-02 harness: the real pipeline (startCapture -> coordinator -> buildFrame ->
 * IngestClient) with a fake addon, a fake clock and a recording fetch. Nothing
 * here touches TCC, the screen, ~/.persome or the network.
 */

/** Not a real token; asserted never to appear in frame records. */
export const TEST_TOKEN = 'og02-test-token-0123456789abcdef0123456789'
/** Synthetic JPEG: SOI/APP0 marker + filler. Never real pixels. */
export const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('OG02-FAKE-PIXELS-'.repeat(8)), Buffer.from([0xff, 0xd9])])

export interface FakeFront {
  pid: number
  name: string
  bundleId: string
  windowTitle?: string | null
}

export interface FakeNativeOptions {
  front: FakeFront
  /** JSON text axTree() resolves to; null = AX read fails. */
  tree: string | null
  accessibility?: boolean
  screenRecording?: boolean
  jpeg?: Buffer | null
  url?: string | null
  urlHandlers?: string[]
}

export function fakeNative(opts: FakeNativeOptions): {
  native: LensNative
  calls: string[]
  emit: (e: Partial<NativeEvent> & { eventType: string }) => void
  setFront: (f: FakeFront, tree: string | null) => void
} {
  const calls: string[] = []
  let front = opts.front
  let tree = opts.tree
  let listener: ((e: NativeEvent) => void) | null = null
  const native = {
    permissions: () => ({ accessibility: opts.accessibility ?? true, screenRecording: opts.screenRecording ?? true }),
    frontmost: () => (calls.push('frontmost'), { pid: front.pid, name: front.name, bundleId: front.bundleId, bundlePath: null, windowTitle: front.windowTitle ?? null }),
    axTree: async () => {
      calls.push('axTree')
      if (tree === null) throw new Error('AX unavailable')
      return tree
    },
    screenshot: async (o: unknown) => {
      calls.push(`screenshot:${JSON.stringify(o)}`)
      const jpeg = opts.jpeg === undefined ? FAKE_JPEG : opts.jpeg
      return jpeg ? { data: jpeg, width: 800, height: 600, mimeType: 'image/jpeg', backend: 'screencapturekit' } : null
    },
    browserUrl: (pid: number) => (calls.push(`browserUrl:${pid}`), opts.url ?? null),
    urlHandlers: () => opts.urlHandlers ?? [],
    observe: (cb: (e: NativeEvent) => void) => ((listener = cb), { accessibilityObservers: opts.accessibility ?? true }),
    stopObserving: () => (listener = null)
  } as unknown as LensNative
  return {
    native,
    calls,
    emit: (e) => listener?.({ pid: front.pid, appName: front.name, bundleId: front.bundleId, ...e } as NativeEvent),
    setFront: (f, t) => {
      front = f
      tree = t
    }
  }
}

/** FakeClock with a wall-clock epoch so ISO timestamps look like real ones. */
export function epochClock(fake: FakeClock, epochMs: number): Clock {
  return {
    now: () => epochMs + fake.now(),
    setTimeout: (fn, ms) => fake.setTimeout(fn, ms),
    clearTimeout: (h) => fake.clearTimeout(h)
  }
}

export interface Posted {
  url: string
  authorization: string | null
  body: string
  json: Record<string, unknown>
}

const roots: string[] = []
export function tempRuntimeRoot(captureToml: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-og02-'))
  roots.push(base)
  fs.writeFileSync(path.join(base, 'config.toml'), `[capture]\n${captureToml}\n`)
  return base
}
export function cleanupRoots(): void {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
}

export function runPipeline(args: {
  native: LensNative
  captureToml: string
  clock: Clock
  respond?: (n: number) => { status: number; data?: Record<string, unknown> }
}): { handle: CaptureHandle; posted: Posted[]; records: FrameRecord[]; root: string } {
  const posted: Posted[] = []
  const records: FrameRecord[] = []
  const root = tempRuntimeRoot(args.captureToml)
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    const body = String(init.body)
    posted.push({ url, authorization: headers.Authorization ?? null, body, json: JSON.parse(body) })
    const r = args.respond?.(posted.length) ?? { status: 200, data: { id: `f${posted.length}`, deduped: false, skipped: false } }
    return new Response(JSON.stringify({ data: r.data ?? {} }), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const handle = startCapture({
    appPath: '/nonexistent',
    root,
    port: 8761,
    getToken: () => TEST_TOKEN,
    lockSource: new EventEmitter(),
    selfPid: 4242,
    native: args.native,
    clock: args.clock,
    fetchImpl,
    onFrame: (r) => records.push(r)
  })
  return { handle, posted, records, root }
}

/** Synthetic Safari surface: address bar + web area, as the addon serializes it. */
export function safariTree(url: string, ts = '2026-11-05T18:00:00Z'): string {
  return JSON.stringify({
    apps: [
      {
        bundle_id: 'com.apple.Safari',
        is_frontmost: true,
        name: 'Safari',
        pid: 700,
        windows: [
          {
            elements: [
              { role: 'AXTextField', description: 'Smart Search Field', value: url },
              {
                role: 'AXWebArea',
                title: 'Example Domain',
                children: [
                  { role: 'AXHeading', title: 'Example Domain' },
                  { role: 'AXStaticText', value: 'This domain is for use in illustrative examples in documents.' }
                ]
              }
            ],
            focused: true,
            title: 'Example Domain'
          }
        ]
      }
    ],
    timestamp: ts
  })
}

/** AX-poor surface (canvas app): window title only, no element text. */
export function canvasTree(ts = '2026-11-05T18:00:00Z'): string {
  return JSON.stringify({
    apps: [
      {
        bundle_id: 'com.example.canvas',
        is_frontmost: true,
        name: 'Canvas',
        pid: 710,
        windows: [{ elements: [{ role: 'AXGroup', children: [{ role: 'AXButton' }] }], focused: true, title: 'Board' }]
      }
    ],
    timestamp: ts
  })
}
