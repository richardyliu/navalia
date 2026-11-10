// S2-09 local subscription folder (DECISIONS X2).
//
// The user picks one local / iCloud Drive folder. Nothing happens until they press 「刷新」:
// then the folder's top level (non-recursive) is scanned once for `.navaliacard` and `.navaliaskill`
// files, each is verified offline and imported through the same paths as a manual import
// (peers store / signed skill share). Files are deduped by sha256 in a ledger.
//
// S1-R4-06 (DECISIONS-ROUND3 X2): an OPT-IN periodic scan (`autoScan`, default off, interval
// ≥ MIN_AUTO_SCAN_MINUTES) runs this same `refresh()` from `subscription-scheduler.ts`. Still no
// file watcher, no recursion, no network. Symlinks are never followed; only regular files are
// read; per-file, per-refresh byte and count caps apply.
//
// Config + ledger: `<storeRoot>/peers/subscription.json` (0600, dir 0700). A corrupt file reads as
// the default (folder unset, subscription and auto-scan off).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { SkillShareError, verifySkillText } from '../skillshare/package'
import { redactForDisplay } from '../import/redact'
import type { SkillShare } from '../skillshare/service'
import { isInside, readFileIfExists, realOrResolved, writeFileSecure } from '../store/paths'
import type {
  SubscriptionFileReport,
  SubscriptionOutcome,
  SubscriptionRefreshReport,
  SubscriptionSkipReason,
  SubscriptionStatus
} from './api'
import { MAX_CARD_BYTES, type PeerStore } from './store'

export const CARD_EXT = '.navaliacard'
export const SKILL_EXT = '.navaliaskill'
/** Previous name (Grapple). */
export const PREV_CARD_EXT = '.grapplecard'
export const PREV_SKILL_EXT = '.grappleskill'
/** Pre-rename extensions, still picked up from subscription folders. */
export const LEGACY_CARD_EXT = '.persomecard'
export const LEGACY_SKILL_EXT = '.lensskill'
/** Candidate files handled per refresh (top level only). */
export const MAX_SUB_FILES = 200
/** Per-file cap; same order as the manual import caps (cards 2 MB, skills 2 MiB). */
export const MAX_SUB_FILE_BYTES = Math.min(MAX_CARD_BYTES, 2 * 1024 * 1024)
/** Total bytes read in one refresh. */
export const MAX_SUB_TOTAL_BYTES = 64 * 1024 * 1024
/** Ledger entries kept (oldest dropped first). */
export const MAX_LEDGER = 5000
/** S1-R4-06 periodic scan bounds (minutes). */
export const MIN_AUTO_SCAN_MINUTES = 5
export const MAX_AUTO_SCAN_MINUTES = 24 * 60
export const DEFAULT_AUTO_SCAN_MINUTES = 30
export const AutoScanSchema = z.strictObject({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(MIN_AUTO_SCAN_MINUTES).max(MAX_AUTO_SCAN_MINUTES)
})
export type AutoScanConfig = z.infer<typeof AutoScanSchema>

const OUTCOMES = ['added', 'updated', 'unchanged', 'older_version', 'duplicate', 'rejected', 'skipped'] as const satisfies readonly SubscriptionOutcome[]
const Iso = z.string().datetime({ offset: true })
const LedgerEntrySchema = z.strictObject({
  name: z.string().max(1024),
  kind: z.enum(['card', 'skill']),
  outcome: z.enum(OUTCOMES),
  importedAt: Iso
})
const ConfigSchema = z.strictObject({
  version: z.literal(1),
  folder: z.string().min(1).max(4096).nullable(),
  enabled: z.boolean(),
  lastRefreshAt: Iso.nullable(),
  ledger: z.record(z.string().regex(/^[0-9a-f]{64}$/), LedgerEntrySchema),
  /** S1-R4-06: absent (older configs) = off. */
  autoScan: AutoScanSchema.optional()
})
type Config = z.infer<typeof ConfigSchema>
type LedgerEntry = z.infer<typeof LedgerEntrySchema>

const DEFAULT_CONFIG: Config = { version: 1, folder: null, enabled: false, lastRefreshAt: null, ledger: {} }

export type SubscriptionErrorCode = 'disabled' | 'invalid_folder' | 'busy'

export class SubscriptionError extends Error {
  constructor(
    readonly code: SubscriptionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SubscriptionError'
  }
}

