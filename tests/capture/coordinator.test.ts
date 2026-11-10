import { describe, expect, it } from 'vitest'
import {
  CaptureCoordinator,
  ACTIVE_TUNING,
  TUNING_PRODUCT,
  TUNING_SPEC,
  TRIGGERS,
  type CaptureEvent,
  type CaptureTrigger,
  type Decision,
  type EventSource
} from '../../src/main/capture/coordinator'
import { FakeClock } from './fake-clock'

interface Captured {
  at: number
  trigger: CaptureTrigger
}

function harness(opts: {
  excluded?: string[]
  captureMs?: number
  accept?: (t: CaptureTrigger) => boolean
} = {}) {
  const clock = new FakeClock()
  const captured: Captured[] = []
  const decisions: Decision[] = []
  const listeners: Array<(e: CaptureEvent) => void> = []
  const source: EventSource = {
    subscribe(listener) {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    }
  }
  const excluded = new Set(opts.excluded ?? [])
  const coordinator = new CaptureCoordinator({
    clock,
    isExcluded: (bundleId) => excluded.has(bundleId),
    onDecision: (d) => decisions.push(d),
    capture: async (trigger) => {
      if (opts.captureMs) await clock.sleep(opts.captureMs)
      const ok = opts.accept ? opts.accept(trigger) : true
      if (ok) captured.push({ at: clock.now(), trigger })
      return ok
    }
  })
  coordinator.start(source)
  const emit = (eventType: string, bundleId = 'com.example.a', extra: Partial<CaptureEvent> = {}) =>
    listeners.forEach((l) => l({ eventType, bundleId, appName: bundleId, ...extra }))
  return { clock, captured, decisions, coordinator, emit }
}

