// S1-R4-05 service: permission flow on first enable, scheduler lifecycle (≤1 tick / 15 min, timer only
// while on), 0600 files with no text, IPC validation. Temp Lens Store only.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROACTIVE_CHANNELS, PROACTIVE_TICK_MS } from '../../src/main/proactive/api'
import { registerProactiveIpc } from '../../src/main/proactive/ipc'
import { createProactiveScheduler } from '../../src/main/proactive/scheduler'
import { createProactiveService } from '../../src/main/proactive/service'
import { PROACTIVE_SETTINGS_FILENAME } from '../../src/main/proactive/settings'
import { PROACTIVE_LOG_FILENAME, PROACTIVE_STATE_FILENAME } from '../../src/main/proactive/store'
import { clock, fakeNotifier, fakeSources, HOUR, MIN, tempDir, safeRm } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) safeRm(r)
})

function fakeTimers() {
  const live = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  return {
    live,
    created: [] as number[],
    cleared: [] as number[],
    setInterval(fn: () => void, ms: number) {
      id += 1
      live.set(id, { fn, ms })
      this.created.push(ms)
      return id
    },
    clearInterval(h: unknown) {
      live.delete(h as number)
      this.cleared.push(h as number)
    },
    fire() {
      for (const t of live.values()) t.fn()
    }
  }
}

function setup(opts: { notifier?: ReturnType<typeof fakeNotifier>; aliases?: string[] } = {}) {
  const root = tempDir('svc')
  roots.push(root)
  const c = clock()
  const timers = fakeTimers()
  const notifier = opts.notifier ?? fakeNotifier()
  const src = fakeSources({ aliases: opts.aliases ?? ['张三', 'https://example.com/x'] })
  const pages: string[] = []
  const svc = createProactiveService({
    storeRoot: root,
    now: c.now,
    timezone: () => 'Asia/Shanghai',
    notifier,
    sources: src.sources,
    openPage: (p) => void pages.push(p),
    hasWindow: () => true,
    timers
  })
  return { root, c, timers, notifier, src, svc, pages }
}

const mode = (f: string): number => fs.statSync(f).mode & 0o777
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('first enable → test notification, permission recorded', () => {
  it('default: off, no timer, no notification, no files', async () => {
    const t = setup()
    await t.svc.start()
    expect(t.svc.running()).toBe(false)
    expect(t.timers.created).toEqual([])
    expect(t.notifier.shown).toEqual([])
    const v = t.svc.view()
    expect(v.settings.enabled).toBe(false)
    expect(v.permission.state).toBe('not_asked')
    expect(fs.readdirSync(t.root)).toEqual([])
  })

  it('turning the master switch on shows one test notification and starts one ≥15 min timer', async () => {
    const t = setup()
    const v = await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    expect(t.notifier.shown.map((n) => n.body)).toEqual(['Notifications are on. This is a test notification with no memory content.', '2 names that might be yours to confirm'])
    expect(v.permission.state).toBe('shown')
    expect(v.running).toBe(true)
    expect(t.timers.created).toEqual([PROACTIVE_TICK_MS])
    expect(PROACTIVE_TICK_MS).toBeGreaterThanOrEqual(15 * MIN)
  })

  it('unsupported → recorded, no timer, nothing sent, no fallback', async () => {
    const t = setup({ notifier: fakeNotifier('shown', false) })
    const v = await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    expect(v.permission.state).toBe('unsupported')
    expect(v.running).toBe(false)
    expect(t.notifier.shown).toEqual([])
    expect((await t.svc.tick()).skipped).toBe('permission')
  })

  it('test not shown → no timer; toggling off/on does not ask again (no nagging)', async () => {
    const n = fakeNotifier('failed')
    const t = setup({ notifier: n })
    await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    expect(t.svc.view().permission.state).toBe('not_shown')
    await t.svc.update({ enabled: false })
    await t.svc.update({ enabled: true })
    expect(n.shown).toHaveLength(1)
    expect(t.svc.running()).toBe(false)
    // Only the explicit 「重新测试」 asks again.
    n.result = 'shown'
    const v = await t.svc.test()
    expect(v.permission.state).toBe('shown')
    expect(v.running).toBe(true)
  })

  it('user reports denied → timer stops, nothing sent', async () => {
    const t = setup()
    await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    const v = await t.svc.reportDenied()
    expect(v.permission.state).toBe('denied')
    expect(v.running).toBe(false)
    expect(t.timers.live.size).toBe(0)
    expect((await t.svc.tick()).skipped).toBe('permission')
  })
})