export interface SubscriptionDeps {
  storeRoot: string
  peers: PeerStore
  /** Signed skill import (`createSkillShare(...)`); null → `.navaliaskill` files are reported as skipped. */
  skills: () => Pick<SkillShare, 'importSkill'> | null
  /** Directory picker; absent → choose() refuses. */
  pickDir?: (opts: { title: string; createDirectory?: boolean }) => Promise<string | null>
  now?: () => Date
}

export interface Subscription {
  file: string
  status(): SubscriptionStatus
  choose(): Promise<SubscriptionStatus | null>
  /** Validate + enable a folder (choose() uses this after the dialog). */
  setFolder(folder: string): SubscriptionStatus
  enable(): SubscriptionStatus
  disable(): SubscriptionStatus
  /** S1-R4-06: opt-in periodic scan of the same folder (the scheduler reads this). */
  setAutoScan(opts: AutoScanConfig): SubscriptionStatus
  refresh(): Promise<SubscriptionRefreshReport>
}

/** Absolute, exists, is a directory (after resolving the folder path itself), not inside the Lens Store. */
export function validateFolder(folder: string, storeRoot: string): { ok: true; real: string } | { ok: false; problem: string } {
  if (!path.isAbsolute(folder)) return { ok: false, problem: tr('Folder path must be absolute', '文件夹路径必须是绝对路径') }
  let real: string
  try {
    real = fs.realpathSync(folder)
  } catch {
    return { ok: false, problem: tr('Folder does not exist or cannot be accessed', '文件夹不存在或无法访问') }
  }
  let st: fs.Stats
  try {
    st = fs.statSync(real)
  } catch {
    return { ok: false, problem: tr('Folder does not exist or cannot be accessed', '文件夹不存在或无法访问') }
  }
  if (!st.isDirectory()) return { ok: false, problem: tr('The selection is not a folder', '选择的不是文件夹') }
  if (isInside(real, realOrResolved(storeRoot))) return { ok: false, problem: tr('Cannot choose the Navalia Store or a folder inside it', '不能选择 Navalia Store 本身或它里面的文件夹') }
  return { ok: true, real }
}

/** Which shared file a folder entry is (current, Grapple-era or Persome Lens extensions). */
export function kindOf(name: string): 'card' | 'skill' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith(CARD_EXT) || lower.endsWith(PREV_CARD_EXT) || lower.endsWith(LEGACY_CARD_EXT)) return 'card'
  if (lower.endsWith(SKILL_EXT) || lower.endsWith(PREV_SKILL_EXT) || lower.endsWith(LEGACY_SKILL_EXT)) return 'skill'
  return null
}

type ReadResult = { ok: true; bytes: Buffer } | { ok: false; reason: SubscriptionSkipReason; size?: number }

/**
 * Read one candidate without following symlinks: lstat (refuse symlink / non-regular before any
 * open, so a FIFO cannot block), then O_NOFOLLOW|O_NONBLOCK open + fstat (closes the lstat→open
 * race), then a capped read.
 */
function readCandidate(file: string, budget: number): ReadResult {
  let st: fs.Stats
  try {
    st = fs.lstatSync(file)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' }
  if (!st.isFile()) return { ok: false, reason: 'not_regular' }
  if (st.size > MAX_SUB_FILE_BYTES) return { ok: false, reason: 'too_large' }
  if (st.size > budget) return { ok: false, reason: 'byte_cap' }
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'symlink' : 'unreadable' }
  }
  try {
    const fst = fs.fstatSync(fd)
    if (!fst.isFile()) return { ok: false, reason: 'not_regular' }
    const limit = Math.min(MAX_SUB_FILE_BYTES, budget)
    const buf = Buffer.alloc(limit + 1)
    let n = 0
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n)
      if (r === 0) break
      n += r
    }
    if (n > MAX_SUB_FILE_BYTES) return { ok: false, reason: 'too_large' }
    if (n > budget) return { ok: false, reason: 'byte_cap' }
    return { ok: true, bytes: buf.subarray(0, n) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    fs.closeSync(fd)
  }
}

function emptyCounts(): Record<SubscriptionOutcome, number> {
  return Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<SubscriptionOutcome, number>
}

