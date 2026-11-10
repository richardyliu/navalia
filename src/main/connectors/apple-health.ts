import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { Readable } from 'node:stream'
import zlib from 'node:zlib'
import type { NormalizedHealthEvent } from './health'
import { tr } from '../../shared/i18n'

/**
 * C19 Apple Health export (`export.xml`, or the `导出.zip` / `export.zip` the iPhone Health app
 * writes) → per-day aggregates in the shape of the Runtime's `POST /health-events/import` body.
 *
 * Streaming: the file is read in chunks (default 1 MiB) through a small tag scanner that keeps only
 * the unfinished tail of the current chunk (`stats.maxCarry`); the zip entry is inflated with
 * node:zlib as a stream. Memory is bounded by the aggregate state (days × known types, sleep
 * intervals per day), never by the file size. No DTD processing: the internal subset is skipped and
 * custom entities are NOT expanded (no entity-expansion attacks); the five predefined entities and
 * numeric character references are decoded.
 *
 * Aggregation (documented, no interpretation; raw device values, not medical conclusions):
 *   - cumulative types (steps, distance, energy, flights, exercise / stand minutes): summed per day
 *     PER SOURCE, the day's value is the largest single-source sum. iPhone and Apple Watch both
 *     record steps for the same walk; summing every source double-counts, so this picks one source
 *     (it can under-count when devices split the day). The source count is kept, names are not.
 *   - discrete types (heart rate, resting / walking HR, HRV, SpO2, respiratory rate, body mass,
 *     VO2max): average with min / max / sample count over all sources.
 *   - sleep (HKCategoryTypeIdentifierSleepAnalysis): asleep and in-bed intervals are merged (union,
 *     so overlapping Watch + iPhone intervals count once) and attributed to the day the interval
 *     ends (wake day); value in minutes.
 *   - workouts: one event each (activity, duration in minutes, distance and energy when present).
 *   - every other type is skipped and counted in a warning.
 * A record's day is the date in its own UTC offset (`startDate`). Records inside `<Correlation>`
 * are ignored (they duplicate top-level records). Event ids are deterministic
 * (`ah-<day>-<metric>-<unit>`), so a re-import is a duplicate and a later export of the same day is
 * a correction upstream.
 */

export const APPLE_HEALTH_PROVIDER = 'lens-apple-health'
export const DEFAULT_CHUNK_BYTES = 1024 * 1024
/** One tag (or DOCTYPE / comment) longer than this is treated as a malformed file. */
export const MAX_TAG_CHARS = 1024 * 1024
/** Decompressed / read bytes ceiling (zip-bomb guard; real exports are a few GB at most). */
export const MAX_XML_BYTES = 32 * 1024 ** 3
const MAX_SLEEP_INTERVALS_PER_DAY = 5000
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024

export class AppleHealthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppleHealthError'
  }
}

// ─── XML tag scanner ───────────────────────────────────────────────────────

export type XmlToken = { type: 'start'; name: string; attrs: Record<string, string>; selfClosing: boolean } | { type: 'end'; name: string }

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decode the predefined entities and numeric references only. Unknown entities stay literal. */
export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m
      return String.fromCodePoint(cp)
    }
    return Object.prototype.hasOwnProperty.call(PREDEFINED, body) ? PREDEFINED[body] : m
  })
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseTag(body: string): XmlToken {
  // body = text between '<' and '>' (exclusive)
  if (body[0] === '/') return { type: 'end', name: body.slice(1).trim() }
  const selfClosing = body.endsWith('/')
  const inner = selfClosing ? body.slice(0, -1) : body
  const m = /^[^\s/>]+/.exec(inner)
  const name = m ? m[0] : ''
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>
  ATTR_RE.lastIndex = name.length
  let a: RegExpExecArray | null
  while ((a = ATTR_RE.exec(inner))) attrs[a[1]] = decodeXmlEntities(a[2] ?? a[3] ?? '')
  return { type: 'start', name, attrs, selfClosing }
}

