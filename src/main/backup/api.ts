// Typed renderer API fragment for S2-02 full export / restore. Owned by the backup-import agent.
// Types + constants only: no node imports, so the renderer typecheck can include it.
import type { LensResult } from '../../shared/types'
import { tr } from '../../shared/i18n'

export const BACKUP_CHANNELS = {
  exportBackup: 'lens:backup:export',
  inspect: 'lens:backup:inspect',
  restore: 'lens:backup:restore'
} as const

export const BACKUP_FORMAT = 'navalia.backup'
/** Previous name (Grapple); still accepted on restore. */
export const PREV_BACKUP_FORMAT = 'grapple.backup'
/** Pre-rename (Persome Lens) manifest format; still accepted on restore. */
export const LEGACY_BACKUP_FORMAT = 'persome-lens.backup'
/**
 * v2 (S1-R3-06): adds `notes`, `access_log`, optional `lens/access-log.json`.
 * v3 (S1-R4-06, X8): adds the explicit boolean `includes_access_log`.
 * v4 (C21): adds `includes_user_data` (opt-in chat / meeting transcripts / moments). v1–v3 backups are still accepted.
 */
export const BACKUP_FORMAT_VERSION = 4

/** Written into every manifest (`notes`); stays Chinese (on-disk content). Settings shows `modelSnapshotNoteText()`. */
export const MODEL_SNAPSHOT_NOTE =
  'model-snapshot.json 是 `persome model export` 的默认脱敏快照（Navalia 从不传 --raw）：不是 Runtime 原始数据库（index.db），' +
  '也不含截图、采集帧或 capture-buffer。恢复时仅存档，Navalia 不会把它写回 Runtime。' +
  '要保留 Runtime 的原始数据（index.db、采集记录），需要另外备份 Runtime 数据目录本身（默认 ~/.persome），Navalia 备份不能代替它。'

/** X8: explicit opt-in, default off. Written into the manifest when included (on-disk, stays Chinese). The checkbox shows `accessLogWarningText()`. */
export const ACCESS_LOG_WARNING =
  'Access log 记录了哪些 Agent 在什么时候读了你的哪些数据，含参数与结果的前 500 字预览（可能包含个人内容）。' +
  '勾选后会在一次只读事务里完整读出 audit.db（一致快照），以 lens/access-log.json 明文写入备份；恢复时只存档，不会写回本机的 Access log。' +
  '无论是否勾选，备份都不含身份私钥（identity/ed25519.key.enc）和授权记录（grants.json）。'

/** UI text of MODEL_SNAPSHOT_NOTE in the active locale. */
export function modelSnapshotNoteText(): string {
  return tr(
    'model-snapshot.json is the default redacted snapshot from `persome model export` (Navalia never passes --raw). It is not the Runtime raw database (index.db) ' +
      'and contains no screenshots, capture frames or capture-buffer. On restore it is archived only; Navalia never writes it back to Runtime. ' +
      'To keep Runtime raw data (index.db, capture records), back up the Runtime data directory itself (default ~/.persome). A Navalia backup does not replace it.',
    MODEL_SNAPSHOT_NOTE
  )
}

/** UI text of ACCESS_LOG_WARNING in the active locale. */
export function accessLogWarningText(): string {
  return tr(
    'The Access log records which Agent read which of your data and when, including a 500-character preview of arguments and results (may contain personal content). ' +
      'When checked, audit.db is read in full in one read-only transaction (consistent snapshot) and written into the backup as plain-text lens/access-log.json. On restore it is archived only and never written back to this Mac\'s Access log. ' +
      'Checked or not, a backup never contains the identity private key (identity/ed25519.key.enc) or grant records (grants.json).',
    ACCESS_LOG_WARNING
  )
}

/** What a backup contains (shown in Settings; the service copies exactly this allowlist). */
export const BACKUP_INCLUDED: ReadonlyArray<{ path: string; label: string }> = [
  {
    path: 'model-snapshot.json',
    get label() {
      return tr('Personal model snapshot (persome model export, redacted; not the raw database, no screenshots or capture frames)', '个人模型快照（persome model export，已脱敏；不是原始数据库，也不含截图 / 采集帧）')
    }
  },
  {
    path: 'lens/workflows/',
    get label() {
      return tr('Workflows (all versions; merged by version on restore, never overwriting newer local versions)', 'Workflow（含所有版本；恢复时按版本合并，不覆盖本机更新的版本）')
    }
  },
  {
    path: 'lens/peers/',
    get label() {
      return tr('Peers (cards signed by them)', '朋友列表（对方签名的卡片）')
    }
  },
  {
    path: 'lens/cards/',
    get label() {
      return tr('Cards you issued (public content + signature; each verified on restore)', '你签发过的卡片（公开内容 + 签名；恢复时逐张验签）')
    }
  },
  {
    path: 'lens/settings.json',
    get label() {
      return tr('Navalia settings (card display name)', 'Navalia 设置（卡片显示名）')
    }
  },
  {
    path: 'lens/het-settings.json',
    get label() {
      return tr('HET switch settings', 'HET 开关设置')
    }
  }
]

