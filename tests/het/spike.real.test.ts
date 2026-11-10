import { test } from 'vitest'
import { readClaudeProjects, readCodexSessions, segment } from './readers'

/**
 * Real-run dry spike (read-only). Skipped unless HET_REAL_SPIKE=1.
 * Prints aggregate counts only — never content, paths, titles or project names.
 */
test.runIf(process.env.HET_REAL_SPIKE === '1')('real ~/.claude/projects dry spike (aggregates only)', () => {
  const t0 = Date.now()
  const cc = readClaudeProjects()
  const cx = readCodexSessions()
  const now = Date.now()
  const tasks = segment({ events: [...cc.events, ...cx.events], sessionTitles: cc.sessionTitles }, now)
  const sessions = new Set(cc.events.map((e) => e.sessionId))
  const projects = new Set(cc.events.map((e) => e.project))
  const roles: Record<string, number> = {}
  for (const e of cc.events) roles[e.role] = (roles[e.role] ?? 0) + 1
  const warnTotal = Object.values(cc.warnings).reduce((a, b) => a + b, 0)
  const warnByClass: Record<string, number> = {}
  for (const [k, v] of Object.entries(cc.warnings)) {
    const cls = k.split(':')[0]
    warnByClass[cls] = (warnByClass[cls] ?? 0) + v
  }
  const summary = {
    claude: {
      files: cc.files,
      lines: cc.lines,
      sessions: sessions.size,
      projects: projects.size,
      events: cc.events.length,
      roles,
      warningsTotal: warnTotal,
      warningCodes: Object.keys(cc.warnings).length,
      warningsByClass: warnByClass
    },
    codex: { files: cx.files, events: cx.events.length },
    tasks: {
      total: tasks.length,
      settled: tasks.filter((t) => t.status === 'settled').length,
      unsettled: tasks.filter((t) => t.status === 'unsettled').length,
      multiSession: tasks.filter((t) => t.sessionIds.length > 1).length,
      withFilesWritten: tasks.filter((t) => t.stats.filesWritten > 0).length,
      withGitCommit: tasks.filter((t) => t.signals.includes('git_commit')).length
    },
    elapsedMs: Date.now() - t0
  }
  console.log('HET_SPIKE ' + JSON.stringify(summary))
})
