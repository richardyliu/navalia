import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SecretBox } from '../identity/secret-box'
import { defaultExec, runImportCli, type ExecFn } from '../import/cli'
import { redactForDisplay, stripSecrets } from '../import/redact'
import { ensureSecureDir, writeFileSecure } from '../store/paths'
import { OWNER_DELETE_MAX_IDS, parseOwnerDeleteResult, refusalText } from '../runtime/owner-delete'
import {
  consentKindOf,
  type CalendarTarget,
  type ConnectorCommitItem,
  type ConnectorCommitResult,
  type ConnectorItem,
  type ConnectorKind,
  type ConnectorPreview,
  type ConsentKind,
  type CsvMapping,
  type DeleteImportedResult,
  type DeleteRemaining,
  type ImapConfigInput,
  type ImapConfigView,
  type ImapFetchOptions,
  type LedgerConnectorView,
  type LedgerView
} from './api'
import { AppleHealthError, appleHealthDaySummary, parseAppleHealthFile } from './apple-health'
import { createConsentStore, ConsentRequiredError } from './consent'
import { parseCsv, type CsvTable } from './csv'
import { csvItems, guessMapping, validateMapping } from './csv-import'
import { daySummary, eventDay, parseHealthFile, type NormalizedHealthEvent } from './health'
import { parseIcs, type IcsDate, type IcsEvent } from './ics'
import { MailParseError, parseEmail, type ParsedEmail } from './eml'
import { createImapCredentialStore, type ImapCredentials } from './imap/credentials'
import type { ImapFetchRequest, ImapFetchResult } from './imap/fetch'
import { looksLikeMbox, parseMbox } from './mbox'
import { tr } from '../../shared/i18n'

/**
 * Local connectors (S1-R3-07, S1-R4-07, S1-FULL C19).
 *
 *   consent for the kind (C19, `consent.ts`) → choose a file (main-process dialog) or fetch over
 *   IMAP (read-only, TLS; the fetch function is injected — this file opens no socket) → parse →
 *   redact → preview (nothing written) → commit selected items to the Runtime:
 *       calendar → MCP `remember` per event (default) or `import-data --source folder --no-build`;
 *       health   → `POST /health-events/import` (structured, idempotent by provider + event_id)
 *                  + MCP `remember` with one plain-aggregate summary per day. CSV / JSON files and
 *                  Apple Health export.xml / zip (streamed, per-day aggregates; `apple-health.ts`);
 *       email    → MCP `remember` per message (.eml / mbox; key = Message-ID hash);
 *       imap     → same as email, tags `connector:imap`;
 *       csv      → MCP `remember` per row (user column mapping) or `import-data` timeline.
 * Lens never writes `index.db` directly.
 *
 * Ledger (`<store>/connectors/ledger.json`, 0600): content hash per item (re-import skips identical
 * items), the Runtime entry ids returned by `remember`, the connector that wrote it, timeline
 * documents, and the structured health event ids. `deleteImported` uses it to delete what the
 * Runtime lets Lens delete (health events: `deleted_events`; memory entries: `POST /model/edit`
 * `retire`) and reports exactly what remains otherwise.
 */

export const MAX_CONNECTOR_FILE_BYTES = 20 * 1024 * 1024
/** S1-R4-07: mbox exports are larger than calendars; still read once into memory. */
export const MAX_EMAIL_FILE_BYTES = 64 * 1024 * 1024
/** Body characters written per message (after decoding, before redaction markers). */
export const MAX_EMAIL_BODY = 4000
const MAX_ATTACHMENT_NAMES = 10
/** Runtime limit is 1000 operations per request (`MAX_HEALTH_EVENTS_PER_REQUEST`). */
export const HEALTH_BATCH = 500
export const HEALTH_DELETE_BATCH = 1000
const MAX_DESCRIPTION = 2000
const MAX_PREVIEWS = 3
const MAX_REMAINING_IDS = 200

/**
 * S1-R3-SEC L3: an event_id taken from the file's own ID column may carry an email / token. When the
 * redactor would change it, send a stable hash instead (same raw id ⇒ same hash, so Runtime dedup by
 * provider + event_id and the Lens ledger keep working). Ids with nothing to redact are unchanged, so
 * earlier imports stay idempotent.
 */
function safeEventId(id: string, redact: (s: string) => string): string {
  if (redact(id) === id) return id
  return `h-${createHash('sha256').update(`lens-file-event-id\u0000${id}`).digest('hex').slice(0, 32)}`
}

export class ConnectorError extends Error {
  constructor(
    readonly code: 'not_found' | 'runtime_missing' | 'unauthorized' | 'unknown',
    message: string
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}

export interface ConnectorServiceDeps {
  storeRoot: string
  runtimeRoot: () => string
  persomeBin: () => string | null
  /** One Runtime MCP tool call (stdio), raw text payload. */
  ossTool: (name: string, args: Record<string, unknown>) => Promise<string>
  /** POST JSON to the Runtime REST API on 127.0.0.1 with the owner token; returns the parsed body. */
  postRuntime: (route: string, body: unknown) => Promise<unknown>
  exec?: ExecFn
  now?: () => number
  /** C19: encryption for IMAP settings at rest (production: Electron safeStorage). Absent → IMAP settings cannot be saved. */
  secretBox?: SecretBox | null
  /** C19: the IMAP read (network lives only in `connectors/imap/**`, injected by ipc.ts). Absent → IMAP is unavailable. */
  imapFetch?: (cred: ImapCredentials, req: ImapFetchRequest) => Promise<ImapFetchResult>
}

interface LedgerEntry {
  sha256: string
  at: string
  entryIds: string[]
  /** C19: connector that wrote this item (older entries: derived from the key prefix). */
  connector?: ConnectorKind
  /** C19: written by `import-data` (timeline document `<kind>/<key>.md`). */
  timelineDoc?: string
}
interface HealthLedger {
  provider: string
  ids: string[]
  at: string
}
interface Ledger {
  version: 1
  entries: Record<string, LedgerEntry>
  /** C19: structured health events written per day ledger key. */
  health?: Record<string, HealthLedger>
}

interface HeldPreview {
  preview: ConnectorPreview
  /** Health: structured events by day key. */
  events: Map<string, NormalizedHealthEvent[]>
  /** Item key → ledger key + content hash used for "already written" checks. */
  ledgerKeys: Map<string, { lk: string; sha: string }>
  /** CSV: per-row extra Runtime tags. */
  itemTags: Map<string, string[]>
  /** CSV: the parsed table, kept so the user can re-map columns without re-reading the file. */
  csv?: { table: CsvTable; fileLabel: string }
  createdAt: number
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function readRegularText(file: string): string {
  return readRegularBytes(file, MAX_CONNECTOR_FILE_BYTES).toString('utf8')
}

function readRegularBytes(file: string, max: number): Buffer {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new ConnectorError('not_found', code === 'ELOOP' ? tr('Symbolic links are not read. Pick the file itself.', '不读取符号链接，请选择文件本身。') : tr('The file does not exist or cannot be read.', '文件不存在或无法读取。'))
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new ConnectorError('unknown', tr('The selected item is not a regular file.', '所选项目不是普通文件。'))
    if (st.size > max) throw new ConnectorError('unknown', tr(`The file is too large (${st.size} bytes, limit ${max}).`, `文件过大（${st.size} 字节，上限 ${max}）。`))
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off)
  } finally {
    fs.closeSync(fd)
  }
}

function fmtDate(d: IcsDate | null): string | null {
  if (!d) return null
  if (d.allDay) return `${d.iso}（全天）`
  return `${d.iso.slice(0, 16).replace('T', ' ')}（${d.tz ?? 'UTC' + d.iso.slice(19)}）`.replace('UTC+00:00', 'UTC')
}

