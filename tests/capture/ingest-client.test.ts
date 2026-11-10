import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IngestFrame } from '../../src/main/capture/frame'
import { IngestClient, MAX_BODY_BYTES, parseIngestResponse } from '../../src/main/capture/ingest-client'
import { startMockRuntime, type MockRuntime } from './mock-ingest-runtime'

function frame(i: number, extra: Partial<IngestFrame> = {}): IngestFrame {
  return {
    timestamp: new Date(Date.UTC(2026, 10, 4, 20, 0, i)).toISOString(),
    trigger: { event_type: 'AXApplicationActivated', app_name: 'A', bundle_id: 'com.example.a', window_title: `w${i}` },
    window_meta: { app_name: 'A', title: `w${i}`, bundle_id: 'com.example.a' },
    ...extra
  }
}

let rt: MockRuntime
let sleeps: number[]
let client: IngestClient

beforeEach(async () => {
  rt = await startMockRuntime()
  sleeps = []
  client = new IngestClient({
    baseUrl: rt.baseUrl,
    getToken: () => rt.token,
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })
})
afterEach(async () => rt.close())

describe('parseIngestResponse', () => {
  it('maps the Runtime envelope to the tri-state', () => {
    expect(parseIngestResponse({ success: true, data: { id: 'x', deduped: false, skipped: false } })).toEqual({ outcome: 'written', id: 'x' })
    expect(parseIngestResponse({ success: true, data: { id: null, deduped: true, skipped: false } })).toEqual({ outcome: 'deduped', id: null })
    expect(parseIngestResponse({ success: true, data: { id: null, deduped: false, skipped: true } })).toEqual({ outcome: 'skipped', id: null })
    expect(parseIngestResponse({ success: true, data: {} })).toBeNull()
  })
})

