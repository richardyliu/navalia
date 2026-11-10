// S1-R4-05: daily cap, cooldown, dedupe, quiet hours (across midnight), default / corrupt settings,
// permission and window gates, content-free text, click = open a page only.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BODY, PROACTIVE_DAILY_CAP, TRIGGER_ROUTE } from '../../src/main/proactive/api'
import { inQuietHours } from '../../src/main/proactive/engine'
import { setLocale } from '../../src/shared/i18n'
import { defaultProactiveSettings, proactiveSettingsFile, readProactiveSettings } from '../../src/main/proactive/settings'
import { GOOD_CAPTURE, HOUR, MIN, rig, settingsWith, tempDir, TZ, safeRm } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) safeRm(r)
})

const ALL = ['owner_aliases', 'capture_degraded', 'runtime', 'daily_brief', 'carried_todos'] as const

describe('daily cap', () => {
  it(`at most ${PROACTIVE_DAILY_CAP} per local day, spent in order T3, T4, T5, T1, T2; resets next day`, async () => {
    const r = rig({
      settings: settingsWith([...ALL]),
      init: {
        aliases: ['a'],
        capture: { ...GOOD_CAPTURE, screenRecording: false },
        runtime: { reachable: false, revision: null },
        brief: { nextSteps: ['x'], yesterdayTodos: ['x'] }
      }
    })
    await r.engine.tick() // T4 / T5 start their incident clocks; T3, T1, T2 fire
    expect(r.notifier.shown).toHaveLength(3)
    r.clock.advance(15 * MIN)
    const res = await r.engine.tick() // T4 and T5 are now due, cap is spent
    expect(res.sent).toEqual([])
    expect(res.suppressed.filter((s) => s.reason === 'daily_cap').map((s) => s.trigger)).toEqual(['capture_degraded', 'runtime'])
    expect(r.store.log.map((e) => e.trigger)).toEqual(['owner_aliases', 'daily_brief', 'carried_todos'])

    r.clock.set(Date.parse('2026-11-06T03:00:00Z')) // next day 11:00 Shanghai
    const next = await r.engine.tick()
    expect(next.sent.map((s) => s.trigger)).toEqual(['capture_degraded', 'runtime', 'daily_brief'])
  })

  it('order: with all due in one tick, T3 → T4 → T5 go first', async () => {
    const r = rig({
      settings: settingsWith([...ALL]),
      init: { aliases: ['a'], capture: { ...GOOD_CAPTURE, screenRecording: false }, runtime: { reachable: false, revision: null }, brief: { nextSteps: ['x'], yesterdayTodos: ['x'] } }
    })
    // Pre-age the incidents so all five are due at once.
    const s = r.store.readState()
    s.capture.badSince = r.clock.now() - HOUR
    s.runtime.downSince = r.clock.now() - HOUR
    r.store.writeState(s)
    const res = await r.engine.tick()
    expect(res.sent.map((x) => x.trigger)).toEqual(['owner_aliases', 'capture_degraded', 'runtime'])
  })
})

describe('cooldown', () => {
  it('T3: a second rise within 4 h waits, then fires', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['a'] } })
    await r.engine.tick()
    r.src.data.aliases = ['a', 'b']
    r.clock.advance(HOUR)
    const res = await r.engine.tick()
    expect(res.suppressed).toEqual([{ trigger: 'owner_aliases', reason: 'cooldown' }])
    r.clock.advance(3 * HOUR)
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual([BODY.ownerAliases(2)])
  })
})

describe('dedupe (trigger + hash of source ids)', () => {
  it('the same pending aliases after a dip are not announced twice', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['a', 'b'] } })
    await r.engine.tick()
    r.src.data.aliases = []
    r.clock.advance(HOUR)
    await r.engine.tick()
    r.src.data.aliases = ['b', 'a']
    r.clock.advance(5 * HOUR)
    const res = await r.engine.tick()
    expect(res.suppressed).toEqual([{ trigger: 'owner_aliases', reason: 'dedupe' }])
    expect(r.notifier.shown).toHaveLength(1)
  })
})