const CALENDAR_MAPPING: Record<CalendarTarget, string> = {
  get memory() {
    return tr(
      'Write mode: Runtime MCP `remember`, one memory entry per event, searchable in Search right after import. Upstream force-tags these entries `source:agent-run` (it treats remember as an Agent write); Navalia adds `lens-connector` and `connector:calendar`.',
      '写入方式：Runtime MCP `remember`，每个事件一条记忆，导入后即可在「搜索」里找到。上游会强制给这些条目加 `source:agent-run` 标签（它把 remember 视为 Agent 写入），Navalia 另加 `lens-connector`、`connector:calendar`。'
    )
  },
  get timeline() {
    return tr(
      'Write mode: `persome import-data --source folder --no-build` (one Markdown document per event at a fixed path, so re-imports do not duplicate). Goes to the timeline only; to show up in memory search it needs a model build, which Navalia never starts by itself (X5).',
      '写入方式：`persome import-data --source folder --no-build`（每个事件一个 Markdown 文档，固定路径 → 重复导入不会重复）。只进入时间线；要出现在记忆搜索里需要一次模型构建，Navalia 不会自动构建（X5）。'
    )
  }
}
const calendarLimits = (): string[] => [
  tr(
    'Reads local .ics files only (X1: no Google / Feishu / Outlook accounts). Recurring events are imported once as defined, RRULE is not expanded; VTIMEZONE is not parsed, time zones are converted with the system time zone database.',
    '只读本地 .ics 文件（X1：不接 Google / 飞书 / Outlook 账号）。重复事件按原始定义导入一次，不展开 RRULE；VTIMEZONE 不解析，时区按系统时区库换算。'
  ),
  tr(
    'Only the attendee count is kept, never names or addresses; title / location / description are redacted (keys, tokens, emails, phone numbers, local user paths).',
    '参会人只记人数，不写入姓名或邮箱；标题 / 地点 / 说明经过脱敏（密钥、令牌、邮箱、电话、本机用户路径）。'
  ),
  tr(
    'An unchanged event is skipped; a changed event writes one more memory marked "updated" and the old entry stays (remember only appends).',
    '同一事件内容未变时跳过；内容变化时会再写一条标注「更新」的记忆，旧条目保留（remember 只追加）。'
  )
]
const emailMapping = (): string[] => [
  tr(
    'Write mode: Runtime MCP `remember`, one memory entry per message, searchable in Search right after import. Upstream force-tags `source:agent-run`; Navalia adds `lens-connector` and `connector:email`.',
    '写入方式：Runtime MCP `remember`，每封邮件一条记忆，导入后即可在「搜索」里找到。上游会强制加 `source:agent-run` 标签，Navalia 另加 `lens-connector`、`connector:email`。'
  ),
  tr(
    'Reads only the local .eml / mbox file you pick (X1: no Gmail / Feishu / Outlook sign-in, offline). Writes: subject, sender, recipients, time, plain-text body (up to 4000 characters); Cc as a count only; attachments as names and count only, attachment content is never read.',
    '只读你选中的本地 .eml / mbox 文件（X1：不登录 Gmail / 飞书 / Outlook，不联网）。写入：主题、发件人、收件人、时间、纯文本正文（最多 4000 字）；抄送只记人数；附件只记文件名和个数，从不读取附件内容。'
  ),
  tr(
    'multipart/alternative prefers text/plain; HTML-only bodies are imported with tags stripped. Supports quoted-printable, base64 and RFC 2047 encoded headers. No S/MIME / PGP decryption, no winmail.dat.',
    'multipart/alternative 优先取 text/plain；只有 HTML 时去掉标签后导入。支持 quoted-printable、base64 和 RFC 2047 编码的邮件头。不支持 S/MIME / PGP 解密、winmail.dat。'
  ),
  tr(
    'Each message is identified by Message-ID (without one, by a hash of sender + time + subject + body): the same message imported again from .eml or mbox is skipped; changed content appends one "updated" entry and the old entry stays (remember only appends).',
    '每封邮件按 Message-ID 识别（没有 Message-ID 时按发件人 + 时间 + 主题 + 正文的 hash）：同一封邮件从 .eml 或 mbox 再次导入时跳过；内容变化时追加一条「更新」，旧条目保留（remember 只追加）。'
  ),
  tr(
    'Email addresses, tokens, keys, phone numbers and local user paths are redacted before the preview; what you see in the preview is everything that will be written.',
    '邮箱地址、令牌、密钥、电话、本机用户路径在预览前就已脱敏；预览里看到的就是将写入的全部内容。'
  )
]
const imapMapping = (): string[] => [
  tr(
    'Write mode: Runtime MCP `remember`, one memory entry per message; upstream force-tags `source:agent-run`; Navalia adds `lens-connector` and `connector:imap`.',
    '写入方式：Runtime MCP `remember`，每封邮件一条记忆；上游会强制加 `source:agent-run` 标签，Navalia 另加 `lens-connector`、`connector:imap`。'
  ),
  tr(
    'Read path: TLS (993) sign-in → EXAMINE (read-only) → UID SEARCH SINCE → BODY.PEEK[] (does not mark as read). Navalia never sends a command that changes the mailbox (no delete, move, flag or send).',
    '读取方式：TLS（993）登录 → EXAMINE（只读）→ UID SEARCH SINCE → BODY.PEEK[]（不标记已读）。Navalia 不发送任何会修改邮箱的命令（不删除、不移动、不标记、不发信）。'
  ),
  tr(
    'Parsed like a local .eml: subject, sender, recipients, time, plain-text body (up to 4000 characters); attachments as names only. Shares Message-ID de-duplication with local .eml / mbox imports.',
    '解析与本地 .eml 相同：主题、发件人、收件人、时间、纯文本正文（最多 4000 字）；附件只记文件名。与本地 .eml / mbox 导入按 Message-ID 共用去重。'
  ),
  tr(
    'Email addresses, tokens, keys and phone numbers are redacted before the preview; what you see in the preview is everything that will be written.',
    '邮箱地址、令牌、密钥、电话在预览前就已脱敏；预览里看到的就是将写入的全部内容。'
  )
]
const healthMapping = (): string[] => [
  tr(
    'Structured write: Runtime `POST /health-events/import` (provider = lens-file, idempotent by provider + event_id; a new value for the same ID counts as a correction). Queryable via MCP `query_health_metrics`. Needs Runtime running.',
    '结构化写入：Runtime `POST /health-events/import`（provider = lens-file，按 provider + event_id 幂等；同一 ID 的新值视为更正）。可经 MCP `query_health_metrics` 查询。需要 Runtime 正在运行。'
  ),
  tr(
    'Searchable summary: one MCP `remember` per day (counts, totals, averages, min and max only; raw device records, not a medical conclusion); upstream adds `source:agent-run`; Navalia adds `lens-connector` and `connector:health`.',
    '可搜索摘要：每天一条 MCP `remember`（只含条数、合计、平均、最小、最大，原始设备记录，不是医学结论）；上游会加 `source:agent-run` 标签，Navalia 另加 `lens-connector`、`connector:health`。'
  ),
  tr(
    'Supports CSV (long: metric + value columns; wide: a date column + value columns), JSON (an array, or an events / data / records / workouts / samples field), and the Apple Health export.xml / export.zip. Times without a time zone are read in the local time zone.',
    '支持 CSV（长表：metric + value 列；宽表：日期列 + 数值列）、JSON（数组或 events / data / records / workouts / samples 字段），以及 Apple Health 的 export.xml / 导出.zip。时间没有时区时按本机时区解释。'
  )
]
const appleHealthMapping = (): string[] => [
  tr(
    'Structured write: Runtime `POST /health-events/import` (provider = lens-apple-health). One daily total per metric (not every raw record), with a fixed event_id (ah-date-metric-unit): re-importing counts as duplicates, and a later export corrects the same day.',
    '结构化写入：Runtime `POST /health-events/import`（provider = lens-apple-health）。每天每种指标一条汇总（不是逐条原始记录），event_id 固定（ah-日期-指标-单位）：重复导入是重复，之后的新导出会更正同一天的数值。'
  ),
  tr(
    'Searchable summary: one MCP `remember` per day (total / average / min / max, sleep minutes, workouts); Navalia adds `lens-connector` and `connector:health`.',
    '可搜索摘要：每天一条 MCP `remember`（合计 / 平均 / 最小 / 最大、睡眠分钟数、体能训练）；Navalia 加 `lens-connector`、`connector:health`。'
  ),
  tr(
    'Streamed: export.xml is read in chunks (never loaded whole); a zip is stream-decompressed straight from its apple_health_export/export.xml (or "导出.xml"). DTD entities are not expanded.',
    '流式读取：export.xml 按块读取（不整体载入内存）；zip 直接流式解压其中的 apple_health_export/export.xml（或「导出.xml」）。不展开 DTD 实体。'
  ),
  tr(
    'Supported: steps, walking-running / cycling / swimming distance, active / resting energy, flights climbed, exercise / stand minutes, heart rate, resting / walking heart rate, HRV, blood oxygen, respiratory rate, body mass, VO2 max, sleep, workouts. Other types are skipped (listed in the preview).',
    '支持：步数、步行跑步 / 骑行 / 游泳距离、活动 / 静息能量、爬楼、锻炼 / 站立分钟、心率、静息 / 步行心率、HRV、血氧、呼吸率、体重、最大摄氧量、睡眠、体能训练。其他类型跳过（预览里列出）。'
  )
]
const CSV_MAPPING: Record<CalendarTarget, string> = {
  get memory() {
    return tr(
      'Write mode: Runtime MCP `remember`, one memory entry per row, searchable right after import. Upstream adds `source:agent-run`; Navalia adds `lens-connector` and `connector:csv`, and tag-column values become `csv-tag:<value>`.',
      '写入方式：Runtime MCP `remember`，每行一条记忆，导入后即可搜索。上游加 `source:agent-run`，Navalia 加 `lens-connector`、`connector:csv`，标签列的值加为 `csv-tag:<值>`。'
    )
  },
  get timeline() {
    return tr(
      'Write mode: `persome import-data --source folder --no-build` (one Markdown document per row). Goes to the timeline only; to show up in search it needs a model build, which Navalia never starts by itself.',
      '写入方式：`persome import-data --source folder --no-build`（每行一个 Markdown 文档）。只进入时间线；要出现在搜索里需要一次模型构建，Navalia 不会自动构建。'
    )
  }
}
const csvLimits = (): string[] => [
  tr(
    'Writes only the columns you map (date / title / body / tags); other columns are never written. Every value is redacted first (keys, tokens, emails, phone numbers, local user paths).',
    '只写入你映射的列（日期 / 标题 / 正文 / 标签）；其他列不会写入。每个值先脱敏（密钥、令牌、邮箱、电话、本机用户路径）。'
  ),
  tr(
    'RFC 4180: quotes, line breaks inside quotes and "" escapes, UTF-8 BOM; the delimiter is detected from the header (comma / semicolon / Tab). Up to 100,000 rows; the preview shows up to 20,000 items.',
    'RFC 4180：引号、引号内换行和 "" 转义、UTF-8 BOM；分隔符按表头自动识别（逗号 / 分号 / Tab）。最多 100,000 行，预览最多 20,000 条。'
  ),
  tr(
    'CSV rows have no stable ID: the same row imported again is skipped; an edited row is written as a new entry (the old one stays).',
    'CSV 行没有稳定 ID：同一行再次导入会跳过；改过内容的行会作为新的一条写入（旧的保留）。'
  )
]