/**
 * What a backup never contains, with the reason (DECISIONS X8). `reason` is written into the manifest
 * (on-disk, stays Chinese); `shown` is the same reason in the active UI locale.
 */
const excluded = (path: string, en: string, reason: string): { path: string; reason: string; readonly shown: string } => ({
  path,
  reason,
  get shown() {
    return tr(en, reason)
  }
})
export const BACKUP_EXCLUDED: ReadonlyArray<{ path: string; reason: string; readonly shown: string }> = [
  excluded('identity/', 'Identity private key (ed25519.key.enc) and identity records: the key stays encrypted in this Mac\'s keychain and is never exported', '身份私钥（ed25519.key.enc）与身份记录：私钥只留在本机钥匙串加密，不导出'),
  excluded('grants.json', 'Agent grant records: grant again in Connections after restoring', 'Agent 授权记录：恢复后需在「连接」里重新授权'),
  excluded('audit.db', 'Access log: not included by default (X8); check "Include Access log" to export it as lens/access-log.json', 'Access log：默认不包含（X8）；可勾选「包含 Access log」导出为 lens/access-log.json'),
  excluded('het.db', 'HET ledger: locally derived data with session excerpts, not exported', 'HET 账本：本机派生数据，含会话摘录，不导出'),
  excluded('import/', 'Import staging area: holds raw session copies, safe to discard after import', '导入暂存区：含会话原文副本，导入后即可丢弃'),
  excluded('connectors/', 'Connector import records (hashes of entries already written to Runtime), kept per Runtime, not exported', '连接器导入记录（本机已写入 Runtime 的条目哈希），按 Runtime 保存，不导出'),
  excluded('peers/subscription.json', 'Subscription folder settings: absolute local folder paths and processed file names, kept per machine, not exported', '订阅文件夹设置：含本机文件夹绝对路径与已处理文件名记录，按机器保存，不导出'),
  excluded('onboarding.json', 'First-run onboarding record, kept per machine', '首次引导记录，按机器保存'),
  excluded('runtime env / token', 'The Runtime local API token and screenshot key are never read into a backup', 'Runtime 的本地 API token 与截图密钥从不读取进备份'),
  excluded('cloud-token.enc / cloud.json', 'Cloud sign-in token (encrypted) and cloud connection settings: kept per machine, sign in again after restoring', '云端登录 token（加密）与云端连接设置：按机器保存，恢复后需重新登录'),
  excluded('meetings/*/audio/', 'Meeting recordings: never exported ("Meeting transcripts" includes only meeting.json and transcript.json)', '会议录音：从不导出（勾选「会议转写」也只含 meeting.json 与 transcript.json）'),
  excluded('chat/ · meetings/ · moments/', 'Chat history, meeting transcripts, shared moments: not included by default, each can be checked', '聊天记录、会议转写、共享时刻：默认不包含，可分别勾选'),
  excluded('performance/ · proactive-*', 'Locally derived data and proactive reminder state, kept per machine', '本机派生数据与主动提醒状态，按机器保存')
]

/** C21: opt-in user data (each default off). `dir` is the Lens Store sub-directory. */
export const USER_DATA_OPTIONS: ReadonlyArray<{ key: 'chat' | 'meetings' | 'moments'; dir: string; label: string; detail: string }> = [
  {
    key: 'chat',
    dir: 'chat/',
    get label() {
      return tr('Chat history', '聊天记录')
    },
    get detail() {
      return tr('Cloud Ask conversations (including quoted context excerpts)', '云端「问」的对话（含引用的上下文摘录）')
    }
  },
  {
    key: 'meetings',
    dir: 'meetings/',
    get label() {
      return tr('Meeting transcripts', '会议转写')
    },
    get detail() {
      return tr('meeting.json + transcript.json for each meeting; recordings are never included', '每场会议的 meeting.json + transcript.json；从不包含录音')
    }
  },
  {
    key: 'moments',
    dir: 'moments/',
    get label() {
      return tr('Shared moments', '共享时刻')
    },
    get detail() {
      return tr('Moments signed by both you and a peer + your private notes', '你和朋友双方签名的时刻 + 你的私人备注')
    }
  }
]

