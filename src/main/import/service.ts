import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ImportNote, ImportRun, ImportScanResult, ImportSessionPreview, PrepareOptions, StagedDocument } from './api'
import { defaultExec, runImportCli, type ExecFn } from './cli'
import { renderSession } from './markdown'
import { redactForDisplay } from './redact'
import {
  DEFAULT_SCAN_LIMITS,
  displayPath,
  loadSession,
  scanTranscripts,
  yieldToLoop,
  type ScanCap,
  type ScanLimits,
  type TranscriptMessage
} from './transcripts'
import { tr } from '../../shared/i18n'

/**
 * Import pipeline: scan (read-only) → prepare (dry run: render + redact + stage under the Lens
 * Store) → commit (`persome import-data --no-build`) → build (explicit, `--build`).
 *
 * Layout under `<storeRoot>/import/` (dirs 0700, files 0600):
 *   staging/<runId>/<source>/<stem>.md   — the dry-run output of one run
 *   source/                              — the ONE stable folder handed to `import-data --path`
 *   runs/<runId>.json                    — run manifest (status, CLI outcomes)
 *   ledger.json                          — keys successfully imported (exit 0 only)
 *
 * S1-R3-06 no duplicates on re-import:
 *   - Stable source key. Upstream keys a folder document by sha256(source_type, resolved --path,
 *     relative path) (`personal-model src/persome/source_import.py`). Lens therefore always passes
 *     the same `source/` folder and deterministic relative names, copying the run's staging into it
 *     for the CLI call only. Identical content in any later run is reported `unchanged` upstream.
 *   - Continuations. The ledger remembers how many messages of a session were imported plus a hash
 *     of that prefix. A grown session stages only the new messages as `<stem>.from-<n>.md`, so the
 *     earlier content is not written a second time. Upstream never deletes a superseded document's
 *     timeline blocks, so a full re-render under the same key would leave both versions; Lens only
 *     does that when the imported prefix itself was rewritten (reported as a note).
 * Staging is written to `staging/.tmp-<runId>` and renamed into place, so a failed prepare
 * never leaves a partial `staging/<runId>`; `.tmp-*` crash leftovers are swept on service
 * creation. Staging is deleted after a successful build, on discard, and after
 * `stagingTtlMs`. Nothing here touches the Runtime except the CLI.
 *
 * Scan and prepare are async and process one transcript file at a time, yielding to the
 * event loop between files (main-thread responsiveness, bounded memory).
 */

export interface ImportServiceDeps {
  storeRoot: string
  homeDir: () => string
  runtimeRoot: () => string
  persomeBin: () => string | null
  exec?: ExecFn
  now?: () => number
  /** Test hook: called after each staged file write (inject failures). */
  onStagedWrite?: (file: string) => void
  scanLimits?: ScanLimits
  /** Max total transcript bytes read by one prepare. */
  prepareMaxBytes?: number
  /** Staging older than this (any status) is removed on service creation. Default 14 days. */
  stagingTtlMs?: number
  /** Test hook for the between-files yield. */
  yieldFn?: () => Promise<void>
}

export class ImportError extends Error {
  constructor(
    readonly code: 'not_found' | 'runtime_missing' | 'unknown',
    message: string
  ) {
    super(message)
  }
}

export const RUN_ID_RE = /^imp-\d{8}T\d{6}-[0-9a-f]{6}$/
export const DEFAULT_PREPARE_MAX_BYTES = 512 * 1024 * 1024
export const DEFAULT_STAGING_TTL_MS = 14 * 24 * 3600_000

interface LedgerEntry {
  sha256: string
  runId: string
  importedAt: string
  messageCount: number
  endTs: number | null
  /** v2: number of (merged) messages of the session now in the Runtime. */
  imported?: number
  /** v2: hash of messages[0 .. imported-1) (role, ts, text). */
  prefixSha?: string
  /** v2: hash of messages[imported-1]. */
  lastSha?: string
  /** C20: dedupe keys (front matter `dedupe_key`) of every document of this session already imported. */
  docKeys?: string[]
}
interface Ledger {
  version: 1
  entries: Record<string, LedgerEntry>
}
interface ScanEntry {
  files: string[]
  messageCount: number
  endTs: number | null
}

