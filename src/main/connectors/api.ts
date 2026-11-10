// Typed renderer API fragment for local connectors (S1-R3-07, S1-R4-07, S1-FULL C19).
// Types + constants only (renderer-safe): no node imports.
import type { LensResult } from '../../shared/types'
import type { CliOutcome } from '../import/api'
import { tr } from '../../shared/i18n'

export const CONNECTOR_CHANNELS = {
  pick: 'lens:connectors:pick',
  commit: 'lens:connectors:commit',
  discard: 'lens:connectors:discard',
  // C19
  consentStatus: 'lens:connectors:consent-status',
  consentGrant: 'lens:connectors:consent-grant',
  consentRevoke: 'lens:connectors:consent-revoke',
  csvMap: 'lens:connectors:csv-map',
  imapStatus: 'lens:connectors:imap-status',
  imapSave: 'lens:connectors:imap-save',
  imapClear: 'lens:connectors:imap-clear',
  imapFetch: 'lens:connectors:imap-fetch',
  ledger: 'lens:connectors:ledger',
  deleteImported: 'lens:connectors:delete-imported'
} as const

/**
 * Connector kinds. File-based: `calendar` (.ics), `health` (CSV / JSON / Apple Health export.xml / .zip),
 * `email` (.eml / mbox), `csv` (generic CSV with a user column mapping). Network: `imap` (read-only,
 * implicit TLS, app password; the only connector that opens a socket — `src/main/connectors/imap/**`).
 * No OAuth (Google / Notion are BLOCKED: no client ids).
 */
export type ConnectorKind = 'calendar' | 'health' | 'email' | 'csv' | 'imap'

/** Consent is recorded per connector kind (C19). `email-file` is the .eml / mbox file connector. */
export type ConsentKind = 'calendar' | 'health' | 'email-file' | 'imap' | 'csv'
export const CONSENT_KINDS: readonly ConsentKind[] = ['calendar', 'health', 'email-file', 'imap', 'csv']

export function consentKindOf(kind: ConnectorKind): ConsentKind {
  return kind === 'email' ? 'email-file' : kind
}

/** Bumped when a consent text changes materially: older grants then no longer count. */
export const CONSENT_TEXT_VERSION = 1

export interface ConsentText {
  kind: ConsentKind
  title: string
  /** What the connector reads. */
  reads: string[]
  /** Where it writes. */
  writes: string[]
  /** Other facts the user should know before agreeing (network, storage of secrets, deletion). */
  notes: string[]
}

