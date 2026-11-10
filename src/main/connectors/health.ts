import { createHash } from 'node:crypto'
import { parseCsv } from './csv'
import { tr } from '../../shared/i18n'

/**
 * Health / training export (CSV or JSON) → normalized events in the shape of the Runtime's
 * `POST /health-events/import` body (`personal-model src/persome/api/models.py HealthEvent`).
 * Pure: no I/O, no network. Values are raw device observations, never medical conclusions.
 *
 * Accepted shapes:
 *   - long:  one row per observation with a metric column (`metric` / `type` / `name` …) and a
 *            `value` column (+ optional `unit`, `end`, `source` / `device`, `id`);
 *   - wide:  one row per day / activity with a time column (`date` / `start` / `日期` …); every
 *            numeric column becomes one metric (unit taken from a `(km)`-style header suffix),
 *            other text columns become metadata (e.g. activity type);
 *   - JSON:  an array of objects, or `{events|data|records|workouts: [...]}`; objects are
 *            flattened one level (`source.device` → `source_device`) and then read like a table.
 * Times without an offset are interpreted in this machine's time zone (reported as a warning;
 * the Runtime requires an offset).
 */

export const HEALTH_PROVIDER = 'lens-file'
export const MAX_HEALTH_EVENTS = 50_000

export interface NormalizedHealthEvent {
  event_id: string
  source: { provider: string; device: string | null; device_id: null }
  metric: string
  value: number | string
  unit: string
  started_at: string
  ended_at: string | null
  timezone: string | null
  metadata: Record<string, string | number>
}

export interface HealthParseResult {
  format: 'csv-long' | 'csv-wide' | 'json-long' | 'json-wide'
  events: NormalizedHealthEvent[]
  warnings: string[]
  /** Text fields kept as values/metadata (the caller redacts them). */
  columns: string[]
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/[\s_-]+/g, '')

const TIME_COLS = ['startedat', 'start', 'starttime', 'startdate', 'date', 'datetime', 'timestamp', 'time', 'day', 'activitydate', '日期', '开始时间', '时间']
const END_COLS = ['endedat', 'end', 'endtime', 'enddate', '结束时间']
const METRIC_COLS = ['metric', 'type', 'name', 'datatype', 'measure', '指标', '类型']
const VALUE_COLS = ['value', 'qty', 'quantity', 'amount', '数值', '值']
const UNIT_COLS = ['unit', 'units', '单位']
const DEVICE_COLS = ['device', 'sourcename', 'source', 'sourcedevice', 'provider', 'app', '设备', '来源']
const ID_COLS = ['eventid', 'id', 'uuid', 'activityid']

function findCol(header: string[], names: string[]): number {
  const n = header.map(norm)
  for (const want of names) {
    const i = n.indexOf(want)
    if (i >= 0) return i
  }
  return -1
}

// S1-R3-SEC L2: a Map, so headers such as `toString` / `constructor` / `__proto__` never hit the prototype.
const ZH_METRICS: ReadonlyMap<string, string> = new Map(Object.entries({
  步数: 'steps',
  心率: 'heart_rate',
  静息心率: 'resting_heart_rate',
  距离: 'distance',
  卡路里: 'active_energy',
  热量: 'active_energy',
  消耗: 'active_energy',
  活动能量: 'active_energy',
  睡眠: 'sleep',
  睡眠时长: 'sleep_duration',
  体重: 'body_mass',
  时长: 'duration',
  配速: 'pace',
  爬升: 'elevation_gain'
}))

/** Header → {metric slug (Runtime pattern ^[a-z][a-z0-9_.-]*$), unit from a `(unit)` suffix}. */
export function metricFromHeader(header: string): { metric: string; unit: string } {
  // S1-R3-SEC L1: cap the label before any regex / slugging work.
  const label = header.trim().slice(0, 200)
  const m = /^(.*?)\s*[(（\[]([^)）\]]{1,24})[)）\]]\s*$/.exec(label)
  const base = (m ? m[1] : label).trim()
  const unit = m ? m[2].trim() : ''
  const zh = ZH_METRICS.get(base)
  if (zh) return { metric: zh, unit }
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  if (!slug) slug = `metric_${createHash('sha256').update(base).digest('hex').slice(0, 8)}`
  if (!/^[a-z]/.test(slug)) slug = `m_${slug}`
  return { metric: slug.slice(0, 96), unit: unit.slice(0, 32) }
}

const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0')
function localOffset(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  const min = -new Date(y, mo - 1, d, h, mi, s).getTimezoneOffset()
  return `${min >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`
}

export interface NormalizedTime {
  iso: string
  /** True when no offset was present and the local zone was assumed. */
  assumedLocal: boolean
  dateOnly: boolean
}

