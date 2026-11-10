// S1-R3-SEC L1 (perf hot spots), L2 (prototype keys), L3 (event_id / unit / metadata-key redaction),
// L5 (main-side confirm on commit). Fakes only; temp dirs only; no network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { daySummary, metricFromHeader, type NormalizedHealthEvent } from '../../src/main/connectors/health'
import { registerConnectorHandlers } from '../../src/main/connectors/ipc'
import { grantAll } from './consent-helper'
import { fileScopedTempDirs } from '../_support/tmpdir'
import { createConnectorService } from '../../src/main/connectors/service'
import { redactText } from '../../src/main/het/redact'
import { scrubText } from '../../src/main/identity/redact'
import { stripSecrets } from '../../src/main/import/redact'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FIX = path.join(__dirname, '..', 'fixtures', 'connectors')
// B17: prefix-guarded cleanup after the file.
const temps = fileScopedTempDirs('lens-conn-sec')
const tmp = (l: string): string => temps.make(l)

function setup() {
  const remembered: Array<{ content: string; tags: string }> = []
  const posted: Array<{ route: string; body: { events: NormalizedHealthEvent[] } }> = []
  const svc = createConnectorService({
    storeRoot: tmp('store'),
    runtimeRoot: () => tmp('rt'),
    persomeBin: () => '/opt/fake/persome',
    ossTool: async (_name, args) => {
      remembered.push(args as { content: string; tags: string })
      return JSON.stringify({ entry_id: `e-${remembered.length}`, file: 'f.md' })
    },
    postRuntime: async (route, body) => {
      posted.push({ route, body: body as { events: NormalizedHealthEvent[] } })
      const n = (body as { events: unknown[] }).events.length
      return { success: true, data: { received: n, inserted: n, corrected: 0, duplicates: 0 } }
    }
  })
  grantAll(svc)
  return { svc, remembered, posted }
}

const timed = (fn: () => unknown): number => {
  const t = performance.now()
  fn()
  return performance.now() - t
}

describe('L1 performance hot spots', () => {
  it('email rule is linear: 60k "a." under 500 ms (HET and identity redactors)', () => {
    const s = 'a.'.repeat(60_000)
    expect(timed(() => redactText(s))).toBeLessThan(500)
    expect(timed(() => scrubText(s))).toBeLessThan(500)
    // still redacts real emails
    expect(redactText('mail jane.doe@example.com now')).toBe('mail [email] now')
    expect(scrubText('mail jane.doe@example.com now')).toBe('mail [email] now')
  })

  it('adversarial repeats through the full redactors (incl. the new M1 rules) stay under 500 ms each', () => {
    const inputs = [
      'a-'.repeat(60_000),
      'A_'.repeat(60_000),
      '_'.repeat(80_000),
      '-H "'.repeat(30_000),
      'mysql '.repeat(20_000),
      'docker login '.repeat(10_000),
      'Authorization: '.repeat(10_000),
      'a@'.repeat(60_000),
      'x='.repeat(60_000),
      'db_'.repeat(40_000) + 'pass',
      '--password '.repeat(10_000),
      'ab://'.repeat(30_000)
    ]
    for (const s of inputs) {
      for (const [name, fn] of [
        ['redactText', redactText],
        ['stripSecrets', (x: string) => stripSecrets(x).text],
        ['scrubText', scrubText]
      ] as const) {
        expect(timed(() => fn(s)), `${name} on ${JSON.stringify(s.slice(0, 16))}…`).toBeLessThan(500)
      }
    }
  })

  it('metricFromHeader with 40k underscores is fast and bounded', () => {
    const h = 'a' + '_'.repeat(40_000) + 'b'
    let out = { metric: '', unit: '' }
    expect(timed(() => (out = metricFromHeader(h)))).toBeLessThan(500)
    expect(out.metric).toMatch(/^[a-z][a-z0-9_.-]*$/)
    expect(out.metric.length).toBeLessThanOrEqual(96)
  })

  it('50k same-day events: daySummary and preview stay fast', () => {
    const ev = (i: number): NormalizedHealthEvent => ({
      event_id: `id-${i}`,
      source: { provider: 'lens-file', device: null, device_id: null },
      metric: 'steps',
      value: i,
      unit: 'count',
      started_at: '2026-11-03T07:00:00+08:00',
      ended_at: null,
      timezone: null,
      metadata: {}
    })
    const list = Array.from({ length: 50_000 }, (_, i) => ev(i))
    let text = ''
    expect(timed(() => (text = daySummary('2026-11-03', list, 'big.csv')))).toBeLessThan(1500)
    expect(text).toContain('50000 条')

    const dir = tmp('big')
    const file = path.join(dir, 'big.csv')
    const rows = ['date,steps']
    for (let i = 0; i < 50_000; i++) rows.push(`2026-11-03T07:${String(i % 60).padStart(2, '0')}:00+08:00,${i}`)
    fs.writeFileSync(file, rows.join('\n'))
    const { svc } = setup()
    const t = performance.now()
    return svc.previewFile('health', file).then((p) => {
      expect(performance.now() - t).toBeLessThan(5000)
      expect(p.totals.events).toBe(50_000)
      expect(p.items).toHaveLength(1)
    })
  })
})