describe('CaptureCoordinator timing contract', () => {
  it('runs the spec preset: 3 s / 500 ms / 2 s / 1 s / 5 s / 10 min', () => {
    expect(ACTIVE_TUNING).toBe(TUNING_SPEC)
    expect(new CaptureCoordinator({ capture: async () => true }).tuning).toEqual(TUNING_SPEC)
    expect(TUNING_SPEC).toMatchObject({
      debounceMs: 3000,
      urgentDebounceMs: 500,
      minGapMs: 2000,
      dedupIntervalMs: 1000,
      sameWindowDedupMs: 5000,
      heartbeatMs: 600_000
    })
  })

  it('urgent events capture after a 500 ms trailing debounce', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated)
    await h.clock.advance(499)
    expect(h.captured).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.captured.map((c) => c.at)).toEqual([500])
    expect(h.captured[0].trigger).toMatchObject({ event_type: 'AXApplicationActivated', bundle_id: 'com.example.a' })
  })

  it('value changes capture after a 3 s trailing debounce, last trigger wins', async () => {
    const h = harness()
    h.emit(TRIGGERS.valueChanged, 'com.example.a', { windowTitle: 'one' })
    await h.clock.advance(1000)
    h.emit(TRIGGERS.valueChanged, 'com.example.a', { windowTitle: 'two' })
    await h.clock.advance(2999)
    expect(h.captured).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.captured).toHaveLength(1)
    expect(h.captured[0]).toMatchObject({ at: 4000, trigger: { window_title: 'two' } })
  })

  it('ignores AXTitleChanged', async () => {
    const h = harness()
    for (let i = 0; i < 50; i++) h.emit(TRIGGERS.titleChanged)
    await h.clock.advance(60_000)
    expect(h.captured).toHaveLength(0)
  })

  it('a normal event never displaces or delays a pending urgent trigger', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated)
    await h.clock.advance(100)
    h.emit(TRIGGERS.valueChanged)
    await h.clock.advance(400)
    expect(h.captured).toHaveLength(1)
    expect(h.captured[0]).toMatchObject({ at: 500, trigger: { event_type: 'AXApplicationActivated' } })
  })

  it('Focus after Activation on one surface replaces it; Activation after Focus is dropped', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated)
    await h.clock.advance(100)
    h.emit(TRIGGERS.focusedWindowChanged)
    await h.clock.advance(1000)
    expect(h.captured.map((c) => c.trigger.event_type)).toEqual(['AXFocusedWindowChanged'])

    await h.clock.advance(10_000)
    h.emit(TRIGGERS.focusedWindowChanged)
    await h.clock.advance(100)
    h.emit(TRIGGERS.applicationActivated)
    await h.clock.advance(1000)
    expect(h.captured.map((c) => c.trigger.event_type)).toEqual([
      'AXFocusedWindowChanged',
      'AXFocusedWindowChanged'
    ])
    expect(h.decisions.some((d) => d.reason === 'event_dedup' && d.eventType === 'AXApplicationActivated')).toBe(true)
  })

  it('event-family dedup drops a repeat inside 1 s and accepts it after', async () => {
    const h = harness()
    h.emit(TRIGGERS.mouseClick)
    await h.clock.advance(999)
    h.emit(TRIGGERS.mouseClick)
    expect(h.decisions.filter((d) => d.reason === 'event_dedup')).toHaveLength(1)
    await h.clock.advance(1)
    h.emit(TRIGGERS.mouseClick)
    expect(h.decisions.filter((d) => d.reason === 'event_dedup')).toHaveLength(1)
  })

  it('focus changes bypass the 2 s minimum gap', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated, 'com.example.a')
    await h.clock.advance(600)
    h.emit(TRIGGERS.applicationActivated, 'com.example.b')
    await h.clock.advance(500)
    expect(h.captured.map((c) => [c.at, c.trigger.bundle_id])).toEqual([
      [500, 'com.example.a'],
      [1100, 'com.example.b']
    ])
  })

  it('other triggers are deferred (not dropped) to the end of the 2 s minimum gap', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated, 'com.example.a')
    await h.clock.advance(700) // captured at 500
    h.emit(TRIGGERS.mouseClick, 'com.example.b') // due at 1200, gap only 700
    await h.clock.advance(1799)
    expect(h.captured).toHaveLength(1)
    await h.clock.advance(1) // 2500 = 500 + 2000
    expect(h.captured.map((c) => [c.at, c.trigger.event_type])).toEqual([
      [500, 'AXApplicationActivated'],
      [2500, 'UserMouseClick']
    ])
    expect(h.decisions.some((d) => d.kind === 'deferred' && d.reason === 'min_gap')).toBe(true)
  })

  it('same-surface triggers are deferred to the end of the 5 s window', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated)
    await h.clock.advance(1000) // captured at 500
    h.emit(TRIGGERS.mouseClick) // due at 1500, same surface
    await h.clock.advance(4499)
    expect(h.captured).toHaveLength(1)
    await h.clock.advance(1) // 5500 = 500 + 5000
    expect(h.captured.map((c) => c.at)).toEqual([500, 5500])
    expect(h.decisions.some((d) => d.kind === 'deferred' && d.reason === 'same_window')).toBe(true)
  })

  it('continuous typing for 60 s does not yield a frame per keystroke', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated)
    await h.clock.advance(1000)
    const keystrokes = 600 // one AXValueChanged every 100 ms
    for (let i = 0; i < keystrokes; i++) {
      h.emit(TRIGGERS.valueChanged)
      await h.clock.advance(100)
    }
    await h.clock.advance(10_000) // typing stopped: trailing frame
    const typingFrames = h.captured.filter((c) => c.trigger.event_type === 'AXValueChanged')
    // Bounded by maxPendingMs (30 s) while typing, plus the trailing frame.
    expect(typingFrames.length).toBeGreaterThanOrEqual(2)
    expect(typingFrames.length).toBeLessThanOrEqual(3)
    expect(h.captured.length).toBeLessThan(keystrokes / 100)
    for (let i = 1; i < h.captured.length; i++) {
      expect(h.captured[i].at - h.captured[i - 1].at).toBeGreaterThanOrEqual(TUNING_SPEC.minGapMs)
    }
  })

  it('heartbeat fires after 10 min of silence and re-arms after every capture', async () => {
    const h = harness()
    await h.clock.advance(600_000 - 1)
    expect(h.captured).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.captured.map((c) => [c.at, c.trigger.event_type])).toEqual([[600_000, 'heartbeat']])
    h.emit(TRIGGERS.applicationActivated) // captured at 600_500, re-arms heartbeat
    await h.clock.advance(600_000)
    expect(h.captured.map((c) => c.trigger.event_type)).toEqual(['heartbeat', 'AXApplicationActivated'])
    await h.clock.advance(500)
    expect(h.captured.map((c) => [c.at, c.trigger.event_type])).toEqual([
      [600_000, 'heartbeat'],
      [600_500, 'AXApplicationActivated'],
      [1_200_500, 'heartbeat']
    ])
  })

  it('a heartbeat flushes a waiting real trigger instead of replacing it', async () => {
    const h = harness({ })
    await h.clock.advance(600_000 - 1000)
    h.emit(TRIGGERS.valueChanged) // due at 600_000 - 1000 + 3000
    await h.clock.advance(1000)
    expect(h.captured.map((c) => [c.at, c.trigger.event_type])).toEqual([[600_000, 'AXValueChanged']])
  })

  it('pause on lock: nothing is captured while locked, heartbeat resumes after unlock', async () => {
    const h = harness()
    h.emit(TRIGGERS.valueChanged)
    await h.clock.advance(100)
    h.coordinator.setLocked(true) // cancels the pending trigger
    for (let i = 0; i < 100; i++) {
      h.emit(TRIGGERS.applicationActivated, `com.example.${i % 3}`)
      await h.clock.advance(1000)
    }
    await h.clock.advance(30 * 60_000)
    expect(h.captured).toHaveLength(0)
    h.coordinator.setLocked(false)
    await h.clock.advance(600_000)
    expect(h.captured.map((c) => c.trigger.event_type)).toEqual(['heartbeat'])
  })

  it('pause: 0 frames across 100 events and a full heartbeat period', async () => {
    const h = harness()
    h.coordinator.setPaused(true)
    for (let i = 0; i < 100; i++) {
      h.emit(i % 2 ? TRIGGERS.focusedWindowChanged : TRIGGERS.valueChanged, `com.example.${i % 5}`)
      await h.clock.advance(700)
    }
    await h.clock.advance(20 * 60_000)
    expect(h.captured).toHaveLength(0)
    expect(h.decisions.filter((d) => d.reason === 'paused')).toHaveLength(100)
  })

  it('100 switches into an excluded app yield 0 frames and 0 capture calls for it', async () => {
    let calls = 0
    const h = harness({
      excluded: ['com.1password.1password'],
      accept: (t) => {
        calls++
        return t.bundle_id !== 'com.1password.1password'
      }
    })
    for (let i = 0; i < 100; i++) {
      h.emit(TRIGGERS.applicationActivated, 'com.1password.1password')
      await h.clock.advance(50)
      h.emit(TRIGGERS.focusedWindowChanged, 'com.1password.1password')
      h.emit(TRIGGERS.valueChanged, 'com.1password.1password')
      await h.clock.advance(2000)
    }
    await h.clock.advance(5000)
    expect(calls).toBe(0)
    expect(h.captured).toHaveLength(0)
  })

  it('switching into an excluded app cancels the pending capture of the previous app', async () => {
    let calls = 0
    const h = harness({ excluded: ['com.1password.1password'], accept: () => (calls++, true) })
    for (let i = 0; i < 100; i++) {
      h.emit(TRIGGERS.applicationActivated, 'com.example.a')
      await h.clock.advance(100) // before the 500 ms debounce elapses
      h.emit(TRIGGERS.applicationActivated, 'com.1password.1password')
      await h.clock.advance(5000)
    }
    expect(calls).toBe(0)
  })

  it('a rejected capture rolls back its reservation', async () => {
    let first = true
    const h = harness({
      accept: () => {
        const ok = !first
        first = false
        return ok
      }
    })
    h.emit(TRIGGERS.applicationActivated) // rejected at 500
    await h.clock.advance(600)
    h.emit(TRIGGERS.mouseClick) // due at 1100; not deferred by the rolled-back capture
    await h.clock.advance(500)
    expect(h.captured.map((c) => c.at)).toEqual([1100])
  })

  it('captures are serial: events during an in-flight capture flush after it', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const clock = new FakeClock()
    const seen: number[] = []
    const c = new CaptureCoordinator({
      clock,
      capture: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await clock.sleep(4000)
        inFlight--
        seen.push(clock.now())
        return true
      }
    })
    c.start()
    c.onEvent({ eventType: TRIGGERS.applicationActivated, bundleId: 'a' })
    await clock.advance(1000) // capture runs 500..4500
    c.onEvent({ eventType: TRIGGERS.applicationActivated, bundleId: 'b' })
    await clock.advance(10_000)
    expect(maxInFlight).toBe(1)
    expect(seen).toEqual([4500, 9000]) // b flushed at 4500, finished 4000 ms later
  })

  it('stop() cancels pending work and the heartbeat', async () => {
    const h = harness()
    h.emit(TRIGGERS.applicationActivated)
    h.coordinator.stop()
    await h.clock.advance(60 * 60_000)
    expect(h.captured).toHaveLength(0)
    expect(h.clock.pendingTimers).toBe(0)
  })
})