export function createSubscription(deps: SubscriptionDeps): Subscription {
  const now = deps.now ?? (() => new Date())
  const file = path.join(deps.storeRoot, 'peers', 'subscription.json')
  let busy = false

  /** Corrupt config → treated as unset (disabled) and reported; overwritten on the next write. */
  function load(): { config: Config; corrupt: boolean } {
    const raw = readFileIfExists(file)
    if (!raw) return { config: structuredClone(DEFAULT_CONFIG), corrupt: false }
    try {
      return { config: ConfigSchema.parse(JSON.parse(raw.toString('utf8'))), corrupt: false }
    } catch {
      return { config: structuredClone(DEFAULT_CONFIG), corrupt: true }
    }
  }

  function save(config: Config): void {
    const entries = Object.entries(config.ledger)
    if (entries.length > MAX_LEDGER) {
      entries.sort((a, b) => b[1].importedAt.localeCompare(a[1].importedAt))
      config.ledger = Object.fromEntries(entries.slice(0, MAX_LEDGER))
    }
    writeFileSecure(file, `${JSON.stringify(config, null, 2)}\n`)
  }

  function statusOf(config: Config, corrupt = false): SubscriptionStatus {
    let folderProblem: string | null = corrupt ? tr('Subscription config could not be read; treated as not set up', '订阅配置文件无法读取，已视为未配置') : null
    if (config.folder) {
      const v = validateFolder(config.folder, deps.storeRoot)
      if (!v.ok) folderProblem = v.problem
    }
    return {
      enabled: config.enabled,
      folder: config.folder,
      folderProblem,
      ledgerSize: Object.keys(config.ledger).length,
      lastRefreshAt: config.lastRefreshAt,
      limits: { maxFiles: MAX_SUB_FILES, maxFileBytes: MAX_SUB_FILE_BYTES, maxTotalBytes: MAX_SUB_TOTAL_BYTES },
      autoScan: {
        enabled: config.autoScan?.enabled ?? false,
        intervalMinutes: config.autoScan?.intervalMinutes ?? DEFAULT_AUTO_SCAN_MINUTES,
        minMinutes: MIN_AUTO_SCAN_MINUTES,
        maxMinutes: MAX_AUTO_SCAN_MINUTES
      }
    }
  }

  function setFolder(folder: string): SubscriptionStatus {
    const v = validateFolder(folder, deps.storeRoot)
    if (!v.ok) throw new SubscriptionError('invalid_folder', v.problem)
    const { config } = load()
    config.folder = folder
    config.enabled = true
    save(config)
    return statusOf(config)
  }

  async function importOne(name: string, kind: 'card' | 'skill', text: string): Promise<Pick<SubscriptionFileReport, 'outcome' | 'reason' | 'detail'>> {
    if (kind === 'card') {
      const r = deps.peers.importText(text)
      if (!r.ok) return { outcome: 'rejected', reason: r.reason, detail: r.detail }
      return { outcome: r.outcome, reason: null, detail: r.peer.displayName ?? r.peer.fingerprint.slice(0, 8) }
    }
    const skills = deps.skills()
    if (!skills) return { outcome: 'skipped', reason: 'unreadable', detail: tr('Skill import is unavailable', '技能导入不可用') }
    // Only friends' skills arrive through the folder (it feeds the Broker's search_workflows /
    // get_workflow). A validly signed skill from a key not in the Peers list is skipped and NOT
    // ledgered, so it imports on a later refresh once the user adds that friend's card. Invalid
    // packages fall through to importSkill, which rejects them with the verifier message.
    const v = verifySkillText(text)
    if (v.valid && !deps.peers.get(v.fingerprint)) {
      return { outcome: 'skipped', reason: 'unknown_signer', detail: tr(`Signer fingerprint ${v.fingerprint.slice(0, 16)}…`, `签名者指纹 ${v.fingerprint.slice(0, 16)}…`) }
    }
    try {
      const r = await skills.importSkill(text, name)
      return r.item.outcome === 'imported'
        ? { outcome: 'added', reason: null, detail: r.item.id }
        : { outcome: 'duplicate', reason: 'skill', detail: r.item.detail ?? r.item.id }
    } catch (error) {
      if (error instanceof SkillShareError) return { outcome: 'rejected', reason: 'skill', detail: redactForDisplay(error.message) }
      return { outcome: 'skipped', reason: 'unreadable', detail: redactForDisplay(error instanceof Error ? error.message : String(error)) }
    }
  }

  return {
    file,

    status() {
      const { config, corrupt } = load()
      return statusOf(config, corrupt)
    },

    async choose() {
      if (!deps.pickDir) throw new SubscriptionError('invalid_folder', tr('Choosing a folder is not supported here', '当前环境不支持选择文件夹'))
      const picked = await deps.pickDir({ title: tr('Choose subscription folder (local or iCloud Drive)', '选择订阅文件夹（本地或 iCloud Drive）') })
      if (!picked) return null
      return setFolder(picked)
    },

    setFolder,

    enable() {
      const { config } = load()
      if (!config.folder) throw new SubscriptionError('invalid_folder', tr('No subscription folder chosen yet', '还没有选择订阅文件夹'))
      return setFolder(config.folder)
    },

    disable() {
      const { config } = load()
      config.enabled = false
      save(config)
      return statusOf(config)
    },

    setAutoScan(opts) {
      const next = AutoScanSchema.parse(opts)
      const { config } = load()
      if (next.enabled && !config.folder) throw new SubscriptionError('invalid_folder', tr('No subscription folder chosen yet; cannot turn on periodic scan', '还没有选择订阅文件夹，不能开启定期扫描'))
      config.autoScan = next
      save(config)
      return statusOf(config)
    },

    async refresh() {
      if (busy) throw new SubscriptionError('busy', tr('Refresh in progress, please wait', '正在刷新，请稍候'))
      busy = true
      try {
        const { config } = load()
        if (!config.enabled || !config.folder) throw new SubscriptionError('disabled', tr('Subscription folder is not enabled: choose a folder first', '订阅文件夹未启用：请先选择文件夹'))
        const v = validateFolder(config.folder, deps.storeRoot)
        if (!v.ok) throw new SubscriptionError('invalid_folder', v.problem)

        const scannedAt = now().toISOString()
        const files: SubscriptionFileReport[] = []
        let ignored = 0
        let candidates = 0
        let budget = MAX_SUB_TOTAL_BYTES
        const added: Record<string, LedgerEntry> = {}
        // Cards before skills, so a friend's card and their skill dropped together import in one refresh.
        const rank = (n: string): number => (kindOf(n.replace(/\.icloud$/i, '')) === 'skill' ? 1 : 0)
        const names = fs.readdirSync(v.real).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))

        for (const name of names) {
          // iCloud placeholder for a not-yet-downloaded file: `.foo.navaliacard.icloud`.
          if (name.startsWith('.') && name.toLowerCase().endsWith('.icloud')) {
            const inner = name.slice(1, -'.icloud'.length)
            const k = kindOf(inner)
            if (k) files.push({ name: inner, kind: k, sha256: null, outcome: 'skipped', reason: 'not_downloaded', detail: null })
            else ignored++
            continue
          }
          const kind = kindOf(name)
          // Hidden files (incl. AppleDouble `._x.navaliacard`) are never read.
          if (!kind || name.startsWith('.')) {
            ignored++
            continue
          }
          candidates++
          const skip = (reason: SubscriptionSkipReason): void => {
            files.push({ name, kind, sha256: null, outcome: 'skipped', reason, detail: null })
          }
          if (candidates > MAX_SUB_FILES) {
            skip('count_cap')
            continue
          }
          const read = readCandidate(path.join(v.real, name), budget)
          if (!read.ok) {
            skip(read.reason)
            continue
          }
          budget -= read.bytes.length
          const sha256 = createHash('sha256').update(read.bytes).digest('hex')
          const seen = config.ledger[sha256]
          if (seen) {
            files.push({ name, kind, sha256, outcome: 'duplicate', reason: null, detail: tr(`Already processed at ${seen.importedAt} (${seen.name})`, `已于 ${seen.importedAt} 处理过（${seen.name}）`) })
            continue
          }
          const r = await importOne(name, kind, read.bytes.toString('utf8'))
          files.push({ name, kind, sha256, ...r })
          if (r.outcome !== 'rejected' && r.outcome !== 'skipped') {
            const entry: LedgerEntry = { name: name.slice(0, 1024), kind, outcome: r.outcome, importedAt: now().toISOString() }
            config.ledger[sha256] = entry
            added[sha256] = entry
          }
        }

        // Re-read before writing so a 停用 / folder change made during this refresh is kept.
        const latest = load().config
        for (const [sha, entry] of Object.entries(added)) latest.ledger[sha] = entry
        latest.lastRefreshAt = scannedAt
        save(latest)
        const counts = emptyCounts()
        for (const f of files) counts[f.outcome]++
        return { folder: config.folder, scannedAt, files, counts, ignored }
      } finally {
        busy = false
      }
    }
  }
}
