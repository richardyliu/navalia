// S1-FULL C17: proactive layer extensions. All OFF by default (incl. v1 → v2 migration), master switch
// turns everything off at once, context-sufficiency gate (silent below threshold, fires above),
// event bus, weekly 「表现」 trigger, quiet hours / daily cap for events, own global shortcut with a
// fake registry, tray items, detail text, and the local decision log (0600, no text).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BODY, DEFAULT_PROACTIVE_ACCELERATOR, PROACTIVE_TRIGGERS, type ProactiveTrigger } from '../../src/main/proactive/api'
import type { WeekSample } from '../../src/main/proactive/engine'
import { createProactiveEventBus, type ProactiveEvent } from '../../src/main/proactive/events'
import { createProactiveService } from '../../src/main/proactive/service'
import { defaultProactiveSettings, proactiveSettingsFile, readProactiveSettings } from '../../src/main/proactive/settings'
import { createProactiveShortcut, type ShortcutRegistry } from '../../src/main/proactive/shortcut'
import { PROACTIVE_DECISIONS_FILENAME, PROACTIVE_STATE_FILENAME } from '../../src/main/proactive/store'
import { clock, fakeNotifier, fakeSources, HOUR, MIN, NOON, rig, safeRm, settingsWith, tempDir } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) safeRm(r)
})

function fakeRegistry(taken: string[] = []) {
  const held = new Map<string, () => void>()
  const calls: string[] = []
  const reg: ShortcutRegistry & { held: typeof held; calls: string[]; refuse: Set<string> } = {
    held,
    calls,
    refuse: new Set(taken),
    register(acc, cb) {
      calls.push(`register:${acc}`)
      if (reg.refuse.has(acc)) return false
      held.set(acc, cb)
      return true
    },
    unregister(acc) {
      calls.push(`unregister:${acc}`)
      held.delete(acc)
    },
    isRegistered: (acc) => held.has(acc)
  }
  return reg
}

function svcSetup(opts: { lastWeek?: (now: number, tz: string) => Promise<WeekSample | null>; reserved?: string[]; start?: number } = {}) {
  const root = tempDir('c17')
  roots.push(root)
  const c = clock(opts.start)
  const notifier = fakeNotifier()
  const src = fakeSources()
  if (opts.lastWeek) src.sources.lastWeek = opts.lastWeek
  const bus = createProactiveEventBus()
  const registry = fakeRegistry()
  const pages: string[] = []
  const timers = { created: 0, cleared: 0, setInterval: () => (timers.created++, 1), clearInterval: () => void timers.cleared++ }
  const svc = createProactiveService({
    storeRoot: root,
    now: c.now,
    timezone: () => 'Asia/Shanghai',
    notifier,
    sources: src.sources,
    openPage: (p) => void pages.push(p),
    hasWindow: () => true,
    timers,
    shortcuts: registry,
    reservedAccelerators: () => opts.reserved ?? [],
    bus
  })
  return { root, c, notifier, src, bus, registry, pages, timers, svc }
}