describe('scheduler lifecycle', () => {
  it('switch off clears the timer; stop() (app quit) clears it too', async () => {
    const t = setup()
    await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    expect(t.timers.live.size).toBe(1)
    await t.svc.update({ enabled: false })
    expect(t.timers.live.size).toBe(0)
    await t.svc.update({ enabled: true })
    expect(t.timers.live.size).toBe(1)
    t.svc.stop()
    expect(t.timers.live.size).toBe(0)
  })

  it('at most one tick per 15 min however often it is poked', async () => {
    const c = clock()
    const timers = fakeTimers()
    let ticks = 0
    const s = createProactiveScheduler({ tick: async () => void ticks++, shouldRun: () => true, now: c.now, timers, intervalMs: 1000 })
    await s.reconcile()
    await s.reconcile()
    expect(timers.created).toEqual([PROACTIVE_TICK_MS]) // a smaller interval is raised to 15 min
    timers.fire()
    await flush()
    c.advance(14 * MIN)
    timers.fire()
    await flush()
    expect(ticks).toBe(1)
    c.advance(MIN)
    timers.fire()
    await flush()
    expect(ticks).toBe(2)
  })

  it('a corrupt settings file keeps everything off at start', async () => {
    const t = setup()
    fs.writeFileSync(path.join(t.root, PROACTIVE_SETTINGS_FILENAME), '{"enabled": true, "oops"')
    await t.svc.start()
    expect(t.svc.running()).toBe(false)
    const v = t.svc.view()
    expect(v.settingsError).toMatch(/is invalid/)
    expect(v.settings.enabled).toBe(false)
    expect((await t.svc.tick()).skipped).toBe('settings_error')
    expect(t.notifier.shown).toEqual([])
  })
})

describe('files', () => {
  it('settings, state and log are 0600; the log holds trigger, time, source ids and no text', async () => {
    const t = setup()
    await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    t.c.advance(HOUR)
    for (const f of [PROACTIVE_SETTINGS_FILENAME, PROACTIVE_STATE_FILENAME, PROACTIVE_LOG_FILENAME]) {
      expect(mode(path.join(t.root, f)), f).toBe(0o600)
    }
    const raw = fs.readFileSync(path.join(t.root, PROACTIVE_LOG_FILENAME), 'utf8')
    const log = JSON.parse(raw) as { version: number; entries: Array<Record<string, unknown>> }
    expect(log.entries.map((e) => e.trigger)).toEqual(['test', 'owner_aliases'])
    for (const e of log.entries) expect(Object.keys(e).sort()).toEqual(['source_ids', 'time', 'trigger'])
    const all = raw + fs.readFileSync(path.join(t.root, PROACTIVE_STATE_FILENAME), 'utf8')
    for (const s of ['张三', 'example.com', '待确认', '测试通知']) expect(all).not.toContain(s)
  })

  it('view() exposes the log newest first', async () => {
    const t = setup()
    const v = await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    expect(v.log.map((e) => e.trigger)).toEqual(['owner_aliases', 'test'])
    expect(v.sentToday).toBe(1) // the test notification does not count toward the cap
  })
})

describe('IPC', () => {
  it('validates input; an invalid patch writes nothing', async () => {
    const t = setup()
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<{ ok: boolean; error?: { message: string } }>>()
    registerProactiveIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, t.svc)
    expect([...handlers.keys()].sort()).toEqual(Object.values(PROACTIVE_CHANNELS).sort())
    const call = (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw)
    expect((await call(PROACTIVE_CHANNELS.get)).ok).toBe(true)
    for (const bad of [{ patch: { enabled: 'yes' } }, { patch: { triggers: { score: true } } }, { patch: { quietHours: { start: '24:00', end: '09:00' } } }, { patch: { extra: 1 } }, { nope: 1 }]) {
      const r = await call(PROACTIVE_CHANNELS.set, bad)
      expect(r.ok).toBe(false)
    }
    expect(fs.readdirSync(t.root)).toEqual([])
    expect((await call(PROACTIVE_CHANNELS.get, { x: 1 })).ok).toBe(false)
    const ok = await call(PROACTIVE_CHANNELS.set, { patch: { quietHours: { start: '23:00', end: '07:30' }, briefTime: '08:15' } })
    expect(ok.ok).toBe(true)
    expect(t.svc.view().settings.quietHours).toEqual({ start: '23:00', end: '07:30' })
    expect(t.notifier.shown).toEqual([]) // changing times while off asks nothing
  })
})
