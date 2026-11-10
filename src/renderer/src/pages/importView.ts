// Pure view-model for the Import page (tested in tests/import/view.test.ts). No DOM, no window.
import type { CliOutcome, ImportRun, ImportSessionPreview, ImportSource } from '../../../main/import/api'
import { formatBytes } from '../lib/format'
import { tr } from '../lib/i18n'

export const SOURCE_LABEL: Record<ImportSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export const STATE_LABEL: Record<ImportSessionPreview['importState'], { text: string; tone: 'ok' | 'warn' | 'subtle' }> = {
  new: {
    get text() {
      return tr('Not imported', '未导入')
    },
    tone: 'subtle'
  },
  changed: {
    get text() {
      return tr('New messages', '有新消息')
    },
    tone: 'warn'
  },
  imported: {
    get text() {
      return tr('Imported', '已导入')
    },
    tone: 'ok'
  }
}

export const RUN_STATUS_LABEL: Record<ImportRun['status'], string> = {
  get staged() {
    return tr('Dry run done (not yet written to Runtime)', '已预演（尚未写入 Runtime）')
  },
  get imported() {
    return tr('Imported to Runtime (model not built)', '已导入 Runtime（未构建模型）')
  },
  get import_failed() {
    return tr('Import failed', '导入失败')
  },
  get built() {
    return tr('Imported and model built', '已导入并完成模型构建')
  },
  get build_failed() {
    return tr('Imported, but the model build failed', '已导入，但模型构建失败')
  },
  get discarded() {
    return tr('Staging discarded', '已丢弃暂存')
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
function fmt(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return '—'
  if (start === null || end === null) return fmt((start ?? end) as number)
  const a = fmt(start)
  const b = fmt(end)
  if (a === b) return a
  return a.slice(0, 10) === b.slice(0, 10) ? `${a} – ${b.slice(11)}` : `${a} – ${b}`
}

export interface SessionFilter {
  source: ImportSource | 'all'
  query: string
  hideImported: boolean
}

export function filterSessions(sessions: ImportSessionPreview[], f: SessionFilter): ImportSessionPreview[] {
  const q = f.query.trim().toLowerCase()
  return sessions.filter(
    (s) =>
      (f.source === 'all' || s.source === f.source) &&
      (!f.hideImported || s.importState !== 'imported') &&
      (!q || [s.title, s.project, s.sessionId].some((v) => v?.toLowerCase().includes(q)))
  )
}

export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** Select / clear all visible rows; already-imported rows are never auto-selected. */
export function toggleAllVisible(selected: ReadonlySet<string>, visible: ImportSessionPreview[]): Set<string> {
  const candidates = visible.filter((s) => s.importState !== 'imported').map((s) => s.key)
  const allOn = candidates.length > 0 && candidates.every((k) => selected.has(k))
  const next = new Set(selected)
  for (const k of candidates) {
    if (allOn) next.delete(k)
    else next.add(k)
  }
  return next
}

export function selectionSummary(sessions: ImportSessionPreview[], selected: ReadonlySet<string>): string {
  const picked = sessions.filter((s) => selected.has(s.key))
  if (!picked.length) return tr('No sessions selected', '未选择会话')
  const msgs = picked.reduce((a, s) => a + s.messageCount, 0)
  return tr(`${picked.length} sessions selected, ${msgs} messages`, `已选 ${picked.length} 个会话，共 ${msgs} 条消息`)
}

export interface Actions {
  canPrepare: boolean
  canCommit: boolean
  canBuild: boolean
  canDiscard: boolean
  commitHint: string | null
}

export function actions(selectedCount: number, run: ImportRun | null, cliAvailable: boolean, busy: boolean): Actions {
  const live = !!run && !run.stagingDeleted
  const commitable = live && (run.status === 'staged' || run.status === 'import_failed') && run.documents.length > 0
  let commitHint: string | null = null
  if (run && run.stagingDeleted && run.status !== 'built' && run.status !== 'discarded') commitHint = tr('Staging was cleaned up. Run the dry run again.', '暂存已清理，请重新预演。')
  else if (run && commitable && !cliAvailable) commitHint = tr('The persome CLI was not found; only a dry run is possible.', '没有找到 persome 命令行工具，只能预演。')
  else if (run && run.status === 'staged' && run.documents.length === 0) commitHint = tr('All selected sessions were imported before; nothing new.', '所选会话都已导入过，没有新内容。')
  return {
    canPrepare: !busy && selectedCount > 0,
    canCommit: !busy && commitable && cliAvailable,
    canBuild: !busy && live && (run.status === 'imported' || run.status === 'build_failed') && cliAvailable,
    canDiscard: !busy && live && (run.status === 'staged' || run.status === 'import_failed'),
    commitHint
  }
}

export interface CliView {
  ok: boolean
  title: string
  lines: string[]
}

export function cliView(kind: 'import' | 'build', o: CliOutcome, expectedDocs: number): CliView {
  const ok = o.exitCode === 0
  const secs = (o.durationMs / 1000).toFixed(1)
  const lines: string[] = [
    tr(`Command: persome ${o.args.join(' ')}`, `命令：persome ${o.args.join(' ')}`),
    tr(
      `Exit code: ${o.exitCode ?? 'none'}${o.signal ? ` (signal ${o.signal})` : ''}, took ${secs} s`,
      `退出码：${o.exitCode ?? '无'}${o.signal ? `（信号 ${o.signal}）` : ''}，耗时 ${secs} 秒`
    )
  ]
  if (kind === 'import' && o.counts) {
    lines.push(
      tr(
        `Runtime receipt: new/changed ${o.counts.imported}, unchanged ${o.counts.unchanged}, skipped ${o.counts.skipped}`,
        `Runtime 回执：新增/变更 ${o.counts.imported}，未变 ${o.counts.unchanged}，跳过 ${o.counts.skipped}`
      )
    )
    if (ok && o.counts.imported + o.counts.unchanged < expectedDocs) {
      lines.push(
        tr(
          `Note: ${expectedDocs} documents were staged, but Runtime accepted only ${o.counts.imported + o.counts.unchanged}.`,
          `注意：暂存了 ${expectedDocs} 个文档，Runtime 只接收了 ${o.counts.imported + o.counts.unchanged} 个。`
        )
      )
    }
  } else if (kind === 'import' && ok) {
    lines.push(tr('Could not parse the Runtime receipt line; the exit code is authoritative.', '未能解析 Runtime 回执行；以退出码为准。'))
  }
  const title =
    kind === 'import'
      ? ok
        ? tr('Import succeeded', '导入成功')
        : tr('Import failed (Runtime returned an error)', '导入失败（Runtime 返回错误）')
      : ok
        ? tr('Model build finished', '模型构建完成')
        : tr('Model build failed', '模型构建失败')
  return { ok, title, lines }
}

export function runTotalsLine(run: ImportRun): string {
  const t = run.totals
  const n = run.skippedAlreadyImported.length
  return tr(
    `${t.documents} documents · ${t.messages} messages · ${formatBytes(t.bytes)} · ${t.redactions} redacted · ${t.droppedBlocks} blocks omitted${n ? `; ${n} unchanged sessions skipped` : ''}`,
    `${t.documents} 个文档 · ${t.messages} 条消息 · ${formatBytes(t.bytes)} · 脱敏 ${t.redactions} 处 · 整段省略 ${t.droppedBlocks} 处${n ? `；${n} 个会话内容未变已跳过` : ''}`
  )
}

// ---- S2-10: “导入后构建” toggle (DECISIONS X5: default OFF, opt-in needs a second confirmation) ----

/**
 * Toggle state. Not persisted: every app start (and every visit to the page) begins OFF, so a
 * build — which runs the Runtime's LLM and may cost money — never happens without a fresh opt-in.
 */
export interface BuildAfterImport {
  enabled: boolean
  /** True while the cost warning is shown and the user has not confirmed yet. */
  confirming: boolean
}

export const BUILD_AFTER_IMPORT_DEFAULT: BuildAfterImport = { enabled: false, confirming: false }

export function buildAfterImportWarning(): string {
  return tr(
    'When on, every successful "Import to Runtime" is followed by a Runtime model build (persome import-data --build). ' +
      'It calls the LLM configured in Runtime and uses the Runtime LLM budget ([agent_funding] daily call quota); it can take a while and cost money. ' +
      'Navalia itself never calls an LLM. On failure, the exit code and error output are shown. Turn it on?',
    '打开后，每次“导入到 Runtime”成功都会接着运行 Runtime 的模型构建（persome import-data --build），' +
      '它会调用你在 Runtime 中配置的 LLM，占用 Runtime 的 LLM 预算（[agent_funding] 每日调用额度），可能耗时较长并产生费用。' +
      'Navalia 本身不调用 LLM。失败时会显示退出码和错误输出。确定打开吗？'
  )
}

/** The switch was clicked. Turning ON only opens the confirmation; turning OFF is immediate. */
export function toggleBuildAfter(state: BuildAfterImport, on: boolean): BuildAfterImport {
  if (!on) return { enabled: false, confirming: false }
  if (state.enabled) return state
  return { enabled: false, confirming: true }
}

export function confirmBuildAfter(state: BuildAfterImport): BuildAfterImport {
  return state.confirming ? { enabled: true, confirming: false } : state
}

export function cancelBuildAfter(): BuildAfterImport {
  return { enabled: false, confirming: false }
}

export interface ImportCommitApi {
  commit(runId: string): Promise<ImportRun>
  build(runId: string, confirm: true): Promise<ImportRun>
}

export interface CommitOutcome {
  /** Latest run state (after the build when one ran). */
  run: ImportRun
  /** True when the build step was started. */
  buildAttempted: boolean
  /** Error thrown by the build call itself (IPC / CLI missing); CLI exit ≠ 0 shows up in `run.buildCli`. */
  buildError: string | null
}

/**
 * Commit, then — only when the toggle is ON and the commit succeeded (status `imported`) —
 * run the existing confirmed build. A failed commit never builds.
 */
export async function commitThenMaybeBuild(api: ImportCommitApi, runId: string, buildAfter: BuildAfterImport): Promise<CommitOutcome> {
  const run = await api.commit(runId)
  if (!buildAfter.enabled || run.status !== 'imported') return { run, buildAttempted: false, buildError: null }
  try {
    return { run: await api.build(run.runId, true), buildAttempted: true, buildError: null }
  } catch (e) {
    return { run, buildAttempted: true, buildError: e instanceof Error ? e.message : String(e) }
  }
}

/** Banner text for a build that ran automatically after import; null when there is nothing to say. */
export function autoBuildNotice(o: CommitOutcome): string | null {
  if (!o.buildAttempted) return null
  if (o.buildError) return tr(`Import succeeded, but the automatic build did not start: ${o.buildError}`, `导入成功，但自动构建没有启动：${o.buildError}`)
  if (o.run.status === 'built') return tr('Import succeeded, and the model build ran as set by "Build after import".', '导入成功，已按“导入后构建”完成模型构建。')
  if (o.run.status === 'build_failed') return tr(
      'Import succeeded, but the automatic build failed (see the exit code and error output below). You can retry "Build personal model" by hand later.',
      '导入成功，但自动构建失败（见下方退出码与错误输出）。可稍后手动重试“构建个人模型”。'
    )
  return null
}

// ---- S1-R3-06: tool call summary toggle + continuation notes ----

/** C20: on by default — the imported Markdown keeps which tools ran, which commands, which files were written. */
export const INCLUDE_TOOLS_DEFAULT = true
export function includeToolsHint(): string {
  return tr(
    'Keeps tool names, the first line of commands, and written / edited file paths (redacted: home folder shown as ~, Runtime paths removed); tool output is never imported',
    '保留工具名、命令首行和写入 / 编辑的文件路径（已脱敏：家目录写作 ~，Runtime 路径移除），从不导入工具输出'
  )
}

const NOTE_LABEL: Record<NonNullable<ImportRun['notes']>[number]['kind'], string> = {
  get continued() {
    return tr('Continued import', '续导入')
  },
  get rewritten() {
    return tr('Full re-import', '整段重新导入')
  },
  get legacy() {
    return tr('Full re-import', '整段重新导入')
  }
}

/** One line per prepare note (continuation / forced full re-import), plus the tool-summary state. */
export function noteLines(run: ImportRun): string[] {
  const lines = (run.notes ?? []).map((n) => tr(`${NOTE_LABEL[n.kind]} · ${n.key}: ${n.detail}`, `${NOTE_LABEL[n.kind]} · ${n.key}：${n.detail}`))
  if (run.includeTools !== undefined)
    lines.push(
      run.includeTools
        ? tr('Tool call summary: included (tool names / commands / paths only)', '工具调用摘要：已包含（仅工具名 / 命令 / 路径）')
        : tr('Tool call summary: not included', '工具调用摘要：未包含')
    )
  return lines
}
