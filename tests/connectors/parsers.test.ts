import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCsv } from '../../src/main/connectors/csv'
import { daySummary, metricFromHeader, normalizeTime, parseHealthFile, parseNumber } from '../../src/main/connectors/health'
import { parseIcs, unfold } from '../../src/main/connectors/ics'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FIX = path.join(__dirname, '..', 'fixtures', 'connectors')
const read = (f: string): string => fs.readFileSync(path.join(FIX, f), 'utf8')

describe('.ics parser', () => {
  const r = parseIcs(read('calendar.ics'))

  it('reads VEVENTs, unfolds lines, unescapes text, ignores VALARM / VTIMEZONE', () => {
    expect(r.calendarName).toBe('工作')
    expect(r.events.map((e) => e.uid)).toEqual(['fixture-001@lens.test', 'fixture-002@lens.test', 'fixture-003@lens.test'])
    const e = r.events[0]
    expect(e.summary).toBe('季度规划评审 Zephyrquill')
    expect(e.location).toBe('会议室 B, 3 楼')
    expect(e.description).toContain('议程：路线图\ntoken=')
    expect(e.description).toContain('联系 alice@example.test')
    expect(e.description).not.toContain('ALARM_SHOULD_NOT_APPEAR')
    expect(e.organizer).toBe('Alice Chen')
    expect(e.attendees).toBe(2)
    expect(e.status).toBe('CONFIRMED')
  })

  it('resolves TZID through Intl, keeps UTC and all-day dates, keeps RRULE as text', () => {
    expect(r.events[0].start).toEqual({ iso: '2026-11-03T10:00:00+08:00', allDay: false, tz: 'Asia/Shanghai' })
    expect(r.events[0].end?.iso).toBe('2026-11-03T11:00:00+08:00')
    expect(r.events[1].start).toEqual({ iso: '2026-11-04T01:30:00+00:00', allDay: false, tz: 'UTC' })
    expect(r.events[1].rrule).toBe('FREQ=WEEKLY;BYDAY=WE')
    expect(r.events[2].start).toEqual({ iso: '2026-11-06', allDay: true, tz: null })
    // `r` is parsed at collection time, before the zh hook: this is the English check.
    expect(r.warnings.join('\n')).toMatch(/RRULE is not expanded/)
  })

  it('handles a DST zone, unknown TZIDs and non-calendar input', () => {
    const ny = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART;TZID=America/New_York:20260704T090000\nEND:VEVENT\nEND:VCALENDAR\n')
    expect(ny.events[0].start?.iso).toBe('2026-07-04T09:00:00-04:00')
    const bad = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:y\nDTSTART;TZID=Mars/Olympus:20260704T090000\nEND:VEVENT\nEND:VCALENDAR\n')
    expect(bad.events[0].start?.tz).toBeNull()
    expect(bad.warnings.join()).toMatch(/未知时区/)
    expect(parseIcs('hello').warnings.join()).toMatch(/不像 .ics/)
    expect(unfold('A:1\r\n 2\r\n\t3\r\nB:4')).toEqual(['A:123', 'B:4'])
  })
})

describe('CSV parser', () => {
  it('handles quotes, embedded delimiters / newlines, doubled quotes, CRLF, BOM and ; delimiter', () => {
    const t = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",\r\n')
    expect(t.header).toEqual(['a', 'b', 'c'])
    expect(t.rows).toEqual([
      ['1', 'x, y', 'say "hi"'],
      ['2', 'line1\nline2', '']
    ])
    expect(parseCsv('a;b\n1;2').rows).toEqual([['1', '2']])
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t')
  })
})

describe('health normalizer', () => {
  it('wide CSV: numeric columns become metrics with units; text columns metadata; local tz assumed', () => {
    const r = parseHealthFile(read('health.csv'), 'health.csv')
    expect(r.format).toBe('csv-wide')
    const day1 = r.events.filter((e) => e.started_at.startsWith('2026-11-03'))
    expect(day1.map((e) => e.metric).sort()).toEqual(['avg_hr', 'avg_hr', 'calories', 'calories', 'distance', 'time', 'time'].sort())
    const dist = day1.find((e) => e.metric === 'distance')!
    expect(dist).toMatchObject({ value: 5.21, unit: 'km', source: { provider: 'lens-file' } })
    expect(dist.metadata.activity_type).toBe('Running')
    expect(day1.find((e) => e.metric === 'time')).toMatchObject({ value: 1725, unit: 's' })
    expect(dist.started_at).toMatch(/^2026-11-03T07:10:00[+-]\d{2}:\d{2}$/)
    expect(r.warnings.join()).toMatch(/本机时区/)
    // Event ids are deterministic (re-import is idempotent upstream) and unique within the file.
    const again = parseHealthFile(read('health.csv'), 'renamed.csv')
    expect(again.events.map((e) => e.event_id)).toEqual(r.events.map((e) => e.event_id))
    expect(new Set(r.events.map((e) => e.event_id)).size).toBe(r.events.length)
  })

  it('JSON long format: metric/value/unit/start/end/source; string values allowed', () => {
    const r = parseHealthFile(read('health.json'), 'health.json')
    expect(r.format).toBe('json-long')
    expect(r.events).toHaveLength(3)
    expect(r.events[0]).toMatchObject({
      event_id: 's-1',
      metric: 'steps',
      value: 8532,
      unit: 'count',
      started_at: '2026-11-03T00:00:00+08:00',
      ended_at: '2026-11-03T23:59:59+08:00',
      source: { device: 'Watch' }
    })
    expect(r.events[2]).toMatchObject({ metric: 'sleep', value: 'asleep_core' })
  })

  it('helpers: metric slugs, times, numbers', () => {
    expect(metricFromHeader('Distance (km)')).toEqual({ metric: 'distance', unit: 'km' })
    expect(metricFromHeader('步数')).toEqual({ metric: 'steps', unit: '' })
    expect(metricFromHeader('9 Weird!')).toEqual({ metric: 'm_9_weird', unit: '' })
    expect(normalizeTime('2026-11-03 10:00:00 +0800')?.iso).toBe('2026-11-03T10:00:00+08:00')
    expect(normalizeTime('2026-11-03T10:00Z')?.iso).toBe('2026-11-03T10:00:00+00:00')
    expect(normalizeTime('2026/11/3')?.dateOnly).toBe(true)
    expect(normalizeTime('yesterday')).toBeNull()
    expect(parseNumber('1,234.5')).toEqual({ value: 1234.5 })
    expect(parseNumber('1:02:03')).toEqual({ value: 3723, unit: 's' })
    expect(parseNumber('abc')).toBeNull()
  })

  it('refuses a file without a time column and summarises a day with plain aggregates only', () => {
    expect(() => parseHealthFile('a,b\n1,2\n', 'x.csv')).toThrow(/时间列/)
    const r = parseHealthFile(read('health.json'), 'health.json')
    const s = daySummary('2026-11-03', r.events.filter((e) => e.started_at.startsWith('2026-11-03')), 'health.json')
    expect(s).toContain('健康 / 训练记录 2026-11-03')
    expect(s).toContain('- steps：8532 count')
    expect(s).toContain('不是医学结论')
  })
})