/** Content signature of messages for the continuation check (tools excluded: toggling the summary is not a rewrite). */
export function messagesSha(messages: TranscriptMessage[]): string {
  const h = createHash('sha256')
  for (const m of messages) h.update(`${m.role}\u0000${m.ts}\u0000${m.text}\u0001`)
  return h.digest('hex')
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true, mode: DIR_MODE })
  chmodSync(p, DIR_MODE)
}

/** Write a file atomically (tmp + rename) with owner-only permissions. */
function writeAtomic(p: string, data: string): void {
  ensureDir(dirname(p))
  const tmp = `${p}.tmp-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, data, { mode: FILE_MODE })
  renameSync(tmp, p)
}

const mib = (n: number): string => `${Math.round(n / 1024 / 1024)} MiB`

export function capWarningText(c: ScanCap): string {
  return tr(
    `This Mac has many sessions, so this scan covered only the most recent ${c.scannedFiles} / ${c.totalFiles} files (${mib(c.scannedBytes)} / ${mib(c.totalBytes)}); ` +
      `the limit is ${c.limitFiles} files or ${mib(c.limitBytes)}. Older sessions are not listed.`,
    `本机会话较多，本次只扫描了最近的 ${c.scannedFiles} / ${c.totalFiles} 个文件（${mib(c.scannedBytes)} / ${mib(c.totalBytes)}），` +
      `上限为 ${c.limitFiles} 个文件或 ${mib(c.limitBytes)}。更早的会话没有列出。`
  )
}

export function createImportService(deps: ImportServiceDeps) {
  const exec = deps.exec ?? defaultExec
  const now = deps.now ?? Date.now
  const yieldFn = deps.yieldFn ?? yieldToLoop
  const limits = deps.scanLimits ?? DEFAULT_SCAN_LIMITS
  const prepareMaxBytes = deps.prepareMaxBytes ?? DEFAULT_PREPARE_MAX_BYTES
  const ttl = deps.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS
  const root = join(deps.storeRoot, 'import')
  const stagingRoot = join(root, 'staging')
  const runsRoot = join(root, 'runs')
  const sourceDir = join(root, 'source')
  const ledgerPath = join(root, 'ledger.json')
  /** Last scan: key → transcript files + summary (prepare re-reads only selected sessions). */
  let lastScan = new Map<string, ScanEntry>()
  let busy = false

  const exclusive = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    if (busy) throw new ImportError('unknown', tr('Another import is in progress. Try again shortly.', '另一个导入操作正在进行，请稍后再试。'))
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  const readLedger = (): Ledger => {
    try {
      const v = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger
      if (v && v.version === 1 && v.entries && typeof v.entries === 'object') return v
    } catch {
      /* missing or corrupt → empty */
    }
    return { version: 1, entries: {} }
  }

  const runPath = (runId: string): string => join(runsRoot, `${runId}.json`)
  const stagingDir = (runId: string): string => join(stagingRoot, runId)
  const saveRun = (run: ImportRun): void => writeAtomic(runPath(run.runId), JSON.stringify(run, null, 2))
  const loadRun = (runId: string): ImportRun => {
    if (!RUN_ID_RE.test(runId)) throw new ImportError('not_found', tr('Invalid import batch ID.', '无效的导入批次 ID。'))
    try {
      return JSON.parse(readFileSync(runPath(runId), 'utf8')) as ImportRun
    } catch {
      throw new ImportError('not_found', tr(`Import batch ${runId} not found.`, `找不到导入批次 ${runId}。`))
    }
  }
  const removeStaging = (run: ImportRun): ImportRun => {
    rmSync(stagingDir(run.runId), { recursive: true, force: true })
    rmSync(join(runsRoot, `${run.runId}.ledger.json`), { force: true })
    return { ...run, stagingDeleted: true }
  }

  const newRunId = (): string => {
    const d = new Date(now())
    const p = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
    return `imp-${stamp}-${randomBytes(3).toString('hex')}`
  }

  /** Startup sweep: `.tmp-*` crash leftovers, orphan staging, and staging past its TTL. */
  function sweep(): void {
    // A crash during commit/build can leave the stable CLI folder behind.
    rmSync(sourceDir, { recursive: true, force: true })
    let entries: string[]
    try {
      entries = readdirSync(stagingRoot)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(stagingRoot, name)
      if (name.startsWith('.tmp-')) {
        rmSync(p, { recursive: true, force: true })
        continue
      }
      if (!RUN_ID_RE.test(name)) continue
      let run: ImportRun | null = null
      try {
        run = JSON.parse(readFileSync(runPath(name), 'utf8')) as ImportRun
      } catch {
        run = null
      }
      let created = Date.parse(run?.createdAt ?? '')
      if (!Number.isFinite(created)) {
        try {
          created = lstatSync(p).mtimeMs
        } catch {
          created = 0
        }
      }
      if (!run) rmSync(p, { recursive: true, force: true })
      else if (run.status === 'built' || run.status === 'discarded' || now() - created > ttl) {
        try {
          saveRun(removeStaging(run))
        } catch {
          /* best effort */
        }
      }
    }
  }
  sweep()

  async function scan(): Promise<ImportScanResult> {
    const home = deps.homeDir()
    const { sessions, warnings, roots, capped } = await scanTranscripts(home, limits, yieldFn)
    const ledger = readLedger()
    lastScan = new Map(sessions.map((s) => [s.key, { files: s.files, messageCount: s.messageCount, endTs: s.endTs }]))
    const previews: ImportSessionPreview[] = sessions
      .filter((s) => s.messageCount > 0)
      .map((s) => {
        const e = ledger.entries[s.key]
        const importState: ImportSessionPreview['importState'] = !e
          ? 'new'
          : e.messageCount === s.messageCount && e.endTs === s.endTs
            ? 'imported'
            : 'changed'
        return {
          key: s.key,
          source: s.source,
          sessionId: s.sessionId,
          project: displayPath(s.project, home),
          title: s.title,
          messageCount: s.messageCount,
          startTs: s.startTs,
          endTs: s.endTs,
          files: s.files.map((f) => displayPath(f, home) ?? f),
          importState
        }
      })
    return {
      homeLabel: redactForDisplay(home),
      roots,
      sessions: previews,
      warnings,
      cli: { available: !!deps.persomeBin() },
      capWarning: capped ? capWarningText(capped) : null
    }
  }

  /**
   * Dry run. Renders, redacts and stages the selected sessions one at a time (only one
   * session's text in memory); never calls the Runtime CLI.
   */
  async function prepare(keys: string[], opts: PrepareOptions = {}): Promise<ImportRun> {
    // C20: tool names / commands / artifact paths are kept by default (redacted); opt out with false.
    const includeTools = opts.includeTools !== false
    const home = deps.homeDir()
    const unique = [...new Set(keys)]
    if (!unique.length) throw new ImportError('unknown', tr('Select at least one session.', '请至少选择一个会话。'))
    if (!lastScan.size) await scan()
    const missing = unique.filter((k) => !lastScan.has(k))
    if (missing.length) throw new ImportError('not_found', tr(`Sessions missing or changed. Scan again: ${missing.slice(0, 3).join(', ')}`, `会话不存在或已变化，请重新扫描：${missing.slice(0, 3).join(', ')}`))
    let bytes = 0
    for (const f of new Set(unique.flatMap((k) => lastScan.get(k)?.files ?? []))) {
      try {
        bytes += lstatSync(f).size
      } catch {
        /* vanished: loadSession reports it */
      }
    }
    if (bytes > prepareMaxBytes) {
      throw new ImportError(
        'unknown',
        tr(
          `The selected sessions' raw records total ${mib(bytes)}, over the per-import limit of ${mib(prepareMaxBytes)}. Select them in smaller batches.`,
          `所选会话的原始记录共 ${mib(bytes)}，超过单次导入上限 ${mib(prepareMaxBytes)}。请分批选择。`
        )
      )
    }
    const ledger = readLedger()
    const runId = newRunId()
    ensureDir(root)
    ensureDir(stagingRoot)
    ensureDir(runsRoot)
    const tmp = join(stagingRoot, `.tmp-${runId}`)
    const documents: StagedDocument[] = []
    const skippedAlreadyImported: string[] = []
    const notes: ImportNote[] = []
    const pending: Record<string, Omit<LedgerEntry, 'runId' | 'importedAt'>> = {}
    // C20: every document key already in the Runtime (any session) — an identical document is never staged again.
    const importedDocKeys = new Set(Object.values(ledger.entries).flatMap((e) => e.docKeys ?? []))
    let runtimeRoot: string | null = null
    try {
      runtimeRoot = deps.runtimeRoot()
    } catch {
      runtimeRoot = null
    }
    try {
      ensureDir(tmp)
      for (const k of unique) {
        const entry = lastScan.get(k)!
        const s = await loadSession(k, entry.files, yieldFn)
        if (!s || !s.messages.length) throw new ImportError('not_found', tr(`Session ${k} has no importable messages left. Scan again.`, `会话 ${k} 已无可导入的消息，请重新扫描。`))
        const msgs = s.messages
        const e = ledger.entries[k]
        let from = 0
        if (e && e.imported && e.prefixSha && e.lastSha) {
          const n = e.imported
          if (n <= msgs.length && messagesSha(msgs.slice(0, n - 1)) === e.prefixSha) {
            // The last imported message may have grown (an assistant turn continued): re-include it.
            from = messagesSha([msgs[n - 1]]) === e.lastSha ? n : n - 1
            if (from >= msgs.length) {
              skippedAlreadyImported.push(k)
              continue
            }
            notes.push({ key: k, kind: 'continued', detail: tr(`Importing messages ${from + 1}–${msgs.length} only (the first ${from} are already imported)`, `只导入第 ${from + 1}–${msgs.length} 条（前 ${from} 条已导入）`) })
          } else {
            notes.push({
              key: k,
              kind: 'rewritten',
              detail: tr(
                'The already-imported part was rewritten in the raw record (compacted / rewound / edited), so the whole session must be re-imported; Runtime does not delete old versions, so the old content stays.',
                '已导入的部分在原始记录里被改写（压缩 / 回退 / 编辑），只能整段重新导入；Runtime 不删除旧版本，旧内容会保留。'
              )
            })
          }
        }
        const r = renderSession(s, home, { includeTools, from, runtimeRoot, storeRoot: deps.storeRoot })
        const sha256 = createHash('sha256')
          .update(r.documents.map((d) => `${d.file}\u0000${d.content}`).join('\u0001'))
          .digest('hex')
        if (e && !e.prefixSha) {
          // Ledger entry from before S1-R3-06 (no prefix hash): identical render → skip; otherwise full re-import.
          if (e.sha256 === sha256) {
            skippedAlreadyImported.push(k)
            continue
          }
          notes.push({ key: k, kind: 'legacy', detail: tr(
              'The old import record has no message positions, so the whole session must be re-imported; the earlier version in Runtime stays.',
              '旧版导入记录没有消息位置信息，只能整段重新导入；Runtime 中较早导入的版本会保留。'
            )
          })
        }
        const docs = r.documents.filter((d) => !importedDocKeys.has(d.dedupeKey))
        if (!docs.length) {
          // C20: every document's dedupe key is already in the Runtime (e.g. a whitespace-only rewrite).
          const last = notes[notes.length - 1]
          if (last && last.key === k && last.kind !== 'continued') {
            notes[notes.length - 1] = { ...last, detail: tr(
                'The raw record changed, but the normalized content (dedupe key) matches what was imported, so it was not re-imported.',
                '原始记录有改动，但规范化后的内容（dedupe key）与已导入的一致，未重新导入。'
              )
            }
          }
          skippedAlreadyImported.push(k)
          continue
        }
        docs.forEach((d, i) => {
          const p = join(tmp, d.file)
          ensureDir(dirname(p))
          writeFileSync(p, d.content, { mode: FILE_MODE, flag: 'wx' })
          deps.onStagedWrite?.(p)
          documents.push({
            key: r.key,
            source: s.source,
            file: d.file,
            bytes: Buffer.byteLength(d.content),
            messages: d.messages,
            dedupeKey: d.dedupeKey,
            turns: d.turns,
            // Attribute session-level counts to the first part only.
            redactions: i === 0 ? r.redactions : 0,
            droppedBlocks: i === 0 ? r.droppedBlocks : 0
          })
        })
        // Scan-side count/endTs so the preview's "imported" check compares like with like.
        pending[k] = {
          sha256,
          messageCount: entry.messageCount,
          endTs: entry.endTs,
          imported: msgs.length,
          prefixSha: messagesSha(msgs.slice(0, msgs.length - 1)),
          lastSha: messagesSha(msgs.slice(msgs.length - 1)),
          docKeys: [...new Set([...(e?.docKeys ?? []), ...r.documents.map((d) => d.dedupeKey)])].slice(-500)
        }
      }
      renameSync(tmp, stagingDir(runId))
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })
      if (e instanceof ImportError) throw e
      throw new ImportError('unknown', tr(`Staging failed; nothing was written: ${e instanceof Error ? e.message : String(e)}`, `暂存失败，未写入任何内容：${e instanceof Error ? e.message : String(e)}`))
    }

    const run: ImportRun = {
      runId,
      createdAt: new Date(now()).toISOString(),
      status: 'staged',
      documents,
      skippedAlreadyImported,
      notes,
      includeTools,
      totals: {
        documents: documents.length,
        messages: documents.reduce((a, d) => a + d.messages, 0),
        bytes: documents.reduce((a, d) => a + d.bytes, 0),
        redactions: documents.reduce((a, d) => a + d.redactions, 0),
        droppedBlocks: documents.reduce((a, d) => a + d.droppedBlocks, 0)
      },
      importCli: null,
      buildCli: null
    }
    try {
      writeAtomic(join(runsRoot, `${runId}.ledger.json`), JSON.stringify(pending))
      saveRun(run)
    } catch (e) {
      rmSync(stagingDir(runId), { recursive: true, force: true })
      rmSync(join(runsRoot, `${runId}.ledger.json`), { force: true })
      throw new ImportError('unknown', tr(`Staging failed; nothing was written: ${e instanceof Error ? e.message : String(e)}`, `暂存失败，未写入任何内容：${e instanceof Error ? e.message : String(e)}`))
    }
    return run
  }

  function requireBin(): string {
    const bin = deps.persomeBin()
    if (!bin) throw new ImportError('runtime_missing', tr('The persome CLI was not found, so nothing can be imported. Install Persome Runtime first.', '没有找到 persome 命令行工具，无法导入。请先安装 Persome Runtime。'))
    return bin
  }

  /**
   * Present one run's staging to the CLI under the stable `source/` folder (stable upstream source
   * keys), then empty it again. `source/` only ever holds the current run's files.
   */
  async function viaSource<T>(staging: string, fn: (src: string) => Promise<T>): Promise<T> {
    rmSync(sourceDir, { recursive: true, force: true })
    ensureDir(root)
    cpSync(staging, sourceDir, { recursive: true, errorOnExist: true, force: false })
    chmodSync(sourceDir, DIR_MODE)
    try {
      return await fn(sourceDir)
    } finally {
      rmSync(sourceDir, { recursive: true, force: true })
    }
  }

  async function commit(runId: string): Promise<ImportRun> {
    const run = loadRun(runId)
    if (run.status !== 'staged' && run.status !== 'import_failed') {
      throw new ImportError('unknown', tr(`The batch status is ${run.status}; it cannot be imported again.`, `批次状态为 ${run.status}，不能再次导入。`))
    }
    if (!run.documents.length) throw new ImportError('unknown', tr('This batch has no documents to import (all selected sessions were imported before).', '该批次没有需要导入的文档（所选会话都已导入过）。'))
    const dir = stagingDir(runId)
    if (run.stagingDeleted || !existsSync(dir)) throw new ImportError('not_found', tr('The staging folder no longer exists (it may have expired and been cleaned up). Run the dry run again.', '暂存目录不存在（可能已过期清理），请重新预演。'))
    const bin = requireBin()
    const outcome = await viaSource(dir, (src) => runImportCli({ exec, bin, runtimeRoot: deps.runtimeRoot(), stagingDir: src, build: false, now }))
    const ok = outcome.exitCode === 0
    const next: ImportRun = { ...run, status: ok ? 'imported' : 'import_failed', importCli: outcome }
    saveRun(next)
    if (ok) {
      let pending: Record<string, Omit<LedgerEntry, 'runId' | 'importedAt'>> = {}
      try {
        pending = JSON.parse(readFileSync(join(runsRoot, `${runId}.ledger.json`), 'utf8'))
      } catch {
        /* ledger hint missing: the import still happened; preview just won't mark it */
      }
      const ledger = readLedger()
      const at = new Date(now()).toISOString()
      for (const [k, v] of Object.entries(pending)) ledger.entries[k] = { ...v, runId, importedAt: at }
      writeAtomic(ledgerPath, JSON.stringify(ledger, null, 2))
    }
    return next
  }

  async function build(runId: string): Promise<ImportRun> {
    const run = loadRun(runId)
    if (run.status !== 'imported' && run.status !== 'build_failed') {
      throw new ImportError('unknown', tr('Import successfully before building the personal model.', '请先成功导入，再构建个人模型。'))
    }
    const dir = stagingDir(runId)
    if (run.stagingDeleted || !existsSync(dir)) throw new ImportError('not_found', tr('The staging folder no longer exists (it may have expired and been cleaned up).', '暂存目录不存在（可能已过期清理）。'))
    const bin = requireBin()
    // Same --path as the import → every document is "unchanged" (idempotent), then the shared build runs.
    const outcome = await viaSource(dir, (src) => runImportCli({ exec, bin, runtimeRoot: deps.runtimeRoot(), stagingDir: src, build: true, now }))
    let next: ImportRun = { ...run, status: outcome.exitCode === 0 ? 'built' : 'build_failed', buildCli: outcome }
    // Built: the Runtime holds the content; the staged plaintext copy is no longer needed.
    if (next.status === 'built') next = removeStaging(next)
    saveRun(next)
    return next
  }

  function discard(runId: string): ImportRun {
    const run = loadRun(runId)
    const next: ImportRun = { ...removeStaging(run), status: run.status === 'staged' ? 'discarded' : run.status }
    saveRun(next)
    return next
  }

  return {
    scan: () => exclusive(scan),
    prepare: (keys: string[], opts?: PrepareOptions) => exclusive(() => prepare(keys, opts)),
    commit: (runId: string) => exclusive(() => commit(runId)),
    build: (runId: string) => exclusive(() => build(runId)),
    discard: (runId: string) => exclusive(() => discard(runId)),
    paths: { root, stagingRoot, runsRoot, ledgerPath, stagingDir, sourceDir }
  }
}

export type ImportService = ReturnType<typeof createImportService>
