// C19 Apple Health export.xml / zip: streaming scan, aggregation, escaping, zip (deflate / stored /
// Chinese entry name), memory bound on a generated 200k-record export, and the service path.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APPLE_HEALTH_PROVIDER,
  decodeXmlEntities,
  parseAppleDate,
  parseAppleHealthFile,
  parseAppleHealthStream,
  XmlTagScanner,
  type XmlToken
} from '../../src/main/connectors/apple-health'
import { createConnectorService } from '../../src/main/connectors/service'
import { grantAll } from './consent-helper'
import { rmTmp, tmpDir } from './tmp-helper'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 14 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary)*)>
<!ATTLIST HealthData locale CDATA #REQUIRED>
<!ENTITY bomb "&bomb;&bomb;&bomb;">
<!ATTLIST Record type CDATA #REQUIRED value CDATA #IMPLIED>
]>
<HealthData locale="zh_CN">
 <ExportDate value="2026-11-05 22:00:00 +0800"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01"/>
`
const R = (type: string, start: string, end: string, value: string | number, extra = '', unit = 'count'): string =>
  ` <Record type="${type}" sourceName="${extra || 'Alice的 iPhone'}" unit="${unit}" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"/>\n`

const FIXTURE =
  HEAD +
  // Steps from two sources: per-source sums 300 (phone) and 450 (watch) → day value 450 (max single source).
  R('HKQuantityTypeIdentifierStepCount', '2026-11-03 08:00:00 +0800', '2026-11-03 08:10:00 +0800', 100) +
  R('HKQuantityTypeIdentifierStepCount', '2026-11-03 09:00:00 +0800', '2026-11-03 09:10:00 +0800', 200) +
  R('HKQuantityTypeIdentifierStepCount', '2026-11-03 08:00:00 +0800', '2026-11-03 08:10:00 +0800', 450, 'Apple&#160;Watch &amp; co') +
  // Heart rate with child metadata, attribute containing '>' and an entity in a quoted value.
  ` <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch &lt;X&gt; &#x4E2D;" unit="count/min" startDate="2026-11-03 10:00:00 +0800" endDate="2026-11-03 10:00:00 +0800" value="60">\n  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="a > b"/>\n </Record>\n` +
  R('HKQuantityTypeIdentifierHeartRate', '2026-11-03 11:00:00 +0800', '2026-11-03 11:00:00 +0800', 90, '', 'count/min') +
  R('HKQuantityTypeIdentifierHeartRate', '2026-11-03 12:00:00 +0800', '2026-11-03 12:00:00 +0800', 75, '', 'count/min') +
  // A comment and CDATA in between records.
  ' <!-- a <Record type="HKQuantityTypeIdentifierStepCount" value="99999"/> inside a comment -->\n <![CDATA[ <Record value="1"/> ]]>\n' +
  // Sleep: overlapping asleep intervals (watch + phone) 23:00–06:00 and 23:30–06:30 → union 450 min, wake day 11-04.
  ` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="W" startDate="2026-11-03 23:00:00 +0800" endDate="2026-11-04 06:00:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>\n` +
  ` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="P" startDate="2026-11-03 23:30:00 +0800" endDate="2026-11-04 06:30:00 +0800" value="HKCategoryValueSleepAnalysisAsleepUnspecified"/>\n` +
  ` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="P" startDate="2026-11-03 22:30:00 +0800" endDate="2026-11-04 07:00:00 +0800" value="HKCategoryValueSleepAnalysisInBed"/>\n` +
  ` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="W" startDate="2026-11-04 02:00:00 +0800" endDate="2026-11-04 02:10:00 +0800" value="HKCategoryValueSleepAnalysisAwake"/>\n` +
  // Correlation: nested records must not be counted.
  ` <Correlation type="HKCorrelationTypeIdentifierBloodPressure" startDate="2026-11-04 08:00:00 +0800" endDate="2026-11-04 08:00:00 +0800">\n` +
  R('HKQuantityTypeIdentifierStepCount', '2026-11-04 08:00:00 +0800', '2026-11-04 08:00:00 +0800', 77777) +
  ` </Correlation>\n` +
  // Unknown type + bad date.
  R('HKQuantityTypeIdentifierDietaryWater', '2026-11-04 08:00:00 +0800', '2026-11-04 08:00:00 +0800', 250) +
  R('HKQuantityTypeIdentifierStepCount', 'yesterday', 'today', 5) +
  // Workouts: modern (WorkoutStatistics children) and legacy (attributes, self-closing).
  ` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="31.5" durationUnit="min" sourceName="W" startDate="2026-11-04 18:00:00 +0800" endDate="2026-11-04 18:31:30 +0800">\n` +
  `  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="x" endDate="y" sum="5.2" unit="km"/>\n` +
  `  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="x" endDate="y" sum="320" unit="kcal"/>\n` +
  ` </Workout>\n` +
  ` <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="1" durationUnit="hr" totalDistance="20" totalDistanceUnit="km" sourceName="W" startDate="2026-11-04 07:00:00 +0800" endDate="2026-11-04 08:00:00 +0800"/>\n` +
  '</HealthData>\n'