describe('L2 metricFromHeader never reads the prototype', () => {
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])('%s → a plain slug string', (h) => {
    const r = metricFromHeader(h)
    expect(typeof r.metric).toBe('string')
    expect(r.metric).toMatch(/^[a-z][a-z0-9_.-]*$/)
  })

  it('Chinese metric names still map', () => {
    expect(metricFromHeader('步数').metric).toBe('steps')
    expect(metricFromHeader('心率 (bpm)')).toEqual({ metric: 'heart_rate', unit: 'bpm' })
  })
})

describe('L3 event_id / unit / metadata keys are redacted before REST and remember', () => {
  const csv = [
    'date,metric,value,unit,id',
    '2026-11-03T07:00:00+08:00,steps,1000,count sk-ant-api03-UNITLEAKabcdefghij,bob@example.com',
    '2026-11-03T08:00:00+08:00,steps,2000,count,run-0001',
    '2026-11-03T09:00:00+08:00,steps,3000,count,carol@example.com'
  ].join('\n')
  const wide = ['date,steps,sk-ant-api03-KEYLEAKabcdefghijk', '2026-11-04T07:00:00+08:00,500,some note'].join('\n')

  it('secrets in ids, units and metadata keys never reach /health-events/import or remember', async () => {
    const dir = tmp('l3')
    fs.writeFileSync(path.join(dir, 'long.csv'), csv)
    fs.writeFileSync(path.join(dir, 'wide.csv'), wide)
    const { svc, posted, remembered } = setup()
    for (const f of ['long.csv', 'wide.csv']) {
      const p = await svc.previewFile('health', path.join(dir, f))
      const shown = JSON.stringify(p)
      for (const s of ['bob@example.com', 'carol@example.com', 'UNITLEAK', 'KEYLEAK']) expect(shown).not.toContain(s)
      await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    }
    const sent = JSON.stringify(posted) + JSON.stringify(remembered)
    for (const s of ['bob@example.com', 'carol@example.com', 'UNITLEAK', 'KEYLEAK']) expect(sent).not.toContain(s)
    const ids = posted.flatMap((p) => p.body.events.map((e) => e.event_id))
    // distinct ids stay distinct; an id with nothing to redact is kept verbatim
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('run-0001')
  })

  it('dedup still works: the same file twice → unchanged, same event ids', async () => {
    const dir = tmp('l3b')
    fs.writeFileSync(path.join(dir, 'long.csv'), csv)
    const { svc, posted } = setup()
    const p1 = await svc.previewFile('health', path.join(dir, 'long.csv'))
    await svc.commit(p1.previewId!, p1.items.map((i) => i.key), {})
    fs.copyFileSync(path.join(dir, 'long.csv'), path.join(dir, 'renamed.csv'))
    const p2 = await svc.previewFile('health', path.join(dir, 'renamed.csv'))
    expect(p2.items.every((i) => i.state === 'unchanged')).toBe(true)
    // ids are deterministic across parses (Runtime idempotency by provider + event_id)
    const p3 = await svc.previewFile('health', path.join(dir, 'long.csv'))
    await svc.commit(p3.previewId!, p3.items.map((i) => i.key), {})
    const firstIds = posted[0].body.events.map((e) => e.event_id)
    expect(posted.length).toBeGreaterThanOrEqual(1)
    if (posted.length > 1) expect(posted[posted.length - 1].body.events.map((e) => e.event_id)).toEqual(firstIds)
    for (const id of firstIds) expect(id).not.toContain('[')
  })
})

describe('L5 connectors commit needs a main-side confirm', () => {
  it('Cancel → nothing written; OK → written; the confirm gets the sender and the item count', async () => {
    const { svc, remembered } = setup()
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<{ ok: boolean; data?: any; error?: any }>>()
    const asks: Array<{ summary: { kind: string; items: number }; sender: unknown }> = []
    let answer = false
    registerConnectorHandlers(
      { handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never,
      svc,
      async () => path.join(FIX, 'calendar.ics'),
      async (summary, sender) => {
        asks.push({ summary, sender })
        return answer
      }
    )
    const sender = { id: 'main' }
    const p = await handlers.get('lens:connectors:pick')!({ sender }, { kind: 'calendar' })
    const keys = p.data.items.map((i: { key: string }) => i.key)
    const no = await handlers.get('lens:connectors:commit')!({ sender }, { previewId: p.data.previewId, keys, opts: {}, confirm: true })
    expect(no.ok).toBe(false)
    expect(no.error.message).toMatch(/取消/)
    expect(remembered).toHaveLength(0)
    answer = true
    const yes = await handlers.get('lens:connectors:commit')!({ sender }, { previewId: p.data.previewId, keys, opts: {}, confirm: true })
    expect(yes).toMatchObject({ ok: true, data: { written: 3 } })
    expect(asks.map((a) => a.sender)).toEqual([sender, sender])
    expect(asks[0].summary).toMatchObject({ kind: 'calendar', items: 3 })
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('a cancelled native confirm reports in English', async () => {
    const { svc, remembered } = setup()
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<{ ok: boolean; data?: any; error?: any }>>()
    registerConnectorHandlers(
      { handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never,
      svc,
      async () => path.join(FIX, 'calendar.ics'),
      async () => false
    )
    const sender = { id: 'main' }
    const p = await handlers.get('lens:connectors:pick')!({ sender }, { kind: 'calendar' })
    const keys = p.data.items.map((i: { key: string }) => i.key)
    const no = await handlers.get('lens:connectors:commit')!({ sender }, { previewId: p.data.previewId, keys, opts: {}, confirm: true })
    expect(no.error.message).toBe('Cancelled. Nothing was written')
    expect(remembered).toHaveLength(0)
  })
})