/**
 * Incremental scanner: feed decoded text chunks, get tags back. Text content, comments, processing
 * instructions, CDATA and the DOCTYPE (incl. its internal subset) are skipped.
 */
export class XmlTagScanner {
  private buf = ''
  maxCarry = 0

  feed(chunk: string, onToken: (t: XmlToken) => void, final = false): void {
    this.buf += chunk
    const buf = this.buf
    let pos = 0
    for (;;) {
      const lt = buf.indexOf('<', pos)
      if (lt < 0) {
        pos = buf.length
        break
      }
      pos = lt
      const rest = buf.length - pos
      if (rest < 9 && !final) break
      let end: number
      if (buf.startsWith('<!--', pos)) {
        end = buf.indexOf('-->', pos + 4)
        if (end < 0) break
        pos = end + 3
        continue
      }
      if (buf.startsWith('<![CDATA[', pos)) {
        end = buf.indexOf(']]>', pos + 9)
        if (end < 0) break
        pos = end + 3
        continue
      }
      if (buf.startsWith('<?', pos)) {
        end = buf.indexOf('?>', pos + 2)
        if (end < 0) break
        pos = end + 2
        continue
      }
      if (buf.startsWith('<!', pos)) {
        end = scanDeclEnd(buf, pos + 2)
        if (end < 0) break
        pos = end + 1
        continue
      }
      end = scanTagEnd(buf, pos + 1)
      if (end < 0) break
      onToken(parseTag(buf.slice(pos + 1, end)))
      pos = end + 1
    }
    this.buf = buf.slice(pos)
    if (this.buf.length > this.maxCarry) this.maxCarry = this.buf.length
    if (this.buf.length > MAX_TAG_CHARS) throw new AppleHealthError(tr('The XML has an abnormally long tag. The file may be corrupt or not an Apple Health export.', 'XML 里有一个异常长的标签，文件可能已损坏或不是 Apple Health 导出。'))
    if (final && this.buf.includes('<')) throw new AppleHealthError(tr('The XML ends in the middle of a tag. The file may be incomplete (truncated export?).', 'XML 在标签中间结束，文件可能不完整（导出被截断？）。'))
  }
}

/** End of a start / end tag, honouring quoted attribute values (which may contain '>'). */
function scanTagEnd(s: string, from: number): number {
  let q = ''
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (q) {
      if (s[i] === q) q = ''
    } else if (c === 34 /* " */ || c === 39 /* ' */) q = s[i]
    else if (c === 62 /* > */) return i
  }
  return -1
}

/** End of `<!DOCTYPE … [ … ]>` / `<!ELEMENT …>`: brackets, quotes and nested comments. */
function scanDeclEnd(s: string, from: number): number {
  let depth = 0
  let q = ''
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) q = ''
      continue
    }
    if (c === '"' || c === "'") q = c
    else if (c === '<' && s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4)
      if (e < 0) return -1
      i = e + 2
    } else if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === '>' && depth <= 0) return i
  }
  return -1
}

// ─── Aggregation ───────────────────────────────────────────────────────────

