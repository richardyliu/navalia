// S1-R4-05: each trigger fires from fixtures and stays silent when its source is empty / unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { GOOD_CAPTURE, HOUR, MIN, NOON, rig, settingsWith } from './helpers'

// Bodies below are asserted in Chinese; the English default is covered by the first block.
describe('bodies are created in the current locale (English default)', () => {
  it('T3 body is English when the locale is en', async () => {
    setLocale('en') // the file-level beforeEach below switches every test to zh
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['alias-a', 'alias-b'] } })
    await r.engine.tick()
    expect(r.notifier.shown.map((n) => n.body)).toEqual(['2 names that might be yours to confirm'])
  })
})

beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

describe('T3 owner aliases pending', () => {
  it('fires when the pending count rises above last-seen, with hashed source ids', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['alias-a', 'alias-b'] } })
    const res = await r.engine.tick()
    expect(res.sent.map((s) => s.body)).toEqual(['有 2 个可能是你的名字待确认'])
    expect(r.store.log[0].trigger).toBe('owner_aliases')
    expect(r.store.log[0].source_ids.every((id) => /^alias:[0-9a-f]{16}$/.test(id))).toBe(true)
    expect(r.store.state.ownerAliases.lastSeen).toBe(2)
  })

  it('unchanged count stays silent; a rise fires again (after cooldown); empty / null is silent', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: ['a', 'b'] } })
    await r.engine.tick() // 12:00
    r.clock.advance(4.5 * HOUR) // 16:30
    expect((await r.engine.tick()).sent).toEqual([])
    r.src.data.aliases = ['a', 'b', 'c']
    r.clock.advance(4.5 * HOUR) // 21:00, before quiet hours
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual(['有 3 个可能是你的名字待确认'])
    r.src.data.aliases = []
    r.clock.advance(5 * HOUR)
    expect((await r.engine.tick()).sent).toEqual([])
    r.src.data.aliases = null
    r.clock.advance(5 * HOUR)
    expect((await r.engine.tick()).sent).toEqual([])
    expect(r.notifier.shown).toHaveLength(2)
  })

  it('empty source from the start never fires', async () => {
    const r = rig({ settings: settingsWith(['owner_aliases']), init: { aliases: [] } })
    for (let i = 0; i < 4; i++) {
      await r.engine.tick()
      r.clock.advance(HOUR)
    }
    expect(r.notifier.shown).toHaveLength(0)
  })
})

describe('T4 capture / OCR degraded', () => {
  const bad = { ...GOOD_CAPTURE, screenRecording: false }

  it('fires only after ≥10 min continuously bad, once per incident, then one recovered message', async () => {
    const r = rig({ settings: settingsWith(['capture_degraded']), init: { capture: bad } })
    expect((await r.engine.tick()).sent).toEqual([]) // just went bad
    r.clock.advance(9 * MIN)
    expect((await r.engine.tick()).sent).toEqual([])
    r.clock.advance(MIN)
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual(['屏幕采集已降级：缺少屏幕录制权限'])
    r.clock.advance(HOUR)
    expect((await r.engine.tick()).sent).toEqual([]) // same incident
    r.src.data.capture = GOOD_CAPTURE
    r.clock.advance(15 * MIN)
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual(['屏幕采集已恢复正常'])
    r.clock.advance(HOUR)
    expect((await r.engine.tick()).sent).toEqual([])
    expect(r.notifier.shown).toHaveLength(2)
  })

  it('a blip shorter than 10 min stays silent and sends no recovered message', async () => {
    const r = rig({ settings: settingsWith(['capture_degraded']), init: { capture: bad } })
    await r.engine.tick()
    r.src.data.capture = GOOD_CAPTURE
    r.clock.advance(5 * MIN)
    await r.engine.tick()
    r.clock.advance(HOUR)
    await r.engine.tick()
    expect(r.notifier.shown).toHaveLength(0)
  })

  it('ingest rejected (counter rising) and Runtime /health ocr / pipeline count; disabled OCR does not', async () => {
    const r = rig({ settings: settingsWith(['capture_degraded']), init: { capture: { ...GOOD_CAPTURE, ingestRejectedTotal: 3 } } })
    await r.engine.tick() // baseline counter
    r.src.data.capture = { ...GOOD_CAPTURE, ingestRejectedTotal: 5, health: { ocr_enabled: true, ocr: 'degraded', ocr_worker: 'ready', capture_pipeline: 'degraded' } }
    r.clock.advance(MIN)
    await r.engine.tick()
    r.src.data.capture = { ...GOOD_CAPTURE, ingestRejectedTotal: 8, health: { ocr_enabled: true, ocr: 'degraded', ocr_worker: 'ready', capture_pipeline: 'degraded' } }
    r.clock.advance(15 * MIN)
    const res = await r.engine.tick()
    expect(res.sent.map((s) => s.body)).toEqual(['屏幕采集已降级：Runtime 拒收采集数据、OCR 未就绪、Runtime 采集流水线异常'])

    const off = rig({ settings: settingsWith(['capture_degraded']), init: { capture: { ...GOOD_CAPTURE, health: { ocr_enabled: false, ocr: 'disabled', ocr_worker: 'stopped', capture_pipeline: 'ok' } } } })
    for (let i = 0; i < 3; i++) {
      await off.engine.tick()
      off.clock.advance(15 * MIN)
    }
    expect(off.notifier.shown).toHaveLength(0)
  })

  it('healthy or unknown source stays silent', async () => {
    const r = rig({ settings: settingsWith(['capture_degraded']), init: { capture: GOOD_CAPTURE } })
    for (let i = 0; i < 4; i++) {
      await r.engine.tick()
      r.clock.advance(15 * MIN)
    }
    r.src.data.capture = null
    await r.engine.tick()
    expect(r.notifier.shown).toHaveLength(0)
  })
})