describe('quiet hours', () => {
  const q = { start: '22:00', end: '09:00' }
  const at = (iso: string): number => Date.parse(iso)
  it('default 22:00–09:00 local crosses midnight', () => {
    expect(defaultProactiveSettings().quietHours).toEqual(q)
    expect(inQuietHours(at('2026-11-05T13:59:00Z'), TZ, q)).toBe(false) // 21:59
    expect(inQuietHours(at('2026-11-05T14:00:00Z'), TZ, q)).toBe(true) // 22:00
    expect(inQuietHours(at('2026-11-05T15:30:00Z'), TZ, q)).toBe(true) // 23:30
    expect(inQuietHours(at('2026-11-05T19:00:00Z'), TZ, q)).toBe(true) // 03:00 next day
    expect(inQuietHours(at('2026-11-06T00:59:00Z'), TZ, q)).toBe(true) // 08:59
    expect(inQuietHours(at('2026-11-06T01:00:00Z'), TZ, q)).toBe(false) // 09:00
    // Same instant, other zone: local time decides.
    expect(inQuietHours(at('2026-11-05T15:30:00Z'), 'UTC', q)).toBe(false) // 15:30 UTC
  })
  it('same-day window and start === end (none)', () => {
    expect(inQuietHours(at('2026-11-05T05:30:00Z'), TZ, { start: '13:00', end: '14:00' })).toBe(true)
    expect(inQuietHours(at('2026-11-05T06:00:00Z'), TZ, { start: '13:00', end: '14:00' })).toBe(false)
    expect(inQuietHours(at('2026-11-05T15:30:00Z'), TZ, { start: '00:00', end: '00:00' })).toBe(false)
  })
  it('a due notification during quiet hours waits and goes out after 09:00 (not lost, not burst)', async () => {
    const r = rig({ start: at('2026-11-05T15:30:00Z'), settings: settingsWith(['owner_aliases']), init: { aliases: ['a'] } })
    expect((await r.engine.tick()).suppressed).toEqual([{ trigger: 'owner_aliases', reason: 'quiet_hours' }])
    r.clock.set(at('2026-11-05T19:00:00Z'))
    expect((await r.engine.tick()).sent).toEqual([])
    r.clock.set(at('2026-11-06T01:00:00Z'))
    expect((await r.engine.tick()).sent).toHaveLength(1)
    expect(r.notifier.shown).toHaveLength(1)
  })
})

describe('defaults and fail-closed settings', () => {
  it('default settings send nothing and read no source', async () => {
    const r = rig({ settings: defaultProactiveSettings(), init: { aliases: ['a'], runtime: { reachable: false, revision: null } } })
    for (let i = 0; i < 3; i++) {
      expect((await r.engine.tick()).skipped).toBe('off')
      r.clock.advance(HOUR)
    }
    expect(r.notifier.shown).toHaveLength(0)
    expect(Object.values(r.src.calls).every((n) => n === 0)).toBe(true)
    const d = defaultProactiveSettings()
    expect(d.enabled).toBe(false)
    expect(Object.values(d.triggers).every((v) => v === false)).toBe(true)
  })

  it('missing file → defaults; corrupt / extra-key / wrong-type file → all off + error', () => {
    const root = tempDir('corrupt')
    roots.push(root)
    const f = proactiveSettingsFile(root)
    expect(readProactiveSettings(f)).toEqual({ settings: defaultProactiveSettings(), error: null })
    const on = { ...settingsWith(['owner_aliases']) }
    for (const bad of ['{not json', JSON.stringify({ ...on, extra: 1 }), JSON.stringify({ ...on, enabled: 'yes' }), JSON.stringify({ ...on, quietHours: { start: '25:00', end: '09:00' } }), JSON.stringify({ enabled: true })]) {
      fs.writeFileSync(f, bad)
      const r = readProactiveSettings(f)
      expect(r.error).not.toBeNull()
      expect(r.settings).toEqual(defaultProactiveSettings())
    }
    fs.writeFileSync(f, JSON.stringify(on))
    expect(readProactiveSettings(f)).toEqual({ settings: on, error: null })
  })

  it('corrupt settings send nothing even with sources that would fire', async () => {
    const r = rig({ settings: settingsWith([...ALL]), settingsError: 'proactive-settings.json 无效', init: { aliases: ['a'] } })
    expect((await r.engine.tick()).skipped).toBe('settings_error')
    expect(r.notifier.shown).toHaveLength(0)
  })

  it('permission not shown / no main window → nothing is sent', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['a'] } })
    for (const st of ['not_asked', 'not_shown', 'unsupported', 'denied'] as const) {
      const s = r.store.readState()
      s.permission = { state: st, at: null }
      r.store.writeState(s)
      expect((await r.engine.tick()).skipped).toBe('permission')
    }
    const w = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['a'] }, window: false })
    expect((await w.engine.tick()).skipped).toBe('no_window')
    expect(r.notifier.shown.length + w.notifier.shown.length).toBe(0)
  })
})