/** C21: shown next to the encryption option. */
export function encryptionNote(): string {
  return tr(
    'Encryption: AES-256-GCM with a key derived from the passphrase via scrypt (N=2^15, random salt). The header (format version, KDF parameters, salt, nonce) is authenticated, ' +
      'and data is encrypted in chunks: any change, truncation or wrong passphrase is rejected before anything is written. The passphrase is not stored and cannot be recovered: if you forget it, this backup cannot be restored.',
    '加密：AES-256-GCM，密钥由口令经 scrypt（N=2^15，随机盐）派生；文件头（格式版本、KDF 参数、盐、随机数）参与认证，' +
      '分块加密，任何改动、截断或错误口令都会在写入任何内容之前被拒绝。口令不保存、无法找回：忘记口令就无法恢复这份备份。'
  )
}

export interface BackupFileEntry {
  /** Path relative to the backup directory, POSIX separators. */
  path: string
  bytes: number
  sha256: string
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT | typeof PREV_BACKUP_FORMAT | typeof LEGACY_BACKUP_FORMAT
  format_version: 1 | 2 | 3 | 4
  created_at: string
  app_version: string | null
  files: BackupFileEntry[]
  model_snapshot: {
    status: 'included' | 'not_requested'
    /** CLI arguments (output path shown as `<backup>/model-snapshot.json`). */
    args: string[] | null
    exit_code: number | null
  }
  excluded: Array<{ path: string; reason: string }>
  /** Files under allowlisted dirs that were not copied (symlink, non-regular, too large, …). */
  skipped: Array<{ path: string; reason: string }>
  /** v2: human-readable statements (model snapshot is redacted, not the raw DB or captures). */
  notes?: string[]
  /** v2: X8 opt-in Access log export. */
  access_log?: { status: 'included' | 'not_requested'; rows: number | null; warning: string | null }
  /** v3 (S1-R4-06): explicit X8 flag; always written. Older backups: derived from the file list. */
  includes_access_log?: boolean
  /** v4 (C21): opt-in user data; always written. Older backups carry none. */
  includes_user_data?: { chat: boolean; meetings: boolean; moments: boolean }
}

export interface ExportOptions {
  withoutModel: boolean
  /** X8: explicit opt-in, default false. */
  includeAccessLog?: boolean
  /** C21: opt-in user data, each default false. */
  includeChat?: boolean
  includeMeetings?: boolean
  includeMoments?: boolean
  /** C21: when set, write one AES-256-GCM `.navaliabackup` file instead of a plain directory. Never stored. */
  passphrase?: string
}

export interface BackupExportResult {
  cancelled: boolean
  /** Final backup directory (absolute). Null when cancelled. */
  path: string | null
  files: number
  bytes: number
  modelSnapshot: BackupManifest['model_snapshot']['status'] | null
  /** Rows exported when the Access log was included; null when not requested. */
  accessLogRows?: number | null
  excluded: BackupManifest['excluded']
  skipped: BackupManifest['skipped']
  /** C21: true when the backup was written as an encrypted `.navaliabackup` file. */
  encrypted?: boolean
  /** C21: opt-in user data files written per kind. */
  userData?: { chat: number; meetings: number; moments: number }
  /** C21: manifest signed with the Lens identity key; when false, `signReason` says why. */
  signed?: boolean
  signReason?: string | null
}

/**
 * C21 (lead decision): who signed the backup manifest. Only `mine` (current identity or a retired key of
 * this Lens) restores Workflows under their original ids with original provenance; `unsigned` /
 * `foreign` fall back to re-stamped `imp-*` copies. `invalid` backups are rejected before inspect returns.
 */
export interface BackupTrust {
  mode: 'mine' | 'foreign' | 'unsigned' | 'invalid'
  /** Signer fingerprint (public), null when unsigned / unreadable. */
  fingerprint: string | null
  reason: string
}