/** Timestamp text → ISO 8601 with offset; null when unrecognised. */
export function normalizeTime(raw: string): NormalizedTime | null {
  const v = raw.trim()
  if (!v) return null
  if (/^\d{10}(\d{3})?$/.test(v)) {
    const ms = v.length === 13 ? Number(v) : Number(v) * 1000
    return { iso: new Date(ms).toISOString().replace('.000Z', '+00:00').replace('Z', '+00:00'), assumedLocal: false, dateOnly: false }
  }
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v)
  if (!m) {
    // Apple Health style: `2026-11-03 10:00:00 +0800`
    m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(v)
    if (!m) return null
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const dateOnly = m[4] === undefined
  const [h, mi, s] = dateOnly ? [0, 0, 0] : [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (h > 23 || mi > 59 || s > 59) return null
  const wall = `${m[1]}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`
  const tz = m[7]
  if (tz) {
    const off = tz.toUpperCase() === 'Z' ? '+00:00' : tz.includes(':') ? tz : `${tz.slice(0, 3)}:${tz.slice(3)}`
    return { iso: `${wall}${off}`, assumedLocal: false, dateOnly }
  }
  return { iso: `${wall}${localOffset(y, mo, d, h, mi, s)}`, assumedLocal: true, dateOnly }
}

/** Numeric text → number (thousands separators, `h:mm:ss` durations → seconds); null otherwise. */
export function parseNumber(raw: string): { value: number; unit?: string } | null {
  const v = raw.trim()
  if (!v) return null
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) return { value: Number(v.replace(/,/g, '')) }
  if (/^-?\d+(\.\d+)?$/.test(v)) return { value: Number(v) }
  const t = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(v)
  if (t) return { value: t[3] === undefined ? Number(t[1]) * 60 + Number(t[2]) : Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]), unit: 's' }
  return null
}

function flatten(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 === null || v2 === undefined || typeof v2 === 'object') continue
        out[`${k}_${k2}`] = String(v2)
      }
    } else if (typeof v !== 'object') out[k] = String(v)
  }
  return out
}

function jsonTable(text: string): { header: string[]; rows: string[][] } {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error(tr('Not a valid JSON file', '不是合法的 JSON 文件'))
  }
  let list: unknown = data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>
    list = o.events ?? o.data ?? o.records ?? o.workouts ?? o.samples
  }
  if (!Array.isArray(list)) throw new Error(tr('No record array found in the JSON (a top-level array, or an events / data / records / workouts / samples field)', 'JSON 里没有找到记录数组（顶层数组，或 events / data / records / workouts / samples 字段）'))
  const objs = list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)).map(flatten)
  const header: string[] = []
  const seenKeys = new Set<string>()
  for (const o of objs)
    for (const k of Object.keys(o))
      if (!seenKeys.has(k)) {
        seenKeys.add(k)
        header.push(k)
      }
  return { header, rows: objs.map((o) => header.map((h) => o[h] ?? '')) }
}