type Agg = 'sum' | 'stats'
const TYPES: ReadonlyMap<string, { metric: string; agg: Agg }> = new Map(
  Object.entries({
    HKQuantityTypeIdentifierStepCount: { metric: 'steps', agg: 'sum' },
    HKQuantityTypeIdentifierDistanceWalkingRunning: { metric: 'distance_walking_running', agg: 'sum' },
    HKQuantityTypeIdentifierDistanceCycling: { metric: 'distance_cycling', agg: 'sum' },
    HKQuantityTypeIdentifierDistanceSwimming: { metric: 'distance_swimming', agg: 'sum' },
    HKQuantityTypeIdentifierActiveEnergyBurned: { metric: 'active_energy', agg: 'sum' },
    HKQuantityTypeIdentifierBasalEnergyBurned: { metric: 'basal_energy', agg: 'sum' },
    HKQuantityTypeIdentifierFlightsClimbed: { metric: 'flights_climbed', agg: 'sum' },
    HKQuantityTypeIdentifierAppleExerciseTime: { metric: 'exercise_minutes', agg: 'sum' },
    HKQuantityTypeIdentifierAppleStandTime: { metric: 'stand_minutes', agg: 'sum' },
    HKQuantityTypeIdentifierHeartRate: { metric: 'heart_rate', agg: 'stats' },
    HKQuantityTypeIdentifierRestingHeartRate: { metric: 'resting_heart_rate', agg: 'stats' },
    HKQuantityTypeIdentifierWalkingHeartRateAverage: { metric: 'walking_heart_rate', agg: 'stats' },
    HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { metric: 'hrv_sdnn', agg: 'stats' },
    HKQuantityTypeIdentifierOxygenSaturation: { metric: 'oxygen_saturation', agg: 'stats' },
    HKQuantityTypeIdentifierRespiratoryRate: { metric: 'respiratory_rate', agg: 'stats' },
    HKQuantityTypeIdentifierBodyMass: { metric: 'body_mass', agg: 'stats' },
    HKQuantityTypeIdentifierVO2Max: { metric: 'vo2max', agg: 'stats' }
  })
)
const SLEEP_TYPE = 'HKCategoryTypeIdentifierSleepAnalysis'
const ASLEEP = new Set([
  'HKCategoryValueSleepAnalysisAsleep',
  'HKCategoryValueSleepAnalysisAsleepUnspecified',
  'HKCategoryValueSleepAnalysisAsleepCore',
  'HKCategoryValueSleepAnalysisAsleepDeep',
  'HKCategoryValueSleepAnalysisAsleepREM'
])
const IN_BED = 'HKCategoryValueSleepAnalysisInBed'

interface Stamp {
  iso: string
  day: string
  offset: string
  ms: number
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s?(?:([+-])(\d{2}):?(\d{2})|Z)$/

/** `2024-01-02 07:30:00 +0800` → ISO with offset, local day, epoch ms. */
export function parseAppleDate(raw: string | undefined): Stamp | null {
  if (!raw) return null
  const m = DATE_RE.exec(raw.trim())
  if (!m) return null
  const offset = m[3] ? `${m[3]}${m[4]}:${m[5]}` : '+00:00'
  const iso = `${m[1]}T${m[2]}${offset}`
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return { iso, day: m[1], offset, ms }
}

interface SumCell {
  metric: string
  unit: string
  bySource: Map<string, number>
  samples: number
}
interface StatCell {
  metric: string
  unit: string
  n: number
  sum: number
  min: number
  max: number
}
interface DayState {
  offset: string
  sums: Map<string, SumCell>
  stats: Map<string, StatCell>
  asleep: Array<[number, number]>
  inBed: Array<[number, number]>
}

export interface AppleHealthStats {
  bytes: number
  chunks: number
  /** Largest unfinished text kept between chunks (the scanner's only buffer). */
  maxCarry: number
  records: number
  recordsUsed: number
  workouts: number
  badDates: number
  skippedTypes: Array<{ type: string; count: number }>
  source: 'xml' | 'zip'
}

export interface AppleHealthResult {
  events: NormalizedHealthEvent[]
  warnings: string[]
  stats: AppleHealthStats
}

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 20)
const slug = (u: string): string => u.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'none'
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d

function unionMinutes(list: Array<[number, number]>): number {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a[0] - b[0])
  let total = 0
  let [s, e] = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i]
    if (a <= e) e = Math.max(e, b)
    else {
      total += e - s
      s = a
      e = b
    }
  }
  total += e - s
  return total / 60_000
}

function toMinutes(v: number, unit: string | undefined): number {
  switch ((unit ?? 'min').toLowerCase()) {
    case 's':
    case 'sec':
      return v / 60
    case 'hr':
    case 'h':
      return v * 60
    default:
      return v
  }
}