describe('content-free text', () => {
  const SECRETS = [
    '张三',
    'Alice Chen',
    'https://example.com/secret?token=abc',
    'sk-ant-api03-SECRET',
    '微信群：家人群 晚饭吃什么',
    'Visual Studio Code — main.ts',
    'alice@example.com'
  ]

  it('bodies and the log contain no names, URLs, secrets or window titles from the fixtures', async () => {
    const r = rig({
      settings: settingsWith([...ALL]),
      init: {
        aliases: SECRETS,
        runtime: { reachable: true, revision: 'https://example.com/secret?token=abc' },
        brief: { nextSteps: SECRETS, yesterdayTodos: SECRETS }
      }
    })
    await r.engine.tick()
    r.src.data.runtime = { reachable: true, revision: 'sk-ant-api03-SECRET' }
    r.clock.set(Date.parse('2026-11-06T03:00:00Z'))
    await r.engine.tick()
    expect(r.notifier.shown.length).toBeGreaterThanOrEqual(4)
    const text = JSON.stringify({ shown: r.notifier.shown.map(({ title, body }) => ({ title, body })), log: r.store.log, state: r.store.state })
    for (const s of SECRETS) expect(text).not.toContain(s)
    for (const n of r.notifier.shown) {
      expect(n.title).toBe('Navalia')
      expect(n.body).not.toMatch(/https?:|@|sk-|token/i)
      expect(n.body.length).toBeLessThanOrEqual(60)
    }
  })

  it('every body template takes only numbers / fixed categories', () => {
    expect(BODY.ownerAliases(2)).toBe('2 names that might be yours to confirm')
    expect(BODY.runtimeUpgraded()).toBe('Runtime was upgraded. Please restart other Agent sessions')
    expect(BODY.captureDegraded(['perm_screen_recording'])).toBe('Screen capture degraded: Screen Recording permission missing')
    expect(BODY.dailyBrief(3)).toBe("Today's brief: 3 next steps")
    expect(BODY.carriedTodos(1)).toBe("1 of yesterday's to-dos still not ticked off")
    setLocale('zh')
    try {
      expect(BODY.ownerAliases(2)).toBe('有 2 个可能是你的名字待确认')
      expect(BODY.runtimeUpgraded()).toBe('Runtime 已升级，请重启其他 Agent 会话')
      expect(BODY.captureDegraded(['perm_screen_recording'])).toBe('屏幕采集已降级：缺少屏幕录制权限')
      expect(BODY.dailyBrief(3)).toBe('今天的简报：3 条下一步')
      expect(BODY.carriedTodos(1)).toBe('有 1 条昨天的待办还没勾掉')
    } finally {
      setLocale('en')
    }
  })
})

describe('click', () => {
  it('opens / focuses the Lens page for the trigger and writes nothing', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['a'] } })
    await r.engine.tick()
    const before = JSON.stringify({ s: r.store.state, l: r.store.log })
    r.notifier.shown[0].onClick!()
    expect(r.pages).toEqual([TRIGGER_ROUTE.owner_aliases])
    expect(JSON.stringify({ s: r.store.state, l: r.store.log })).toBe(before)
    expect(Object.values(r.src.calls).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('routes are Lens pages only: every proactive route is a QuickOpenPage (meetings / performance wired at the Phase 4 gate)', async () => {
    const { QUICK_OPEN_PAGE_IDS } = await import('../../src/main/shell/api')
    const { PROACTIVE_ROUTES } = await import('../../src/main/proactive/api')
    const extra = PROACTIVE_ROUTES.filter((r) => !(QUICK_OPEN_PAGE_IDS as readonly string[]).includes(r))
    expect(extra).toEqual([])
    for (const route of Object.values(TRIGGER_ROUTE)) expect(PROACTIVE_ROUTES).toContain(route)
  })
})

it('helper temp dirs are under the OS temp dir, never ~/.persome', () => {
  const d = tempDir('x')
  roots.push(d)
  expect(d.includes('.persome')).toBe(false)
  expect(path.isAbsolute(d)).toBe(true)
})