export const CONSENT_TEXT: Record<ConsentKind, ConsentText> = {
  calendar: {
    kind: 'calendar',
    get title() { return tr('Calendar (.ics file)', '日历（.ics 文件）') },
    get reads() { return [tr('Reads only the local .ics file you pick in the system dialog. Signs in to no calendar account and never goes online.', '只读你在系统对话框里选中的本地 .ics 文件。不登录任何日历账号，不联网。')] },
    get writes() { return [tr('Runtime memory (MCP remember, one entry per event), or the timeline if you choose it (persome import-data --no-build).', 'Runtime 记忆（MCP remember，每个事件一条），或你选择的时间线（persome import-data --no-build）。')] },
    get notes() {
      return [
        tr('Only the attendee count is kept; title, location and description are redacted before writing.', '参会人只记人数；标题 / 地点 / 说明先脱敏再写入。'),
        tr('After you revoke consent, no more imports are possible; imported content can be deleted under "Imported data".', '撤销同意后不能再导入；已导入的内容可在「已导入的数据」里删除。')
      ]
    }
  },
  health: {
    kind: 'health',
    get title() { return tr('Health / workouts (CSV / JSON / Apple Health export)', '健康 / 训练（CSV / JSON / Apple Health 导出）') },
    get reads() {
      return [
        tr(
          'Reads only the local CSV / JSON file you pick, or the export.xml / export.zip from the iPhone Health app (streamed, never loaded into memory whole).',
          '只读你选中的本地 CSV / JSON 文件，或 iPhone「健康」App 导出的 export.xml / 导出.zip（流式读取，不整体载入内存）。'
        )
      ]
    },
    get writes() {
      return [
        tr(
          'Runtime structured health records (POST /health-events/import, local 127.0.0.1) plus one searchable summary per day (MCP remember).',
          'Runtime 结构化健康记录（POST /health-events/import，本机 127.0.0.1）+ 每天一条可搜索摘要（MCP remember）。'
        )
      ]
    },
    get notes() {
      return [
        tr('Writes only daily totals of raw device values. No medical judgment.', '只写原始设备数值的按天汇总，不做医学判断。'),
        tr(
          'From Apple Health, only common types (steps, heart rate, sleep, active energy and the like) and workouts are read; other types are skipped and listed in the preview.',
          'Apple Health 只读步数、心率、睡眠、活动能量等常见类型和体能训练，其他类型跳过并在预览里列出。'
        )
      ]
    }
  },
  'email-file': {
    kind: 'email-file',
    get title() { return tr('Email files (.eml / mbox)', '邮件文件（.eml / mbox）') },
    get reads() { return [tr('Reads only the local .eml / mbox file you pick. Attachment content is never read; only file names are kept.', '只读你选中的本地 .eml / mbox 文件。附件内容从不读取，只记文件名。')] },
    get writes() { return [tr('Runtime memory (MCP remember, one entry per message).', 'Runtime 记忆（MCP remember，每封邮件一条）。')] },
    get notes() { return [tr('Email addresses, tokens, phone numbers and similar are redacted before the preview.', '邮箱地址、令牌、电话等在预览前就已脱敏。')] }
  },
  imap: {
    kind: 'imap',
    get title() { return tr('IMAP mailbox (app password, read-only)', 'IMAP 邮箱（应用专用密码，只读）') },
    get reads() {
      return [
        tr(
          'Signs in to IMAP with the server, account and app password you enter (TLS only, default port 993; no plaintext, no STARTTLS).',
          '用你填写的服务器、账号和「应用专用密码」登录 IMAP（只用 TLS，默认端口 993；不支持明文和 STARTTLS）。'
        ),
        tr(
          'Opens only the one mailbox you name, with EXAMINE (read-only), and reads at most M messages from the last N days (BODY.PEEK: never marks as read, deletes, moves or sends).',
          '只用 EXAMINE（只读）打开你指定的一个邮箱，读取最近 N 天、最多 M 封邮件（BODY.PEEK，不标记已读，不删除、不移动、不发信）。'
        )
      ]
    },
    get writes() {
      return [tr('After you confirm the preview, writes to Runtime memory (MCP remember, one entry per message, tag connector:imap).', '预览确认后写入 Runtime 记忆（MCP remember，每封邮件一条，标签 connector:imap）。')]
    },
    get notes() {
      return [
        tr('This is the only connector that goes online: it connects only to the mail server you enter.', '这是唯一会联网的连接器：只连你填写的那台邮件服务器。'),
        tr(
          'Server, account and password are encrypted with the macOS Keychain (Electron safeStorage) and kept in the local Navalia Store. They are never sent to the UI or logged.',
          '服务器、账号和密码用 macOS 钥匙串（Electron safeStorage）加密后存在本机 Navalia Store，不会发给界面，不写日志。'
        ),
        tr('Revoking consent also clears the saved IMAP credentials.', '撤销同意会同时清除保存的 IMAP 凭据。')
      ]
    }
  },
  csv: {
    kind: 'csv',
    get title() { return tr('Generic CSV', '通用 CSV') },
    get reads() { return [tr('Reads only the local CSV file you pick; you choose the date / title / body / tag columns in the preview.', '只读你选中的本地 CSV 文件；你在预览里指定日期 / 标题 / 正文 / 标签列。')] },
    get writes() { return [tr('Runtime memory (MCP remember, one entry per row, tag connector:csv), or the timeline (persome import-data --no-build).', 'Runtime 记忆（MCP remember，每行一条，标签 connector:csv），或时间线（persome import-data --no-build）。')] },
    get notes() { return [tr('Each row is redacted before writing; unmapped columns are never written.', '每行先脱敏再写入；没有映射到的列不会写入。')] }
  }
}

/**
 * Where a calendar / CSV import is written:
 *   - `memory`   → Runtime MCP `remember` (one entry per event / row; searchable immediately; upstream
 *                  force-tags entries `source:agent-run`, Lens adds `lens-connector`, `connector:<kind>`);
 *   - `timeline` → `persome import-data --source folder --no-build` (timeline only; appears in memory
 *                  search only after a model build, which Lens never starts by itself — X5).
 * Health always goes to `POST /health-events/import` (structured) plus one `remember` summary per day.
 * Email / IMAP always go to MCP `remember`, one entry per message.
 */
export type CalendarTarget = 'memory' | 'timeline'

export interface ConnectorItem {
  /** Stable item key (calendar: `ev-…`; health: `day:<YYYY-MM-DD>`; email / imap: `mail-…`; csv: `row-…`). */
  key: string
  title: string
  /** Display time (calendar start; health day). */
  when: string | null
  /** Exactly the redacted text that will be written. */
  text: string
  redactions: number
  /** `unchanged`: already written with identical text; `changed`: written before with different text. */
  state: 'new' | 'unchanged' | 'changed'
  /** Health: number of structured observations behind this day. */
  events?: number
  /** Email: attachment count (names only appear in `text`; attachment content is never read). */
  attachments?: number
}

/** C19 generic CSV: column indexes chosen by the user (null = not mapped). */
export interface CsvMapping {
  date: number | null
  title: number | null
  body: number[]
  tags: number | null
}

export interface CsvPreviewInfo {
  /** Redacted header cells. */
  header: string[]
  /** First rows (redacted), for choosing the mapping. */
  sample: string[][]
  delimiter: ',' | ';' | '\t'
  rows: number
  truncated: boolean
  mapping: CsvMapping
}

export interface ConnectorPreview {
  cancelled: boolean
  previewId: string | null
  kind: ConnectorKind
  /** File name only (never the full path); IMAP: `<mailbox> @ <host>`. */
  fileName: string | null
  items: ConnectorItem[]
  warnings: string[]
  totals: { items: number; events: number; redactions: number }
  /** Honest description of the upstream mapping and its limits for this kind. */
  mapping: string[]
  /** CSV only: header, sample and the current column mapping. */
  csv?: CsvPreviewInfo
}