describe('IngestClient against a mock Runtime', () => {
  it('distinguishes written / deduped / skipped', async () => {
    rt.script.push({ status: 200, result: 'written' }, { status: 200, result: 'deduped' }, { status: 200, result: 'skipped' })
    const results = [await client.push(frame(1)), await client.push(frame(2)), await client.push(frame(3))]
    expect(results.map((r) => r.outcome)).toEqual(['written', 'deduped', 'skipped'])
    expect(client.stats).toMatchObject({ written: 1, deduped: 1, skipped: 1, retries: 0 })
    expect(rt.received[0].auth).toBe(`Bearer ${rt.token}`)
    expect(rt.received[0].body).toMatchObject({ window_meta: { title: 'w1' }, trigger: { event_type: 'AXApplicationActivated' } })
  })

  it('retries 5xx at 250 / 1000 ms and then succeeds', async () => {
    rt.script.push({ status: 503 }, { status: 500 }, { status: 200, result: 'written' })
    const r = await client.push(frame(1))
    expect(r.outcome).toBe('written')
    expect(sleeps).toEqual([250, 1000])
    expect(rt.received).toHaveLength(1)
  })

  it('parks a frame after 250 / 1000 / 3000 ms retries and delivers it later: no frame lost', async () => {
    rt.script.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 })
    const r = await client.push(frame(1))
    expect(r).toEqual({ outcome: 'parked', reason: 'http_503' })
    expect(sleeps).toEqual([250, 1000, 3000])
    expect(client.parkedFrames).toHaveLength(1)
    const again = await client.retryParked()
    expect(again.map((x) => x.outcome)).toEqual(['written'])
    expect(client.parkedFrames).toHaveLength(0)
    expect(rt.received.map((x) => (x.body.window_meta as { title: string }).title)).toEqual(['w1'])
  })

  it('does not retry 4xx', async () => {
    rt.script.push({ status: 422 })
    expect(await client.push(frame(1))).toEqual({ outcome: 'rejected', status: 422, reason: 'http' })
    expect(sleeps).toEqual([])
  })

  it('a token that cannot be read is an auth rejection, not "unreachable", and sends nothing', async () => {
    const noToken = new IngestClient({
      baseUrl: rt.baseUrl,
      getToken: () => {
        throw new Error('没有找到 env')
      },
      sleep: async (ms) => void sleeps.push(ms)
    })
    expect(await noToken.push(frame(1))).toEqual({ outcome: 'rejected', status: 0, reason: 'auth' })
    expect(rt.received).toHaveLength(0)
    expect(sleeps).toEqual([])
  })

  it('re-reads a rotated token once after 401', async () => {
    let token = 'stale-token-0000000000'
    const rotating = new IngestClient({
      baseUrl: rt.baseUrl,
      getToken: () => {
        const t = token
        token = rt.token // the env file now holds the new token
        return t
      },
      sleep: async (ms) => void sleeps.push(ms)
    })
    expect((await rotating.push(frame(1))).outcome).toBe('written')
    expect(sleeps).toEqual([])
    expect(rt.received).toHaveLength(1)
  })

  it('a token refused twice is an auth rejection', async () => {
    const wrong = new IngestClient({ baseUrl: rt.baseUrl, getToken: () => 'wrong-token-000000000', sleep: async (ms) => void sleeps.push(ms) })
    expect(await wrong.push(frame(1))).toEqual({ outcome: 'rejected', status: 401, reason: 'auth' })
    expect(rt.received).toHaveLength(0)
  })

  it('refuses bodies over 12 MiB without sending', async () => {
    const big = frame(1, {
      screenshot: { image_base64: 'A'.repeat(MAX_BODY_BYTES), mime_type: 'image/jpeg', width: 1, height: 1 }
    })
    const r = await client.push(big)
    expect(r.outcome).toBe('too_large')
    expect(rt.received).toHaveLength(0)
  })

  it('is strictly serial and loses nothing across a burst with intermittent 5xx', async () => {
    for (let i = 0; i < 40; i++) rt.script.push(i % 7 === 3 ? { status: 502 } : { status: 200, result: 'written' })
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => client.push(frame(i))))
    expect(rt.maxConcurrent).toBe(1)
    expect(results.every((r) => r.outcome === 'written')).toBe(true)
    const titles = rt.received.map((x) => (x.body.window_meta as { title: string }).title)
    expect(titles).toEqual(Array.from({ length: 30 }, (_, i) => `w${i}`))
  })

  it('OG-02: parked frames are re-delivered automatically after the next successful frame', async () => {
    rt.script.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 })
    expect((await client.push(frame(1))).outcome).toBe('parked')
    expect(client.parkedFrames).toHaveLength(1)
    // Runtime back: the next frame goes through and the parked one follows it.
    expect((await client.push(frame(2))).outcome).toBe('written')
    for (let i = 0; i < 50 && rt.received.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(client.parkedFrames).toHaveLength(0)
    expect(client.stats.parked).toBe(0)
    expect(rt.received.map((x) => (x.body.window_meta as { title: string }).title)).toEqual(['w2', 'w1'])
  })

  it('OG-02: the park list is hard-capped; evictions are counted, pixels shed first', async () => {
    const capped = new IngestClient({ baseUrl: 'http://127.0.0.1:1', getToken: () => rt.token, sleep: async () => {}, maxParked: 2, retryDelaysMs: [] })
    const shot = { image_base64: 'AAAA', mime_type: 'image/jpeg', width: 1, height: 1 }
    for (let i = 0; i < 12; i++) expect((await capped.push(frame(i, { screenshot: shot, ocr_jpeg_b64: 'AAAA' }))).outcome).toBe('parked')
    expect(capped.parkedFrames.length).toBeLessThanOrEqual(8)
    expect(capped.stats.parkedEvicted).toBe(12 - capped.parkedFrames.length)
    expect(capped.stats.parked).toBe(capped.parkedFrames.length)
    // Only the newest frames may still carry pixels.
    expect(capped.parkedFrames.filter((f) => f.screenshot || f.ocr_jpeg_b64).length).toBeLessThanOrEqual(2)
    expect(capped.parkedFrames.at(-1)!.window_meta.title).toBe('w11')
  })

  it('OG-02: a frame parked on an unreadable 200 is not resent automatically (the Runtime already processed it)', async () => {
    rt.script.push({ status: 200, raw: '{"success":true,"data":{}}' })
    const r = await client.push(frame(1))
    expect(r).toEqual({ outcome: 'parked', reason: 'bad_response' })
    expect((await client.push(frame(2))).outcome).toBe('written')
    await new Promise((res) => setTimeout(res, 30))
    expect(rt.received).toHaveLength(2)
    expect(client.parkedFrames).toHaveLength(1)
  })

  it('treats an unreachable Runtime as retryable and parks', async () => {
    await rt.close()
    const r = await client.push(frame(1))
    expect(r).toEqual({ outcome: 'parked', reason: 'unreachable' })
    expect(sleeps).toEqual([250, 1000, 3000])
  })
})