async function parseString(s: string, chunk: number) {
  const buf = Buffer.from(s, 'utf8')
  const pieces: Buffer[] = []
  for (let i = 0; i < buf.length; i += chunk) pieces.push(buf.subarray(i, i + chunk))
  return parseAppleHealthStream(Readable.from(pieces), 'xml', { chunkBytes: chunk })
}

const byId = (events: Array<{ event_id: string }>) => new Map(events.map((e) => [e.event_id, e]))

describe('Apple Health XML scanner', () => {
  it('decodes predefined + numeric entities only; custom entities stay literal (no expansion)', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#20013;&#x6587;')).toBe(`a & b <c> "d" 'e' 中文`)
    expect(decodeXmlEntities('&bomb; &#0; &#xD800; &unknown;')).toBe('&bomb; &#0; &#xD800; &unknown;')
  })

  it('tags split across arbitrary chunk boundaries come out the same', () => {
    const collect = (chunk: number): XmlToken[] => {
      const s = new XmlTagScanner()
      const out: XmlToken[] = []
      for (let i = 0; i < FIXTURE.length; i += chunk) s.feed(FIXTURE.slice(i, i + chunk), (t) => out.push(t))
      s.feed('', (t) => out.push(t), true)
      return out
    }
    const a = collect(1_000_000)
    expect(collect(1)).toEqual(a)
    expect(collect(13)).toEqual(a)
    const hr = a.find((t) => t.type === 'start' && t.name === 'Record' && t.attrs.value === '60')
    expect(hr && hr.type === 'start' && hr.attrs.sourceName).toBe('Watch <X> 中')
    expect(a.some((t) => t.type === 'start' && t.name === 'MetadataEntry' && t.attrs.value === 'a > b')).toBe(true)
    // Nothing from the comment / CDATA / DTD.
    expect(a.some((t) => t.type === 'start' && t.attrs.value === '99999')).toBe(false)
    expect(a.some((t) => t.type === 'start' && (t.name === '!ELEMENT' || t.name === '!ENTITY'))).toBe(false)
  })

  it('dates: offset kept, day is the local date', () => {
    expect(parseAppleDate('2026-11-03 23:30:00 +0800')).toMatchObject({ iso: '2026-11-03T23:30:00+08:00', day: '2026-11-03', offset: '+08:00' })
    expect(parseAppleDate('2026-11-03 23:30:00 -0530')?.iso).toBe('2026-11-03T23:30:00-05:30')
    expect(parseAppleDate('yesterday')).toBeNull()
  })
})

describe('Apple Health aggregation', () => {
  it('per-day aggregates: max single-source sum, stats, sleep union on wake day, workouts; skips + warnings', async () => {
    const r = await parseString(FIXTURE, 4096)
    const m = byId(r.events)
    expect(m.get('ah-2026-11-03-steps-count')).toMatchObject({ value: 450, unit: 'count', started_at: '2026-11-03T00:00:00+08:00', metadata: { aggregation: 'sum', sources: 2, samples: 3, method: 'max_single_source' } })
    expect(m.get('ah-2026-11-03-heart_rate-count_min')).toMatchObject({ value: 75, metadata: { aggregation: 'avg', min: 60, max: 90, samples: 3 } })
    expect(m.get('ah-2026-11-04-sleep_asleep-min')).toMatchObject({ value: 450, unit: 'min' })
    expect(m.get('ah-2026-11-04-sleep_in_bed-min')?.value).toBe(510)
    // Correlation-nested steps ignored; unknown type skipped; bad date counted.
    expect([...m.keys()].some((k) => k.startsWith('ah-2026-11-04-steps'))).toBe(false)
    const workouts = r.events.filter((e) => e.metric === 'workout')
    expect(workouts.map((w) => [w.metadata.activity, w.value, w.metadata.distance, w.metadata.energy])).toEqual([
      ['running', 31.5, 5.2, 320],
      ['cycling', 60, 20, undefined]
    ])
    expect(r.events.every((e) => e.source.provider === APPLE_HEALTH_PROVIDER && /^[a-z][a-z0-9_.-]*$/.test(e.metric))).toBe(true)
    expect(r.warnings.join()).toMatch(/DietaryWater（1）/)
    expect(r.warnings.join()).toMatch(/1 条记录的时间无法识别/)
    expect(r.stats).toMatchObject({ workouts: 2, badDates: 1, source: 'xml' })
    // No device / person names leave the parser.
    expect(JSON.stringify(r.events)).not.toMatch(/Alice|iPhone|Watch/)
  })

  it('chunk size does not change the result (1-byte chunks, multi-byte UTF-8 split)', async () => {
    const a = await parseString(FIXTURE, 1 << 20)
    const b = await parseString(FIXTURE, 1)
    expect(b.events).toEqual(a.events)
    expect(b.stats.chunks).toBeGreaterThan(1000)
  })

  it('refuses non-Health XML and a truncated export', async () => {
    await expect(parseString('<?xml version="1.0"?><plist><dict/></plist>', 64)).rejects.toThrow(/HealthData/)
    await expect(parseString(FIXTURE.slice(0, FIXTURE.indexOf('<Workout') + 20), 64)).rejects.toThrow(/不完整/)
  })
})