const meeting = (id: string, n: number, withEvidence = true, label?: string): ProactiveEvent => ({
  type: 'meeting.transcript_ready',
  id,
  items: Array.from({ length: n }, (_, i) => ({ id: `seg-${i}`, evidence: withEvidence ? `00:0${i}:00` : '' })),
  ...(label ? { label } : {})
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('defaults: everything off', () => {
  it('fresh defaults: master, every trigger, tray, shortcut and detail are off', () => {
    const d = defaultProactiveSettings()
    expect(d.version).toBe(2)
    expect(d.enabled).toBe(false)
    for (const t of PROACTIVE_TRIGGERS) expect(d.triggers[t]).toBe(false)
    expect(d.tray).toBe(false)
    expect(d.shortcut).toEqual({ enabled: false, accelerator: DEFAULT_PROACTIVE_ACCELERATOR })
    expect(d.detail).toBe(false)
  })

  it('a v1 file migrates: user values kept, every new field off, T1/T2 keep firing every day', () => {
    const root = tempDir('mig')
    roots.push(root)
    const file = proactiveSettingsFile(root)
    const v1 = {
      version: 1,
      enabled: true,
      triggers: { owner_aliases: true, capture_degraded: false, runtime: false, daily_brief: true, carried_todos: false },
      quietHours: { start: '23:00', end: '08:00' },
      briefTime: '10:30'
    }
    fs.writeFileSync(file, JSON.stringify(v1))
    const r = readProactiveSettings(file)
    expect(r.error).toBeNull()
    expect(r.settings.enabled).toBe(true)
    expect(r.settings.triggers).toMatchObject({ owner_aliases: true, daily_brief: true, meeting_ready: false, friend_moment: false, weekly_counts: false })
    expect(r.settings.quietHours).toEqual({ start: '23:00', end: '08:00' })
    expect(r.settings.briefDays).toBe('all')
    expect(r.settings.tray).toBe(false)
    expect(r.settings.shortcut.enabled).toBe(false)
    expect(r.settings.detail).toBe(false)
  })

  it('service start with no file: no timer, no shortcut registered, no tray items, no files', async () => {
    const t = svcSetup()
    await t.svc.start()
    expect(t.timers.created).toBe(0)
    expect(t.registry.calls).toEqual([])
    expect(t.svc.view().tray).toEqual([])
    expect(t.svc.view().shortcut.state).toBe('off')
    expect(t.bus.publish(meeting('m1', 5))).toBe(true)
    await flush()
    expect(t.notifier.shown).toEqual([])
    expect(fs.readdirSync(t.root)).toEqual([])
  })
})

describe('master switch', () => {
  it('turning it off unregisters the shortcut, clears tray items, timer and pending events at once', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, tray: true, quietHours: { start: '00:00', end: '23:59' }, triggers: { meeting_ready: true }, shortcut: { enabled: true } })
    expect(t.registry.held.has(DEFAULT_PROACTIVE_ACCELERATOR)).toBe(true)
    expect(t.svc.view().tray.length).toBeGreaterThan(0)
    expect(t.svc.running()).toBe(true)
    // Quiet hours: the event stays pending.
    await t.svc.onEvent(meeting('m1', 5))
    expect(t.svc.view().pendingEvents).toBe(1)

    await t.svc.update({ enabled: false })
    expect(t.registry.held.size).toBe(0)
    expect(t.registry.calls).toContain(`unregister:${DEFAULT_PROACTIVE_ACCELERATOR}`)
    expect(t.svc.view().tray).toEqual([])
    expect(t.svc.running()).toBe(false)
    expect(t.svc.view().pendingEvents).toBe(0)
    const shownBefore = t.notifier.shown.length
    expect(await t.svc.onEvent(meeting('m2', 9))).toBeNull()
    expect(await t.svc.tick()).toMatchObject({ skipped: 'off', decisions: [] })
    expect(t.notifier.shown.length).toBe(shownBefore)
  })

  it('tray 「关闭全部提醒」 is the master switch', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, tray: true, triggers: { owner_aliases: true } })
    const items = t.svc.trayItems()
    expect(items.map((i) => i.kind === 'action' && i.id).filter(Boolean)).toEqual(['proactive_open_log', 'proactive_pause_all'])
    expect(JSON.stringify(items)).not.toMatch(/张|https?:/)
    await t.svc.trayAction('proactive_open_log')
    expect(t.pages).toEqual(['settings'])
    await t.svc.trayAction('proactive_pause_all')
    expect(t.svc.view().settings.enabled).toBe(false)
    expect(t.svc.trayItems()).toEqual([])
  })
})

