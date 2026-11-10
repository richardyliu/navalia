// S1-R4-06 (DECISIONS-ROUND3 X2): opt-in periodic scan of the local subscription folder.
// Default off; interval ≥ 5 min; same refresh() as the 「刷新」 button (offline verify, sha256
// dedupe, top level only); timer cleared on 停用 / auto-scan off / stop(); corrupt config → off.
// Timers are fakes; every directory is a mkdtemp dir.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { PEERS_CHANNELS, type SubscriptionRefreshReport, type SubscriptionStatus } from '../../src/main/peers/api'
import { registerPeersIpc } from '../../src/main/peers/ipc'
import type { PeersDeps, PeersService } from '../../src/main/peers/service'
import { DEFAULT_AUTO_SCAN_MINUTES, MIN_AUTO_SCAN_MINUTES } from '../../src/main/peers/subscription'
import type { Timers } from '../../src/main/peers/subscription-scheduler'
import type { RuntimeClient } from '../../src/main/runtime/client'
import type { LensResult } from '../../src/shared/types'
import { autoScanLine, clampInterval, subscriptionState } from '../../src/renderer/src/components/peers/peersView'
import { friend, tempDir, text, userGraph } from './fixtures'

// Heavily Chinese UI assertions: run this file in zh (an English check is at the end).
beforeEach(() => setLocale('zh'))
const roots: string[] = []
afterEach(() => {
  setLocale('en')
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  const timers: Timers = {
    set: (fn, ms) => {
      pending.set(++id, { fn, ms })
      return id
    },
    clear: (h) => void pending.delete(h as number)
  }
  return {
    timers,
    pending,
    /** Fire every pending timer (as the event loop would) and wait for the scans. */
    async fireAll(): Promise<void> {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, t] of due) t.fn()
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

type Handler = (event: unknown, raw: unknown) => Promise<LensResult<unknown>>

function harness(opts: { storeRoot?: string } = {}) {
  const storeRoot = opts.storeRoot ?? tempDir('auto-store')
  const runtimeRoot = tempDir('auto-runtime')
  const folder = tempDir('auto-folder')
  roots.push(storeRoot, runtimeRoot, folder)
  const t = fakeTimers()
  const deps: PeersDeps = {
    storeRoot,
    runtimeRoot: () => runtimeRoot,
    now: () => new Date('2026-11-05T02:00:00Z'),
    runtime: () => ({ modelGraph: async () => userGraph() }) as unknown as RuntimeClient,
    ossTool: async () => '{}',
    saveDialog: async () => null,
    openDialog: async () => null,
    openDirectoryDialog: async () => folder,
    timers: t.timers
  }
  const handlers = new Map<string, Handler>()
  const service: PeersService = registerPeersIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, deps)
  const call = <T>(ch: string, raw?: unknown) => handlers.get(ch)!({}, raw) as Promise<LensResult<T>>
  return { storeRoot, folder, deps, call, service, ...t, configFile: path.join(storeRoot, 'peers', 'subscription.json') }
}

function data<T>(r: LensResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}

const setAuto = (h: ReturnType<typeof harness>, enabled: boolean, intervalMinutes: number) =>
  h.call<SubscriptionStatus>(PEERS_CHANNELS.subAutoScan, { enabled, intervalMinutes })

describe('subscription auto-scan (X2)', () => {
  it('is off by default: no timer at start, after choosing a folder, or after a manual refresh', async () => {
    const h = harness()
    const s0 = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s0.autoScan).toMatchObject({ enabled: false, intervalMinutes: DEFAULT_AUTO_SCAN_MINUTES, minMinutes: MIN_AUTO_SCAN_MINUTES, lastRun: null, nextAt: null })
    expect(MIN_AUTO_SCAN_MINUTES).toBeGreaterThanOrEqual(5)
    data(await h.call(PEERS_CHANNELS.subChoose))
    data(await h.call<SubscriptionRefreshReport>(PEERS_CHANNELS.subRefresh))
    expect(h.pending.size).toBe(0)
    expect(h.service.scheduler.armed()).toBe(false)
    expect(subscriptionState(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))).text).toBe('已启用（手动刷新）')
  })

  it('validates the setting (zod strict, ≥ 5 min, needs a folder) and persists it 0600', async () => {
    const h = harness()
    expect(await setAuto(h, true, 10)).toMatchObject({ ok: false, error: { message: expect.stringContaining('还没有选择订阅文件夹') } })
    data(await h.call(PEERS_CHANNELS.subChoose))
    for (const bad of [
      { enabled: true, intervalMinutes: 4 },
      { enabled: true, intervalMinutes: 1441 },
      { enabled: true, intervalMinutes: 7.5 },
      { enabled: 'yes', intervalMinutes: 10 },
      { enabled: true, intervalMinutes: 10, folder: '/etc' },
      undefined
    ]) {
      expect((await h.call(PEERS_CHANNELS.subAutoScan, bad)).ok, JSON.stringify(bad)).toBe(false)
    }
    expect(h.pending.size).toBe(0)
    const s = data(await setAuto(h, true, 5))
    expect(s.autoScan).toMatchObject({ enabled: true, intervalMinutes: 5 })
    expect(fs.statSync(h.configFile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(h.configFile, 'utf8')).autoScan).toEqual({ enabled: true, intervalMinutes: 5 })
    expect(subscriptionState(s).text).toBe('已启用（每 5 分钟扫描）')
  })

  it('a tick runs the same refresh: imports a top-level card once, dedupes by hash next time, never recurses', async () => {
    const h = harness()
    const alice = friend('auto-alice')
    const bob = friend('auto-bob')
    roots.push(alice.root, bob.root)
    data(await h.call(PEERS_CHANNELS.subChoose))
    fs.writeFileSync(path.join(h.folder, 'alice.navaliacard'), text(alice.card()))
    fs.mkdirSync(path.join(h.folder, 'nested'))
    fs.writeFileSync(path.join(h.folder, 'nested', 'bob.navaliacard'), text(bob.card()))

    const on = data(await setAuto(h, true, 15))
    expect([...h.pending.values()].map((p) => p.ms)).toEqual([15 * 60_000])
    expect(on.autoScan.nextAt).toBe('2026-11-05T02:15:00.000Z')

    await h.fireAll()
    expect(h.service.store.list().peers.map((p) => p.displayName ?? p.fingerprint)).toHaveLength(1)
    let s = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s.autoScan.lastRun).toMatchObject({ ok: true, error: null, counts: { added: 1 } })
    expect(s.lastRefreshAt).toBe('2026-11-05T02:00:00.000Z')
    expect(autoScanLine(s)).toMatch(/上次自动扫描 .*新增 1/)
    // Re-armed for the next round.
    expect([...h.pending.values()].map((p) => p.ms)).toEqual([15 * 60_000])

    await h.fireAll()
    s = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s.autoScan.lastRun!.counts).toMatchObject({ added: 0, duplicate: 1 })
    expect(h.service.store.list().peers).toHaveLength(1) // nested/bob never read
  })

  it('stops when the auto-scan is turned off, when the subscription is 停用, and on stop() (quit)', async () => {
    const h = harness()
    data(await h.call(PEERS_CHANNELS.subChoose))
    data(await setAuto(h, true, 5))
    expect(h.pending.size).toBe(1)
    data(await setAuto(h, false, 5))
    expect(h.pending.size).toBe(0)

    data(await setAuto(h, true, 5))
    const stale = [...h.pending.values()][0].fn
    data(await h.call(PEERS_CHANNELS.subDisable))
    expect(h.pending.size).toBe(0)
    // A timer callback that fires anyway after 停用 scans nothing and arms nothing.
    stale()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.pending.size).toBe(0)
    expect(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)).autoScan.lastRun).toBeNull()
    expect(autoScanLine(data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus)))).toBe('订阅已停用，定期扫描暂停')

    data(await h.call(PEERS_CHANNELS.subEnable))
    expect(h.pending.size).toBe(1)
    h.service.scheduler.stop()
    expect(h.pending.size).toBe(0)
    h.service.scheduler.sync()
    data(await setAuto(h, true, 6))
    expect(h.pending.size).toBe(0)
  })

  it('changing the interval re-arms with the new value; a failed scan is recorded and retried next round', async () => {
    const h = harness()
    data(await h.call(PEERS_CHANNELS.subChoose))
    data(await setAuto(h, true, 5))
    data(await setAuto(h, true, 60))
    expect([...h.pending.values()].map((p) => p.ms)).toEqual([60 * 60_000])
    fs.rmSync(h.folder, { recursive: true, force: true })
    await h.fireAll()
    const s = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s.autoScan.lastRun).toMatchObject({ ok: false, counts: null, error: expect.stringContaining('不存在') })
    expect(h.pending.size).toBe(1)
  })

  it('a persisted "on" config arms the timer at startup; a corrupt or out-of-range config reads as off', async () => {
    const h = harness()
    data(await h.call(PEERS_CHANNELS.subChoose))
    data(await setAuto(h, true, 5))
    const h2 = harness({ storeRoot: h.storeRoot })
    expect(h2.pending.size).toBe(1)

    const cfg = JSON.parse(fs.readFileSync(h.configFile, 'utf8'))
    fs.writeFileSync(h.configFile, JSON.stringify({ ...cfg, autoScan: { enabled: true, intervalMinutes: 1 } }))
    const h3 = harness({ storeRoot: h.storeRoot })
    expect(h3.pending.size).toBe(0)
    expect(data(await h3.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))).toMatchObject({ enabled: false, autoScan: { enabled: false } })

    fs.writeFileSync(h.configFile, '{"version":1,"autoScan":{"enabled":true')
    const h4 = harness({ storeRoot: h.storeRoot })
    expect(h4.pending.size).toBe(0)
  })

  it('a tick during a manual refresh is recorded as busy, never overlaps', async () => {
    const h = harness()
    data(await h.call(PEERS_CHANNELS.subChoose))
    data(await setAuto(h, true, 5))
    const carol = friend('auto-carol')
    roots.push(carol.root)
    // A candidate file makes the manual refresh yield (await importOne) while still busy.
    fs.writeFileSync(path.join(h.folder, 'carol.navaliacard'), text(carol.card()))
    const manual = h.call(PEERS_CHANNELS.subRefresh)
    await h.service.scheduler.tick()
    await manual
    const s = data(await h.call<SubscriptionStatus>(PEERS_CHANNELS.subStatus))
    expect(s.autoScan.lastRun).toMatchObject({ ok: false, error: expect.stringContaining('正在刷新') })
  })

  it('clampInterval keeps typed values in range', () => {
    const a = { minMinutes: 5, maxMinutes: 1440, intervalMinutes: 30 }
    expect(clampInterval('2', a)).toBe(5)
    expect(clampInterval('99999', a)).toBe(1440)
    expect(clampInterval('abc', a)).toBe(30)
    expect(clampInterval(12, a)).toBe(12)
  })
})

describe('auto-scan view-model in English (default locale)', () => {
  it('state line reads in English', () => {
    setLocale('en')
    const base = { minMinutes: 5, maxMinutes: 1440, intervalMinutes: 30, nextAt: null, lastRun: null }
    const s = { enabled: true, folder: '/x', folderProblem: null, autoScan: { ...base, enabled: true } } as unknown as SubscriptionStatus
    expect(subscriptionState(s).text).toBe('Enabled (scans every 30 min)')
    expect(autoScanLine(s)).toBe('Periodic scan is on')
  })
})