/** C21: what restore will do with one Workflow id of the backup (computed before anything is written). */
export type WorkflowRestoreAction =
  /** id not in this Lens: every version written byte-for-byte under the original id. */
  | 'restore'
  /** same history as local, backup has newer versions: only those versions are appended. */
  | 'merge'
  /** identical history: nothing to do. */
  | 'unchanged'
  /** this Lens already has newer versions of the same history: kept, nothing written. */
  | 'local_newer'
  /** histories diverged (or the id is a different Runtime-observed Workflow): saved as a separate `imp-*` copy. */
  | 'copy'
  /** a diverged copy whose content already exists here. */
  | 'duplicate'
  | 'failed'

export interface RestorePreview {
  workflows: Array<{ id: string; title: string; action: WorkflowRestoreAction; versions: number; detail: string | null }>
  cards: { valid: number; invalid: number }
  peers: number
  userData: { chat: number; meetings: number; moments: number }
  accessLog: boolean
  /** C21: signature trust; decides original-id restore vs re-stamped copies. */
  trust?: BackupTrust
}

export interface BackupInspection {
  cancelled: boolean
  /** Opaque handle for `restore`; the renderer never sends a filesystem path back. */
  inspectionId: string | null
  /** Directory name (not the full path). */
  name: string | null
  createdAt: string | null
  appVersion: string | null
  counts: { workflows: number; peers: number; cards: number; files: number; bytes: number; workflowVersions?: number }
  modelSnapshot: boolean
  /** True when the backup carries `lens/access-log.json`. */
  accessLog?: boolean
  notes?: string[]
  /** C21: the backup was an encrypted `.navaliabackup` file (decrypted into a private staging dir). */
  encrypted?: boolean
  /** C21: manifest signature trust (decides original-id restore vs re-stamped copies). */
  trust?: BackupTrust
  /** C21: per-item plan, computed against the current store; nothing has been written. */
  preview?: RestorePreview
}

export interface InspectOptions {
  /** C21: pick an encrypted `.navaliabackup` file instead of a backup directory. */
  encrypted?: boolean
  passphrase?: string
}

export interface RestoreReport {
  name: string
  workflows: {
    /** Diverged histories saved as separate `imp-*` copies. */
    imported: number
    duplicates: number
    failed: number
    /** C21: ids restored byte-for-byte under their original id. */
    restored?: number
    /** C21: ids where only newer backup versions were appended. */
    merged?: number
    /** C21: identical histories. */
    unchanged?: number
    /** C21: this Lens had newer versions; kept. */
    localNewer?: number
    items: Array<{
      title: string
      outcome: 'restored' | 'merged' | 'unchanged' | 'local_newer' | 'imported' | 'duplicate' | 'failed'
      detail: string | null
      /** Versions written (history kept). */
      versions?: number
      /** C21: Workflow id written to (original id, or the new `imp-*` id for a copy). */
      id?: string
    }>
  }
  peers: {
    added: number
    updated: number
    unchanged: number
    failed: number
    items: Array<{ fingerprint: string; outcome: string; detail: string | null }>
  }
  /** S1-R3-06: issued cards, each re-verified. Cards of the current identity go to cards/, others to cards/archive/. */
  cards?: {
    restored: number
    archived: number
    unchanged: number
    failed: number
    items: Array<{ cardId: string; outcome: 'restored' | 'archived' | 'unchanged' | 'failed'; detail: string | null }>
  }
  /** S1-R4-06 (X8): whether the backup carried the Access log (archive-only either way; never written to audit.db). */
  accessLog?: { included: boolean; rows: number | null }
  /** C21: signature trust the restore ran under. */
  trust?: BackupTrust
  /** C21: opt-in user data files (written only when absent locally; never overwritten). */
  userData?: Record<'chat' | 'meetings' | 'moments', { restored: number; unchanged: number; skipped: number }>
  /** Parts of the backup that are archive-only and were not written into the current store. */
  notRestored: string[]
}

export interface BackupApi {
  backup: {
    /** Pick a directory, then write `<dir>/navalia-backup-<timestamp>/` atomically. */
    exportBackup(opts: ExportOptions): Promise<LensResult<BackupExportResult>>
    /**
     * Pick a backup directory (or, with `encrypted`, a `.navaliabackup` file + passphrase) and validate it
     * (manifest schema, paths, sizes, sha256; GCM tags). Writes nothing into the Lens data.
     */
    inspect(opts?: InspectOptions): Promise<LensResult<BackupInspection>>
    /** Merge the inspected backup's workflows (with history) / peers / cards into the current store. Requires confirm. */
    restore(inspectionId: string, confirm: true): Promise<LensResult<RestoreReport>>
  }
}
