import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IngestFrame } from '../../src/main/capture/frame'
import { IngestClient, type DropReason } from '../../src/main/capture/ingest-client'
import { startMockRuntime, type MockRuntime } from './mock-ingest-runtime'

/**
 * R5 (SECURITY-FINDINGS): a frame built before pause must not be delivered
 * after it, including through retries, with a slow or misbehaving Runtime.
 */
function frame(i: number, bundleId = 'com.example.a'): IngestFrame {
  return {
    timestamp: new Date(Date.UTC(2026, 10, 4, 20, 0, i)).toISOString(),
    trigger: { event_type: 'AXApplicationActivated', app_name: 'A', bundle_id: bundleId, window_title: '' },
    window_meta: { app_name: 'A', title: `w${i}`, bundle_id: bundleId }
  }
}

let rt: MockRuntime
let paused: boolean
let excluded: Set<string>
let client: IngestClient
const gate = (f: IngestFrame): DropReason | null =>
  paused ? 'paused' : excluded.has(f.window_meta.bundle_id) ? 'excluded_app' : null

beforeEach(async () => {
  rt = await startMockRuntime()
  paused = false
  excluded = new Set()
  // Real (short) retry sleeps so pause can land between attempts.
  client = new IngestClient({ baseUrl: rt.baseUrl, getToken: () => rt.token, retryDelaysMs: [60, 60, 60], gate })
})
afterEach(async () => rt.close())

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('R5: withdrawal of undelivered frames', () => {
  it('a malformed 200 (no envelope) is parked once, not retried', async () => {
    rt.script.push({ status: 200, raw: '{"ok":true}' })
    const r = await client.push(frame(1))
    expect(r).toEqual({ outcome: 'parked', reason: 'bad_response' })
    expect(rt.arrivals).toHaveLength(1)
    expect(client.stats.retries).toBe(0)
  })

  it('pause during 5xx retries: 0 requests after the pause instant, counted dropped:paused', async () => {
    rt.fallback = { status: 503, delayMs: 40 }
    const pending = client.push(frame(1)) // built and queued before the pause
    await wait(70) // first attempt answered 503; the client is in its retry sleep
    paused = true
    const pausedAt = Date.now()
    client.revalidate()
    expect(await pending).toEqual({ outcome: 'dropped', reason: 'paused' })
    await wait(300)
    expect(rt.arrivals.filter((t) => t > pausedAt)).toEqual([])
    expect(rt.received).toHaveLength(0)
    expect(client.stats.dropped).toEqual({ paused: 1, locked: 0, excluded_app: 0 })
    expect(client.parkedFrames).toHaveLength(0)
  })

  it('pause while an attempt is on the wire aborts it and sends nothing more', async () => {
    rt.fallback = { status: 503, delayMs: 400 }
    const pending = client.push(frame(1))
    await wait(50) // request arrived, response still 350 ms away
    paused = true
    const pausedAt = Date.now()
    client.revalidate()
    expect(await pending).toEqual({ outcome: 'dropped', reason: 'paused' })
    await wait(600)
    expect(rt.arrivals.filter((t) => t > pausedAt)).toEqual([])
    expect(rt.received).toHaveLength(0)
  })

  it('queued frames behind a slow delivery are withdrawn on pause', async () => {
    rt.script.push({ status: 200, result: 'written', delayMs: 150 })
    const first = client.push(frame(1))
    const queued = [client.push(frame(2)), client.push(frame(3))]
    await wait(30)
    paused = true
    const pausedAt = Date.now()
    client.revalidate()
    expect((await Promise.all(queued)).map((r) => r.outcome)).toEqual(['dropped', 'dropped'])
    // The first request was already on the wire before the pause; it is aborted.
    expect((await first).outcome).toBe('dropped')
    await wait(300)
    expect(rt.arrivals.filter((t) => t > pausedAt)).toEqual([])
    expect(client.stats.dropped.paused).toBe(3)
    // Residual, by construction: a body the server had already read before the
    // pause instant can still be processed server-side; the abort cannot recall it.
    expect(rt.received.length).toBeLessThanOrEqual(1)
    expect(rt.received.every((r) => r.body.window_meta && (r.body.window_meta as { title: string }).title === 'w1')).toBe(true)
  })

  it('parked frames of a newly excluded app are dropped and never resent', async () => {
    rt.script.push({ status: 200, raw: 'not json' }, { status: 200, raw: 'not json' })
    await client.push(frame(1, 'com.1password.1password'))
    await client.push(frame(2, 'com.example.b'))
    expect(client.parkedFrames).toHaveLength(2)
    excluded.add('com.1password.1password')
    client.revalidate()
    expect(client.parkedFrames.map((f) => f.window_meta.bundle_id)).toEqual(['com.example.b'])
    const before = rt.arrivals.length
    const results = await client.retryParked()
    expect(results.map((r) => r.outcome)).toEqual(['written'])
    expect(rt.arrivals.length - before).toBe(1)
    expect(rt.received.at(-1)!.body.window_meta).toMatchObject({ bundle_id: 'com.example.b' })
    expect(client.stats.dropped.excluded_app).toBe(1)
  })

  it('a frame pushed after the pause instant is never sent', async () => {
    paused = true
    expect(await client.push(frame(1))).toEqual({ outcome: 'dropped', reason: 'paused' })
    expect(rt.arrivals).toHaveLength(0)
  })
})