export class AppleHealthAggregator {
  private days = new Map<string, DayState>()
  private workouts: NormalizedHealthEvent[] = []
  private skipped = new Map<string, number>()
  private correlationDepth = 0
  private workout: { attrs: Record<string, string>; distance?: [number, string]; energy?: [number, string] } | null = null
  records = 0
  recordsUsed = 0
  badDates = 0
  sawHealthData = false

  private day(st: Stamp): DayState {
    let d = this.days.get(st.day)
    if (!d) {
      d = { offset: st.offset, sums: new Map(), stats: new Map(), asleep: [], inBed: [] }
      this.days.set(st.day, d)
    }
    return d
  }

  token(t: XmlToken): void {
    if (t.type === 'end') {
      if (t.name === 'Correlation') this.correlationDepth = Math.max(0, this.correlationDepth - 1)
      else if (t.name === 'Workout' && this.workout) this.finishWorkout()
      return
    }
    switch (t.name) {
      case 'HealthData':
        this.sawHealthData = true
        return
      case 'Correlation':
        if (!t.selfClosing) this.correlationDepth++
        return
      case 'Record':
        if (this.correlationDepth === 0) this.record(t.attrs)
        return
      case 'Workout':
        this.workout = { attrs: t.attrs }
        if (t.selfClosing) this.finishWorkout()
        return
      case 'WorkoutStatistics':
        if (this.workout) {
          const sum = Number(t.attrs.sum)
          if (!Number.isFinite(sum)) return
          if (/Distance/.test(t.attrs.type ?? '')) this.workout.distance = [sum, t.attrs.unit ?? '']
          else if (t.attrs.type === 'HKQuantityTypeIdentifierActiveEnergyBurned') this.workout.energy = [sum, t.attrs.unit ?? '']
        }
        return
      default:
        return
    }
  }

  private record(a: Record<string, string>): void {
    this.records++
    const type = a.type ?? ''
    if (type === SLEEP_TYPE) {
      const s = parseAppleDate(a.startDate)
      const e = parseAppleDate(a.endDate)
      if (!s || !e || e.ms < s.ms) {
        this.badDates++
        return
      }
      const list = ASLEEP.has(a.value ?? '') ? 'asleep' : a.value === IN_BED ? 'inBed' : null
      if (!list) return
      const d = this.day(e)
      if (d[list].length < MAX_SLEEP_INTERVALS_PER_DAY) d[list].push([s.ms, e.ms])
      this.recordsUsed++
      return
    }
    const spec = TYPES.get(type)
    if (!spec) {
      // Bounded: one counter per distinct type name (≈ 100 in real exports; capped).
      if (this.skipped.size < 500 || this.skipped.has(type)) this.skipped.set(type, (this.skipped.get(type) ?? 0) + 1)
      return
    }
    const st = parseAppleDate(a.startDate)
    if (!st) {
      this.badDates++
      return
    }
    const v = Number(a.value)
    if (!Number.isFinite(v)) return
    const unit = (a.unit ?? '').slice(0, 32)
    const d = this.day(st)
    const key = `${spec.metric}\u0000${unit}`
    this.recordsUsed++
    if (spec.agg === 'sum') {
      let c = d.sums.get(key)
      if (!c) {
        c = { metric: spec.metric, unit, bySource: new Map(), samples: 0 }
        d.sums.set(key, c)
      }
      const src = (a.sourceName ?? '').slice(0, 200)
      c.bySource.set(src, (c.bySource.get(src) ?? 0) + v)
      c.samples++
    } else {
      let c = d.stats.get(key)
      if (!c) {
        c = { metric: spec.metric, unit, n: 0, sum: 0, min: Infinity, max: -Infinity }
        d.stats.set(key, c)
      }
      c.n++
      c.sum += v
      if (v < c.min) c.min = v
      if (v > c.max) c.max = v
    }
  }