// ─── zip ────────────────────────────────────────────────────────────────

function zip(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const body = e.store ? e.data : zlib.deflateRawSync(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0808, 6) // UTF-8 names + data descriptor (sizes 0 in the local header, as streaming writers do)
    lh.writeUInt16LE(e.store ? 0 : 8, 8)
    lh.writeUInt16LE(name.length, 26)
    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074b50, 0)
    dd.writeUInt32LE(body.length, 8)
    dd.writeUInt32LE(e.data.length, 12)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0808, 8)
    ch.writeUInt16LE(e.store ? 0 : 8, 10)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(off, 42)
    locals.push(lh, name, body, dd)
    centrals.push(ch, name)
    off += lh.length + name.length + body.length + dd.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, eocd])
}

describe('Apple Health zip export', () => {
  it('streams apple_health_export/export.xml out of the zip (deflate); ignores export_cda.xml; stored + 导出.xml too', async () => {
    const dir = tmpDir('ahzip')
    try {
      const xml = Buffer.from(FIXTURE, 'utf8')
      const cda = Buffer.from('<?xml version="1.0"?><ClinicalDocument/>', 'utf8')
      const z1 = path.join(dir, 'export.zip')
      fs.writeFileSync(z1, zip([{ name: 'apple_health_export/export_cda.xml', data: cda }, { name: 'apple_health_export/workout-routes/route_1.gpx', data: Buffer.from('<gpx/>') }, { name: 'apple_health_export/export.xml', data: xml }]))
      const plain = await parseString(FIXTURE, 1 << 20)
      const a = await parseAppleHealthFile(z1)
      expect(a.stats.source).toBe('zip')
      expect(a.events).toEqual(plain.events)
      const z2 = path.join(dir, '导出.zip')
      fs.writeFileSync(z2, zip([{ name: 'apple_health_export/导出.xml', data: xml, store: true }, { name: 'apple_health_export/导出_cda.xml', data: cda }]))
      expect((await parseAppleHealthFile(z2)).events).toEqual(plain.events)
      const z3 = path.join(dir, 'other.zip')
      fs.writeFileSync(z3, zip([{ name: 'a.txt', data: Buffer.from('x') }, { name: 'b.txt', data: Buffer.from('y') }]))
      await expect(parseAppleHealthFile(z3)).rejects.toThrow(/没有找到 apple_health_export\/export\.xml/)
      fs.writeFileSync(path.join(dir, 'broken.zip'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]))
      await expect(parseAppleHealthFile(path.join(dir, 'broken.zip'))).rejects.toThrow(/zip/)
    } finally {
      rmTmp(dir)
    }
  })
})

// ─── 200k records: streaming, bounded memory ───────────────────────────

