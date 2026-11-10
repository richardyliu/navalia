import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ImportApi, ImportRun, ImportScanResult } from '../../../main/import/api'
import {
  actions,
  autoBuildNotice,
  BUILD_AFTER_IMPORT_DEFAULT,
  buildAfterImportWarning,
  cancelBuildAfter,
  cliView,
  commitThenMaybeBuild,
  confirmBuildAfter,
  toggleBuildAfter,
  filterSessions,
  formatRange,
  INCLUDE_TOOLS_DEFAULT,
  includeToolsHint,
  noteLines,
  RUN_STATUS_LABEL,
  runTotalsLine,
  selectionSummary,
  SOURCE_LABEL,
  STATE_LABEL,
  toggleAllVisible,
  toggleKey,
  type BuildAfterImport,
  type CliView,
  type SessionFilter
} from './importView'
import './import.css'
import { tr } from '../lib/i18n'
import { unwrap, errorMessage } from '../lib/api'

const importer = (): ImportApi['importer'] => (window.lens as unknown as ImportApi).importer

function CliBox({ view }: { view: CliView }) {
  return (
    <div className={`banner compact ${view.ok ? 'ok' : 'bad'}`}>
      <div>
        <strong>{view.title}</strong>
        {view.lines.map((l) => (
          <div key={l} className="mono tiny">
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}

export function Import() {
  const scan = useQuery<ImportScanResult>({ queryKey: ['import', 'scan'], queryFn: () => unwrap(importer().scan()), enabled: false })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<SessionFilter>({ source: 'all', query: '', hideImported: false })
  const [run, setRun] = useState<ImportRun | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmBuild, setConfirmBuild] = useState(false)
  // S2-10: “导入后构建”, default OFF, React state only (not persisted across restarts).
  const [buildAfter, setBuildAfter] = useState<BuildAfterImport>(BUILD_AFTER_IMPORT_DEFAULT)
  const [autoNotice, setAutoNotice] = useState<string | null>(null)
  // C20: 「保留工具调用」, default ON (tool name + command first line + paths, redacted; never tool output).
  const [includeTools, setIncludeTools] = useState(INCLUDE_TOOLS_DEFAULT)

  const act = useMutation({
    mutationFn: (fn: () => Promise<ImportRun>) => fn(),
    onSuccess: (r) => setRun(r),
    onError: (e) => setNotice(errorMessage(e))
  })
  const go = (fn: () => Promise<ImportRun>) => {
    setNotice(null)
    setAutoNotice(null)
    act.mutate(fn)
  }
  const commit = (runId: string) =>
    go(async () => {
      const o = await commitThenMaybeBuild(
        { commit: (id) => unwrap(importer().commit(id)), build: (id, c) => unwrap(importer().build(id, c)) },
        runId,
        buildAfter
      )
      setAutoNotice(autoBuildNotice(o))
      return o.run
    })

  const data = scan.data
  const visible = useMemo(() => filterSessions(data?.sessions ?? [], filter), [data, filter])
  const a = actions(selected.size, run, data?.cli.available ?? false, act.isPending || scan.isFetching)

  return (
    <div className="page import-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Import</div>
          <h2>{tr('Connect and import', '连接并导入')}</h2>
          <p className="muted">
            {tr(
              'Reads past sessions from local Claude Code (~/.claude/projects) and Codex (~/.codex/sessions), converts them to redacted Markdown, and hands them to persome import-data to write into your personal database. Raw files are only read; tool output, reasoning and subagent sessions are not imported.',
              '从本机 Claude Code（~/.claude/projects）和 Codex（~/.codex/sessions）读取历史会话，转换为脱敏 Markdown， 再交给 persome import-data 写入个人数据库。只读原始文件；工具输出、思考过程和子代理会话不导入。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" disabled={scan.isFetching} onClick={() => void scan.refetch()}>
            {scan.isFetching ? tr('Scanning…', '扫描中…') : data ? tr('Scan again', '重新扫描') : tr('Scan local sessions', '扫描本机会话')}
          </button>
        </div>
      </header>

      {scan.isError ? <div className="banner bad compact">{errorMessage(scan.error)}</div> : null}
      {notice ? <div className="banner bad compact">{notice}</div> : null}

      {data ? (
        <section className="card import-sources">
          <div className="import-source-row">
            <span className={`chip ${data.roots.claudeCode ? 'ok' : 'subtle'}`}>Claude Code {data.roots.claudeCode ? tr('found', '已找到') : tr('not found', '未找到')}</span>
            <span className={`chip ${data.roots.codex ? 'ok' : 'subtle'}`}>Codex {data.roots.codex ? tr('found', '已找到') : tr('not found', '未找到')}</span>
            <span className={`chip ${data.cli.available ? 'ok' : 'warn'}`}>persome CLI {data.cli.available ? tr('available', '可用') : tr('not found (dry run only)', '未找到（仅能预演）')}</span>
            <span className="muted tiny mono">{data.homeLabel}</span>
          </div>
          {data.capWarning ? <div className="banner warn compact">{data.capWarning}</div> : null}
          {Object.keys(data.warnings).length ? (
            <div className="muted tiny">
              {tr('Parse notes: ', '解析提示：')}
              {Object.entries(data.warnings)
                .map(([k, v]) => `${k}×${v}`)
                .join(tr(', ', '，'))}
            </div>
          ) : null}
        </section>
      ) : null}

      {data ? (
        <section className="card">
          <div className="import-toolbar">
            <div className="segmented">
              {(['all', 'claude-code', 'codex'] as const).map((s) => (
                <button key={s} className={`seg-btn ${filter.source === s ? 'active' : ''}`} onClick={() => setFilter({ ...filter, source: s })}>
                  {s === 'all' ? tr('All', '全部') : SOURCE_LABEL[s]}
                </button>
              ))}
            </div>
            <input
              className="input"
              placeholder={tr('Filter by title / project / session ID', '按标题 / 项目 / 会话 ID 过滤')}
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            />
            <label className="tiny">
              <input type="checkbox" checked={filter.hideImported} onChange={(e) => setFilter({ ...filter, hideImported: e.target.checked })} /> {tr('Hide imported', '隐藏已导入')}
            </label>
            <span className="muted tiny">{selectionSummary(data.sessions, selected)}</span>
          </div>
          {visible.length ? (
            <table className="table import-table">
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" aria-label={tr('Select all', '全选')} onChange={() => setSelected(toggleAllVisible(selected, visible))} />
                  </th>
                  <th>{tr('Source', '来源')}</th>
                  <th>{tr('Session', '会话')}</th>
                  <th>{tr('Project', '项目')}</th>
                  <th>{tr('Messages', '消息')}</th>
                  <th>{tr('Time', '时间')}</th>
                  <th>{tr('Status', '状态')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.key} onClick={() => setSelected(toggleKey(selected, s.key))}>
                    <td>
                      <input type="checkbox" checked={selected.has(s.key)} readOnly />
                    </td>
                    <td>{SOURCE_LABEL[s.source]}</td>
                    <td>
                      <div>{s.title ?? <span className="muted">{tr('(untitled)', '（无标题）')}</span>}</div>
                      <div className="mono tiny muted">{s.sessionId}</div>
                    </td>
                    <td className="mono tiny">{s.project ?? '—'}</td>
                    <td>{s.messageCount}</td>
                    <td className="tiny">{formatRange(s.startTs, s.endTs)}</td>
                    <td>
                      <span className={`chip ${STATE_LABEL[s.importState].tone}`}>{STATE_LABEL[s.importState].text}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">{tr('No sessions to import.', '没有可导入的会话。')}</p>
          )}
        </section>
      ) : (
        <p className="muted">{tr('Click "Scan local sessions" to start. Scanning only reads files and writes nothing.', '点击“扫描本机会话”开始。扫描只读取文件，不写入任何内容。')}</p>
      )}

      {data ? (
        <section className="card import-steps">
          <div className="page-actions">
            <button className="btn" disabled={!a.canPrepare} onClick={() => go(() => unwrap(importer().prepare([...selected], { includeTools })))}>
              {tr('1. Dry run (redact and stage, nothing written to Runtime)', '1. 预演（脱敏并暂存，不写入 Runtime）')}
            </button>
            <button className="btn primary" disabled={!a.canCommit} onClick={() => run && commit(run.runId)}>
              {buildAfter.enabled ? tr('2. Import to Runtime and build', '2. 导入到 Runtime 并构建') : tr('2. Import to Runtime', '2. 导入到 Runtime')}
            </button>
            <button className="btn" disabled={!a.canBuild} onClick={() => setConfirmBuild(true)}>
              {tr('3. Build personal model (optional)', '3. 构建个人模型（可选）')}
            </button>
            <button className="btn ghost" disabled={!a.canDiscard} onClick={() => run && go(() => unwrap(importer().discard(run.runId)))}>
              {tr('Discard staging', '丢弃暂存')}
            </button>
          </div>
          {a.commitHint ? <div className="muted tiny">{a.commitHint}</div> : null}
          <label className="tiny import-build-after" title={includeToolsHint()}>
            <input type="checkbox" checked={includeTools} disabled={act.isPending} onChange={(e) => setIncludeTools(e.target.checked)} />{' '}
            {tr('Keep tool calls (tool names / commands / file paths)', '保留工具调用（工具名 / 命令 / 文件路径）')}
            <span className="muted">
              {tr(`(on by default; ${includeToolsHint()}; applies from the next dry run)`, `（默认打开；${includeToolsHint()}；下次预演生效）`)}
            </span>
          </label>
          <label className="tiny import-build-after">
            <input
              type="checkbox"
              checked={buildAfter.enabled}
              disabled={act.isPending}
              onChange={(e) => setBuildAfter(toggleBuildAfter(buildAfter, e.target.checked))}
            />{' '}
            {tr('Build after import (off by default; resets to off on every launch)', '导入后构建（默认关闭；每次启动都会恢复为关闭）')}
          </label>
          {buildAfter.confirming ? (
            <div className="banner warn compact">
              <span>{buildAfterImportWarning()}</span>
              <span className="page-actions">
                <button className="btn primary small" onClick={() => setBuildAfter(confirmBuildAfter(buildAfter))}>
                  {tr('Turn on', '确认打开')}
                </button>
                <button className="btn ghost small" onClick={() => setBuildAfter(cancelBuildAfter())}>
                  {tr('Cancel', '取消')}
                </button>
              </span>
            </div>
          ) : null}
          {autoNotice ? <div className={`banner compact ${run?.status === 'built' ? 'ok' : 'warn'}`}>{autoNotice}</div> : null}
          {confirmBuild && run ? (
            <div className="banner warn compact">
              <span>
                {tr(
                  'This runs the Runtime model build (it calls the LLM configured in Runtime and can take a while and cost money). Build now?',
                  '构建会运行 Runtime 的模型构建流程（调用你在 Runtime 中配置的 LLM，可能耗时较长并产生费用）。确定要构建吗？'
                )}
              </span>
              <span className="page-actions">
                <button
                  className="btn primary small"
                  onClick={() => {
                    setConfirmBuild(false)
                    go(() => unwrap(importer().build(run.runId, true)))
                  }}
                >
                  {tr('Build', '确认构建')}
                </button>
                <button className="btn ghost small" onClick={() => setConfirmBuild(false)}>
                  {tr('Cancel', '取消')}
                </button>
              </span>
            </div>
          ) : null}
          {act.isPending ? <p className="muted">{tr('Working… (import / build can take a few minutes)', '处理中…（导入 / 构建可能需要几分钟）')}</p> : null}
          {run ? (
            <div className="import-run">
              <div>
                <strong>{tr(`Batch ${run.runId}`, `批次 ${run.runId}`)}</strong> · {RUN_STATUS_LABEL[run.status]}
              </div>
              <div className="muted tiny">{runTotalsLine(run)}</div>
              {noteLines(run).map((l) => (
                <div key={l} className="muted tiny">
                  {l}
                </div>
              ))}
              {run.documents.length ? (
                <ul className="import-docs mono tiny">
                  {run.documents.map((d) => (
                    <li key={d.file}>
                      {d.file} ·{' '}
                      {tr(`${d.messages} messages · ${d.redactions} redacted`, `${d.messages} 条 · 脱敏 ${d.redactions}`)}
                      {d.droppedBlocks ? tr(` · ${d.droppedBlocks} omitted`, ` · 省略 ${d.droppedBlocks}`) : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              {run.importCli ? <CliBox view={cliView('import', run.importCli, run.documents.length)} /> : null}
              {run.importCli?.stderr && run.importCli.exitCode !== 0 ? <pre className="build-log">{run.importCli.stderr}</pre> : null}
              {run.buildCli ? <CliBox view={cliView('build', run.buildCli, run.documents.length)} /> : null}
              {run.buildCli && run.buildCli.exitCode !== 0 ? <pre className="build-log">{run.buildCli.stderr || run.buildCli.stdout}</pre> : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