export function parseHealthFile(text: string, fileName: string): HealthParseResult {
  const isJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text.replace(/^﻿/, ''))
  const table = isJson ? jsonTable(text) : parseCsv(text)
  const warnings = new Set<string>()
  if ('truncated' in table && table.truncated) warnings.add(tr('Too many rows; only the first 100000 were read', '行数过多，只读取了前 100000 行'))
  const { header, rows } = table
  const tCol = findCol(header, TIME_COLS)
  if (tCol < 0) throw new Error(
      tr(
        `No time column found (need one of ${TIME_COLS.slice(0, 6).join(' / ')}). Header: ${header.slice(0, 12).join(', ')}`,
        `找不到时间列（需要 ${TIME_COLS.slice(0, 6).join(' / ')} 之一）。表头：${header.slice(0, 12).join(', ')}`
      )
    )
  const eCol = findCol(header, END_COLS)
  const mCol = findCol(header, METRIC_COLS)
  const vCol = findCol(header, VALUE_COLS)
  const uCol = findCol(header, UNIT_COLS)
  const dCol = findCol(header, [...DEVICE_COLS, 'source_device', 'sourcedevice', 'source_provider'].map(norm))
  const idCol = findCol(header, ID_COLS)
  const long = mCol >= 0 && vCol >= 0
  const used = new Set([tCol, eCol, mCol, vCol, uCol, dCol, idCol].filter((i) => i >= 0))
  const events: NormalizedHealthEvent[] = []
  const seen = new Map<string, number>()
  let assumed = 0
  let badTime = 0
  let skipped = 0

  const push = (row: string[], rowIdx: number, metric: string, value: number | string, unit: string, meta: Record<string, string | number>): void => {
    if (events.length >= MAX_HEALTH_EVENTS) {
      warnings.add(tr(`More than ${MAX_HEALTH_EVENTS} records; the rest were not read`, `记录超过 ${MAX_HEALTH_EVENTS} 条，其余未读取`))
      return
    }
    const start = normalizeTime(row[tCol] ?? '')
    if (!start) {
      badTime++
      return
    }
    if (start.assumedLocal) assumed++
    const end = eCol >= 0 ? normalizeTime(row[eCol] ?? '') : null
    const ended = end && Date.parse(end.iso) >= Date.parse(start.iso) ? end.iso : null
    const rawId = idCol >= 0 ? (row[idCol] ?? '').trim() : ''
    const base = `${metric}|${start.iso}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const event_id = rawId
      ? `${rawId.slice(0, 200)}${long ? '' : `:${metric}`}`
      : createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 32)
    const device = dCol >= 0 ? (row[dCol] ?? '').trim().slice(0, 160) || null : null
    events.push({
      event_id,
      source: { provider: HEALTH_PROVIDER, device, device_id: null },
      metric,
      value,
      unit: unit.slice(0, 32),
      started_at: start.iso,
      ended_at: ended,
      timezone: null,
      metadata: { ...meta, file_row: rowIdx + 2, ...(start.dateOnly ? { date_only: 1 } : {}) }
    })
  }

  rows.forEach((row, i) => {
    if (long) {
      const label = (row[mCol] ?? '').trim()
      const raw = (row[vCol] ?? '').trim()
      if (!label || !raw) {
        skipped++
        return
      }
      const { metric, unit: hdrUnit } = metricFromHeader(label)
      const num = parseNumber(raw)
      const unit = (uCol >= 0 ? (row[uCol] ?? '').trim() : '') || num?.unit || hdrUnit
      const meta: Record<string, string | number> = metric !== label.toLowerCase() ? { label: label.slice(0, 200) } : {}
      push(row, i, metric, num ? num.value : raw.slice(0, 1000), unit, meta)
      return
    }
    // wide: text columns → metadata of every event of the row; numeric columns → one event each
    const meta: Record<string, string | number> = {}
    const numeric: Array<{ col: number; value: number; unit?: string }> = []
    header.forEach((h, c) => {
      if (used.has(c)) return
      const raw = (row[c] ?? '').trim()
      if (!raw) return
      const num = parseNumber(raw)
      if (num) numeric.push({ col: c, value: num.value, unit: num.unit })
      else if (Object.keys(meta).length < 10) meta[metricFromHeader(h).metric] = raw.slice(0, 200)
    })
    if (!numeric.length) {
      skipped++
      return
    }
    for (const n of numeric) {
      const { metric, unit } = metricFromHeader(header[n.col])
      const label = header[n.col].trim()
      push(row, i, metric, n.value, n.unit ?? unit, { ...meta, ...(metric !== label.toLowerCase() ? { label: label.slice(0, 200) } : {}) })
    }
  })
  if (assumed) warnings.add(tr(`${assumed} records have no time zone and were read in the local time zone`, `${assumed} 条记录的时间没有时区，已按本机时区解释`))
  if (badTime) warnings.add(tr(`${badTime} rows have an unreadable time and were skipped`, `${badTime} 行时间无法识别，已跳过`))
  if (skipped) warnings.add(tr(`${skipped} rows have no usable value and were skipped`, `${skipped} 行没有可用的数值，已跳过`))
  const format = `${isJson ? 'json' : 'csv'}-${long ? 'long' : 'wide'}` as HealthParseResult['format']
  return { format, events, warnings: [...warnings], columns: header }
}

/** Local calendar day of an event (the date part of its own offset timestamp). */
export const eventDay = (e: NormalizedHealthEvent): string => e.started_at.slice(0, 10)

const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))

/** One searchable text per day: counts and plain aggregates only (no interpretation). */
export function daySummary(day: string, events: NormalizedHealthEvent[], fileLabel: string): string {
  const byMetric = new Map<string, NormalizedHealthEvent[]>()
  for (const e of events) {
    const list = byMetric.get(e.metric)
    if (list) list.push(e)
    else byMetric.set(e.metric, [e])
  }
  const lines = [`健康 / 训练记录 ${day}（来自 ${fileLabel}，经 Navalia 本地连接器导入；原始设备记录，不是医学结论）`]
  for (const [metric, list] of [...byMetric.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const unit = list.find((e) => e.unit)?.unit ?? ''
    const nums = list.map((e) => e.value).filter((v): v is number => typeof v === 'number')
    const label = list.find((e) => typeof e.metadata.label === 'string')?.metadata.label
    const name = label ? `${metric}（${label}）` : metric
    if (nums.length === list.length) {
      if (nums.length === 1) lines.push(`- ${name}：${fmtNum(nums[0])}${unit ? ` ${unit}` : ''}`)
      else {
        const sum = nums.reduce((a, b) => a + b, 0)
        lines.push(
          `- ${name}：${nums.length} 条，合计 ${fmtNum(sum)}，平均 ${fmtNum(sum / nums.length)}，最小 ${fmtNum(nums.reduce((a, b) => Math.min(a, b)))}，最大 ${fmtNum(nums.reduce((a, b) => Math.max(a, b)))}${unit ? ` ${unit}` : ''}`
        )
      }
    } else {
      const vals = [...new Set(list.map((e) => String(e.value)))].slice(0, 5)
      lines.push(`- ${name}：${vals.join('、')}${list.length > vals.length ? ` 等 ${list.length} 条` : ''}`)
    }
  }
  const kinds = [...new Set(events.map((e) => e.metadata.type ?? e.metadata.activity_type ?? e.metadata.activity).filter((v) => v !== undefined))].slice(0, 5)
  if (kinds.length) lines.push(`- 类型：${kinds.join('、')}`)
  return lines.join('\n')
}