describe('Apple Health large export', () => {
  it('200k records stream through in bounded chunks; aggregate state stays small', { timeout: 120_000 }, async () => {
    const dir = tmpDir('ahbig')
    try {
      const file = path.join(dir, 'export.xml')
      const fd = fs.openSync(file, 'w')
      fs.writeSync(fd, HEAD)
      const N = 200_000
      const types = ['HKQuantityTypeIdentifierStepCount', 'HKQuantityTypeIdentifierHeartRate', 'HKQuantityTypeIdentifierActiveEnergyBurned', 'HKQuantityTypeIdentifierBodyTemperature']
      let lines: string[] = []
      for (let i = 0; i < N; i++) {
        const day = 1 + (Math.floor(i / 4) % 28)
        const d = `2026-02-${String(day).padStart(2, '0')}`
        const h = String(Math.floor(i / 28) % 24).padStart(2, '0')
        lines.push(R(types[i % 4], `${d} ${h}:00:00 +0800`, `${d} ${h}:05:00 +0800`, (i % 97) + 1, i % 2 ? 'Watch' : 'Phone'))
        if (lines.length === 5000) {
          fs.writeSync(fd, lines.join(''))
          lines = []
        }
      }
      fs.writeSync(fd, `${lines.join('')}</HealthData>\n`)
      fs.closeSync(fd)
      const size = fs.statSync(file).size
      expect(size).toBeGreaterThan(30 * 1024 * 1024)

      const gc = (globalThis as { gc?: () => void }).gc
      gc?.()
      const before = process.memoryUsage().heapUsed
      const r = await parseAppleHealthFile(file, { chunkBytes: 64 * 1024 })
      const after = process.memoryUsage().heapUsed
      expect(r.stats.records).toBe(N)
      expect(r.stats.recordsUsed).toBe(N * 0.75)
      expect(r.stats.bytes).toBe(size)
      // Chunked: the file was never one buffer; the scanner's carry stayed below one chunk.
      expect(r.stats.chunks).toBeGreaterThanOrEqual(Math.floor(size / (64 * 1024)))
      expect(r.stats.maxCarry).toBeLessThan(64 * 1024)
      // 28 days × 3 known types; BodyTemperature skipped with a count.
      expect(r.events).toHaveLength(28 * 3)
      expect(r.warnings.join()).toMatch(/BodyTemperature（50000）/)
      // Loose heap bound: far below the file size (the state is 84 aggregates).
      expect(after - before).toBeLessThan(size)
    } finally {
      rmTmp(dir)
    }
  })
})

// ─── Service ────────────────────────────────────────────────────────────

describe('Apple Health through the health connector', () => {
  it('preview per day with Apple summaries; commit posts aggregates (provider lens-apple-health) and ledgers their ids', async () => {
    const dir = tmpDir('ahsvc')
    const posted: Array<{ events: Array<{ event_id: string; source: { provider: string } }> }> = []
    const remembered: Array<{ content: string; tags: string }> = []
    try {
      const file = path.join(dir, 'export.xml')
      fs.writeFileSync(file, FIXTURE)
      const svc = grantAll(
        createConnectorService({
          storeRoot: dir,
          runtimeRoot: () => dir,
          persomeBin: () => null,
          ossTool: async (_n, a) => {
            remembered.push(a as { content: string; tags: string })
            return JSON.stringify({ entry_id: `e-${remembered.length}` })
          },
          postRuntime: async (_r, b) => {
            posted.push(b as (typeof posted)[number])
            const n = (b as { events: unknown[] }).events.length
            return { data: { received: n, inserted: n, corrected: 0, duplicates: 0 } }
          }
        })
      )
      const p = await svc.previewFile('health', file)
      expect(p.items.map((i) => i.key)).toEqual(['day:2026-11-03', 'day:2026-11-04'])
      expect(p.items[0].text).toContain('来自 Apple Health 导出 export.xml')
      expect(p.items[0].text).toContain('- steps：450 count（3 条记录，2 个来源，取单一来源最大合计）')
      expect(p.items[1].text).toContain('- 体能训练：running，31.5 分钟，距离 5.2 km，能量 320 kcal')
      expect(p.mapping.join()).toMatch(/lens-apple-health/)
      const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
      expect(r.failed).toBe(0)
      expect(posted.flatMap((b) => b.events).every((e) => e.source.provider === 'lens-apple-health')).toBe(true)
      expect(remembered.map((x) => x.tags)).toEqual(['lens-connector,connector:health', 'lens-connector,connector:health'])
      const v = svc.ledger().connectors.find((c) => c.kind === 'health')
      expect(v).toMatchObject({ memoryEntries: 2, healthEvents: posted.flatMap((b) => b.events).length })
      // Re-import: unchanged.
      const p2 = await svc.previewFile('health', file)
      expect(p2.items.every((i) => i.state === 'unchanged')).toBe(true)
    } finally {
      rmTmp(dir)
    }
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('parse errors default to English', async () => {
    await expect(parseString('<?xml version="1.0"?><plist><dict/></plist>', 64)).rejects.toThrow(/does not look like an Apple Health export/)
    await expect(parseString(FIXTURE.slice(0, FIXTURE.indexOf('<Workout') + 20), 64)).rejects.toThrow(/may be incomplete/)
  })
})