describe('T5 Runtime down / upgraded', () => {
  it('down ≥5 min fires once per incident', async () => {
    const r = rig({ settings: settingsWith(['runtime']), init: { runtime: { reachable: false, revision: null } } })
    expect((await r.engine.tick()).sent).toEqual([])
    r.clock.advance(4 * MIN)
    expect((await r.engine.tick()).sent).toEqual([])
    r.clock.advance(MIN)
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual(['Persome Runtime 已连不上 5 分钟以上'])
    r.clock.advance(2 * HOUR)
    expect((await r.engine.tick()).sent).toEqual([])
    expect(r.store.log[0].source_ids).toContain('down')
  })

  it('first revision is the baseline; a changed revision fires the restart message; unchanged is silent', async () => {
    const r = rig({ settings: settingsWith(['runtime']), init: { runtime: { reachable: true, revision: '2026-08-11.4' } } })
    expect((await r.engine.tick()).sent).toEqual([])
    r.clock.advance(HOUR)
    expect((await r.engine.tick()).sent).toEqual([])
    r.src.data.runtime = { reachable: true, revision: '2026-11-05.3' }
    r.clock.advance(HOUR)
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual(['Runtime 已升级，请重启其他 Agent 会话'])
    r.clock.advance(2 * HOUR)
    expect((await r.engine.tick()).sent).toEqual([])
    expect(r.store.state.runtime.revision).toMatch(/^revision:[0-9a-f]{16}$/)
    expect(JSON.stringify(r.store.state)).not.toContain('2026-11-05.3')
    // The revision string itself is never logged.
    expect(JSON.stringify(r.store.log)).not.toContain('2026-11-05.3')
  })

  it('reachable without a revision, or an unknown source, stays silent', async () => {
    const r = rig({ settings: settingsWith(['runtime']), init: { runtime: { reachable: true, revision: null } } })
    await r.engine.tick()
    r.src.data.runtime = null
    r.clock.advance(HOUR)
    await r.engine.tick()
    expect(r.notifier.shown).toHaveLength(0)
  })
})

describe('T1 daily brief / T2 carried-over todos', () => {
  it('T1 fires at/after briefTime when the brief has ≥1 item, once per day', async () => {
    const early = Date.parse('2026-11-05T00:30:00Z') // 08:30 Shanghai
    const r = rig({ start: early, settings: settingsWith(['daily_brief'], { quietHours: { start: '00:00', end: '00:00' } }), init: { brief: { nextSteps: ['k1', 'k2'], yesterdayTodos: [] } } })
    expect((await r.engine.tick()).sent).toEqual([])
    expect(r.src.calls.brief).toBe(0) // not read before briefTime
    r.clock.set(Date.parse('2026-11-05T01:00:00Z')) // 09:00
    expect((await r.engine.tick()).sent.map((s) => s.body)).toEqual(['今天的简报：2 条下一步'])
    r.clock.advance(3 * HOUR)
    expect((await r.engine.tick()).sent).toEqual([])
    r.clock.set(Date.parse('2026-11-06T02:00:00Z')) // next day 10:00
    expect((await r.engine.tick()).sent).toHaveLength(1)
  })

  it('T1 empty brief stays silent; T2 counts yesterday todos only', async () => {
    const r = rig({ settings: settingsWith(['daily_brief', 'carried_todos']), init: { brief: { nextSteps: [], yesterdayTodos: [] } } })
    expect((await r.engine.tick()).sent).toEqual([])
    r.src.data.brief = { nextSteps: ['t1', 't2', 't3'], yesterdayTodos: ['t1', 't3'] }
    r.clock.advance(HOUR)
    const res = await r.engine.tick()
    expect(res.sent.map((s) => s.body)).toEqual(['今天的简报：3 条下一步', '有 2 条昨天的待办还没勾掉'])
    expect(r.src.calls.brief).toBe(2) // one read per tick, shared by T1 and T2
  })
})

describe('disabled triggers read nothing', () => {
  it('master on but every trigger off → no source is touched', async () => {
    const r = rig({ settings: settingsWith([]), init: { aliases: ['a'] } })
    expect((await r.engine.tick()).skipped).toBe('off')
    expect(Object.values(r.src.calls).every((n) => n === 0)).toBe(true)
  })

  it('only the enabled trigger source is read', async () => {
    const r = rig({ settings: settingsWith(['runtime']), init: { aliases: ['a'] } })
    await r.engine.tick()
    expect(r.src.calls).toEqual({ aliases: 0, capture: 0, runtime: 1, brief: 0 })
  })
})

it('NOON fixture is outside default quiet hours', () => {
  expect(new Date(NOON).toISOString()).toBe('2026-11-05T04:00:00.000Z')
})