const LEDGER_PREFIX: ReadonlyArray<[string, ConnectorKind, boolean]> = [
  ['calendar-timeline:', 'calendar', true],
  ['csv-timeline:', 'csv', true],
  ['calendar:', 'calendar', false],
  ['health:', 'health', false],
  ['email:', 'email', false],
  ['csv:', 'csv', false]
]

function ledgerOwner(lk: string, e: LedgerEntry): { kind: ConnectorKind; timeline: boolean } | null {
  const p = LEDGER_PREFIX.find(([pre]) => lk.startsWith(pre))
  if (!p) return null
  return { kind: e.connector ?? p[1], timeline: p[2] }
}

export function createConnectorService(deps: ConnectorServiceDeps) {
  const exec = deps.exec ?? defaultExec
  const now = deps.now ?? Date.now
  const root = path.join(deps.storeRoot, 'connectors')
  const ledgerPath = path.join(root, 'ledger.json')
  const sourceDir = path.join(root, 'source')
  const previews = new Map<string, HeldPreview>()
  const consent = createConsentStore(root, now)
  const imapCreds = createImapCredentialStore(root, deps.secretBox ?? null)
  let busy = false

  const exclusive = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    if (busy) throw new ConnectorError('unknown', tr('Another connector operation is in progress. Try again shortly.', '另一个连接器操作正在进行，请稍后再试。'))
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  const requireConsent = (kind: ConsentKind): void => {
    try {
      consent.require(kind)
    } catch (e) {
      if (e instanceof ConsentRequiredError) throw new ConnectorError('unauthorized', e.message)
      throw e
    }
  }

  const readLedger = (): Ledger => {
    try {
      const v = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Ledger
      if (v && v.version === 1 && v.entries && typeof v.entries === 'object') return v
    } catch {
      /* missing / corrupt → empty */
    }
    return { version: 1, entries: {} }
  }
  const saveLedger = (l: Ledger): void => writeFileSecure(ledgerPath, `${JSON.stringify(l, null, 2)}\n`)

  const stateOf = (ledger: Ledger, ledgerKey: string, contentSha: string): ConnectorItem['state'] => {
    const e = Object.prototype.hasOwnProperty.call(ledger.entries, ledgerKey) ? ledger.entries[ledgerKey] : undefined
    return !e ? 'new' : e.sha256 === contentSha ? 'unchanged' : 'changed'
  }

  const holdPreview = (id: string, held: Omit<HeldPreview, 'createdAt'>): void => {
    previews.set(id, { ...held, createdAt: now() })
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value as string)
  }

  /**
   * Health day identity = the set of observation ids (not the file name), content = the observations
   * themselves: a renamed copy of the same export is "unchanged"; a corrected value is "changed";
   * two different files with data on the same day get separate summaries.
   */
  function healthLedger(day: string, list: NormalizedHealthEvent[]): { lk: string; sha: string } {
    const sorted = [...list].sort((a, b) => a.event_id.localeCompare(b.event_id))
    const ids = sha(sorted.map((e) => `${e.source.provider}\u0000${e.event_id}`).join('\u0001')).slice(0, 16)
    const body = sha(JSON.stringify(sorted.map((e) => [e.event_id, e.metric, e.value, e.unit, e.started_at, e.ended_at])))
    return { lk: `health:${day}:${ids}`, sha: body }
  }

  function clean(s: string | null, max = 500): { text: string | null; redactions: number } {
    if (!s) return { text: null, redactions: 0 }
    const r = stripSecrets(s.length > max ? `${s.slice(0, max)}…` : s)
    return { text: r.text, redactions: r.redactions }
  }

  function calendarItem(ev: IcsEvent, fileLabel: string, calendarName: string | null): Omit<ConnectorItem, 'state'> {
    let redactions = 0
    const c = (s: string | null, max?: number): string | null => {
      const r = clean(s, max)
      redactions += r.redactions
      return r.text
    }
    const summary = c(ev.summary, 300) ?? '（无标题）'
    const start = fmtDate(ev.start)
    const end = fmtDate(ev.end)
    const lines = [`日历事件：${summary}`]
    lines.push(`时间：${start ?? '未知'}${end ? ` — ${end}` : ev.duration ? `，时长 ${ev.duration}` : ''}`)
    const location = c(ev.location, 300)
    if (location) lines.push(`地点：${location}`)
    if (ev.rrule) lines.push(`重复：${c(ev.rrule, 200)}（未展开）`)
    if (ev.recurrenceId) lines.push(`（重复事件中的一次：${c(ev.recurrenceId, 60)}）`)
    if (ev.status) lines.push(`状态：${ev.status}`)
    const organizer = c(ev.organizer, 100)
    if (organizer) lines.push(`组织者：${organizer}`)
    if (ev.attendees) lines.push(`参会人：${ev.attendees} 人`)
    const description = c(ev.description, MAX_DESCRIPTION)
    if (description) lines.push(`说明：${description}`)
    lines.push(`来源：${c(fileLabel, 200)}${calendarName ? `（日历：${c(calendarName, 100)}）` : ''} · 本地 .ics，经 Navalia 连接器导入`)
    const identity = ev.uid ? `uid:${ev.uid}` : `nouid:${ev.summary ?? ''}|${ev.start?.iso ?? ''}`
    return {
      key: `ev-${sha(`${identity}\u0000${ev.recurrenceId ?? ''}`).slice(0, 24)}`,
      title: summary,
      when: ev.start?.iso ?? null,
      text: lines.join('\n'),
      redactions
    }
  }

  function emailItem(m: ParsedEmail, sourceLine: string): Omit<ConnectorItem, 'state'> {
    let redactions = 0
    const c = (s: string | null, max?: number): string | null => {
      const r = clean(s, max)
      redactions += r.redactions
      return r.text
    }
    const subject = c(m.subject, 300) ?? '（无主题）'
    const lines = [`邮件：${subject}`]
    const from = c(m.from, 300)
    if (from) lines.push(`发件人：${from}`)
    const to = c(m.to, 500)
    if (to) lines.push(`收件人：${to}`)
    if (m.ccCount) lines.push(`抄送：${m.ccCount} 人`)
    lines.push(`时间：${m.date ? `${m.date.slice(0, 16).replace('T', ' ')}（UTC）` : '未知'}`)
    if (m.attachments.length) {
      const names = m.attachments.slice(0, MAX_ATTACHMENT_NAMES).map((n) => c(n, 120) ?? '（未命名）')
      const more = m.attachments.length > MAX_ATTACHMENT_NAMES ? ` 等` : ''
      lines.push(`附件：${m.attachments.length} 个（${names.join('、')}${more}）· 只记文件名，未读取附件内容`)
    }
    const body = c(m.body, MAX_EMAIL_BODY)
    lines.push(body ? `正文${m.bodySource === 'html' ? '（由 HTML 转换）' : ''}：\n${body}` : '正文：（没有可读的纯文本正文）')
    lines.push(sourceLine)
    // Stable identity: Message-ID; otherwise a content hash of the raw (pre-redaction) fields.
    const identity = m.messageId ? `mid:${m.messageId}` : `nomid:${sha([m.from ?? '', m.date ?? '', m.subject ?? '', m.body].join('\u0000'))}`
    return {
      key: `mail-${sha(identity).slice(0, 24)}`,
      title: subject,
      when: m.date,
      text: lines.join('\n'),
      redactions,
      attachments: m.attachments.length
    }
  }

  function parseEmailFile(bytes: Buffer, fileName: string): { messages: ParsedEmail[]; warnings: string[] } {
    // latin1 keeps every byte: each MIME part is decoded later in its own charset.
    const raw = bytes.toString('latin1')
    const lower = fileName.toLowerCase()
    try {
      if (!lower.endsWith('.eml') && (lower.endsWith('.mbox') || lower.endsWith('.mbx') || looksLikeMbox(raw))) {
        const r = parseMbox(raw)
        return { messages: r.messages, warnings: r.warnings }
      }
      const m = parseEmail(raw)
      return { messages: [m], warnings: [] }
    } catch (e) {
      if (e instanceof MailParseError) throw new ConnectorError('unknown', tr(`Cannot read ${fileName}: ${e.message}`, `无法读取 ${fileName}：${e.message}`))
      throw e
    }
  }

  async function previewFile(kind: ConnectorKind, file: string): Promise<ConnectorPreview> {
    if (kind === 'imap') throw new ConnectorError('unknown', tr('IMAP does not read from a file.', 'IMAP 不从文件读取。'))
    requireConsent(consentKindOf(kind))
    if (!path.isAbsolute(file)) throw new ConnectorError('unknown', tr('The file path must be absolute.', '文件路径必须是绝对路径。'))
    const fileName = path.basename(file)
    if (kind === 'email') return previewEmailMessages('email', parseEmailFile(readRegularBytes(file, MAX_EMAIL_FILE_BYTES), fileName), fileName, '来源：本地邮件文件（.eml / mbox）· 经 Navalia 连接器导入', emailMapping())
    if (kind === 'health' && /\.(xml|zip)$/i.test(fileName)) return previewAppleHealth(file, fileName)
    const text = readRegularText(file)
    if (kind === 'csv') return previewCsv(text, fileName)
    const ledger = readLedger()
    const id = randomBytes(12).toString('hex')
    const ledgerKeys = new Map<string, { lk: string; sha: string }>()
    if (kind === 'calendar') {
      const parsed = parseIcs(text)
      if (!parsed.events.length) {
        throw new ConnectorError(
          'unknown',
          tr(`No calendar events (VEVENT) found in ${fileName}. ${parsed.warnings.join('; ')}`, `没有在 ${fileName} 里找到日历事件（VEVENT）。${parsed.warnings.join('；')}`)
        )
      }
      const byKey = new Map<string, Omit<ConnectorItem, 'state'>>()
      const warnings = [...parsed.warnings]
      for (const ev of parsed.events) {
        const it = calendarItem(ev, fileName, parsed.calendarName)
        if (byKey.has(it.key)) {
          warnings.push(tr('The file has duplicate events (same UID); only the last one is kept', '文件中有重复的事件（相同 UID），只保留最后一个'))
        }
        byKey.set(it.key, it)
      }
      const items = [...byKey.values()]
        .sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''))
        .map((it) => {
          ledgerKeys.set(it.key, { lk: `calendar:${it.key}`, sha: sha(it.text) })
          return { ...it, state: stateOf(ledger, `calendar:${it.key}`, sha(it.text)) }
        })
      const preview: ConnectorPreview = {
        cancelled: false,
        previewId: id,
        kind,
        fileName,
        items,
        warnings: [...new Set(warnings)],
        totals: { items: items.length, events: parsed.events.length, redactions: items.reduce((a, i) => a + i.redactions, 0) },
        mapping: [CALENDAR_MAPPING.memory, CALENDAR_MAPPING.timeline, ...calendarLimits()]
      }
      holdPreview(id, { preview, events: new Map(), ledgerKeys, itemTags: new Map() })
      return preview
    }
    let parsed: ReturnType<typeof parseHealthFile>
    try {
      parsed = parseHealthFile(text, fileName)
    } catch (e) {
      throw new ConnectorError('unknown', tr(`Cannot read ${fileName}: ${e instanceof Error ? e.message : String(e)}`, `无法读取 ${fileName}：${e instanceof Error ? e.message : String(e)}`))
    }
    if (!parsed.events.length) throw new ConnectorError('unknown', tr(`No importable records found in ${fileName}. ${parsed.warnings.join('; ')}`, `没有在 ${fileName} 里找到可导入的记录。${parsed.warnings.join('；')}`))
    return previewHealthEvents(parsed.events, parsed.warnings, fileName, healthMapping(), (day, list, label) => daySummary(day, list, label))
  }

  async function previewAppleHealth(file: string, fileName: string): Promise<ConnectorPreview> {
    let r: Awaited<ReturnType<typeof parseAppleHealthFile>>
    try {
      r = await parseAppleHealthFile(file)
    } catch (e) {
      if (e instanceof AppleHealthError) throw new ConnectorError(/符号链接|不存在|Symbolic links|does not exist/.test(e.message) ? 'not_found' : 'unknown', tr(`Cannot read ${fileName}: ${e.message}`, `无法读取 ${fileName}：${e.message}`))
      throw new ConnectorError('unknown', tr(`Cannot read ${fileName}: ${e instanceof Error ? e.message : String(e)}`, `无法读取 ${fileName}：${e instanceof Error ? e.message : String(e)}`))
    }
    if (!r.events.length) throw new ConnectorError('unknown', tr(`No supported health records found in ${fileName}. ${r.warnings.join('; ')}`, `没有在 ${fileName} 里找到支持的健康记录。${r.warnings.join('；')}`))
    const warnings = [
      tr(
        `Read ${r.stats.records} records (used ${r.stats.recordsUsed}) and ${r.stats.workouts} workouts, summarized into ${r.events.length} daily records.`,
        `读取 ${r.stats.records} 条记录（使用 ${r.stats.recordsUsed} 条）、${r.stats.workouts} 次体能训练，汇总成 ${r.events.length} 条按天记录。`
      ),
      ...r.warnings
    ]
    return previewHealthEvents(r.events, warnings, fileName, appleHealthMapping(), (day, list, label) => appleHealthDaySummary(day, list, label))
  }

  function previewHealthEvents(
    events: NormalizedHealthEvent[],
    warnings: string[],
    fileName: string,
    mapping: string[],
    summarize: (day: string, list: NormalizedHealthEvent[], fileLabel: string) => string
  ): ConnectorPreview {
    const ledger = readLedger()
    const id = randomBytes(12).toString('hex')
    const byDay = new Map<string, NormalizedHealthEvent[]>()
    const ledgerKeys = new Map<string, { lk: string; sha: string }>()
    let redactions = 0
    const r = (s: string): string => {
      const x = stripSecrets(s)
      redactions += x.redactions
      return x.text
    }
    // Text values / metadata are redacted before they can be written anywhere.
    for (const e of events) {
      const metadata: Record<string, string | number> = {}
      // S1-R3-SEC L3: metadata KEYS (from file headers) are redacted too.
      for (const [k, v] of Object.entries(e.metadata)) metadata[r(k)] = typeof v === 'string' ? r(v) : v
      const red: NormalizedHealthEvent = {
        ...e,
        event_id: safeEventId(e.event_id, r),
        unit: r(e.unit),
        value: typeof e.value === 'string' ? r(e.value) : e.value,
        source: { ...e.source, device: e.source.device ? r(e.source.device) : null },
        metadata
      }
      // S1-R3-SEC L1: push, not array spread (quadratic for 50k same-day events).
      const k = `day:${eventDay(red)}`
      const list = byDay.get(k)
      if (list) list.push(red)
      else byDay.set(k, [red])
    }
    const fileLabel = stripSecrets(fileName).text
    const items: ConnectorItem[] = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, list]) => {
        const day = key.slice(4)
        const text = summarize(day, list, fileLabel)
        const l = healthLedger(day, list)
        ledgerKeys.set(key, l)
        return { key, title: tr(`${day} · ${new Set(list.map((e) => e.metric)).size} metrics`, `${day} · ${new Set(list.map((e) => e.metric)).size} 项指标`), when: day, text, redactions: 0, events: list.length, state: stateOf(ledger, l.lk, l.sha) }
      })
    if (items.length) items[0].redactions = redactions
    const preview: ConnectorPreview = {
      cancelled: false,
      previewId: id,
      kind: 'health',
      fileName,
      items,
      warnings,
      totals: { items: items.length, events: events.length, redactions },
      mapping
    }
    holdPreview(id, { preview, events: byDay, ledgerKeys, itemTags: new Map() })
    return preview
  }

  function previewEmailMessages(
    kind: 'email' | 'imap',
    parsed: { messages: ParsedEmail[]; warnings: string[] },
    label: string,
    sourceLine: string,
    mapping: string[]
  ): ConnectorPreview {
    if (!parsed.messages.length) throw new ConnectorError('unknown', tr(`No importable messages found in ${label}. ${parsed.warnings.join('; ')}`, `没有在 ${label} 里找到可导入的邮件。${parsed.warnings.join('；')}`))
    const ledger = readLedger()
    const id = randomBytes(12).toString('hex')
    const ledgerKeys = new Map<string, { lk: string; sha: string }>()
    const warnings = [...parsed.warnings]
    const byKey = new Map<string, Omit<ConnectorItem, 'state'>>()
    for (const m of parsed.messages) {
      warnings.push(...m.warnings)
      const it = emailItem(m, sourceLine)
      if (byKey.has(it.key)) warnings.push(tr('Duplicate messages (same Message-ID); only the last one is kept', '有重复的邮件（相同 Message-ID），只保留最后一封'))
      byKey.set(it.key, it)
    }
    const items = [...byKey.values()]
      .sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''))
      .map((it) => {
        const l = { lk: `email:${it.key}`, sha: sha(it.text) }
        ledgerKeys.set(it.key, l)
        return { ...it, state: stateOf(ledger, l.lk, l.sha) }
      })
    const preview: ConnectorPreview = {
      cancelled: false,
      previewId: id,
      kind,
      fileName: label,
      items,
      warnings: [...new Set(warnings)],
      totals: { items: items.length, events: parsed.messages.length, redactions: items.reduce((a, i) => a + i.redactions, 0) },
      mapping
    }
    holdPreview(id, { preview, events: new Map(), ledgerKeys, itemTags: new Map() })
    return preview
  }

  // ─── CSV ────────────────────────────────────────────────────────────────

  function csvPreviewFrom(id: string, table: CsvTable, fileName: string, fileLabel: string, mapping: CsvMapping, extraWarnings: string[]): ConnectorPreview {
    const ledger = readLedger()
    const { items: rows, warnings } = csvItems(table, mapping, fileLabel)
    const ledgerKeys = new Map<string, { lk: string; sha: string }>()
    const itemTags = new Map<string, string[]>()
    const items: ConnectorItem[] = rows
      .sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''))
      .map(({ tags, ...it }) => {
        const l = { lk: `csv:${it.key}`, sha: sha(it.text) }
        ledgerKeys.set(it.key, l)
        if (tags.length) itemTags.set(it.key, tags)
        return { ...it, state: stateOf(ledger, l.lk, l.sha) }
      })
    const red = (s: string): string => stripSecrets(s.slice(0, 200)).text
    const preview: ConnectorPreview = {
      cancelled: false,
      previewId: id,
      kind: 'csv',
      fileName,
      items,
      warnings: [...new Set([...extraWarnings, ...warnings])],
      totals: { items: items.length, events: table.rows.length, redactions: items.reduce((a, i) => a + i.redactions, 0) },
      mapping: [CSV_MAPPING.memory, CSV_MAPPING.timeline, ...csvLimits()],
      csv: {
        header: table.header.map(red),
        sample: table.rows.slice(0, 5).map((r) => table.header.map((_, i) => red(r[i] ?? ''))),
        delimiter: (table.delimiter === ';' ? ';' : table.delimiter === '\t' ? '\t' : ',') as ',' | ';' | '\t',
        rows: table.rows.length,
        truncated: table.truncated,
        mapping
      }
    }
    holdPreview(id, { preview, events: new Map(), ledgerKeys, itemTags, csv: { table, fileLabel } })
    return preview
  }

  function previewCsv(text: string, fileName: string): ConnectorPreview {
    const table = parseCsv(text)
    if (!table.header.length || !table.rows.length) throw new ConnectorError('unknown', tr(`${fileName} has no data rows (the first row should be the header).`, `${fileName} 里没有数据行（第一行应为表头）。`))
    const extra: string[] = []
    if (table.truncated) extra.push(tr('The file has more than 100,000 rows; only the first 100,000 were read', '文件超过 100,000 行，只读取了前 100,000 行'))
    const width = table.header.length
    const ragged = table.rows.filter((r) => r.length !== width).length
    if (ragged) extra.push(tr(`${ragged} rows have a column count that differs from the header (missing columns are treated as empty)`, `${ragged} 行的列数与表头不一致（缺的列按空值处理）`))
    const id = randomBytes(12).toString('hex')
    return csvPreviewFrom(id, table, fileName, stripSecrets(fileName).text, guessMapping(table), extra)
  }

  function csvMap(previewId: string, mapping: CsvMapping): ConnectorPreview {
    requireConsent('csv')
    const held = previews.get(previewId)
    if (!held || !held.csv) throw new ConnectorError('not_found', tr('The preview has expired. Pick the CSV file again.', '预览已过期，请重新选择 CSV 文件。'))
    const err = validateMapping(mapping, held.csv.table.header.length)
    if (err) throw new ConnectorError('unknown', err)
    previews.delete(previewId)
    const extra = held.preview.warnings.filter((w) => /100,000|列数与表头|differs from the header/.test(w))
    return csvPreviewFrom(randomBytes(12).toString('hex'), held.csv.table, held.preview.fileName ?? '', held.csv.fileLabel, mapping, extra)
  }

  // ─── IMAP ───────────────────────────────────────────────────────────────

  function imapSave(input: ImapConfigInput): ImapConfigView {
    requireConsent('imap')
    let password = input.password
    if (!password) {
      let prev: ImapCredentials | null = null
      try {
        prev = imapCreds.load()
      } catch {
        prev = null
      }
      if (!prev || !prev.password) throw new ConnectorError('unknown', tr('Enter the app password.', '请填写应用专用密码。'))
      password = prev.password
    }
    try {
      imapCreds.save({ host: input.host.trim().toLowerCase(), port: input.port, user: input.user.trim(), password, mailbox: input.mailbox.trim() || 'INBOX' })
    } catch (e) {
      throw new ConnectorError('unknown', e instanceof Error ? e.message : String(e))
    }
    return imapCreds.view()
  }

  async function previewImap(opts: ImapFetchOptions): Promise<ConnectorPreview> {
    requireConsent('imap')
    if (!deps.imapFetch) throw new ConnectorError('unknown', tr('This build has no IMAP support.', '这个版本没有接入 IMAP。'))
    let cred: ImapCredentials | null
    try {
      cred = imapCreds.load()
    } catch (e) {
      throw new ConnectorError('unknown', e instanceof Error ? e.message : String(e))
    }
    if (!cred) throw new ConnectorError('not_found', tr('IMAP settings have not been entered yet.', '还没有填写 IMAP 设置。'))
    let r: ImapFetchResult
    try {
      r = await deps.imapFetch(cred, { sinceDays: opts.sinceDays, maxMessages: opts.maxMessages, now })
    } catch (e) {
      // ImapError messages are already scrubbed; scrub again against the stored secrets (defence in depth).
      let msg = e instanceof Error ? e.message : String(e)
      for (const s of [cred.password, cred.user]) if (s) msg = msg.split(s).join('[redacted]')
      throw new ConnectorError('unknown', `IMAP：${redactForDisplay(msg).slice(0, 300)}`)
    }
    const messages: ParsedEmail[] = []
    const warnings = [
      tr(
        `${r.found} messages on the server from the last ${opts.sinceDays} days; read ${r.messages.length}.`,
        `服务器上最近 ${opts.sinceDays} 天有 ${r.found} 封，读取了 ${r.messages.length} 封。`
      ),
      ...r.warnings
    ]
    let bad = 0
    for (const m of r.messages) {
      try {
        messages.push(parseEmail(m.raw.toString('latin1')))
      } catch {
        bad++
      }
    }
    if (bad) warnings.push(tr(`Skipped ${bad} unreadable messages`, `${bad} 封邮件无法解析，已跳过`))
    const label = `${cred.mailbox} @ ${cred.host}`
    if (!messages.length) {
      return {
        cancelled: false,
        previewId: null,
        kind: 'imap',
        fileName: label,
        items: [],
        warnings,
        totals: { items: 0, events: 0, redactions: 0 },
        mapping: imapMapping()
      }
    }
    return previewEmailMessages('imap', { messages, warnings }, label, `来源：IMAP 邮箱（只读）${stripSecrets(label).text} · 经 Navalia 连接器导入`, imapMapping())
  }

  // ─── Commit ─────────────────────────────────────────────────────────────

  function parseEntryId(raw: string): string | null {
    try {
      const v = JSON.parse(raw) as { entry_id?: unknown }
      return typeof v.entry_id === 'string' ? v.entry_id : null
    } catch {
      return null
    }
  }

  async function rememberItems(
    kind: ConnectorKind,
    items: ConnectorItem[],
    held: HeldPreview,
    ledger: Ledger,
    out: ConnectorCommitItem[]
  ): Promise<void> {
    const base = `lens-connector,connector:${kind}`
    for (const it of items) {
      const { lk, sha: contentSha } = held.ledgerKeys.get(it.key) ?? { lk: `${kind}:${it.key}`, sha: sha(it.text) }
      const prev = Object.prototype.hasOwnProperty.call(ledger.entries, lk) ? ledger.entries[lk] : undefined
      if (prev && prev.sha256 === contentSha) {
        out.push({ key: it.key, outcome: 'unchanged', detail: null, entryId: prev.entryIds[prev.entryIds.length - 1] ?? null })
        continue
      }
      const content = prev ? `（更新）${it.text}` : it.text
      const extra = held.itemTags.get(it.key) ?? []
      const tags = extra.length ? `${base},${extra.join(',')}` : base
      try {
        const raw = await deps.ossTool('remember', { content, tags })
        const entryId = parseEntryId(raw)
        ledger.entries[lk] = {
          sha256: contentSha,
          at: new Date(now()).toISOString(),
          entryIds: [...(prev?.entryIds ?? []), ...(entryId ? [entryId] : [])],
          connector: kind
        }
        saveLedger(ledger)
        out.push({ key: it.key, outcome: prev ? 'updated' : 'written', detail: prev ? tr('Content changed: appended an "updated" memory; the old entry stays', '内容有变化：已追加一条「更新」记忆，旧条目保留') : null, entryId })
      } catch (e) {
        out.push({ key: it.key, outcome: 'failed', detail: redactForDisplay(e instanceof Error ? e.message : String(e)).slice(0, 300) })
      }
    }
  }

  async function timelineItems(kind: 'calendar' | 'csv', items: ConnectorItem[], ledger: Ledger, out: ConnectorCommitItem[]): Promise<ConnectorCommitResult['cli']> {
    const bin = deps.persomeBin()
    if (!bin) throw new ConnectorError('runtime_missing', tr('The persome CLI was not found, so import-data cannot write. Use "Write to memory" instead.', '没有找到 persome 命令行工具，无法用 import-data 写入。可改用「写入记忆」。'))
    const lkOf = (key: string): string => `${kind}-timeline:${key}`
    const todo = items.filter((it) => {
      const prev = ledger.entries[lkOf(it.key)]
      if (prev && prev.sha256 === sha(it.text)) {
        out.push({ key: it.key, outcome: 'unchanged', detail: null })
        return false
      }
      return true
    })
    if (!todo.length) return null
    // Stable folder + deterministic names → stable upstream source keys (no duplicates on re-run).
    fs.rmSync(sourceDir, { recursive: true, force: true })
    ensureSecureDir(path.join(sourceDir, kind))
    try {
      for (const it of todo) writeFileSecure(path.join(sourceDir, kind, `${it.key}.md`), `# ${it.title}\n\n${it.text}\n`)
      const cli = await runImportCli({ exec, bin, runtimeRoot: deps.runtimeRoot(), stagingDir: sourceDir, build: false, now })
      const ok = cli.exitCode === 0
      for (const it of todo) {
        const prev = ledger.entries[lkOf(it.key)]
        if (ok) ledger.entries[lkOf(it.key)] = { sha256: sha(it.text), at: new Date(now()).toISOString(), entryIds: [], connector: kind, timelineDoc: `${kind}/${it.key}.md` }
        out.push({
          key: it.key,
          outcome: ok ? (prev ? 'updated' : 'written') : 'failed',
          detail: ok
            ? prev
              ? tr('New content at the same path: Runtime updates the source record, but the old timeline blocks stay', '同一路径的新内容：Runtime 更新来源记录，但旧时间线块保留')
              : null
            : tr(`import-data exit code ${cli.exitCode ?? 'none'}`, `import-data 退出码 ${cli.exitCode ?? '无'}`)
        })
      }
      if (ok) saveLedger(ledger)
      return cli
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  }

  async function commit(previewId: string, keys: string[], opts: { target?: CalendarTarget }): Promise<ConnectorCommitResult> {
    const held = previews.get(previewId)
    if (!held) throw new ConnectorError('not_found', tr('The preview has expired. Pick the file again.', '预览已过期，请重新选择文件。'))
    const kind = held.preview.kind
    // C19: consent is checked again at write time — revoking after the preview blocks the import.
    requireConsent(consentKindOf(kind))
    const want = new Set(keys)
    const items = held.preview.items.filter((i) => want.has(i.key))
    if (!items.length) throw new ConnectorError('unknown', tr('Select at least one item.', '请至少选择一项。'))
    const unknown = keys.filter((k) => !held.preview.items.some((i) => i.key === k))
    if (unknown.length) throw new ConnectorError('not_found', tr(`These items are not in the preview: ${unknown.slice(0, 3).join(', ')}`, `预览里没有这些项：${unknown.slice(0, 3).join(', ')}`))
    ensureSecureDir(root)
    const ledger = readLedger()
    const out: ConnectorCommitItem[] = []
    const notes: string[] = []
    let health: ConnectorCommitResult['health'] = null
    let cli: ConnectorCommitResult['cli'] = null
    let target: ConnectorCommitResult['target']

    if (kind === 'calendar' || kind === 'csv') {
      target = opts.target ?? 'memory'
      if (target === 'timeline') {
        cli = await timelineItems(kind, items, ledger, out)
        notes.push(tr('Written to the timeline (--no-build): it needs a model build to show up in memory search; Navalia never starts one by itself.', '已写入时间线（--no-build）：要出现在记忆搜索里需要一次模型构建；Navalia 不会自动构建。'))
      } else {
        await rememberItems(kind, items, held, ledger, out)
      }
    } else if (kind === 'email' || kind === 'imap') {
      target = kind
      await rememberItems(kind, items, held, ledger, out)
    } else {
      target = 'health'
      health = { received: 0, inserted: 0, corrected: 0, duplicates: 0 }
      const done: ConnectorItem[] = []
      // Batches span days; a day counts as written once its last event is in a successful batch.
      const perItem = items.map((it) => ({ it, events: held.events.get(it.key) ?? [] }))
      const flat = perItem.flatMap((p, idx) => p.events.map((e) => ({ e, idx })))
      const lastIndex = new Map<number, number>()
      flat.forEach((f, i) => lastIndex.set(f.idx, i))
      const markDone = (posted: number): void => {
        for (let idx = 0; idx < perItem.length; idx++) {
          const p = perItem[idx]
          if (done.includes(p.it)) continue
          const last = lastIndex.get(idx)
          if (last !== undefined && last >= posted) continue
          // C19: remember which structured events this day wrote, so they can be deleted later.
          const lk = held.ledgerKeys.get(p.it.key)?.lk
          if (lk && p.events.length) {
            ledger.health = ledger.health ?? {}
            ledger.health[lk] = { provider: p.events[0].source.provider, ids: [...new Set(p.events.map((e) => e.event_id))], at: new Date(now()).toISOString() }
          }
          done.push(p.it)
        }
      }
      try {
        for (let i = 0; i < flat.length; i += HEALTH_BATCH) {
          const res = (await deps.postRuntime('/health-events/import', { schema_version: 1, events: flat.slice(i, i + HEALTH_BATCH).map((f) => f.e) })) as {
            data?: Record<string, unknown>
          }
          const d = res?.data ?? {}
          for (const k of ['received', 'inserted', 'corrected', 'duplicates'] as const) health[k] += typeof d[k] === 'number' ? (d[k] as number) : 0
          markDone(Math.min(i + HEALTH_BATCH, flat.length))
        }
        markDone(flat.length)
        saveLedger(ledger)
      } catch (e) {
        saveLedger(ledger)
        const msg = redactForDisplay(e instanceof Error ? e.message : String(e)).slice(0, 300)
        for (const it of items.filter((x) => !done.includes(x))) out.push({ key: it.key, outcome: 'failed', detail: tr(`Structured write failed: ${msg}`, `结构化写入失败：${msg}`) })
        notes.push(tr(`/health-events/import failed (batches already written stay; retrying is idempotent): ${msg}`, `/health-events/import 失败（已写入的批次保留；重试是幂等的）：${msg}`))
        if (done.length) await rememberItems('health', done, held, ledger, out)
        return summarize(kind, target, out, health, cli, notes)
      }
      notes.push(
        tr(
          `Structured records: received ${health.received}, inserted ${health.inserted}, corrected ${health.corrected}, duplicates ${health.duplicates}.`,
          `结构化记录：收到 ${health.received}，新增 ${health.inserted}，更正 ${health.corrected}，重复 ${health.duplicates}。`
        )
      )
      await rememberItems('health', items, held, ledger, out)
    }
    return summarize(kind, target, out, health, cli, notes)
  }

  function summarize(
    kind: ConnectorKind,
    target: ConnectorCommitResult['target'],
    items: ConnectorCommitItem[],
    health: ConnectorCommitResult['health'],
    cli: ConnectorCommitResult['cli'],
    notes: string[]
  ): ConnectorCommitResult {
    const n = (o: ConnectorCommitItem['outcome']): number => items.filter((i) => i.outcome === o).length
    return { kind, target, written: n('written'), updated: n('updated'), unchanged: n('unchanged'), failed: n('failed'), items, health, cli, notes }
  }

  // ─── Ledger view + deletion ─────────────────────────────────────────────

  function ledgerView(): LedgerView {
    const ledger = readLedger()
    const by = new Map<ConnectorKind, LedgerConnectorView>()
    const get = (k: ConnectorKind): LedgerConnectorView => {
      let v = by.get(k)
      if (!v) {
        v = { kind: k, items: 0, memoryEntries: 0, memoryWithoutId: 0, healthEvents: 0, timelineDocs: 0, lastAt: null }
        by.set(k, v)
      }
      return v
    }
    const touch = (v: LedgerConnectorView, at: string): void => {
      if (!v.lastAt || at > v.lastAt) v.lastAt = at
    }
    for (const [lk, e] of Object.entries(ledger.entries)) {
      const o = ledgerOwner(lk, e)
      if (!o) continue
      const v = get(o.kind)
      v.items++
      touch(v, e.at)
      if (o.timeline) v.timelineDocs++
      else if (e.entryIds.length) v.memoryEntries += e.entryIds.length
      else v.memoryWithoutId++
    }
    for (const h of Object.values(ledger.health ?? {})) {
      const v = get('health')
      v.healthEvents += h.ids.length
      touch(v, h.at)
    }
    return { connectors: [...by.values()].sort((a, b) => a.kind.localeCompare(b.kind)) }
  }

  const RETIRE_REASONS: Record<string, string> = {
    get unknown_point() {
      return tr(
        'Runtime cannot find the model entry for this memory: when Runtime write authority is markdown (the default), entries written by remember live only in the Markdown file, and /model/edit cannot delete them one by one.',
        'Runtime 找不到这条记忆对应的模型条目：Runtime 的写入权限为 markdown（默认）时，remember 写入的条目只在 Markdown 文件里，/model/edit 不能按条目删除。'
      )
    },
    get point_not_editable_in_this_file() {
      return tr('Runtime does not allow deleting single entries in this file.', 'Runtime 不允许在这个文件里按条目删除。')
    },
    get point_file_missing() {
      return tr('Runtime cannot find the file that holds this memory.', 'Runtime 找不到这条记忆所在的文件。')
    },
    get point_archived() {
      return tr('Runtime has archived this memory; it can no longer be deleted as a single entry.', '这条记忆已被 Runtime 归档，不能再按条目删除。')
    }
  }

  async function deleteImported(kind: ConnectorKind): Promise<DeleteImportedResult> {
    const ledger = readLedger()
    const notes: string[] = []
    const remaining: DeleteRemaining[] = []
    let memoryRetired = 0
    let healthDeleted = 0
    let runtimeDown: string | null = null
    const failedIds = new Map<string, string[]>() // reason → ids
    let withoutId = 0
    const timelineDocs: string[] = []
    const reasonText = (e: unknown): { key: string; text: string; down: boolean } => {
      if (e instanceof ConnectorError && e.code === 'runtime_missing') return { key: 'runtime_down', text: tr('Runtime is not running (cannot reach 127.0.0.1).', 'Runtime 没有运行（连不上 127.0.0.1）。'), down: true }
      const msg = e instanceof Error ? e.message : String(e)
      const m = /Runtime (?:返回|returned) (\d+)(?:：|: )(\w+)/.exec(msg)
      if (m && RETIRE_REASONS[m[2]]) return { key: m[2], text: RETIRE_REASONS[m[2]], down: false }
      return { key: 'other', text: tr(`Runtime refused the deletion: ${redactForDisplay(msg).slice(0, 200)}`, `Runtime 拒绝了删除：${redactForDisplay(msg).slice(0, 200)}`), down: false }
    }
    const reasonOf = new Map<string, string>()
    let memoryErased = 0
    let memoryMissing = 0
    let timelineDeleted = 0
    const timelineLeft: Array<{ lk: string; doc: string }> = []
    let timelineReason: { text: string; how: string[] } | null = null

    // R10 Runtime (build 7066066+): per-item erase. `null` = not tried yet, `false` = route absent
    // (older Runtime → fall back to /model/edit retire for memory; timeline docs stay listed).
    let r10 = null as boolean | null
    const isNotFound = (err: unknown): boolean => /Runtime (?:返回 404：|returned 404: )not_found$/.test(err instanceof Error ? err.message : '')
    const isRouteMissing = (err: unknown): boolean => !isNotFound(err) && /Runtime (?:返回|returned) 40[45]/.test(err instanceof Error ? err.message : '')

    const memoryRows: Array<[string, LedgerEntry]> = []
    for (const [lk, e] of Object.entries(ledger.entries)) {
      const o = ledgerOwner(lk, e)
      if (!o || o.kind !== kind) continue
      if (o.timeline) {
        timelineDocs.push(e.timelineDoc ?? lk.slice(lk.indexOf(':') + 1))
        timelineLeft.push({ lk, doc: e.timelineDoc ?? lk.slice(lk.indexOf(':') + 1) })
        continue
      }
      if (!e.entryIds.length) {
        withoutId++
        continue
      }
      memoryRows.push([lk, e])
    }

    // 1) R10 erase, batched. Outcome per id: gone (erased / already / missing) or a failure key.
    const gone = new Set<string>()
    const retireInstead = new Set<string>()
    const allIds = [...new Set(memoryRows.flatMap(([, e]) => e.entryIds))]
    for (let i = 0; i < allIds.length && r10 !== false && !runtimeDown; i += OWNER_DELETE_MAX_IDS) {
      const batch = allIds.slice(i, i + OWNER_DELETE_MAX_IDS)
      try {
        const res = parseOwnerDeleteResult(await deps.postRuntime('/memory/entries/delete', { schema_version: 1, entry_ids: batch }))
        if (!res) throw new ConnectorError('unknown', tr('Runtime returned data in an unexpected format', 'Runtime 返回的数据格式与预期不符'))
        r10 = true
        for (const id of [...res.deleted_ids, ...res.already_deleted]) gone.add(id)
        memoryErased += res.deleted_ids.length + res.already_deleted.length
        for (const id of res.missing) {
          gone.add(id)
          memoryMissing++
        }
        for (const ref of res.refused) {
          // evomem write authority: the R10 erase route stands down; /model/edit retire handles it.
          if (ref.reason === 'evomem_authority') {
            retireInstead.add(ref.id)
            continue
          }
          const key = `refused:${ref.reason}`
          reasonOf.set(key, refusalText(ref.reason))
          failedIds.set(key, [...(failedIds.get(key) ?? []), ref.id])
        }
      } catch (err) {
        if (isNotFound(err)) {
          r10 = true
          for (const id of batch) gone.add(id)
          memoryMissing += batch.length
          continue
        }
        if (isRouteMissing(err)) {
          r10 = false
          break
        }
        const r = reasonText(err)
        if (r.down) runtimeDown = r.text
        reasonOf.set(r.key, r.text)
        failedIds.set(r.key, [...(failedIds.get(r.key) ?? []), ...batch])
      }
    }
    const failedSet = new Set([...failedIds.values()].flat())

    // 2) Older Runtime: /model/edit retire per id (unchanged behaviour).
    for (const [lk, e] of memoryRows) {
      const left: string[] = []
      for (const id of e.entryIds) {
        if (gone.has(id)) continue
        if ((r10 !== false && !retireInstead.has(id)) || runtimeDown) {
          left.push(id)
          if (runtimeDown && !failedSet.has(id)) {
            reasonOf.set('runtime_down', runtimeDown)
            failedIds.set('runtime_down', [...(failedIds.get('runtime_down') ?? []), id])
          }
          continue
        }
        try {
          await deps.postRuntime('/model/edit', { schema_version: 1, kind: 'point', id, op: 'retire', reason: `Navalia: owner deleted data imported by the ${kind} connector` })
          memoryRetired++
        } catch (err) {
          const r = reasonText(err)
          // Already retired (e.g. a second delete run, or the owner retired it elsewhere) = gone.
          if (/point_already_retired/.test(err instanceof Error ? err.message : '')) {
            memoryRetired++
            continue
          }
          if (r.down) runtimeDown = r.text
          left.push(id)
          reasonOf.set(r.key, r.text)
          failedIds.set(r.key, [...(failedIds.get(r.key) ?? []), id])
        }
      }
      if (left.length) ledger.entries[lk] = { ...e, entryIds: left }
      else delete ledger.entries[lk]
    }

    // 3) Timeline documents (import-data): R10 `/imports/delete` by the Runtime's source key, which
    // `source_import.import_folder` derives as sha256("folder\0<resolved staging root>\0<relative>").
    if (timelineLeft.length && r10 !== false && !runtimeDown) {
      let resolvedSource = sourceDir
      try {
        resolvedSource = path.join(fs.realpathSync(root), 'source')
      } catch {
        /* keep the unresolved path */
      }
      const keyOf = new Map(timelineLeft.map((t) => [createHash('sha256').update(`folder\u0000${resolvedSource}\u0000${t.doc}`).digest('hex'), t]))
      const keys = [...keyOf.keys()]
      const deletedKeys = new Set<string>()
      const missingKeys = new Set<string>()
      for (let i = 0; i < keys.length; i += OWNER_DELETE_MAX_IDS) {
        const batch = keys.slice(i, i + OWNER_DELETE_MAX_IDS)
        try {
          const res = parseOwnerDeleteResult(await deps.postRuntime('/imports/delete', { schema_version: 1, by: 'source_key', ids: batch }))
          if (!res) throw new ConnectorError('unknown', tr('Runtime returned data in an unexpected format', 'Runtime 返回的数据格式与预期不符'))
          for (const k of [...res.deleted_ids, ...res.already_deleted]) deletedKeys.add(k)
          for (const k of res.missing) missingKeys.add(k)
        } catch (err) {
          if (isNotFound(err)) {
            for (const k of batch) missingKeys.add(k)
            continue
          }
          if (isRouteMissing(err)) {
            r10 = false
            break
          }
          const r = reasonText(err)
          if (r.down) runtimeDown = r.text
          timelineReason = { text: r.text, how: [tr('Start Runtime, then click "Delete" here again; deletion is by source and safe to repeat.', '启动 Runtime 后在这里再点一次「删除」；按来源删除，重复执行是安全的。')] }
          break
        }
      }
      for (const [k, t] of keyOf) {
        if (!deletedKeys.has(k)) continue
        delete ledger.entries[t.lk]
        timelineDeleted++
      }
      timelineDocs.splice(0, timelineDocs.length, ...[...keyOf].filter(([k]) => !deletedKeys.has(k)).map(([, t]) => t.doc))
      if (missingKeys.size && !timelineReason)
        timelineReason = {
          text: tr(
            'Runtime did not find these timeline documents (perhaps already cleared with "Delete timeline", or Navalia used a different data folder at import time).',
            'Runtime 里没有找到这些时间线文档（可能已用「删除时间线」清空，或导入时 Navalia 的数据目录不同）。'
          ),
          how: [
            tr(
              'If you have already cleared the timeline, these documents are no longer in Runtime; Navalia keeps these records so you can check them. Document names are below.',
              '如果你已经清空过时间线，这些文档已经不在 Runtime 里；Navalia 保留这些记录方便你核对，文档名见下方。'
            )
          ]
        }
    }

    if (kind === 'health' && ledger.health) {
      const all = Object.entries(ledger.health)
      const byProvider = new Map<string, Array<[string, HealthLedger]>>()
      for (const [lk, h] of all) byProvider.set(h.provider, [...(byProvider.get(h.provider) ?? []), [lk, h]])
      let healthLeft = 0
      let healthReason: string | null = null
      for (const [provider, list] of byProvider) {
        const pairs = list.flatMap(([, h]) => h.ids.map((id) => ({ event_id: id, provider })))
        let ok = !runtimeDown
        if (runtimeDown) healthReason = runtimeDown
        for (let i = 0; ok && i < pairs.length; i += HEALTH_DELETE_BATCH) {
          try {
            const res = (await deps.postRuntime('/health-events/import', { schema_version: 1, deleted_events: pairs.slice(i, i + HEALTH_DELETE_BATCH) })) as { data?: { deleted?: unknown } }
            healthDeleted += typeof res?.data?.deleted === 'number' ? res.data.deleted : 0
          } catch (err) {
            const r = reasonText(err)
            healthReason = r.text
            if (r.down) runtimeDown = r.text
            ok = false
          }
        }
        if (ok) for (const [lk] of list) delete ledger.health[lk]
        else healthLeft += pairs.length
      }
      if (healthLeft) {
        remaining.push({
          what: 'health',
          count: healthLeft,
          reason: healthReason ?? tr('The deletion did not finish.', '删除没有完成。'),
          how: [tr('Start Runtime, then click "Delete" here again; deletion is by provider + event_id and safe to repeat.', '启动 Runtime 后在这里再点一次「删除」；删除按 provider + event_id 进行，重复执行是安全的。')],
          ids: []
        })
      }
      notes.push(tr(`Structured health records: Runtime deleted ${healthDeleted} (records that did not exist are not counted).`, `结构化健康记录：Runtime 删除了 ${healthDeleted} 条（不存在的记录不计数）。`))
    }

    for (const [key, ids] of failedIds) {
      remaining.push({
        what: 'memory',
        count: ids.length,
        reason: reasonOf.get(key) ?? tr('The deletion did not finish.', '删除没有完成。'),
        how:
          key === 'runtime_down'
            ? [tr('Start Runtime, then click "Delete" here again.', '启动 Runtime 后在这里再点一次「删除」。')]
            : key.startsWith('refused:')
              ? [
                tr(
                  'Runtime refused to delete these entries one by one; entry ids are below. You can look them up in Search, or use "Delete memory" under "Settings → Privacy" (clears all memory).',
                  'Runtime 拒绝按条删除这些条目，条目 id 见下方；可在「搜索」里查看，或在「设置 → 隐私」里「删除记忆」（会清空全部记忆）。'
                )
              ]
              : [
                tr(
                  'These entries are in the Runtime memory file topic-agent-findings.md (where remember writes); entry ids are below. You can delete them by hand and then run `persome rebuild-index` (Navalia has not verified this path and will not edit Runtime files for you).',
                  '这些条目在 Runtime 记忆文件 topic-agent-findings.md 里（remember 写入的位置），条目 id 见下方。可以手动删除这些条目后运行 `persome rebuild-index`（Navalia 没有验证这一路径，也不会替你编辑 Runtime 文件）。'
                ),
                tr(
                  'Or use "Delete memory" under "Settings → Privacy" (persome clean memory): it clears all memory, not just imported entries.',
                  '或在「设置 → 隐私」里「删除记忆」（persome clean memory）：会清空全部记忆，不只是导入的。'
                ),
                tr(
                  'When Runtime has [evomem] write_authority = "evomem", Navalia can delete single entries (POST /model/edit retire).',
                  'Runtime 的 [evomem] write_authority = "evomem" 时，Navalia 可以按条目删除（POST /model/edit retire）。'
                )
              ],
        ids: ids.slice(0, MAX_REMAINING_IDS)
      })
    }
    if (withoutId) {
      remaining.push({
        what: 'memory',
        count: withoutId,
        reason: tr('Runtime returned no entry id at write time, so Navalia cannot locate these memories.', '写入时 Runtime 没有返回条目 id，Navalia 无法定位这些记忆。'),
        how: [
          tr(
            `Find them in Search by the tag connector:${kind} or by title; they can only be deleted by hand in Runtime, or by clearing all memory with "Settings → Privacy → Delete memory".`,
            '在「搜索」里按标签 connector:' + kind + ' 或标题查找；只能在 Runtime 里手动删除，或用「设置 → 隐私 → 删除记忆」清空全部记忆。'
          )
        ],
        ids: []
      })
    }
    if (timelineDocs.length) {
      remaining.push({
        what: 'timeline',
        count: timelineDocs.length,
        reason:
          timelineReason?.text ??
          tr(
            'Runtime has no API to delete timeline documents by source (needs Runtime R10 or newer; older import-data only appends / updates).',
            'Runtime 没有按来源删除时间线文档的接口（需要 R10 或更新的 Runtime；旧版 import-data 只追加 / 更新）。'
          ),
        how: timelineReason?.how ?? [
          tr('"Settings → Privacy → Delete timeline" (persome clean timeline) clears the whole timeline, not just imported documents.', '「设置 → 隐私 → 删除时间线」（persome clean timeline）会清空全部时间线，不只是导入的。'),
          tr('Navalia keeps these records so you can check them; document names are below.', 'Navalia 保留这些记录，方便你核对；文档名见下方。')
        ],
        ids: timelineDocs.slice(0, MAX_REMAINING_IDS)
      })
    }
    if (memoryErased) notes.push(
        tr(
          `Memory: Runtime deleted ${memoryErased} entries (removed from the memory file, search index and model; the Runtime audit keeps only entry ids and counts).`,
          `记忆：Runtime 删除了 ${memoryErased} 条（从记忆文件、搜索索引和模型里移除；Runtime 审计只记录条目 id 和数量）。`
        )
      )
    if (memoryMissing) notes.push(
        tr(
          `Memory: ${memoryMissing} entries no longer exist in Runtime (for example, memory was cleared earlier) and were removed from the Navalia ledger.`,
          `记忆：${memoryMissing} 条在 Runtime 里已经不存在（例如之前清空过记忆），已从 Navalia 账本移除。`
        )
      )
    if (timelineDeleted) notes.push(
        tr(
          `Timeline: Runtime deleted ${timelineDeleted} imported documents (source records, sessions and timeline blocks); memories Runtime already derived from them are not deleted.`,
          `时间线：Runtime 删除了 ${timelineDeleted} 个导入文档（来源记录、会话和时间线块）；Runtime 已经据此生成的记忆不会随之删除。`
        )
      )
    if (memoryRetired) notes.push(
        tr(
          `Memory: Runtime retired ${memoryRetired} entries; retired entries no longer appear in search, and the Runtime audit record stays.`,
          `记忆：Runtime 撤回（retire）了 ${memoryRetired} 条；撤回的条目不再出现在搜索里，Runtime 的审计记录保留。`
        )
      )
    saveLedger(ledger)
    return { kind, memoryRetired, memoryErased, timelineDeleted, healthDeleted, remaining, notes }
  }

  return {
    previewFile: (kind: ConnectorKind, file: string) => exclusive(() => previewFile(kind, file)),
    commit: (previewId: string, keys: string[], opts: { target?: CalendarTarget } = {}) => exclusive(() => commit(previewId, keys, opts)),
    discard: (previewId: string) => ({ discarded: previews.delete(previewId) }),
    csvMap: (previewId: string, mapping: CsvMapping) => csvMap(previewId, mapping),
    imapStatus: (): ImapConfigView => imapCreds.view(),
    imapSave: (input: ImapConfigInput) => imapSave(input),
    imapClear: (): ImapConfigView => {
      imapCreds.clear()
      return imapCreds.view()
    },
    imapFetch: (opts: ImapFetchOptions) => exclusive(() => previewImap(opts)),
    consent: {
      list: () => consent.list(),
      get: (k: ConsentKind) => consent.get(k),
      grant: (k: ConsentKind) => consent.grant(k),
      revoke: (k: ConsentKind) => {
        const v = consent.revoke(k)
        // Revoking IMAP consent also removes the stored credentials (nothing secret left at rest).
        if (k === 'imap') imapCreds.clear()
        // Held previews of that kind can no longer be committed anyway; drop them.
        for (const [id, h] of previews) if (consentKindOf(h.preview.kind) === k) previews.delete(id)
        return v
      },
      require: requireConsent
    },
    ledger: () => ledgerView(),
    deleteImported: (kind: ConnectorKind) => exclusive(() => deleteImported(kind)),
    paths: { root, ledgerPath, sourceDir, consentPath: consent.path, imapPath: imapCreds.path }
  }
}

export type ConnectorService = ReturnType<typeof createConnectorService>
