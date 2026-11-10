import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { defaultExec, type ExecFn } from '../import/cli'
import { redactForDisplay } from '../import/redact'
import { verifyCardText } from '../identity/card'
import { createPeerStore } from '../peers/store'
import { DIR_MODE, ensureSecureDir, FILE_MODE, isInside, readFileIfExists, realOrResolved, storePaths, writeFileSecure } from '../store/paths'
import { readRuntimeSkills } from '../workflows/runtime'
import { provenance, source, WorkflowIdSchema, WorkflowSchema, type Workflow } from '../workflows/schema'
import { contentHash, createWorkflowStore } from '../workflows/store'
import {
  BackupCryptoError,
  ContainerReader,
  ContainerWriter,
  checkPassphrase,
  decryptFile,
  ENC_EXT,
  LEGACY_ENC_EXT,
  PREV_ENC_EXT,
  EncryptWriter,
  type KdfParams
} from './crypto'
import { evaluateTrust, MAX_SIG_BYTES, SIG_FILE, signManifest, type BackupSigner } from './signature'
import {
  ACCESS_LOG_WARNING,
  BACKUP_EXCLUDED,
  BACKUP_FORMAT,
  LEGACY_BACKUP_FORMAT,
  PREV_BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  MODEL_SNAPSHOT_NOTE,
  type ExportOptions,
  type BackupExportResult,
  type BackupFileEntry,
  type BackupInspection,
  type BackupManifest,
  type BackupTrust,
  type RestorePreview,
  type RestoreReport,
  type WorkflowRestoreAction
} from './api'
import { tr } from '../../shared/i18n'
export const MODEL_SNAPSHOT_FILE = 'model-snapshot.json'
export const MANIFEST_FILE = 'manifest.json'
export const ACCESS_LOG_FILE = 'lens/access-log.json'
const WORK_PREFIX = '.backup-work-'
const RESTORE_PREFIX = '.backup-restore-'
const CHAT_FILE_RE = /^c-[0-9a-f]{16}\.json$/
const MOMENT_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/
const MEETING_DIR_RE = /^[A-Za-z0-9_-]{1,128}$/
const USER_DATA_REL_RE = /^lens\/(chat\/c-[0-9a-f]{16}\.json|moments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json|meetings\/[A-Za-z0-9_-]{1,128}\/(meeting|transcript)\.json)$/
type UserDataKind = 'chat' | 'meetings' | 'moments'
const USER_DATA_KINDS: UserDataKind[] = ['chat', 'meetings', 'moments']
const userDataKind = (rel: string): UserDataKind | null => (USER_DATA_REL_RE.test(rel) ? (rel.split('/')[1] as UserDataKind) : null)
const CARD_REL_RE = /^lens\/cards\/(archive\/)?(card_[0-9a-f]{32})\.(?:navaliacard|grapplecard|persomecard)$/
export const MODEL_EXPORT_TIMEOUT_MS = 10 * 60_000

export interface BackupLimits {
  /** Max bytes for one copied Lens Store file. */
  maxFileBytes: number
  /** Max total bytes copied from the Lens Store. */
  maxLensBytes: number
  /** Max files copied from the Lens Store. */
  maxFiles: number
  /** Max bytes of the model snapshot. */
  maxSnapshotBytes: number
  /** Max directory depth under an allowlisted dir. */
  maxDepth: number
}

export const DEFAULT_LIMITS: BackupLimits = {
  maxFileBytes: 16 * 1024 * 1024,
  maxLensBytes: 512 * 1024 * 1024,
  maxFiles: 20_000,
  maxSnapshotBytes: 1024 * 1024 * 1024,
  maxDepth: 4
}

/** Lens Store entries copied into `lens/`. Everything else at the store root is excluded. */
export const ALLOWED_DIRS = ['workflows', 'peers', 'cards'] as const
export const ALLOWED_FILES = ['settings.json', 'het-settings.json'] as const
/**
 * Under `peers/` only friend records `<fingerprint>.json` are copied (S2-SEC L2). Anything else —
 * notably `subscription.json` (absolute folder path + file-name ledger) — stays on this machine.
 */
export const PEER_FILE_RE = /^[0-9a-f]{64}\.json$/

export class BackupError extends Error {
  constructor(
    readonly code: 'not_found' | 'runtime_missing' | 'schema' | 'unauthorized' | 'unknown',
    message: string
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

export interface BackupServiceDeps {
  storeRoot: string
  runtimeRoot: () => string
  persomeBin: () => string | null
  exec?: ExecFn
  now?: () => number
  appVersion?: () => string | null
  limits?: Partial<BackupLimits>
  /** Test hook: called after each Lens file copy (inject failures). */
  onCopy?: (rel: string) => void
  /** C21: scrypt parameters for new encrypted backups (default N=2^15, r=8, p=1; N below 2^15 is refused). */
  kdf?: KdfParams
  /** C21: Runtime-observed Workflows (shadowing guard). Default: read `<runtimeRoot>/memory/skills`. */
  observedWorkflows?: () => Workflow[]
  /** C21: Lens identity (KeyManager) — signs manifests at export, decides "mine" at restore. */
  identity?: BackupSigner
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/**
 * Read a regular file without following a final symlink, refusing anything over `max`.
 * Returns null for symlinks / non-regular files.
 */
function readRegular(file: string, max: number): Buffer | null {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOENT') return null
    throw e
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return null
    if (st.size > max) throw new BackupError('unknown', tr(`File too large (${st.size} bytes, limit ${max}): ${path.basename(file)}`, `文件过大（${st.size} 字节，上限 ${max}）：${path.basename(file)}`))
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off)
      if (n === 0) break
      off += n
    }
    return off === st.size ? buf : buf.subarray(0, off)
  } finally {
    fs.closeSync(fd)
  }
}

/** Chunked sha256 of a regular file (no symlink follow). Null when missing / not regular / over `max`. */
function hashRegular(file: string, max: number): { bytes: number; sha256: string } | null {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > max) return null
    const h = createHash('sha256')
    const buf = Buffer.alloc(1024 * 1024)
    let total = 0
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, total)
      if (n === 0) break
      h.update(buf.subarray(0, n))
      total += n
    }
    return { bytes: total, sha256: h.digest('hex') }
  } finally {
    fs.closeSync(fd)
  }
}

function mkdirSecure(p: string): void {
  fs.mkdirSync(p, { recursive: true, mode: DIR_MODE })
  fs.chmodSync(p, DIR_MODE)
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/** Secret values from `<runtimeRoot>/env` (token, screenshot key, other *_KEY/_TOKEN/_SECRET). Never leaves main. */
export function runtimeSecretValues(runtimeRoot: string): string[] {
  let text: string
  try {
    const buf = readRegular(path.join(runtimeRoot, 'env'), 1024 * 1024)
    if (!buf) return []
    text = buf.toString('utf8')
  } catch {
    return []
  }
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    if (!/(TOKEN|KEY|SECRET|PASSW)/.test(m[1])) continue
    const v = m[2].replace(/^["']|["']$/g, '')
    if (v.length >= 12) out.push(v)
  }
  return out
}

const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const FORBIDDEN_BASENAME = /^(ed25519\.key\.enc|.*\.key\.enc|cloud-token\.enc|cloud\.json|grants\.json|(audit|het)\.db(-(wal|shm|journal))?|env|token)$/
const FORBIDDEN_TOP = new Set(['identity', 'import', 'connectors'])

function forbiddenPath(rel: string): boolean {
  const segs = rel.split('/')
  const inner = segs[0] === 'lens' ? segs.slice(1) : segs
  return FORBIDDEN_TOP.has(inner[0]) || FORBIDDEN_BASENAME.test(segs[segs.length - 1])
}

/**
 * Fail-closed scan of a produced backup: forbidden file names, PEM private key headers,
 * exact Runtime secret values, and byte-identical copies of the encrypted private key.
 */
export function scanForSecrets(
  files: Array<{ rel: string; data: Buffer }>,
  secrets: string[],
  keyMaterial: Buffer | Buffer[] | null
): string[] {
  const problems: string[] = []
  // C21: every key-material file (identity private key, cloud token) — byte-identical copy OR embedded bytes.
  const keys = (Array.isArray(keyMaterial) ? keyMaterial : keyMaterial ? [keyMaterial] : []).filter((k) => k.length >= 16)
  const keyHashes = new Set(keys.map(sha256))
  for (const f of files) {
    if (forbiddenPath(f.rel)) problems.push(tr(`${f.rel}: forbidden file name for export`, `${f.rel}: 禁止导出的文件名`))
    const text = f.data.toString('utf8')
    if (PEM_PRIVATE.test(text)) problems.push(tr(`${f.rel}: contains a PEM private key header`, `${f.rel}: 含私钥 PEM 头`))
    if (secrets.some((s) => text.includes(s))) problems.push(tr(`${f.rel}: contains a Runtime token / key`, `${f.rel}: 含 Runtime token / 密钥`))
    if (keyHashes.has(sha256(f.data)) || keys.some((k) => f.data.includes(k) || text.includes(k.toString('base64')))) {
      problems.push(tr(`${f.rel}: contains ciphertext of the identity private key or cloud token`, `${f.rel}: 含身份私钥或云端 token 的密文`))
    }
  }
  return problems
}

const RelPath = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.includes('\\') && !p.includes('\0') && !p.startsWith('/'), { error: () => tr('Invalid path', '路径不合法') })
  .refine((p) => p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'), { error: () => tr('Invalid path (contains .. or an empty segment)', '路径不合法（含 .. 或空段）') })
  .refine(
    (p) =>
      p === MODEL_SNAPSHOT_FILE ||
      p === ACCESS_LOG_FILE ||
      USER_DATA_REL_RE.test(p) ||
      /^lens\/(settings|het-settings)\.json$/.test(p) ||
      /^lens\/(workflows|peers|cards)\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+){0,3}$/.test(p),
    { error: () => tr('Path is not in the backup allowlist', '路径不在备份白名单内') }
  )

export const ManifestSchema = z.strictObject({
  format: z.union([z.literal(BACKUP_FORMAT), z.literal(PREV_BACKUP_FORMAT), z.literal(LEGACY_BACKUP_FORMAT)]),
  format_version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(BACKUP_FORMAT_VERSION)]),
  created_at: z.string().datetime({ offset: true }),
  app_version: z.string().max(64).nullable(),
  files: z
    .array(
      z.strictObject({
        path: RelPath,
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/)
      })
    )
    .max(DEFAULT_LIMITS.maxFiles + 1),
  model_snapshot: z.strictObject({
    status: z.enum(['included', 'not_requested']),
    args: z.array(z.string().max(512)).max(16).nullable(),
    exit_code: z.number().int().nullable()
  }),
  excluded: z.array(z.strictObject({ path: z.string().max(512), reason: z.string().max(512) })).max(1000),
  skipped: z.array(z.strictObject({ path: z.string().max(512), reason: z.string().max(512) })).max(DEFAULT_LIMITS.maxFiles),
  notes: z.array(z.string().max(2000)).max(20).optional(),
  access_log: z
    .strictObject({
      status: z.enum(['included', 'not_requested']),
      rows: z.number().int().nonnegative().nullable(),
      warning: z.string().max(2000).nullable()
    })
    .optional(),
  includes_access_log: z.boolean().optional(),
  includes_user_data: z.strictObject({ chat: z.boolean(), meetings: z.boolean(), moments: z.boolean() }).optional()
})