describe('context-sufficiency gate', () => {
  it('meeting event: silent below the threshold (logged), fires at/above it', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { meeting_ready: true } })
    const base = t.notifier.shown.length // the permission test notification
    t.bus.publish(meeting('m-small', 2))
    await flush()
    await flush()
    expect(t.notifier.shown.length).toBe(base)
    const silent = t.svc.view().decisions.find((d) => d.trigger === 'meeting_ready')
    expect(silent).toMatchObject({ outcome: 'suppressed', reason: 'below_threshold', count: 2, threshold: 3 })

    const r = await t.svc.onEvent(meeting('m-big', 4))
    expect(r?.sent.map((s) => s.body)).toEqual([BODY.meetingReady(4)])
    expect(t.notifier.shown.length).toBe(base + 1)
    t.notifier.shown[t.notifier.shown.length - 1].onClick!()
    expect(t.pages).toEqual(['meetings'])
    expect(t.svc.view().decisions[0]).toMatchObject({ trigger: 'meeting_ready', outcome: 'fired', count: 4, threshold: 3 })
  })

  it('items without an evidence pointer do not count', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { meeting_ready: true } })
    const r = await t.svc.onEvent(meeting('m-noev', 10, false))
    expect(r?.sent).toEqual([])
    expect(r?.decisions[0]).toMatchObject({ reason: 'below_threshold', count: 0 })
  })

  it('daily brief: threshold is configurable; below it silent, at it fires', async () => {
    const r = rig({ settings: settingsWith(['daily_brief'], { minItems: { ...defaultProactiveSettings().minItems, daily_brief: 3 } }), init: { brief: { nextSteps: ['a', 'b'], yesterdayTodos: [] } } })
    const res = await r.engine.tick()
    expect(res.sent).toEqual([])
    expect(res.decisions).toEqual([expect.objectContaining({ trigger: 'daily_brief', reason: 'below_threshold', count: 2, threshold: 3 })])
    r.src.data.brief = { nextSteps: ['a', 'b', 'c'], yesterdayTodos: [] }
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual([BODY.dailyBrief(3)])
  })

  it('weekly 「表现」 counts: fires once per week above the threshold, silent below, wrong week ignored', async () => {
    const lastMonday = '2026-10-26' // NOON is Thu 2026-11-05 → previous ISO week starts Mon 10-26
    let sample: WeekSample | null = { weekStart: lastMonday, items: ['accepted:t1', 'git_commit:r:h1'] }
    const t = svcSetup({ lastWeek: async () => sample })
    await t.svc.update({ enabled: true, triggers: { weekly_counts: true } })
    let res = await t.svc.tick()
    expect(res.sent).toEqual([])
    expect(res.decisions[0]).toMatchObject({ reason: 'below_threshold', count: 2, threshold: 3 })
    sample = { weekStart: lastMonday, items: ['accepted:t1', 'git_commit:r:h1', 'transcript_commit:e1', 'transcript_commit:e1'] }
    res = await t.svc.tick()
    expect(res.decisions[0]).toMatchObject({ trigger: 'weekly_counts', outcome: 'fired', count: 3, threshold: 3 })
    expect(res.sent.map((s) => s.body)).toEqual([BODY.weeklyCounts(3)])
    expect(res.sent[0].sourceIds).toEqual([`week:${lastMonday}`])
    t.c.advance(24 * HOUR)
    sample = { weekStart: lastMonday, items: ['a', 'b', 'c', 'd'] }
    expect((await t.svc.tick()).suppressed).toEqual([{ trigger: 'weekly_counts', reason: 'dedupe' }])
    sample = { weekStart: '2026-10-19', items: ['a', 'b', 'c', 'd'] }
    expect((await t.svc.tick()).decisions[0]).toMatchObject({ reason: 'no_source' })
  })

  it('weekdays only: Saturday is silent (not_today)', async () => {
    const saturday = NOON + 2 * 24 * HOUR
    const r = rig({ start: saturday, settings: settingsWith(['daily_brief'], { briefDays: 'weekdays' }), init: { brief: { nextSteps: ['a'], yesterdayTodos: [] } } })
    const res = await r.engine.tick()
    expect(res.sent).toEqual([])
    expect(res.decisions[0]).toMatchObject({ reason: 'not_today' })
  })
})