  private finishWorkout(): void {
    const w = this.workout
    this.workout = null
    if (!w) return
    const a = w.attrs
    const s = parseAppleDate(a.startDate)
    const e = parseAppleDate(a.endDate)
    if (!s) {
      this.badDates++
      return
    }
    const activity = (a.workoutActivityType ?? 'HKWorkoutActivityTypeOther').replace(/^HKWorkoutActivityType/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 60) || 'Other'
    const dur = Number(a.duration)
    const minutes = Number.isFinite(dur) ? toMinutes(dur, a.durationUnit) : e ? (e.ms - s.ms) / 60_000 : NaN
    const metadata: Record<string, string | number> = { activity: activity.toLowerCase(), aggregation: 'workout' }
    const dist = w.distance ?? (Number.isFinite(Number(a.totalDistance)) ? ([Number(a.totalDistance), a.totalDistanceUnit ?? ''] as [number, string]) : undefined)
    if (dist) {
      metadata.distance = round(dist[0])
      metadata.distance_unit = dist[1].slice(0, 16)
    }
    const en = w.energy ?? (Number.isFinite(Number(a.totalEnergyBurned)) ? ([Number(a.totalEnergyBurned), a.totalEnergyBurnedUnit ?? ''] as [number, string]) : undefined)
    if (en) {
      metadata.energy = round(en[0])
      metadata.energy_unit = en[1].slice(0, 16)
    }
    this.workouts.push({
      event_id: `ah-w-${shortHash(`${s.iso}\u0000${e?.iso ?? ''}\u0000${activity}\u0000${a.sourceName ?? ''}`)}`,
      source: { provider: APPLE_HEALTH_PROVIDER, device: null, device_id: null },
      metric: 'workout',
      value: Number.isFinite(minutes) ? round(minutes, 1) : 0,
      unit: 'min',
      started_at: s.iso,
      ended_at: e && e.ms >= s.ms ? e.iso : null,
      timezone: null,
      metadata
    })
  }