const PeerBackupSchema = z.object({ history: z.array(z.object({ card: z.unknown() }).passthrough()).min(1).max(100) }).passthrough()

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

interface ValidatedBackup {
  dir: string
  name: string
  encrypted: boolean
  manifest: BackupManifest
  /** sha256 over manifest.json (+ manifest.sig.json when present): TOCTOU check between inspect and restore. */
  manifestHash: string
  trust: BackupTrust
  /** rel → bytes, already sha256-verified. */
  data: Map<string, Buffer>
}

export function createBackupService(deps: BackupServiceDeps) {
  const exec = deps.exec ?? defaultExec
  const now = deps.now ?? Date.now
  const limits: BackupLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  let busy = false

  const exclusive = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    if (busy) throw new BackupError('unknown', tr('Another backup or restore is in progress. Try again later.', '另一个备份 / 恢复操作正在进行，请稍后再试。'))
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  function checkParent(parent: string): string {
    if (!path.isAbsolute(parent)) throw new BackupError('unknown', tr('The backup location must be an absolute path.', '备份位置必须是绝对路径。'))
    let st: fs.Stats
    try {
      st = fs.statSync(parent)
    } catch {
      throw new BackupError('not_found', tr('The selected folder does not exist.', '所选目录不存在。'))
    }
    if (!st.isDirectory()) throw new BackupError('unknown', tr('The selected location is not a folder.', '所选位置不是目录。'))
    const real = realOrResolved(parent)
    if (isInside(real, realOrResolved(deps.storeRoot))) throw new BackupError('unknown', tr('A backup cannot be placed inside the Navalia data folder.', '不能把备份放在 Navalia 数据目录里。'))
    if (isInside(real, realOrResolved(deps.runtimeRoot()))) throw new BackupError('unknown', tr('A backup cannot be placed inside the Runtime data folder.', '不能把备份放在 Runtime 数据目录里。'))
    return real
  }

  /** Copy one allowlisted dir (no symlinks, regular files only, caps). */
  function copyTree(
    srcRoot: string,
    destRoot: string,
    relBase: string,
    out: BackupFileEntry[],
    skipped: BackupManifest['skipped'],
    produced: Array<{ rel: string; data: Buffer }>,
    totals: { bytes: number },
    depth: number
  ): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(srcRoot, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${relBase}/${e.name}`
      const src = path.join(srcRoot, e.name)
      if (e.name.startsWith('.') || !/^[A-Za-z0-9._~-]+$/.test(e.name)) {
        skipped.push({ path: rel, reason: '临时 / 隐藏或名称不合规的文件' })
        continue
      }
      if (relBase === 'lens/peers' && !PEER_FILE_RE.test(e.name)) {
        // subscription.json is listed in the manifest's `excluded` (BACKUP_EXCLUDED); report the rest.
        if (e.name !== 'subscription.json') skipped.push({ path: rel, reason: '不是朋友记录（peers/ 只备份 <指纹>.json）' })
        continue
      }
      const st = fs.lstatSync(src)
      if (st.isSymbolicLink()) {
        skipped.push({ path: rel, reason: '符号链接（不跟随）' })
        continue
      }
      if (st.isDirectory()) {
        if (depth >= limits.maxDepth) {
          skipped.push({ path: rel, reason: '目录层级过深' })
          continue
        }
        mkdirSecure(path.join(destRoot, e.name))
        copyTree(src, path.join(destRoot, e.name), rel, out, skipped, produced, totals, depth + 1)
        continue
      }
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: '不是普通文件' })
        continue
      }
      if (st.size > limits.maxFileBytes) {
        skipped.push({ path: rel, reason: `超过单文件上限 ${limits.maxFileBytes} 字节` })
        continue
      }
      copyFile(src, path.join(destRoot, e.name), rel, out, produced, totals, skipped)
    }
  }

  function copyFile(
    src: string,
    dest: string,
    rel: string,
    out: BackupFileEntry[],
    produced: Array<{ rel: string; data: Buffer }>,
    totals: { bytes: number },
    skipped: BackupManifest['skipped']
  ): void {
    const data = readRegular(src, limits.maxFileBytes)
    if (!data) {
      skipped.push({ path: rel, reason: '不是普通文件' })
      return
    }
    if (out.length + 1 > limits.maxFiles) throw new BackupError('unknown', tr(`Navalia data exceeds the file count limit of ${limits.maxFiles}. Aborted.`, `Navalia 数据文件数超过上限 ${limits.maxFiles}，已中止。`))
    if (totals.bytes + data.length > limits.maxLensBytes) throw new BackupError('unknown', tr(`Navalia data exceeds the total size limit of ${limits.maxLensBytes} bytes. Aborted.`, `Navalia 数据总量超过上限 ${limits.maxLensBytes} 字节，已中止。`))
    fs.writeFileSync(dest, data, { mode: FILE_MODE, flag: 'wx' })
    deps.onCopy?.(rel)
    totals.bytes += data.length
    out.push({ path: rel, bytes: data.length, sha256: sha256(data) })
    produced.push({ rel, data })
  }

  /**
   * X8 opt-in: every Access log row as JSON. Read-only open, one explicit read transaction, so the
   * table check and the row read see one consistent state while the Broker keeps appending
   * (audit.db uses journal_mode=DELETE: the shared lock makes a concurrent writer wait until the read
   * ends — never a half-written page). The sqlite file itself (and any -journal) is never copied.
   */
  function dumpAccessLog(): { data: Buffer; rows: number } {
    const file = storePaths(deps.storeRoot).auditDb
    let rows: Array<Record<string, unknown>> = []
    if (fs.existsSync(file)) {
      let db: DatabaseSync | null = null
      try {
        db = new DatabaseSync(file, { readOnly: true })
        db.exec('BEGIN')
        try {
          const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='access_log'").get()
          rows = has ? (db.prepare('SELECT * FROM access_log ORDER BY id').all() as Array<Record<string, unknown>>) : []
        } finally {
          db.exec('COMMIT')
        }
      } catch (e) {
        throw new BackupError('unknown', tr(`Cannot read the Access log (audit.db): ${e instanceof Error ? e.message : String(e)}`, `无法读取 Access log（audit.db）：${e instanceof Error ? e.message : String(e)}`))
      } finally {
        db?.close()
      }
    }
    const doc = { format: 'navalia.access-log', format_version: 1, exported_at: new Date(now()).toISOString(), warning: ACCESS_LOG_WARNING, rows }
    return { data: Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8'), rows: rows.length }
  }

  /** C21: copy opt-in user data (chat / meeting transcripts / moments). Audio is never read. */
  function copyUserData(
    kind: UserDataKind,
    lensDir: string,
    files: BackupFileEntry[],
    produced: Array<{ rel: string; data: Buffer }>,
    totals: { bytes: number },
    skipped: BackupManifest['skipped']
  ): number {
    const src = path.join(deps.storeRoot, kind)
    let st: fs.Stats
    try {
      st = fs.lstatSync(src)
    } catch {
      return 0
    }
    if (!st.isDirectory()) {
      skipped.push({ path: `lens/${kind}`, reason: st.isSymbolicLink() ? '符号链接（不跟随）' : '不是目录' })
      return 0
    }
    const before = files.length
    const destRoot = path.join(lensDir, kind)
    mkdirSecure(destRoot)
    const names = fs.readdirSync(src).sort()
    for (const n of names) {
      const rel = `lens/${kind}/${n}`
      if (kind === 'chat' || kind === 'moments') {
        if (!(kind === 'chat' ? CHAT_FILE_RE : MOMENT_FILE_RE).test(n)) {
          if (!n.startsWith('.')) skipped.push({ path: rel, reason: '不是对话 / 时刻文件' })
          continue
        }
        if (isSymlink(path.join(src, n))) {
          skipped.push({ path: rel, reason: '符号链接（不跟随）' })
          continue
        }
        copyFile(path.join(src, n), path.join(destRoot, n), rel, files, produced, totals, skipped)
        continue
      }
      // meetings/<id>/{meeting,transcript}.json — only meetings that have a transcript; audio/ never.
      const mdir = path.join(src, n)
      if (!MEETING_DIR_RE.test(n)) {
        if (!n.startsWith('.')) skipped.push({ path: rel, reason: '不是会议目录' })
        continue
      }
      let ms: fs.Stats
      try {
        ms = fs.lstatSync(mdir)
      } catch {
        continue
      }
      if (!ms.isDirectory()) {
        skipped.push({ path: rel, reason: '不是目录（或是符号链接）' })
        continue
      }
      if (!fs.existsSync(path.join(mdir, 'transcript.json')) || !fs.existsSync(path.join(mdir, 'meeting.json'))) {
        skipped.push({ path: rel, reason: '没有转写（录音从不导出）' })
        continue
      }
      mkdirSecure(path.join(destRoot, n))
      for (const f of ['meeting.json', 'transcript.json']) {
        if (isSymlink(path.join(mdir, f))) {
          skipped.push({ path: `${rel}/${f}`, reason: '符号链接（不跟随）' })
          continue
        }
        copyFile(path.join(mdir, f), path.join(destRoot, n, f), `${rel}/${f}`, files, produced, totals, skipped)
      }
    }
    return files.length - before
  }

  function readKeyMaterial(): Buffer[] {
    const out: Buffer[] = []
    for (const f of [storePaths(deps.storeRoot).privateKeyFile, path.join(deps.storeRoot, 'cloud-token.enc')]) {
      try {
        const b = readRegular(f, 1024 * 1024)
        if (b && b.length) out.push(b)
      } catch {
        /* unreadable: nothing to compare */
      }
    }
    return out
  }

  /** C21: stream the staged backup dir (manifest first, then manifest order) into one encrypted file. */
  async function writeEncrypted(workDir: string, manifest: BackupManifest, finalFile: string, pass: string): Promise<number> {
    const tmpFile = path.join(path.dirname(finalFile), `.${path.basename(finalFile)}.tmp-${randomBytes(4).toString('hex')}`)
    const fd = fs.openSync(tmpFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE)
    let ok = false
    try {
      const enc = await EncryptWriter.open(fd, pass, { kdf: deps.kdf })
      const tar = new ContainerWriter(enc)
      const manifestPath = path.join(workDir, MANIFEST_FILE)
      tar.addFile(MANIFEST_FILE, manifestPath, fs.statSync(manifestPath).size)
      const sigPath = path.join(workDir, SIG_FILE)
      if (fs.existsSync(sigPath)) tar.addFile(SIG_FILE, sigPath, fs.statSync(sigPath).size)
      for (const f of manifest.files) tar.addFile(f.path, path.join(workDir, ...f.path.split('/')), f.bytes)
      tar.end()
      enc.finish()
      fs.fsyncSync(fd)
      ok = true
    } finally {
      fs.closeSync(fd)
      if (!ok) fs.rmSync(tmpFile, { force: true })
    }
    try {
      fs.chmodSync(tmpFile, FILE_MODE)
      if (fs.existsSync(finalFile)) throw new BackupError('unknown', tr('The target backup file already exists.', '目标备份文件已存在。'))
      fs.renameSync(tmpFile, finalFile)
    } catch (e) {
      fs.rmSync(tmpFile, { force: true })
      throw e
    }
    return fs.statSync(finalFile).size
  }

  async function exportTo(parentDir: string, opts: ExportOptions): Promise<BackupExportResult> {
    const encrypt = typeof opts.passphrase === 'string'
    if (encrypt) {
      try {
        checkPassphrase(opts.passphrase!)
      } catch (e) {
        throw new BackupError('unknown', e instanceof Error ? e.message : String(e))
      }
    }
    const parent = checkParent(parentDir)
    const bin = opts.withoutModel ? null : deps.persomeBin()
    if (!opts.withoutModel && !bin) {
      throw new BackupError('runtime_missing', tr('The persome command-line tool was not found, so the model snapshot cannot be exported. Check "Exclude model snapshot" to back up only Navalia data.', '没有找到 persome 命令行工具，无法导出模型快照。可勾选“不包含模型快照”只备份 Navalia 数据。'))
    }
    const t = now()
    const taken = (n: string): boolean => fs.existsSync(path.join(parent, n)) || fs.existsSync(path.join(parent, `${n}.${ENC_EXT}`))
    let name = `navalia-backup-${stamp(t)}`
    for (let i = 2; taken(name); i++) {
      if (i > 999) throw new BackupError('unknown', tr('Too many backup folders with the same name.', '同名备份目录过多。'))
      name = `navalia-backup-${stamp(t)}-${i}`
    }
    const finalDir = path.join(parent, name)
    const finalFile = path.join(parent, `${name}.${ENC_EXT}`)
    // Plain: temp dir next to the target (same filesystem → atomic rename). Encrypted: the plaintext is
    // staged in a private dir inside the Lens Store and never touches the target folder.
    let tmp: string
    if (encrypt) {
      ensureSecureDir(deps.storeRoot)
      tmp = path.join(deps.storeRoot, `${WORK_PREFIX}${randomBytes(6).toString('hex')}`)
    } else {
      tmp = path.join(parent, `.${name}.tmp-${randomBytes(4).toString('hex')}`)
    }
    fs.mkdirSync(tmp, { mode: DIR_MODE })
    try {
      fs.chmodSync(tmp, DIR_MODE)
      const files: BackupFileEntry[] = []
      const produced: Array<{ rel: string; data: Buffer }> = []
      const skipped: BackupManifest['skipped'] = []
      let model: BackupManifest['model_snapshot'] = { status: 'not_requested', args: null, exit_code: null }

      // 1. Model snapshot through the Runtime CLI (redacted by default; `--raw` is never passed).
      if (bin) {
        const out = path.join(tmp, MODEL_SNAPSHOT_FILE)
        const args = ['model', 'export', '--out', out]
        const r = await exec(bin, args, { env: { ...process.env, PERSOME_ROOT: deps.runtimeRoot() }, timeoutMs: MODEL_EXPORT_TIMEOUT_MS })
        const shownArgs = args.map((a) => (a === out ? `<backup>/${MODEL_SNAPSHOT_FILE}` : a))
        if (r.code !== 0) {
          const err = redactForDisplay(r.stderr.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')).trim().slice(-2000)
          throw new BackupError(
            'unknown',
            tr(
              `Model snapshot export failed: persome ${shownArgs.join(' ')} exit code ${r.code ?? 'none'}${r.signal ? ` (signal ${r.signal})` : ''}${err ? `\n${err}` : ''}`,
              `模型快照导出失败：persome ${shownArgs.join(' ')} 退出码 ${r.code ?? '无'}${r.signal ? `（信号 ${r.signal}）` : ''}${err ? `\n${err}` : ''}`
            )
          )
        }
        const data = readRegular(out, limits.maxSnapshotBytes)
        if (!data) throw new BackupError('unknown', tr('persome model export reported success but produced no snapshot file.', 'persome model export 返回成功，但没有生成快照文件。'))
        try {
          const v = JSON.parse(data.toString('utf8')) as unknown
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
        } catch {
          throw new BackupError('unknown', tr('The model snapshot is not a valid JSON object.', '模型快照不是合法的 JSON 对象。'))
        }
        fs.chmodSync(out, FILE_MODE)
        files.push({ path: MODEL_SNAPSHOT_FILE, bytes: data.length, sha256: sha256(data) })
        produced.push({ rel: MODEL_SNAPSHOT_FILE, data })
        model = { status: 'included', args: shownArgs, exit_code: r.code }
      }

      // 2. Lens Store allowlist.
      const lensDir = path.join(tmp, 'lens')
      mkdirSecure(lensDir)
      const totals = { bytes: 0 }
      for (const d of ALLOWED_DIRS) {
        const src = path.join(deps.storeRoot, d)
        let st: fs.Stats
        try {
          st = fs.lstatSync(src)
        } catch {
          continue
        }
        if (!st.isDirectory()) {
          skipped.push({ path: `lens/${d}`, reason: st.isSymbolicLink() ? '符号链接（不跟随）' : '不是目录' })
          continue
        }
        mkdirSecure(path.join(lensDir, d))
        copyTree(src, path.join(lensDir, d), `lens/${d}`, files, skipped, produced, totals, 1)
      }
      for (const f of ALLOWED_FILES) {
        const src = path.join(deps.storeRoot, f)
        if (!fs.existsSync(src) && !isSymlink(src)) continue
        copyFile(src, path.join(lensDir, f), `lens/${f}`, files, produced, totals, skipped)
      }

      // 2b. X8: Access log, only on explicit opt-in.
      let accessLog: NonNullable<BackupManifest['access_log']> = { status: 'not_requested', rows: null, warning: null }
      if (opts.includeAccessLog === true) {
        const dump = dumpAccessLog()
        if (totals.bytes + dump.data.length > limits.maxLensBytes) throw new BackupError('unknown', tr('The Access log exceeds the backup total size limit. Aborted.', 'Access log 超过备份总量上限，已中止。'))
        if (dump.data.length > limits.maxFileBytes) throw new BackupError('unknown', tr(`The Access log export exceeds the per-file limit of ${limits.maxFileBytes} bytes. Aborted.`, `Access log 导出超过单文件上限 ${limits.maxFileBytes} 字节，已中止。`))
        fs.writeFileSync(path.join(tmp, ...ACCESS_LOG_FILE.split('/')), dump.data, { mode: FILE_MODE, flag: 'wx' })
        totals.bytes += dump.data.length
        files.push({ path: ACCESS_LOG_FILE, bytes: dump.data.length, sha256: sha256(dump.data) })
        produced.push({ rel: ACCESS_LOG_FILE, data: dump.data })
        accessLog = { status: 'included', rows: dump.rows, warning: ACCESS_LOG_WARNING }
      }

      // 2c. C21: opt-in user data, each default off.
      const want: Record<UserDataKind, boolean> = { chat: opts.includeChat === true, meetings: opts.includeMeetings === true, moments: opts.includeMoments === true }
      const userData = { chat: 0, meetings: 0, moments: 0 }
      for (const k of USER_DATA_KINDS) if (want[k]) userData[k] = copyUserData(k, lensDir, files, produced, totals, skipped)

      // 3. Excluded: fixed list + anything else found at the store root.
      const excluded = BACKUP_EXCLUDED.map((e) => ({ path: e.path, reason: e.reason }))
      const known = new Set<string>([
        ...ALLOWED_DIRS,
        ...ALLOWED_FILES,
        'identity',
        'grants.json',
        'audit.db',
        'het.db',
        'import',
        'connectors',
        'onboarding.json',
        'cloud-token.enc',
        'cloud.json',
        ...USER_DATA_KINDS
      ])
      try {
        for (const n of fs.readdirSync(deps.storeRoot).sort()) {
          if (known.has(n) || n.startsWith(WORK_PREFIX) || n.startsWith(RESTORE_PREFIX)) continue
          if (/^(audit|het)\.db-(wal|shm|journal)$/.test(n)) continue
          excluded.push({ path: n, reason: '不在备份白名单内' })
        }
      } catch {
        /* store root missing: nothing to list */
      }

      // 4. Manifest.
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        format_version: BACKUP_FORMAT_VERSION,
        created_at: new Date(t).toISOString(),
        app_version: deps.appVersion?.() ?? null,
        files,
        model_snapshot: model,
        excluded: accessLog.status === 'included' ? excluded.filter((e) => e.path !== 'audit.db') : excluded,
        skipped,
        notes: [MODEL_SNAPSHOT_NOTE, ...(accessLog.status === 'included' ? [ACCESS_LOG_WARNING] : [])],
        access_log: accessLog,
        includes_access_log: accessLog.status === 'included',
        includes_user_data: want
      }
      ManifestSchema.parse(manifest)
      const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      fs.writeFileSync(path.join(tmp, MANIFEST_FILE), manifestBuf, { mode: FILE_MODE, flag: 'wx' })
      produced.push({ rel: MANIFEST_FILE, data: manifestBuf })
      // C21: sign the manifest (which lists every file's sha256) with the Lens identity key, if any.
      const signed = signManifest(deps.identity, manifest)
      if (signed.sig) {
        const sigBuf = Buffer.from(`${JSON.stringify(signed.sig, null, 2)}\n`, 'utf8')
        fs.writeFileSync(path.join(tmp, SIG_FILE), sigBuf, { mode: FILE_MODE, flag: 'wx' })
        produced.push({ rel: SIG_FILE, data: sigBuf })
      }

      // 5. Fail-closed secret scan over everything produced (before any encryption).
      const problems = scanForSecrets(produced, runtimeSecretValues(deps.runtimeRoot()), readKeyMaterial())
      if (problems.length) {
        throw new BackupError('unknown', tr(`Possible secrets detected in the backup. Aborted; no files were kept: ${problems.slice(0, 5).join('; ')}`, `备份中检测到疑似密钥，已中止且未保留任何文件：${problems.slice(0, 5).join('；')}`))
      }

      // 6. Publish atomically.
      let outPath = finalDir
      if (encrypt) {
        await writeEncrypted(tmp, manifest, finalFile, opts.passphrase!)
        outPath = finalFile
        fs.rmSync(tmp, { recursive: true, force: true })
      } else {
        if (fs.existsSync(finalDir)) throw new BackupError('unknown', tr('The target backup folder already exists.', '目标备份目录已存在。'))
        fs.renameSync(tmp, finalDir)
      }
      return {
        cancelled: false,
        path: outPath,
        files: files.length,
        bytes: files.reduce((a, f) => a + f.bytes, 0),
        modelSnapshot: model.status,
        accessLogRows: accessLog.rows,
        excluded: manifest.excluded,
        skipped,
        encrypted: encrypt,
        userData,
        signed: signed.sig !== null,
        signReason: signed.reason
      }
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true })
      if (e instanceof BackupError) throw e
      throw new BackupError('unknown', tr(`Backup failed; no files were kept: ${e instanceof Error ? e.message : String(e)}`, `备份失败，未保留任何文件：${e instanceof Error ? e.message : String(e)}`))
    }
  }

  function isSymlink(p: string): boolean {
    try {
      return fs.lstatSync(p).isSymbolicLink()
    } catch {
      return false
    }
  }

  /** Validate a backup directory completely; throws on the first problem. Writes nothing. */
  function validate(dirInput: string, encrypted = false, displayName?: string): ValidatedBackup {
    if (!path.isAbsolute(dirInput)) throw new BackupError('unknown', tr('The backup folder must be an absolute path.', '备份目录必须是绝对路径。'))
    let st: fs.Stats
    try {
      st = fs.lstatSync(dirInput)
    } catch {
      throw new BackupError('not_found', tr('The backup folder does not exist.', '备份目录不存在。'))
    }
    if (!st.isDirectory()) throw new BackupError('schema', tr('The selected location is not a folder (or is a symlink).', '所选位置不是目录（或是符号链接）。'))
    const dir = dirInput
    const name = displayName ?? path.basename(dir)
    let manifestBuf: Buffer | null
    try {
      manifestBuf = readRegular(path.join(dir, MANIFEST_FILE), MAX_MANIFEST_BYTES)
    } catch {
      throw new BackupError('schema', tr('manifest.json is too large or unreadable.', 'manifest.json 过大或无法读取。'))
    }
    if (!manifestBuf) throw new BackupError('schema', tr('Not a Navalia backup: manifest.json is missing.', '不是 Navalia 备份：缺少 manifest.json。'))
    const manifest = parseManifest(manifestBuf)
    const seen = new Set<string>()
    const data = new Map<string, Buffer>()
    let lensBytes = 0
    for (const f of manifest.files) {
      if (seen.has(f.path)) throw new BackupError('schema', tr(`Duplicate path in manifest: ${f.path}`, `manifest 中有重复路径：${f.path}`))
      seen.add(f.path)
      const cap = f.path === MODEL_SNAPSHOT_FILE ? limits.maxSnapshotBytes : limits.maxFileBytes
      if (f.bytes > cap) throw new BackupError('schema', tr(`File exceeds the size limit: ${f.path}`, `文件超过大小上限：${f.path}`))
      const abs = path.join(dir, ...f.path.split('/'))
      if (!isInside(abs, dir)) throw new BackupError('schema', tr(`Path escapes the backup: ${f.path}`, `路径越界：${f.path}`))
      // No symlinks anywhere along the path inside the backup.
      let cur = dir
      for (const seg of f.path.split('/').slice(0, -1)) {
        cur = path.join(cur, seg)
        let s: fs.Stats
        try {
          s = fs.lstatSync(cur)
        } catch {
          throw new BackupError('schema', tr(`Missing file: ${f.path}`, `缺少文件：${f.path}`))
        }
        if (!s.isDirectory()) throw new BackupError('schema', tr(`Path contains a symlink or non-folder: ${f.path}`, `路径含符号链接或非目录：${f.path}`))
      }
      if (f.path === MODEL_SNAPSHOT_FILE) {
        // Archive-only (never restored into the Runtime): verify size + sha256 in chunks.
        const h = hashRegular(abs, limits.maxSnapshotBytes)
        if (!h || h.bytes !== f.bytes || h.sha256 !== f.sha256) throw new BackupError('schema', tr(`File failed verification (possibly tampered with): ${f.path}`, `文件校验失败（可能被篡改）：${f.path}`))
        continue
      }
      let buf: Buffer | null
      try {
        buf = readRegular(abs, limits.maxFileBytes)
      } catch {
        throw new BackupError('schema', tr(`File exceeds the size limit: ${f.path}`, `文件超过大小上限：${f.path}`))
      }
      if (!buf) throw new BackupError('schema', tr(`File missing or a symlink: ${f.path}`, `缺少文件或为符号链接：${f.path}`))
      if (buf.length !== f.bytes || sha256(buf) !== f.sha256) throw new BackupError('schema', tr(`File failed verification (possibly tampered with): ${f.path}`, `文件校验失败（可能被篡改）：${f.path}`))
      lensBytes += buf.length
      if (lensBytes > limits.maxLensBytes) throw new BackupError('schema', tr('Navalia data in the backup exceeds the total size limit.', '备份中的 Navalia 数据超过总量上限。'))
      data.set(f.path, buf)
    }
    // S1-R4-06 (X8): the explicit flag (v3) must agree with the file list and access_log status.
    const hasLog = data.has(ACCESS_LOG_FILE)
    if (manifest.includes_access_log !== undefined && manifest.includes_access_log !== hasLog) {
      throw new BackupError('schema', tr(`manifest includes_access_log=${manifest.includes_access_log} does not match the backup contents.`, `manifest 的 includes_access_log=${manifest.includes_access_log} 与备份内容不一致。`))
    }
    if (manifest.access_log && (manifest.access_log.status === 'included') !== hasLog) {
      throw new BackupError('schema', tr('manifest access_log status does not match the backup contents.', 'manifest 的 access_log 状态与备份内容不一致。'))
    }
    // C21: user data files only when the manifest says that kind was opted in.
    for (const rel of data.keys()) {
      const k = userDataKind(rel)
      if (k && manifest.includes_user_data?.[k] !== true) throw new BackupError('schema', tr(`manifest does not declare ${k}, but the backup contains ${rel}.`, `manifest 未声明包含 ${k}，但备份里有 ${rel}。`))
    }
    // C21: signature. A present-but-failing signature means the manifest was changed after signing →
    // reject the whole backup (fail closed). Unsigned / foreign → accepted, restored as copies only.
    let sigBuf: Buffer | null
    try {
      sigBuf = readRegular(path.join(dir, SIG_FILE), MAX_SIG_BYTES)
    } catch {
      throw new BackupError('schema', tr('manifest.sig.json is too large. Rejected.', 'manifest.sig.json 过大，已拒绝。'))
    }
    if (!sigBuf && isSymlink(path.join(dir, SIG_FILE))) throw new BackupError('schema', tr('manifest.sig.json is a symlink. Rejected.', 'manifest.sig.json 是符号链接，已拒绝。'))
    const trust = evaluateTrust(deps.identity, JSON.parse(manifestBuf.toString('utf8')), sigBuf)
    if (trust.mode === 'invalid') throw new BackupError('schema', tr(`The backup signature is invalid. Rejected; nothing was restored: ${trust.reason}`, `备份签名无效，已拒绝，没有恢复任何内容：${trust.reason}`))
    const manifestHash = sha256(sigBuf ? Buffer.concat([manifestBuf, Buffer.from('\0'), sigBuf]) : manifestBuf)
    return { dir, name, encrypted, manifest, manifestHash, trust, data }
  }

  function parseManifest(buf: Buffer): BackupManifest {
    try {
      return ManifestSchema.parse(JSON.parse(buf.toString('utf8'))) as BackupManifest
    } catch (e) {
      const detail = e instanceof z.ZodError ? e.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : tr('not valid JSON', '不是合法 JSON')
      throw new BackupError('schema', tr(`manifest.json is invalid: ${detail}`, `manifest.json 不合法：${detail}`))
    }
  }

  // ---- staging (encrypted archives) ---------------------------------------------------------

  const inspections = new Map<string, { dir: string; manifestHash: string; staging: boolean; name: string; encrypted: boolean }>()

  function dropInspections(): void {
    for (const h of inspections.values()) if (h.staging) removeStaging(h.dir)
    inspections.clear()
  }

  function removeStaging(dir: string): void {
    // Only ever our own private dirs directly inside the store root.
    if (path.dirname(dir) === deps.storeRoot && path.basename(dir).startsWith(RESTORE_PREFIX)) fs.rmSync(dir, { recursive: true, force: true })
  }

  /** Startup sweep: plaintext leftovers of a crashed encrypted export / inspect. */
  function sweep(): void {
    let names: string[]
    try {
      names = fs.readdirSync(deps.storeRoot)
    } catch {
      return
    }
    for (const n of names) {
      if (n.startsWith(WORK_PREFIX) || n.startsWith(RESTORE_PREFIX)) fs.rmSync(path.join(deps.storeRoot, n), { recursive: true, force: true })
    }
  }
  sweep()

  /**
   * Decrypt `<file>` into a fresh private staging dir, checking every GCM tag, the container layout
   * (manifest first; every entry listed in the manifest with its exact size and sha256; nothing
   * extra; nothing missing). On any failure the staging dir is removed and nothing else is written.
   */
  async function decryptToStaging(file: string, pass: string): Promise<string> {
    if (!path.isAbsolute(file)) throw new BackupError('unknown', tr('The backup file must be an absolute path.', '备份文件必须是绝对路径。'))
    let fd: number
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      throw new BackupError(code === 'ENOENT' ? 'not_found' : 'schema', code === 'ELOOP' ? tr('The backup file is a symlink. Rejected.', '备份文件是符号链接，已拒绝。') : tr('Cannot open the backup file.', '无法打开备份文件。'))
    }
    ensureSecureDir(deps.storeRoot)
    const staging = path.join(deps.storeRoot, `${RESTORE_PREFIX}${randomBytes(6).toString('hex')}`)
    fs.mkdirSync(staging, { mode: DIR_MODE })
    try {
      if (!fs.fstatSync(fd).isFile()) throw new BackupError('schema', tr('The selected location is not a file.', '所选位置不是文件。'))
      let expected: Map<string, BackupFileEntry> | null = null
      let manifestParts: Buffer[] | null = null
      let cur: { rel: string; fd: number | null; hash: ReturnType<typeof createHash>; size: number; got: number } | null = null
      const seen = new Set<string>()
      let total = 0
      const reader = new ContainerReader({
        begin(rel, size) {
          if (expected === null) {
            if (rel !== MANIFEST_FILE || size > MAX_MANIFEST_BYTES) throw new BackupError('schema', tr('The first entry of the encrypted backup is not manifest.json.', '加密备份的第一项不是 manifest.json。'))
            manifestParts = []
            cur = { rel, fd: null, hash: createHash('sha256'), size, got: 0 }
            return
          }
          if (rel === SIG_FILE && !seen.has(rel)) {
            if (size > MAX_SIG_BYTES) throw new BackupError('schema', tr('manifest.sig.json is too large. Rejected.', 'manifest.sig.json 过大，已拒绝。'))
            seen.add(rel)
            const out = fs.openSync(path.join(staging, SIG_FILE), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, FILE_MODE)
            cur = { rel, fd: out, hash: createHash('sha256'), size, got: 0 }
            return
          }
          const e = expected.get(rel)
          if (!e || seen.has(rel)) throw new BackupError('schema', tr(`The encrypted backup contains a file not listed in the manifest, or a duplicate: ${rel.slice(0, 200)}`, `加密备份含 manifest 未列出或重复的文件：${rel.slice(0, 200)}`))
          if (size !== e.bytes) throw new BackupError('schema', tr(`File size does not match the manifest: ${rel}`, `文件大小与 manifest 不一致：${rel}`))
          total += size
          if (total > limits.maxLensBytes + limits.maxSnapshotBytes) throw new BackupError('schema', tr('The encrypted backup exceeds the total size limit.', '加密备份超过总量上限。'))
          seen.add(rel)
          const abs = path.join(staging, ...rel.split('/'))
          if (!isInside(abs, staging)) throw new BackupError('schema', tr(`Path escapes the backup: ${rel}`, `路径越界：${rel}`))
          mkdirSecure(path.dirname(abs))
          const out = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, FILE_MODE)
          cur = { rel, fd: out, hash: createHash('sha256'), size, got: 0 }
        },
        data(chunk) {
          const c = cur!
          c.hash.update(chunk)
          c.got += chunk.length
          if (c.fd === null) manifestParts!.push(Buffer.from(chunk))
          else {
            let off = 0
            while (off < chunk.length) off += fs.writeSync(c.fd, chunk, off, chunk.length - off)
          }
        },
        end() {
          const c = cur!
          cur = null
          if (c.fd === null) {
            const buf = Buffer.concat(manifestParts!)
            writeFileSecure(path.join(staging, MANIFEST_FILE), buf)
            const m = parseManifest(buf)
            expected = new Map(m.files.map((f) => [f.path, f]))
            return
          }
          fs.closeSync(c.fd)
          if (c.rel === SIG_FILE) return // verified against the manifest by validate()
          if (c.hash.digest('hex') !== expected!.get(c.rel)!.sha256) throw new BackupError('schema', tr(`File failed verification (possibly tampered with): ${c.rel}`, `文件校验失败（可能被篡改）：${c.rel}`))
        }
      })
      try {
        await decryptFile(fd, pass, (chunk) => reader.push(chunk))
        reader.finish()
      } finally {
        const c = cur as { fd: number | null } | null
        if (c && c.fd !== null) fs.closeSync(c.fd)
      }
      const exp = expected as Map<string, BackupFileEntry> | null
      if (!exp) throw new BackupError('schema', tr('The encrypted backup is missing manifest.json.', '加密备份缺少 manifest.json。'))
      const missing = [...exp.keys()].filter((k) => !seen.has(k) && k !== SIG_FILE)
      if (missing.length) throw new BackupError('schema', tr(`The encrypted backup is missing files: ${missing.slice(0, 3).join(', ')}`, `加密备份缺少文件：${missing.slice(0, 3).join('，')}`))
      return staging
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true })
      if (e instanceof BackupError) throw e
      if (e instanceof BackupCryptoError) throw new BackupError(e.code === 'bad_passphrase' ? 'unauthorized' : 'schema', e.message)
      throw new BackupError('schema', tr(`Cannot decrypt the backup: ${e instanceof Error ? e.message : String(e)}`, `无法解密备份：${e instanceof Error ? e.message : String(e)}`))
    } finally {
      fs.closeSync(fd)
    }
  }

  // ---- planning (shared by inspect preview and restore) ----------------------------------------

  interface WfVersion {
    version: number
    rel: string
    buf: Buffer
    wf: Workflow
  }
  interface WfPlan {
    id: string
    title: string
    action: WorkflowRestoreAction
    detail: string | null
    history: WfVersion[]
    /** Versions to write (restore: all; merge: only the newer ones; copy: all, re-stamped). */
    write: WfVersion[]
    copyId?: string
    copyHash?: string
  }

  function observedById(): Map<string, Workflow> {
    try {
      const list = deps.observedWorkflows ? deps.observedWorkflows() : readRuntimeSkills(deps.runtimeRoot()).workflows
      return new Map(list.map((w) => [w.id, w]))
    } catch {
      return new Map()
    }
  }

  function planWorkflows(v: ValidatedBackup): WfPlan[] {
    const byId = new Map<string, Array<{ version: number; rel: string }>>()
    for (const rel of v.data.keys()) {
      const m = /^lens\/workflows\/([^/]+)\/v(\d{6})\.json$/.exec(rel)
      if (!m) continue
      const list = byId.get(m[1]) ?? []
      list.push({ version: Number(m[2]), rel })
      byId.set(m[1], list)
    }
    const store = createWorkflowStore(deps.storeRoot)
    const hashes = new Map<string, string>()
    for (const w of store.listLatest()) for (const x of store.versions(w.id)) hashes.set(contentHash(x), w.id)
    const observed = observedById()
    const plans: WfPlan[] = []
    for (const [id, list] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      list.sort((a, b) => a.version - b.version)
      let history: WfVersion[]
      try {
        if (!WorkflowIdSchema.safeParse(id).success) throw new Error('id')
        history = list.map(({ version, rel }) => {
          const buf = v.data.get(rel)!
          const parsed = WorkflowSchema.safeParse(JSON.parse(buf.toString('utf8')))
          if (!parsed.success || parsed.data.id !== id || parsed.data.version !== version) throw new Error('schema')
          return { version, rel, buf, wf: parsed.data }
        })
      } catch {
        plans.push({ id, title: id, action: 'failed', detail: tr('Not a valid Workflow version file', '不是合法的 Workflow 版本文件'), history: [], write: [] })
        continue
      }
      const latest = history[history.length - 1]
      const title = latest.wf.title
      const local = store.versions(id)
      const toCopy = (why: string): WfPlan => {
        const h = contentHash(latest.wf)
        const dup = hashes.get(h)
        if (dup) return { id, title, action: 'duplicate', detail: tr(`${why}; identical content already in ${dup}`, `${why}；相同内容已在 ${dup}`), history, write: [] }
        let newId = `imp-${h.slice(0, 12)}`
        if (store.latest(newId)) newId = `${newId}~${h.slice(12, 20)}`
        if (store.latest(newId)) return { id, title, action: 'failed', detail: tr(`id ${newId} already exists`, `id ${newId} 已存在`), history, write: [] }
        hashes.set(h, newId)
        return { id, title, action: 'copy', detail: tr(`${why}; saved as ${newId}`, `${why}；另存为 ${newId}`), history, write: history, copyId: newId, copyHash: h }
      }
      if (v.trust.mode !== 'mine') {
        plans.push(toCopy(tr(`${v.trust.reason}: can only be restored as an imported copy (original ID not used)`, `${v.trust.reason}：只能以导入副本恢复（不使用原 ID）`)))
        continue
      }
      if (!local.length) {
        const o = observed.get(id)
        if (o && contentHash(history[0].wf) !== contentHash(o)) {
          plans.push(toCopy(tr('The Workflow with this ID that Runtime currently sees has different content (the backup does not replace it)', 'Runtime 当前观察到的同 ID Workflow 内容不同（不让备份顶替）')))
          continue
        }
        plans.push({ id, title, action: 'restore', detail: null, history, write: history })
        continue
      }
      const localByVersion = new Map<number, { wf: Workflow; buf: Buffer | null }>()
      for (const w of local) {
        let buf: Buffer | null = null
        try {
          buf = readRegular(path.join(store.dir, id, `v${String(w.version).padStart(6, '0')}.json`), limits.maxFileBytes)
        } catch {
          buf = null
        }
        localByVersion.set(w.version, { wf: w, buf })
      }
      const same = (h: WfVersion): boolean => {
        const l = localByVersion.get(h.version)!
        return (l.buf !== null && l.buf.equals(h.buf)) || (contentHash(l.wf) === contentHash(h.wf) && l.wf.provenance.kind === h.wf.provenance.kind)
      }
      const diverged = history.filter((h) => localByVersion.has(h.version)).some((h) => !same(h))
      if (diverged) {
        plans.push(toCopy(tr('Version history differs from the local one with the same ID (local versions are not overwritten)', '与本机同 ID 的版本历史不一致（不覆盖本机版本）')))
        continue
      }
      const localMax = local[local.length - 1].version
      const newer = history.filter((h) => h.version > localMax)
      if (newer.length) plans.push({ id, title, action: 'merge', detail: tr(`Append v${newer[0].version}–v${newer[newer.length - 1].version}`, `追加 v${newer[0].version}–v${newer[newer.length - 1].version}`), history, write: newer })
      else if (localMax > latest.version) plans.push({ id, title, action: 'local_newer', detail: tr(`This Mac already has v${localMax}; the backup's latest is v${latest.version}. Keeping the local one`, `本机已有 v${localMax}，备份最新为 v${latest.version}，保留本机`), history, write: [] })
      else plans.push({ id, title, action: 'unchanged', detail: null, history, write: [] })
    }
    return plans
  }

  function preview(v: ValidatedBackup): RestorePreview {
    const rels = [...v.data.keys()]
    let valid = 0
    let invalid = 0
    for (const rel of rels.filter((r) => r.startsWith('lens/cards/'))) {
      const m = CARD_REL_RE.exec(rel)
      const vr = m ? verifyCardText(v.data.get(rel)!.toString('utf8')) : null
      if (vr && vr.valid && vr.card.card.card_id === m![2]) valid++
      else invalid++
    }
    const userData = { chat: 0, meetings: 0, moments: 0 }
    for (const rel of rels) {
      const k = userDataKind(rel)
      if (k === 'meetings') {
        if (rel.endsWith('/meeting.json')) userData.meetings++
      } else if (k) userData[k]++
    }
    return {
      workflows: planWorkflows(v).map((p) => ({ id: p.id, title: p.title, action: p.action, versions: p.write.length, detail: p.detail })),
      cards: { valid, invalid },
      peers: rels.filter((p) => /^lens\/peers\/[0-9a-f]{64}\.json$/.test(p)).length,
      userData,
      accessLog: v.data.has(ACCESS_LOG_FILE),
      trust: v.trust
    }
  }

  function inspectValidated(v: ValidatedBackup, staging: boolean): BackupInspection {
    const id = randomBytes(12).toString('hex')
    dropInspections()
    inspections.set(id, { dir: v.dir, manifestHash: v.manifestHash, staging, name: v.name, encrypted: v.encrypted })
    const paths = v.manifest.files.map((f) => f.path)
    return {
      cancelled: false,
      inspectionId: id,
      name: v.name,
      createdAt: v.manifest.created_at,
      appVersion: v.manifest.app_version,
      counts: {
        workflows: new Set(paths.filter((p) => p.startsWith('lens/workflows/')).map((p) => p.split('/')[2])).size,
        peers: paths.filter((p) => /^lens\/peers\/[0-9a-f]{64}\.json$/.test(p)).length,
        cards: paths.filter((p) => p.startsWith('lens/cards/')).length,
        files: paths.length,
        bytes: v.manifest.files.reduce((a, f) => a + f.bytes, 0),
        workflowVersions: paths.filter((p) => /^lens\/workflows\/[^/]+\/v\d{6}\.json$/.test(p)).length
      },
      modelSnapshot: v.manifest.model_snapshot.status === 'included',
      accessLog: paths.includes(ACCESS_LOG_FILE),
      notes: v.manifest.notes ?? [],
      encrypted: v.encrypted,
      trust: v.trust,
      preview: preview(v)
    }
  }

  function inspect(dir: string): BackupInspection {
    dropInspections()
    return inspectValidated(validate(dir), false)
  }

  async function inspectEncrypted(file: string, pass: string): Promise<BackupInspection> {
    dropInspections()
    try {
      checkPassphrase(pass)
    } catch (e) {
      throw new BackupError('unauthorized', e instanceof Error ? e.message : String(e))
    }
    const staging = await decryptToStaging(file, pass)
    try {
      return inspectValidated(validate(staging, true, path.basename(file).replace(new RegExp(`\\.(?:${ENC_EXT}|${PREV_ENC_EXT}|${LEGACY_ENC_EXT})$`), '')), true)
    } catch (e) {
      removeStaging(staging)
      throw e
    }
  }

  /** Human-readable plan for the main-side native confirm (counts only; no paths). */
  function describe(inspectionId: string): string {
    const held = inspections.get(inspectionId)
    if (!held) return tr('Choose and verify the backup again first.', '请先重新选择并校验备份。')
    let p: RestorePreview
    try {
      p = preview(validate(held.dir, held.encrypted, held.name))
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    return restoreSummary(p)
  }

  function restore(inspectionId: string): RestoreReport {
    const held = inspections.get(inspectionId)
    if (!held) throw new BackupError('not_found', tr('Choose and verify the backup folder again first.', '请先重新选择并校验备份目录。'))
    inspections.delete(inspectionId)
    try {
      // Re-validate now (the directory may have changed since inspection).
      const v = validate(held.dir, held.encrypted, held.name)
      if (v.manifestHash !== held.manifestHash) throw new BackupError('schema', tr('The backup changed after verification. Choose it again.', '备份在校验后发生了变化，请重新选择。'))
      return restoreValidated(v)
    } finally {
      if (held.staging) removeStaging(held.dir)
    }
  }

  function restoreValidated(v: ValidatedBackup): RestoreReport {
    // Workflows: merged by version (C21).
    const wfItems = restoreWorkflows(v)

    // Peers: re-import every stored card (oldest first) through signature verification.
    const peerStore = createPeerStore({ storeRoot: deps.storeRoot })
    const peerItems: RestoreReport['peers']['items'] = []
    const counts = { added: 0, updated: 0, unchanged: 0, failed: 0 }
    for (const [rel, buf] of [...v.data.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const m = /^lens\/peers\/([0-9a-f]{64})\.json$/.exec(rel)
      if (!m) continue
      const fp = m[1]
      let cards: unknown[]
      try {
        const parsed = PeerBackupSchema.parse(JSON.parse(buf.toString('utf8')))
        cards = parsed.history.map((h) => h.card)
      } catch {
        counts.failed++
        peerItems.push({ fingerprint: fp, outcome: 'failed', detail: tr('Not a valid peer record', '不是合法的朋友记录') })
        continue
      }
      // S2-SEC L3: checked BEFORE importText. Any card that verifies but was issued by a key other
      // than the file name's fingerprint fails the whole record and nothing is written. (Cards that
      // do not verify are still refused by importText below, as before.)
      const mismatch = cards.some((c) => {
        const vc = verifyCardText(JSON.stringify(c))
        return vc.valid && vc.card.card.issuer.fingerprint !== fp
      })
      if (mismatch) {
        counts.failed++
        peerItems.push({ fingerprint: fp, outcome: 'failed', detail: tr('Card signer does not match the file name; not imported', '卡片签名者与文件名不一致，未导入') })
        continue
      }
      const issuedAt = (c: unknown): number => {
        const s = (c as { card?: { issued_at?: unknown } })?.card?.issued_at
        return typeof s === 'string' ? Date.parse(s) || 0 : 0
      }
      cards.sort((a, b) => issuedAt(a) - issuedAt(b))
      let outcome: string = 'unchanged'
      let detail: string | null = null
      let failed = false
      for (const c of cards) {
        const r = peerStore.importText(JSON.stringify(c))
        if (!r.ok) {
          failed = true
          detail = `${r.reason}${r.detail ? `：${redactForDisplay(String(r.detail)).slice(0, 200)}` : ''}`
          continue
        }
        if (r.peer.fingerprint !== fp) {
          failed = true
          detail = tr('Card signer does not match the file name', '卡片签名者与文件名不一致')
          continue
        }
        if (r.outcome === 'added') outcome = 'added'
        else if (r.outcome === 'updated' && outcome !== 'added') outcome = 'updated'
      }
      if (failed && outcome === 'unchanged') {
        counts.failed++
        peerItems.push({ fingerprint: fp, outcome: 'failed', detail })
      } else {
        counts[outcome as 'added' | 'updated' | 'unchanged']++
        peerItems.push({ fingerprint: fp, outcome, detail })
      }
    }

    const cards = restoreCards(v)
    const userData = restoreUserData(v)

    const notRestored: string[] = []
    if (v.manifest.model_snapshot.status === 'included') notRestored.push(tr('Model snapshot (redacted, archive only; Navalia does not write the Runtime database, restore it on the Runtime side)', '模型快照（已脱敏，仅供存档；Navalia 不写 Runtime 数据库，需由 Runtime 侧恢复）'))
    if (v.data.has(ACCESS_LOG_FILE)) notRestored.push(tr('Access log (archive only, not written back to this Mac\'s Access log)', 'Access log（仅存档，不写回本机 Access log）'))
    if (v.data.has('lens/settings.json') || v.data.has('lens/het-settings.json')) notRestored.push(tr('Navalia / HET settings (current settings kept)', 'Navalia / HET 设置（保留当前设置）'))

    const n = (o: RestoreReport['workflows']['items'][number]['outcome']): number => wfItems.filter((i) => i.outcome === o).length
    return {
      name: v.name,
      workflows: {
        imported: n('imported'),
        duplicates: n('duplicate'),
        failed: n('failed'),
        restored: n('restored'),
        merged: n('merged'),
        unchanged: n('unchanged'),
        localNewer: n('local_newer'),
        items: wfItems
      },
      peers: { ...counts, items: peerItems },
      cards,
      trust: v.trust,
      accessLog: { included: v.data.has(ACCESS_LOG_FILE), rows: v.data.has(ACCESS_LOG_FILE) ? (v.manifest.access_log?.rows ?? null) : null },
      ...(USER_DATA_KINDS.some((k) => userData[k].restored + userData[k].unchanged + userData[k].skipped > 0) ? { userData } : {}),
      notRestored
    }
  }

  function restoreWorkflows(v: ValidatedBackup): RestoreReport['workflows']['items'] {
    const store = createWorkflowStore(deps.storeRoot)
    const at = new Date(now()).toISOString()
    const items: RestoreReport['workflows']['items'] = []
    const vfile = (n: number): string => `v${String(n).padStart(6, '0')}.json`
    for (const p of planWorkflows(v)) {
      const item = (outcome: RestoreReport['workflows']['items'][number]['outcome'], detail: string | null, versions: number, id?: string): void => {
        items.push({ title: p.title, outcome, detail, versions, ...(id ? { id } : {}) })
      }
      if (p.action === 'failed') {
        item('failed', p.detail, 0)
        continue
      }
      if (p.action === 'unchanged' || p.action === 'local_newer') {
        item(p.action, p.detail, 0, p.id)
        continue
      }
      if (p.action === 'duplicate') {
        item('duplicate', p.detail, 0)
        continue
      }
      if (p.action === 'merge') {
        // Append only versions newer than every local one; never replace an existing file.
        try {
          ensureSecureDir(path.join(store.dir, p.id))
          for (const w of p.write) {
            const f = path.join(store.dir, p.id, vfile(w.version))
            if (fs.existsSync(f)) throw new Error(tr(`v${w.version} already exists`, `v${w.version} 已存在`))
            writeFileSecure(f, w.buf)
          }
        } catch (e) {
          item('failed', tr(`Write failed: ${e instanceof Error ? e.message : String(e)}`, `写入失败：${e instanceof Error ? e.message : String(e)}`), 0, p.id)
          continue
        }
        item('merged', p.detail, p.write.length, p.id)
        continue
      }
      // 'restore' (byte-for-byte, original id) and 'copy' (re-stamped, new id): whole history under a
      // temp dir name the store ignores, then renamed into place (no half-restored history).
      const targetId = p.action === 'restore' ? p.id : p.copyId!
      let payload: Array<{ version: number; data: Buffer | string }>
      if (p.action === 'restore') {
        payload = p.write.map((w) => ({ version: w.version, data: w.buf }))
      } else {
        const imported = (w: Workflow): Workflow => ({ ...w, id: targetId, evidence: w.evidence.map((e) => ({ ...e, origin: 'imported' as const })) })
        // S1-R3-SEC L4: EVERY copied version is re-stamped (provenance 'imported', source import_file).
        payload = p.write.map(({ wf: w }, i) => {
          const r = WorkflowSchema.parse({
            ...imported(w),
            provenance: provenance('imported', {
              imported_at: at,
              from: v.name,
              observed_at: w.provenance.observed_at,
              original_id: w.id,
              original_version: w.version,
              original_kind: w.provenance.kind
            }),
            source: source('import_file', { path: w.source.path, entry_ids: w.source.entry_ids, stage: w.source.stage, confidence: w.source.confidence }),
            ...(i === p.write.length - 1 ? { updated_at: at } : {})
          })
          return { version: r.version, data: `${JSON.stringify(r, null, 2)}\n` }
        })
      }
      ensureSecureDir(store.dir)
      const tmpDir = path.join(store.dir, `.restore-${randomBytes(6).toString('hex')}`)
      try {
        if (fs.existsSync(path.join(store.dir, targetId))) throw new Error(tr(`id ${targetId} already exists`, `id ${targetId} 已存在`))
        ensureSecureDir(tmpDir)
        for (const w of payload) writeFileSecure(path.join(tmpDir, vfile(w.version)), w.data)
        fs.renameSync(tmpDir, path.join(store.dir, targetId))
      } catch (e) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        item('failed', tr(`Write failed: ${e instanceof Error ? e.message : String(e)}`, `写入失败：${e instanceof Error ? e.message : String(e)}`), 0)
        continue
      }
      item(p.action === 'restore' ? 'restored' : 'imported', p.action === 'restore' ? null : p.detail, payload.length, targetId)
    }
    return items
  }

  /** C21: opt-in user data — written only where absent; an existing different file is never overwritten. */
  function restoreUserData(v: ValidatedBackup): NonNullable<RestoreReport['userData']> {
    const out = { chat: { restored: 0, unchanged: 0, skipped: 0 }, meetings: { restored: 0, unchanged: 0, skipped: 0 }, moments: { restored: 0, unchanged: 0, skipped: 0 } }
    for (const [rel, buf] of [...v.data.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const k = userDataKind(rel)
      if (!k) continue
      const dest = path.join(deps.storeRoot, ...rel.split('/').slice(1))
      if (!isInside(dest, deps.storeRoot)) {
        out[k].skipped++
        continue
      }
      let existing: Buffer | null = null
      try {
        existing = readRegular(dest, limits.maxFileBytes)
      } catch {
        existing = null
      }
      if (existing && existing.equals(buf)) {
        out[k].unchanged++
        continue
      }
      if (existing || isSymlink(dest)) {
        out[k].skipped++
        continue
      }
      try {
        ensureSecureDir(path.dirname(dest))
        writeFileSecure(dest, buf)
        out[k].restored++
      } catch {
        out[k].skipped++
      }
    }
    return out
  }

  function currentFingerprint(): string | null {
    try {
      const raw = readFileIfExists(storePaths(deps.storeRoot).identityFile)
      if (!raw) return null
      const fp = (JSON.parse(raw.toString('utf8')) as { fingerprint?: unknown }).fingerprint
      return typeof fp === 'string' ? fp : null
    } catch {
      return null
    }
  }

  function restoreCards(v: ValidatedBackup): NonNullable<RestoreReport['cards']> {
    const cardsDir = storePaths(deps.storeRoot).cardsDir
    const current = currentFingerprint()
    const out: NonNullable<RestoreReport['cards']> = { restored: 0, archived: 0, unchanged: 0, failed: 0, items: [] }
    for (const [rel, buf] of [...v.data.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!rel.startsWith('lens/cards/')) continue
      const m = CARD_REL_RE.exec(rel)
      const cardId = m?.[2] ?? rel.slice('lens/cards/'.length)
      const fail = (detail: string): void => {
        out.failed++
        out.items.push({ cardId, outcome: 'failed', detail })
      }
      if (!m) {
        fail(tr('Not a card file (card_<id>.navaliacard)', '不是卡片文件（card_<id>.navaliacard）'))
        continue
      }
      const vr = verifyCardText(buf.toString('utf8'))
      if (!vr.valid) {
        fail(tr(`Signature check failed: ${vr.reason}`, `验签失败：${vr.reason}`))
        continue
      }
      if (vr.card.card.card_id !== cardId) {
        fail(tr('Card ID does not match the file name', '卡片 ID 与文件名不一致'))
        continue
      }
      const mine = current !== null && vr.card.card.issuer.fingerprint === current
      const name = `${cardId}.navaliacard`
      const dest = mine ? path.join(cardsDir, name) : path.join(cardsDir, 'archive', name)
      const existing = [path.join(cardsDir, name), path.join(cardsDir, 'archive', name)].map((p) => readFileIfExists(p))
      if (existing.some((b) => b && b.equals(buf))) {
        out.unchanged++
        out.items.push({ cardId, outcome: 'unchanged', detail: null })
        continue
      }
      if (existing.some((b) => b)) {
        fail(tr('This Mac already has a card with the same ID but different content; not overwritten', '本机已有同 ID 但内容不同的卡片，未覆盖'))
        continue
      }
      try {
        ensureSecureDir(path.dirname(dest))
        writeFileSecure(dest, buf)
      } catch (e) {
        fail(tr(`Write failed: ${e instanceof Error ? e.message : String(e)}`, `写入失败：${e instanceof Error ? e.message : String(e)}`))
        continue
      }
      if (mine) {
        out.restored++
        out.items.push({ cardId, outcome: 'restored', detail: null })
      } else {
        out.archived++
        out.items.push({ cardId, outcome: 'archived', detail: tr('Issuer is not the current identity: saved to cards/archive/ and never offered to Agents as "your card"', '签发者不是当前身份：存入 cards/archive/，不会作为“你的卡片”提供给 Agent') })
      }
    }
    return out
  }

  return {
    exportTo: (parentDir: string, opts: ExportOptions) => exclusive(() => exportTo(parentDir, opts)),
    inspect: (dir: string) => exclusive(() => inspect(dir)),
    /** C21: decrypt a `.navaliabackup` file into private staging and validate it. Writes nothing into the Lens data. */
    inspectEncrypted: (file: string, passphrase: string) => exclusive(() => inspectEncrypted(file, passphrase)),
    /** C21: counts-only plan text for the native confirm. */
    describe: (inspectionId: string) => describe(inspectionId),
    restore: (inspectionId: string) => exclusive(() => restore(inspectionId))
  }
}

/** C21: one-paragraph plan (counts only) used by the main-side native confirm. */
export function restoreSummary(p: RestorePreview): string {
  const c = (a: WorkflowRestoreAction): number => p.workflows.filter((w) => w.action === a).length
  const t = p.trust
  const parts = [
    t?.mode === 'mine'
      ? tr(
          `Signature: ${t.reason} (${(t.fingerprint ?? '').slice(0, 12)}…) → Workflows can be restored under their original IDs.`,
          `签名：${t.reason}（${(t.fingerprint ?? '').slice(0, 12)}…）→ Workflow 可按原 ID 恢复。`
        )
      : tr(
          `Signature: ${t?.reason ?? 'The backup is not signed'} → Workflows will only be restored as imported copies (imp-*), not under their original IDs.`,
          `签名：${t?.reason ?? '备份没有签名'} → Workflow 只会以导入副本（imp-*）恢复，不使用原 ID。`
        ),
    tr(
      `Workflows: restore under original ID ${c('restore')}, append new versions ${c('merge')}, keep newer local ${c('local_newer')}, identical ${c('unchanged')}, save diverged as copy ${c('copy')}${c('duplicate') ? `, already present ${c('duplicate')}` : ''}${c('failed') ? `, invalid ${c('failed')}` : ''}.`,
      `Workflow：按原 ID 恢复 ${c('restore')}，追加新版本 ${c('merge')}，本机较新保留 ${c('local_newer')}，相同 ${c('unchanged')}，分叉另存副本 ${c('copy')}${c('duplicate') ? `，已存在 ${c('duplicate')}` : ''}${c('failed') ? `，无效 ${c('failed')}` : ''}。`
    ),
    tr(
      `Cards: ${p.cards.valid} verified${p.cards.invalid ? `, ${p.cards.invalid} invalid will be skipped` : ''}. ${p.peers} peer records (each verified).`,
      `卡片：验签通过 ${p.cards.valid}${p.cards.invalid ? `，无效将跳过 ${p.cards.invalid}` : ''}。朋友记录 ${p.peers} 份（逐张验签）。`
    )
  ]
  const u = p.userData
  if (u.chat + u.meetings + u.moments)
    parts.push(
      tr(
        `Chats ${u.chat} · meeting transcripts ${u.meetings} · shared moments ${u.moments} (only items missing on this Mac are written).`,
        `聊天 ${u.chat} · 会议转写 ${u.meetings} · 共享时刻 ${u.moments}（只写入本机没有的）。`
      )
    )
  if (p.accessLog) parts.push(tr('Access log is archived only, not written back.', 'Access log 仅存档，不写回。'))
  parts.push(tr('No existing file on this Mac will be overwritten; identity keys and grants stay unchanged.', '不会覆盖本机已有的任何文件；身份密钥、授权不变。'))
  return parts.join('\n')
}

export type BackupService = ReturnType<typeof createBackupService>