describe('quiet hours, daily cap, dedupe for events', () => {
  it('an event in quiet hours stays pending and is sent after quiet hours end', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { meeting_ready: true }, quietHours: { start: '11:00', end: '13:00' } })
    const r = await t.svc.onEvent(meeting('m-q', 5))
    expect(r?.suppressed).toEqual([{ trigger: 'meeting_ready', reason: 'quiet_hours' }])
    expect(t.svc.view().pendingEvents).toBe(1)
    t.c.advance(90 * MIN)
    const after = await t.svc.tick()
    expect(after.sent.map((s) => s.trigger)).toEqual(['meeting_ready'])
    expect(t.svc.view().pendingEvents).toBe(0)
  })

  it('daily cap is configurable (1): the second event waits; same event twice is deduped', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, dailyCap: 1, triggers: { meeting_ready: true } })
    expect((await t.svc.onEvent(meeting('m-1', 4)))?.sent.length).toBe(1)
    t.c.advance(30 * MIN)
    expect((await t.svc.onEvent(meeting('m-2', 4)))?.suppressed).toEqual([{ trigger: 'meeting_ready', reason: 'daily_cap' }])
    expect(t.svc.view().sentToday).toBe(1)
    expect(t.svc.view().dailyCap).toBe(1)
  })

  it('a pending event expires after 24 h (dropped and logged)', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { meeting_ready: true }, quietHours: { start: '00:00', end: '23:59' } })
    await t.svc.onEvent(meeting('m-old', 5))
    t.c.advance(25 * HOUR)
    const r = await t.svc.tick()
    expect(r.decisions).toEqual([expect.objectContaining({ trigger: 'meeting_ready', reason: 'expired' })])
    expect(t.svc.view().pendingEvents).toBe(0)
  })
})

describe('detail text', () => {
  it('off: title + count only; on: a short one-line label; the label is never written to disk', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { meeting_ready: true } })
    const secret = '与张三讨论 https://example.com/x 的周会\n第二行'
    await t.svc.onEvent(meeting('m-a', 3, true, secret))
    expect(t.notifier.shown.at(-1)!.body).toBe(BODY.meetingReady(3))
    await t.svc.update({ detail: true })
    t.c.advance(HOUR)
    await t.svc.onEvent(meeting('m-b', 3, true, secret))
    const body = t.notifier.shown.at(-1)!.body
    expect(body.startsWith(`${BODY.meetingReady(3)} · `)).toBe(true)
    expect(body).not.toContain('\n')
    expect(body.length).toBeLessThanOrEqual(BODY.meetingReady(3).length + 3 + 30)
    for (const f of fs.readdirSync(t.root)) {
      const raw = fs.readFileSync(path.join(t.root, f), 'utf8')
      expect(raw, f).not.toMatch(/张三|example\.com|周会|m-a|m-b|seg-/)
    }
  })
})

describe('decision log', () => {
  it('0600 file, folds identical consecutive decisions, holds no text, can be cleared', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { owner_aliases: true } })
    t.src.data.aliases = []
    for (let i = 0; i < 3; i++) {
      t.c.advance(20 * MIN)
      await t.svc.tick()
    }
    const file = path.join(t.root, PROACTIVE_DECISIONS_FILENAME)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(t.root, PROACTIVE_STATE_FILENAME)).mode & 0o777).toBe(0o600)
    const v = t.svc.view()
    const noChange = v.decisions.filter((d) => d.trigger === 'owner_aliases' && d.reason === 'no_change')
    expect(noChange.length).toBe(1)
    expect(noChange[0].repeat).toBeGreaterThanOrEqual(3)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Array<Record<string, unknown>> }
    for (const e of raw.entries) expect(Object.keys(e).sort()).toEqual(['count', 'last_time', 'outcome', 'reason', 'repeat', 'source_ids', 'threshold', 'time', 'trigger'])
    expect(t.svc.clearDecisions().decisions).toEqual([])
  })

  it('no permission / no window is logged once per state as an "all" decision', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), window: false })
    const res = await r.engine.tick()
    expect(res.skipped).toBe('no_window')
    expect(r.store.decisions).toEqual([expect.objectContaining({ trigger: 'all', reason: 'no_window' })])
  })
})