  finish(): { events: NormalizedHealthEvent[]; skippedTypes: Array<{ type: string; count: number }> } {
    const events: NormalizedHealthEvent[] = []
    const src = { provider: APPLE_HEALTH_PROVIDER, device: null, device_id: null }
    for (const [day, d] of [...this.days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const range = { started_at: `${day}T00:00:00${d.offset}`, ended_at: `${day}T23:59:59${d.offset}` }
      for (const c of d.sums.values()) {
        const value = Math.max(...c.bySource.values())
        events.push({
          event_id: `ah-${day}-${c.metric}-${slug(c.unit)}`,
          source: src,
          metric: c.metric,
          value: round(value),
          unit: c.unit,
          ...range,
          timezone: null,
          metadata: { aggregation: 'sum', method: 'max_single_source', sources: c.bySource.size, samples: c.samples }
        })
      }
      for (const c of d.stats.values()) {
        events.push({
          event_id: `ah-${day}-${c.metric}-${slug(c.unit)}`,
          source: src,
          metric: c.metric,
          value: round(c.sum / c.n),
          unit: c.unit,
          ...range,
          timezone: null,
          metadata: { aggregation: 'avg', min: round(c.min), max: round(c.max), samples: c.n }
        })
      }
      for (const [list, metric] of [
        [d.asleep, 'sleep_asleep'],
        [d.inBed, 'sleep_in_bed']
      ] as const) {
        if (!list.length) continue
        events.push({
          event_id: `ah-${day}-${metric}-min`,
          source: src,
          metric,
          value: round(unionMinutes(list), 1),
          unit: 'min',
          ...range,
          timezone: null,
          metadata: { aggregation: 'union_of_intervals', intervals: list.length, attributed_to: 'wake_day' }
        })
      }
    }
    events.push(...this.workouts)
    const skippedTypes = [...this.skipped.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
    return { events, skippedTypes }
  }
}

// ─── Sources: plain XML or the zip export ─────────────────────────────────

function openRegular(file: string): { fd: number; size: number } {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (e) {
    throw new AppleHealthError((e as NodeJS.ErrnoException).code === 'ELOOP' ? tr('Symbolic links are not read. Pick the file itself.', '不读取符号链接，请选择文件本身。') : tr('The file does not exist or cannot be read.', '文件不存在或无法读取。'))
  }
  const st = fs.fstatSync(fd)
  if (!st.isFile()) {
    fs.closeSync(fd)
    throw new AppleHealthError(tr('The selected item is not a regular file.', '所选项目不是普通文件。'))
  }
  return { fd, size: st.size }
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len)
  let off = 0
  while (off < len) {
    const n = fs.readSync(fd, b, off, len - off, pos + off)
    if (n === 0) break
    off += n
  }
  return b.subarray(0, off)
}

export interface ZipEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

/** Central directory listing (zip + zip64), bounded. */
export function listZip(fd: number, fileSize: number): ZipEntry[] {
  const tailLen = Math.min(fileSize, 65_557)
  const tail = readAt(fd, fileSize - tailLen, tailLen)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new AppleHealthError(tr('Not a valid zip file (no central directory found).', '不是有效的 zip 文件（找不到目录）。'))
  let entries = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = fileSize - tailLen + eocd - 20
    const loc = locPos >= 0 ? readAt(fd, locPos, 20) : Buffer.alloc(0)
    if (loc.length !== 20 || loc.readUInt32LE(0) !== 0x07064b50) throw new AppleHealthError(tr('The zip64 directory is corrupt.', 'zip64 目录损坏。'))
    const z64 = readAt(fd, Number(loc.readBigUInt64LE(8)), 56)
    if (z64.length !== 56 || z64.readUInt32LE(0) !== 0x06064b50) throw new AppleHealthError(tr('The zip64 directory is corrupt.', 'zip64 目录损坏。'))
    entries = Number(z64.readBigUInt64LE(32))
    cdSize = Number(z64.readBigUInt64LE(40))
    cdOffset = Number(z64.readBigUInt64LE(48))
  }
  if (cdSize > MAX_CENTRAL_DIRECTORY || cdOffset + cdSize > fileSize) throw new AppleHealthError(tr('The zip directory is too large or corrupt.', 'zip 目录过大或损坏。'))
  const cd = readAt(fd, cdOffset, cdSize)
  const out: ZipEntry[] = []
  let p = 0
  for (let n = 0; n < entries && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new AppleHealthError(tr('A zip directory entry is corrupt.', 'zip 目录项损坏。'))
    const flags = cd.readUInt16LE(p + 8)
    const method = cd.readUInt16LE(p + 10)
    let compressedSize = cd.readUInt32LE(p + 20)
    let size = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    let localHeaderOffset = cd.readUInt32LE(p + 42)
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    // zip64 extended information: only the fields that are 0xFFFFFFFF, in this order.
    let e = p + 46 + nameLen
    const eEnd = e + extraLen
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e)
      const len = cd.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff && q + 8 <= e + 4 + len) (size = Number(cd.readBigUInt64LE(q))), (q += 8)
        if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) (compressedSize = Number(cd.readBigUInt64LE(q))), (q += 8)
        if (localHeaderOffset === 0xffffffff && q + 8 <= e + 4 + len) localHeaderOffset = Number(cd.readBigUInt64LE(q))
      }
      e += 4 + len
    }
    out.push({ name, method, flags, compressedSize, size, localHeaderOffset })
    p = eEnd + commentLen
  }
  return out
}

/** `apple_health_export/export.xml` (English) or `…/导出.xml` (Chinese); never `export_cda.xml`. */
export function pickExportEntry(entries: ZipEntry[]): ZipEntry | null {
  const xml = entries.filter((e) => /\.xml$/i.test(e.name) && !/cda/i.test(e.name) && !e.name.endsWith('/'))
  const exact = xml.find((e) => /(^|\/)(export|导出)\.xml$/i.test(e.name))
  if (exact) return exact
  return xml.length === 1 ? xml[0] : null
}