export interface ConnectorCommitItem {
  key: string
  outcome: 'written' | 'updated' | 'unchanged' | 'failed'
  detail: string | null
  /** Runtime entry id returned by `remember`, when applicable. */
  entryId?: string | null
}

export interface ConnectorCommitResult {
  kind: ConnectorKind
  target: CalendarTarget | 'health' | 'email' | 'imap'
  written: number
  updated: number
  unchanged: number
  failed: number
  items: ConnectorCommitItem[]
  /** Health: Runtime receipt of `/health-events/import` (summed over batches). */
  health: { received: number; inserted: number; corrected: number; duplicates: number } | null
  /** Calendar / CSV `timeline`: the import-data outcome. */
  cli: CliOutcome | null
  notes: string[]
}

export interface ConsentView {
  kind: ConsentKind
  text: ConsentText
  granted: boolean
  grantedAt: string | null
  revokedAt: string | null
}

/** IMAP settings as the renderer may see them. The password never crosses IPC back to the renderer. */
export interface ImapConfigView {
  configured: boolean
  /** safeStorage usable on this machine (false → settings cannot be saved). */
  encryptionAvailable: boolean
  host: string | null
  port: number | null
  /** e.g. `al***@example.com`. */
  userMasked: string | null
  mailbox: string | null
  hasPassword: boolean
}

export interface ImapConfigInput {
  host: string
  port: number
  user: string
  /** App password. Empty string → keep the stored one (only when one is stored). */
  password: string
  mailbox: string
}

export interface ImapFetchOptions {
  /** Messages received in the last N days (IMAP SEARCH SINCE). */
  sinceDays: number
  /** Newest M messages at most. */
  maxMessages: number
}

/** What Lens has written for one connector, from its local ledger. */
export interface LedgerConnectorView {
  kind: ConnectorKind
  /** Items (events / days / messages / rows) the ledger knows about. */
  items: number
  /** Runtime memory entry ids from `remember` (retire-able through the Runtime when it supports it). */
  memoryEntries: number
  /** Items written with `remember` whose entry id the Runtime did not return. */
  memoryWithoutId: number
  /** Structured health events (`provider` + `event_id`), deletable through `/health-events/import`. */
  healthEvents: number
  /** Timeline documents written by `import-data` (no per-source delete upstream). */
  timelineDocs: number
  lastAt: string | null
}

export interface LedgerView {
  connectors: LedgerConnectorView[]
}

export interface DeleteRemaining {
  what: 'memory' | 'timeline' | 'health'
  count: number
  /** Why it is still there. */
  reason: string
  /** Exactly how the user can remove it (manual steps). */
  how: string[]
  /** Runtime ids still present (memory entry ids), at most 200. */
  ids: string[]
}

export interface DeleteImportedResult {
  kind: ConnectorKind
  memoryRetired: number
  /** R10 Runtime: memory entries erased (`POST /memory/entries/delete`; gone from Markdown + search). */
  memoryErased?: number
  /** R10 Runtime: timeline documents deleted (`POST /imports/delete` by source key). */
  timelineDeleted?: number
  healthDeleted: number
  remaining: DeleteRemaining[]
  notes: string[]
}

export interface ConnectorsApi {
  connectors: {
    /** Native file picker (main), parse, redact, preview. Writes nothing. Requires consent for the kind. */
    pick(kind: Exclude<ConnectorKind, 'imap'>): Promise<LensResult<ConnectorPreview>>
    /** Write the selected items to the Runtime. Requires confirm (+ main native confirm) and consent. */
    commit(previewId: string, keys: string[], opts: { target?: CalendarTarget }, confirm: true): Promise<LensResult<ConnectorCommitResult>>
    discard(previewId: string): Promise<LensResult<{ discarded: boolean }>>
    consentStatus(): Promise<LensResult<ConsentView[]>>
    /** Main shows the consent text in a native dialog; nothing is granted without it. */
    consentGrant(kind: ConsentKind): Promise<LensResult<ConsentView>>
    consentRevoke(kind: ConsentKind): Promise<LensResult<ConsentView>>
    /** CSV: re-map the held preview's columns (no file re-read). */
    csvMap(previewId: string, mapping: CsvMapping): Promise<LensResult<ConnectorPreview>>
    imapStatus(): Promise<LensResult<ImapConfigView>>
    imapSave(config: ImapConfigInput): Promise<LensResult<ImapConfigView>>
    imapClear(): Promise<LensResult<ImapConfigView>>
    /** Connect (TLS), read-only fetch, parse, redact, preview. Writes nothing. */
    imapFetch(opts: ImapFetchOptions): Promise<LensResult<ConnectorPreview>>
    ledger(): Promise<LensResult<LedgerView>>
    /** Delete what this connector wrote, where the Runtime supports it. Main native confirm. */
    deleteImported(kind: ConnectorKind, confirm: true): Promise<LensResult<DeleteImportedResult>>
  }
}
