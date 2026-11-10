// S1-R4-05 test helpers: injected clock, notifier, sources and store. No Electron, no network, no
// real Lens Store (temp dirs only).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProactiveEngine, type BriefSample, type CaptureSample, type Notifier, type ProactiveSources, type RuntimeSample } from '../../src/main/proactive/engine'
import type { ProactiveSettings, ProactiveTrigger } from '../../src/main/proactive/api'
import { defaultProactiveSettings } from '../../src/main/proactive/settings'
import { createMemoryStore } from '../../src/main/proactive/store'

export const TZ = 'Asia/Shanghai'
/** 2026-11-05 12:00 Asia/Shanghai (outside default quiet hours, after default briefTime 09:00). */
export const NOON = Date.parse('2026-11-05T04:00:00Z')
export const MIN = 60_000
export const HOUR = 60 * MIN

/** Every temp dir these tests create starts with this basename prefix. */
export const TMP_PREFIX = 'lens-pp-'

export function tempDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}${tag}-`))
}

/**
 * Removes a temp dir this suite created. Refuses anything whose basename does not start with
 * TMP_PREFIX, the OS temp dir itself, and anything not directly under it.
 */
export function safeRm(dir: string): void {
  const resolved = path.resolve(dir)
  const tmp = path.resolve(os.tmpdir())
  if (!path.basename(resolved).startsWith(TMP_PREFIX)) throw new Error(`refusing to remove ${resolved}: not a ${TMP_PREFIX} dir`)
  if (resolved === tmp || path.dirname(resolved) !== tmp) throw new Error(`refusing to remove ${resolved}: not directly under the temp dir`)
  fs.rmSync(resolved, { recursive: true, force: true })
}

export function clock(start = NOON) {
  let t = start
  return { now: () => t, set: (v: number) => void (t = v), advance: (ms: number) => void (t += ms) }
}

export function fakeNotifier(result: 'shown' | 'failed' | 'timeout' = 'shown', supported = true) {
  const shown: Array<{ title: string; body: string; onClick?: () => void }> = []
  const n: Notifier & { shown: typeof shown; result: typeof result; supported: boolean } = {
    shown,
    result,
    supported,
    isSupported: () => n.supported,
    show: async (x, onClick) => {
      shown.push({ ...x, onClick })
      return n.result
    }
  }
  return n
}

export interface FakeSourceData {
  aliases: string[] | null
  capture: CaptureSample | null
  runtime: RuntimeSample | null
  brief: BriefSample | null
}

export const GOOD_CAPTURE: CaptureSample = {
  captureActive: true,
  accessibility: true,
  screenRecording: true,
  ingestRejectedTotal: 0,
  health: { ocr_enabled: true, ocr: 'ready', ocr_worker: 'ready', capture_pipeline: 'ok' }
}

export function fakeSources(init: Partial<FakeSourceData> = {}) {
  const data: FakeSourceData = { aliases: [], capture: GOOD_CAPTURE, runtime: { reachable: true, revision: null }, brief: { nextSteps: [], yesterdayTodos: [] }, ...init }
  const calls: Record<string, number> = { aliases: 0, capture: 0, runtime: 0, brief: 0 }
  const sources: ProactiveSources = {
    ownerAliasesPending: async () => (calls.aliases++, data.aliases),
    capture: async () => (calls.capture++, data.capture),
    runtime: async () => (calls.runtime++, data.runtime),
    brief: async () => (calls.brief++, data.brief)
  }
  return { data, calls, sources }
}

export function settingsWith(triggers: ProactiveTrigger[], over: Partial<ProactiveSettings> = {}): ProactiveSettings {
  const s = defaultProactiveSettings()
  s.enabled = true
  for (const t of triggers) s.triggers[t] = true
  return { ...s, ...over }
}

/** Engine over an in-memory store with permission already `shown`. */
export function rig(opts: { settings?: ProactiveSettings; settingsError?: string | null; init?: Partial<FakeSourceData>; start?: number; window?: boolean } = {}) {
  const c = clock(opts.start)
  const notifier = fakeNotifier()
  const src = fakeSources(opts.init)
  const store = createMemoryStore()
  const s0 = store.readState()
  s0.permission = { state: 'shown', at: new Date(c.now()).toISOString() }
  store.writeState(s0)
  const pages: string[] = []
  let settings = opts.settings ?? defaultProactiveSettings()
  const engine = createProactiveEngine({
    now: c.now,
    timezone: () => TZ,
    readSettings: () => ({ settings, error: opts.settingsError ?? null }),
    store,
    sources: src.sources,
    notifier,
    openPage: (p) => void pages.push(p),
    hasWindow: () => opts.window ?? true
  })
  return {
    clock: c,
    notifier,
    src,
    store,
    pages,
    engine,
    setSettings: (s: ProactiveSettings) => void (settings = s)
  }
}