function zipEntryStream(file: string, fd: number, entry: ZipEntry): Readable {
  if (entry.flags & 0x1) throw new AppleHealthError(tr('The file inside the zip is encrypted and cannot be read.', 'zip 内的文件是加密的，无法读取。'))
  if (entry.method !== 0 && entry.method !== 8) throw new AppleHealthError(tr(`Zip compression method ${entry.method} is not supported. Unzip it first, then pick the export.xml inside.`, `zip 压缩方式 ${entry.method} 不支持，请先解压，再选择其中的 export.xml。`))
  const lh = readAt(fd, entry.localHeaderOffset, 30)
  if (lh.length !== 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new AppleHealthError(tr('The zip file header is corrupt.', 'zip 文件头损坏。'))
  const start = entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  const raw = fs.createReadStream(file, { fd, start, end: start + entry.compressedSize - 1, autoClose: false, highWaterMark: DEFAULT_CHUNK_BYTES })
  if (entry.method === 0) return raw
  const inflate = zlib.createInflateRaw({ chunkSize: 256 * 1024 })
  raw.on('error', (e) => inflate.destroy(e))
  return raw.pipe(inflate)
}

export interface AppleHealthOptions {
  chunkBytes?: number
}

/** Parse an Apple Health `export.xml` or export zip, streaming. */
export async function parseAppleHealthFile(file: string, opts: AppleHealthOptions = {}): Promise<AppleHealthResult> {
  const { fd, size } = openRegular(file)
  try {
    const head = readAt(fd, 0, 4)
    const isZip = head.length === 4 && head.readUInt32LE(0) === 0x04034b50
    let stream: Readable
    if (isZip) {
      const entry = pickExportEntry(listZip(fd, size))
      if (!entry) throw new AppleHealthError(
          tr(
            'No apple_health_export/export.xml (or "导出.xml") found in the zip. Make sure you picked the archive exported by the Health app, or unzip it and pick export.xml.',
            'zip 里没有找到 apple_health_export/export.xml（或「导出.xml」）。请确认选的是「健康」App 导出的压缩包，或先解压再选择 export.xml。'
          )
        )
      stream = zipEntryStream(file, fd, entry)
    } else {
      stream = fs.createReadStream(file, { fd, autoClose: false, highWaterMark: opts.chunkBytes ?? DEFAULT_CHUNK_BYTES })
    }
    return await parseAppleHealthStream(stream, isZip ? 'zip' : 'xml', opts)
  } finally {
    fs.closeSync(fd)
  }
}

/** Core streaming loop; exported for tests (any Readable / async iterable of Buffers). */
export async function parseAppleHealthStream(stream: AsyncIterable<Buffer | string>, source: 'xml' | 'zip' = 'xml', opts: AppleHealthOptions = {}): Promise<AppleHealthResult> {
  const decoder = new TextDecoder('utf-8')
  const scanner = new XmlTagScanner()
  const agg = new AppleHealthAggregator()
  const onToken = (t: XmlToken): void => agg.token(t)
  const chunkLimit = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES
  let bytes = 0
  let chunks = 0
  let first = true
  for await (const raw of stream) {
    const buf = typeof raw === 'string' ? Buffer.from(raw) : raw
    bytes += buf.length
    if (bytes > MAX_XML_BYTES) throw new AppleHealthError(tr('The unzipped data exceeds the limit (32 GiB). Stopped.', '解压后的数据超过上限（32 GiB），已停止。'))
    // Inflate output may arrive in larger pieces than the read chunk: process in slices so the
    // scanner's working string stays near the chunk size.
    for (let off = 0; off < buf.length; off += chunkLimit) {
      chunks++
      let text = decoder.decode(buf.subarray(off, off + chunkLimit), { stream: true })
      if (first) {
        text = text.replace(/^﻿/, '')
        first = false
      }
      scanner.feed(text, onToken)
    }
  }
  scanner.feed(decoder.decode(), onToken, true)
  if (!agg.sawHealthData) throw new AppleHealthError(tr('This does not look like an Apple Health export: no <HealthData> root element found.', '这不像 Apple Health 导出：没有找到 <HealthData> 根元素。'))
  const { events, skippedTypes } = agg.finish()
  const warnings: string[] = []
  if (skippedTypes.length) {
    const total = skippedTypes.reduce((a, b) => a + b.count, 0)
    const top = skippedTypes.slice(0, 8).map((s) => `${s.type.replace(/^HK(Quantity|Category)TypeIdentifier/, '')}（${s.count}）`)
    warnings.push(
      tr(
        `Skipped ${total} records of unsupported types: ${top.join(', ')}${skippedTypes.length > 8 ? ` and more (${skippedTypes.length} types)` : ''}`,
        `跳过了 ${total} 条不在支持列表里的记录：${top.join('、')}${skippedTypes.length > 8 ? ` 等 ${skippedTypes.length} 类` : ''}`
      )
    )
  }
  if (agg.badDates) warnings.push(tr(`${agg.badDates} records had an unreadable time and were skipped`, `${agg.badDates} 条记录的时间无法识别，已跳过`))
  warnings.push(
    tr(
      'Cumulative types (steps, distance, energy and so on) use the largest single-source daily total, so iPhone and Watch are not counted twice. This can run low when a device records in segments.',
      '累计类（步数、距离、能量等）按天取「单一来源的最大合计」，避免 iPhone 与手表重复计数；设备分段记录时可能偏低。'
    )
  )
  warnings.push(tr('Sleep counts toward the day you woke up; overlapping periods count once.', '睡眠按醒来那天计入，重叠的时段只算一次。'))
  return {
    events,
    warnings,
    stats: {
      bytes,
      chunks,
      maxCarry: scanner.maxCarry,
      records: agg.records,
      recordsUsed: agg.recordsUsed,
      workouts: events.filter((e) => e.metric === 'workout').length,
      badDates: agg.badDates,
      skippedTypes,
      source
    }
  }
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))

