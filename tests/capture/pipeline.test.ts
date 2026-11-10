import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { readCaptureSource, readRuntimeCaptureConfig, startCapture } from '../../src/main/capture/pipeline'
import type { LensNative, NativeEvent } from '../../src/main/capture/native'

const tmpRoots: string[] = []
function tempRoot(config: string | null): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-capture-'))
  tmpRoots.push(base)
  if (config !== null) fs.writeFileSync(path.join(base, 'config.toml'), config)
  return base
}
afterEach(() => {
  for (const r of tmpRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function fakeNative(trusted = true) {
  let listener: ((e: NativeEvent) => void) | null = null
  const native = {
    permissions: () => ({ accessibility: trusted, screenRecording: false }),
    frontmost: () => ({ pid: 1, name: 'Notes', bundleId: 'com.apple.Notes', bundlePath: null, windowTitle: 'x' }),
    observe: (cb: (e: NativeEvent) => void) => ((listener = cb), { accessibilityObservers: true }),
    stopObserving: () => (listener = null),
    axTree: async () => '{"apps":[],"timestamp":"2026-11-04T20:00:00Z"}',
    screenshot: async () => null
  } as unknown as LensNative
  return { native, emit: (e: NativeEvent) => listener?.(e), observing: () => listener !== null }
}

describe('readCaptureSource', () => {
  it('reads [capture] source and defaults to daemon', () => {
    expect(readCaptureSource(tempRoot(null))).toBe('daemon')
    expect(readCaptureSource(tempRoot('[mcp]\nsource = "ingest"\n'))).toBe('daemon')
    expect(readCaptureSource(tempRoot('[capture]\nsource = "ingest"   # app pushes\n'))).toBe('ingest')
    expect(readCaptureSource(tempRoot("[capture]\nsource='daemon'\n"))).toBe('daemon')
  })
})

describe('readRuntimeCaptureConfig', () => {
  it('parses scalar [capture] keys only', () => {
    const root = tempRoot('[capture]\nsource = "ingest" # x\ninclude_screenshot = false\nbuffer_retention_hours = 72\nlist = [1,2]\n[timeline]\nwindow_minutes = 1\n')
    expect(readRuntimeCaptureConfig(root)).toEqual({ source: 'ingest', include_screenshot: false, buffer_retention_hours: 72 })
  })
})

describe('startCapture guards', () => {
  const base = { appPath: '/nonexistent', port: 1, getToken: () => 'x', lockSource: new EventEmitter() }

  it('refuses to run while the Runtime still owns capture', () => {
    const { native, observing } = fakeNative()
    const h = startCapture({ ...base, root: tempRoot('[capture]\nsource = "daemon"\n'), native })
    expect(h.status()).toMatchObject({ started: false, reason: expect.stringContaining('"daemon"') })
    expect(observing()).toBe(false)
  })

  it('starts degraded without Accessibility (frames carry no AX text)', () => {
    const { native } = fakeNative(false)
    const h = startCapture({ ...base, root: tempRoot('[capture]\nsource = "ingest"\n'), native })
    expect(h.status()).toMatchObject({ started: true, reason: null, degraded: expect.stringContaining('Accessibility') })
    h.stop()
  })

  it('starts in ingest mode, follows screen lock, and stops cleanly', () => {
    const { native, observing } = fakeNative()
    const lock = new EventEmitter()
    const h = startCapture({ ...base, lockSource: lock, root: tempRoot('[capture]\nsource = "ingest"\n'), native })
    expect(h.status()).toMatchObject({ started: true, accessibilityObservers: true })
    expect(observing()).toBe(true)
    lock.emit('lock-screen')
    expect(h.coordinator!.state.locked).toBe(true)
    lock.emit('unlock-screen')
    expect(h.coordinator!.state.locked).toBe(false)
    h.stop()
    expect(observing()).toBe(false)
    expect(lock.listenerCount('lock-screen')).toBe(0)
  })
})