describe('global shortcut (fake registry)', () => {
  const on = (accelerator = DEFAULT_PROACTIVE_ACCELERATOR) => ({ ...defaultProactiveSettings(), enabled: true, shortcut: { enabled: true, accelerator } })

  it('registers only when master + shortcut are on; re-registers on change; unregisters on off and dispose', () => {
    const reg = fakeRegistry()
    let pressed = 0
    const sc = createProactiveShortcut({ registry: reg, onPress: () => void pressed++ })
    expect(sc.apply({ ...on(), enabled: false }).state).toBe('off')
    expect(reg.calls).toEqual([])
    expect(sc.apply(on()).state).toBe('registered')
    reg.held.get(DEFAULT_PROACTIVE_ACCELERATOR)!()
    expect(pressed).toBe(1)
    expect(sc.apply(on('Alt+Shift+K'))).toMatchObject({ state: 'registered', accelerator: 'Alt+Shift+K' })
    expect(reg.held.has(DEFAULT_PROACTIVE_ACCELERATOR)).toBe(false)
    sc.dispose()
    expect(reg.held.size).toBe(0)
  })

  it('conflicts: Quick Box accelerator, invalid / reserved combos, OS refusal are reported, not swallowed', () => {
    const reg = fakeRegistry(['Control+Alt+J'])
    const sc = createProactiveShortcut({ registry: reg, reserved: () => ['CommandOrControl+Alt+L'], onPress: () => undefined })
    expect(sc.apply(on('CommandOrControl+Alt+L'))).toMatchObject({ state: 'failed' })
    expect(sc.apply(on('Command+Q'))).toMatchObject({ state: 'failed' })
    expect(sc.apply(on('Shift+K'))).toMatchObject({ state: 'failed' })
    expect(sc.apply(on('Control+Alt+J'))).toMatchObject({ state: 'failed', message: expect.stringContaining('Could not register') })
    expect(reg.held.size).toBe(0)
  })

  it('service: pressing it opens the page of the latest notification (else 今天), writes nothing', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { meeting_ready: true }, shortcut: { enabled: true } })
    t.registry.held.get(DEFAULT_PROACTIVE_ACCELERATOR)!()
    expect(t.pages).toEqual(['today'])
    await t.svc.onEvent(meeting('m-s', 3))
    const before = fs.readdirSync(t.root).map((f) => fs.readFileSync(path.join(t.root, f), 'utf8')).join('|')
    t.registry.held.get(DEFAULT_PROACTIVE_ACCELERATOR)!()
    expect(t.pages).toEqual(['today', 'meetings'])
    expect(fs.readdirSync(t.root).map((f) => fs.readFileSync(path.join(t.root, f), 'utf8')).join('|')).toBe(before)
  })

  it('an invalid accelerator in a patch is rejected and nothing is written', async () => {
    const t = svcSetup()
    await expect(t.svc.update({ shortcut: { accelerator: 'Command+Q' } })).rejects.toThrow()
    expect(fs.existsSync(proactiveSettingsFile(t.root))).toBe(false)
  })
})

describe('event bus', () => {
  it('rejects invalid payloads and never throws into the publisher', () => {
    const bus = createProactiveEventBus()
    bus.subscribe(() => {
      throw new Error('listener bug')
    })
    expect(bus.publish({ type: 'nope', id: 'x', items: [] } as unknown as ProactiveEvent)).toBe(false)
    expect(bus.publish({ type: 'peers.moment_accepted', id: '', items: [] })).toBe(false)
    expect(bus.publish({ type: 'peers.moment_accepted', id: 'mo1', items: [{ id: 'mo1', evidence: 'moment:2026-11-05' }] })).toBe(true)
  })

  it('friend moment: threshold 1 by default, opens 朋友', async () => {
    const t = svcSetup()
    await t.svc.update({ enabled: true, triggers: { friend_moment: true } })
    const r = await t.svc.onEvent({ type: 'peers.moment_accepted', id: 'mo1', items: [{ id: 'mo1', evidence: 'moment:2026-11-05' }] })
    expect(r?.sent.map((s) => s.body)).toEqual([BODY.friendMoment(1)])
    t.notifier.shown.at(-1)!.onClick!()
    expect(t.pages).toEqual(['peers'])
  })
})

it('every trigger has a code, label, route and cooldown', async () => {
  const api = await import('../../src/main/proactive/api')
  for (const t of PROACTIVE_TRIGGERS as readonly ProactiveTrigger[]) {
    expect(api.TRIGGER_CODE[t]).toMatch(/^T\d+$/)
    expect(api.TRIGGER_LABEL[t].length).toBeGreaterThan(3)
    expect(api.TRIGGER_ROUTE[t]).toBeTruthy()
    expect(api.TRIGGER_COOLDOWN[t]).toBeTruthy()
  }
})