describe('TUNING_PRODUCT preset', () => {
  it('carries the product shell numbers', () => {
    expect(TUNING_PRODUCT).toEqual({
      debounceMs: 3000,
      urgentDebounceMs: 500,
      minGapMs: 30_000,
      dedupIntervalMs: 1000,
      sameWindowDedupMs: 120_000,
      heartbeatMs: 300_000,
      maxPendingMs: 30_000
    })
    expect(Object.isFrozen(TUNING_PRODUCT) && Object.isFrozen(TUNING_SPEC)).toBe(true)
  })

  it('is honoured by the coordinator: 30 s min gap, 5 min heartbeat', async () => {
    const clock = new FakeClock()
    const at: Array<[number, string]> = []
    const c = new CaptureCoordinator({
      clock,
      tuning: TUNING_PRODUCT,
      capture: async (t) => (at.push([clock.now(), t.event_type]), true)
    })
    c.start()
    c.onEvent({ eventType: TRIGGERS.applicationActivated, bundleId: 'a' }) // 500
    await clock.advance(1000)
    c.onEvent({ eventType: TRIGGERS.mouseClick, bundleId: 'b' }) // due 1500 -> deferred to 30_500
    await clock.advance(29_499)
    expect(at).toHaveLength(1)
    await clock.advance(1)
    expect(at).toEqual([
      [500, 'AXApplicationActivated'],
      [30_500, 'UserMouseClick']
    ])
    await clock.advance(300_000)
    expect(at[2]).toEqual([330_500, 'heartbeat'])
  })
})