/** One searchable text per day for Apple Health aggregates (plain numbers, no interpretation). */
export function appleHealthDaySummary(day: string, events: NormalizedHealthEvent[], fileLabel: string): string {
  const lines = [`健康 / 训练记录 ${day}（来自 Apple Health 导出 ${fileLabel}，经 Navalia 本地连接器导入；原始设备记录的按天汇总，不是医学结论）`]
  const sorted = [...events].sort((a, b) => a.metric.localeCompare(b.metric) || a.started_at.localeCompare(b.started_at))
  for (const e of sorted) {
    const u = e.unit ? ` ${e.unit}` : ''
    const m = e.metadata
    if (e.metric === 'workout') {
      const extra = [m.distance !== undefined ? `距离 ${m.distance} ${m.distance_unit ?? ''}`.trim() : null, m.energy !== undefined ? `能量 ${m.energy} ${m.energy_unit ?? ''}`.trim() : null].filter(Boolean)
      lines.push(`- 体能训练：${m.activity}，${fmt(Number(e.value))} 分钟${extra.length ? `，${extra.join('，')}` : ''}（${e.started_at.slice(11, 16)} 开始）`)
    } else if (m.aggregation === 'avg') lines.push(`- ${e.metric}：平均 ${fmt(Number(e.value))}，最小 ${m.min}，最大 ${m.max}${u}（${m.samples} 次测量）`)
    else if (m.aggregation === 'sum') lines.push(`- ${e.metric}：${fmt(Number(e.value))}${u}（${m.samples} 条记录，${m.sources} 个来源，取单一来源最大合计）`)
    else lines.push(`- ${e.metric}：${fmt(Number(e.value))}${u}`)
  }
  return lines.join('\n')
}
