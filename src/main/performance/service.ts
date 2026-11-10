// S1-FULL C16 「表现」 service (owner-only). Electron-free: main.ts injects the dialog, MCP tool call
// and git runner.
//
// Traceability by construction: every count is `rows.length` of the same row list that rows()
// returns for that kind / window / day. There is no second counting query that could drift.
// Unknown sources are `null` all the way to the renderer ("未知 / 未接入"), never 0.
import { tr } from '../../shared/i18n'
import { addDays, dayIn, daysBetween } from '../het/tz'
import { isoWeekBounds, zonedMidnightMs } from '../het/weekCounts'
import type { MemorySearchHit } from '../../shared/types'
import {
  COUNT_KINDS,
  type ActivityItem,
  type CountKind,
  type CountMap,
  type PerformanceCounts,
  type PerformanceRow,
  type PerformanceRows,
  type PeriodRange,
  type Project,
  type ProjectActivity,
  type RepoEntry,
  type RepoSourceState,
  type RepoView,
  type SourceState
} from './api'
import { commitsBy, configuredEmail, repoToplevel, type GitRunner } from './git'
import { correctionRows, displayPath, matchingTasks, transcriptCommitRows, withHetDb, type TranscriptCommitRaw } from './het'
import { createPerformanceStore, PerformanceStoreError, type PerformanceStore } from './store'
import { commitHashAt } from './transcriptHash'

export interface PerformanceDeps {
  storeRoot: string
  /** het.db path (Lens Store). Opened read-only per call. */
  hetDbFile: string
  now(): number
  timezone(): string
  /** For `~/…` display and the transcript roots. */
  homeDir(): string | null
  /** Roots a transcript file must be under before Lens reads it for a commit hash. */
  transcriptRoots(): string[]
  git: GitRunner
  /** Runtime MCP tool call (memory search for project activity). Absent ⇒ memory source unknown. */
  ossTool?(name: string, args: Record<string, unknown>): Promise<string>
  /** Native folder picker (main). Absent / cancelled ⇒ null. */
  pickDirectory?(): Promise<string | null>
  store?: PerformanceStore
}

export interface Window {
  first: string
  last: string
  start: number
  end: number
}

export function periodWindow(range: PeriodRange, offset: number, now: number, tz: string): Window {
  if (range === 'day') {
    const first = addDays(dayIn(now, tz), offset)
    return { first, last: first, start: zonedMidnightMs(first, tz), end: zonedMidnightMs(addDays(first, 1), tz) }
  }
  const first = addDays(isoWeekBounds(now, tz).weekStart, offset * 7)
  return { first, last: addDays(first, 6), start: zonedMidnightMs(first, tz), end: zonedMidnightMs(addDays(first, 7), tz) }
}

/** Last `days` local days through today. */
export function lastDaysWindow(days: number, now: number, tz: string): Window {
  const last = dayIn(now, tz)
  const first = addDays(last, -(days - 1))
  return { first, last, start: zonedMidnightMs(first, tz), end: zonedMidnightMs(addDays(last, 1), tz) }
}

const unknown = (reason: string): SourceState => ({ state: 'unknown', reason })

export function createPerformanceService(deps: PerformanceDeps) {
  const store = deps.store ?? createPerformanceStore(deps.storeRoot, deps.now)
  const home = (): string | null => deps.homeDir()

  async function repoState(repo: RepoEntry): Promise<{ view: RepoSourceState; email: string | null; ok: boolean }> {
    const display = displayPath(repo.path, home())
    const top = await repoToplevel(deps.git, repo.path)
    if (!top) return { view: { id: repo.id, path: display, authorEmail: repo.authorEmail, state: unknown(tr('Unknown: cannot read this repo (moved, or not a git repo)', '未知：读不到这个仓库（已移动或不是 git 仓库）')) }, email: null, ok: false }
    const email = repo.authorEmail ?? (await configuredEmail(deps.git, repo.path))
    if (!email) return { view: { id: repo.id, path: display, authorEmail: null, state: unknown(tr('Unknown: this repo has no git user.email configured and none was entered manually', '未知：这个仓库没有配置 git user.email，也没有手动填写')) }, email: null, ok: false }
    return { view: { id: repo.id, path: display, authorEmail: email, state: { state: 'ok', detail: null } }, email, ok: true }
  }

  async function gitRows(repos: RepoEntry[], w: Window, tz: string): Promise<{ rows: PerformanceRow[]; state: SourceState; repos: RepoSourceState[] }> {
    if (repos.length === 0) return { rows: [], state: unknown(tr('Not connected: no local repos added yet', '未接入：还没有添加本地仓库')), repos: [] }
    const rows: PerformanceRow[] = []
    const views: RepoSourceState[] = []
    let ok = 0
    for (const repo of repos) {
      const s = await repoState(repo)
      if (!s.ok || !s.email) {
        views.push(s.view)
        continue
      }
      try {
        const commits = await commitsBy(deps.git, repo.path, s.email, w.start, w.end)
        ok += 1
        views.push(s.view)
        for (const c of commits) {
          rows.push({
            kind: 'git_commit',
            id: `${repo.id}:${c.hash}`,
            at: new Date(c.authorMs).toISOString(),
            day: dayIn(c.authorMs, tz),
            atSource: 'author_date',
            agent: null,
            taskId: null,
            sessionIds: [],
            project: null,
            evidence: null,
            commit: { hash: c.hash, hashSource: 'git', repo: s.view.path, subject: c.subject }
          })
        }
      } catch {
        views.push({ ...s.view, state: unknown(tr('Unknown: failed to read git log', '未知：git log 读取失败')) })
      }
    }
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    const state: SourceState = ok > 0 ? { state: 'ok', detail: tr(`${ok}/${repos.length} repos readable`, `${ok}/${repos.length} 个仓库可读`) } : unknown(tr('Unknown: none of the added repos can be read', '未知：已添加的仓库都读不到'))
    return { rows, state, repos: views }
  }

  interface AllRows {
    w: Window
    tz: string
    byKind: Record<CountKind, PerformanceRow[] | null>
    transcriptRaw: TranscriptCommitRaw[]
    sources: PerformanceCounts['sources']
  }

  async function allRows(range: PeriodRange, offset: number, at?: { now: number; tz: string }, needGit = true): Promise<AllRows> {
    const now = at?.now ?? deps.now()
    const tz = at?.tz ?? deps.timezone()
    const w = periodWindow(range, offset, now, tz)
    const h = home()
    const het = withHetDb(deps.hetDbFile, (db) => ({
      accepted: correctionRows(db, 'accepted', w.start, w.end, tz, h),
      rejected: correctionRows(db, 'rejected', w.start, w.end, tz, h),
      not_agent: correctionRows(db, 'not_agent', w.start, w.end, tz, h),
      transcript: transcriptCommitRows(db, w.start, w.end, tz, h)
    }))
    let repos: RepoEntry[] = []
    let reposError: string | null = null
    try {
      repos = store.readRepos()
    } catch (e) {
      reposError = e instanceof PerformanceStoreError ? e.message : tr('Failed to read the repo list', '读取仓库列表失败')
    }
    const git = reposError
      ? { rows: [], state: unknown(tr(`Unknown: ${reposError}`, `未知：${reposError}`)), repos: [] }
      : needGit
        ? await gitRows(repos, w, tz)
        : { rows: [], state: unknown(tr('Not read', '未读取')), repos: [] }
    const v = het.value
    return {
      w,
      tz,
      byKind: {
        accepted: v ? v.accepted : null,
        rejected: v ? v.rejected : null,
        not_agent: v ? v.not_agent : null,
        transcript_commit: v ? v.transcript.map((r) => r.row) : null,
        git_commit: git.state.state === 'ok' ? git.rows : null
      },
      transcriptRaw: v ? v.transcript : [],
      sources: { het: het.state, transcripts: het.state, git: git.state, repos: git.repos }
    }
  }

  function countMap(byKind: Record<CountKind, PerformanceRow[] | null>, day?: string): CountMap {
    return Object.fromEntries(
      COUNT_KINDS.map((k) => {
        const rows = byKind[k]
        return [k, rows === null ? null : day === undefined ? rows.length : rows.filter((r) => r.day === day).length]
      })
    ) as CountMap
  }

  async function counts(range: PeriodRange, offset: number): Promise<PerformanceCounts> {
    const a = await allRows(range, offset)
    const labels = daysBetween(a.w.start, a.w.end, a.tz)
    return {
      range,
      offset,
      first: a.w.first,
      last: a.w.last,
      start: new Date(a.w.start).toISOString(),
      end: new Date(a.w.end).toISOString(),
      timezone: a.tz,
      days: labels.map((day) => ({ day, counts: countMap(a.byKind, day) })),
      totals: countMap(a.byKind),
      sources: a.sources
    }
  }

  async function rows(range: PeriodRange, offset: number, kind: CountKind, day?: string): Promise<PerformanceRows> {
    const a = await allRows(range, offset, undefined, kind === 'git_commit')
    const list = a.byKind[kind]
    const source = kind === 'git_commit' ? a.sources.git : a.sources.het
    if (list === null) return { kind, first: a.w.first, last: a.w.last, rows: [], total: null, source }
    const picked = day === undefined ? list : list.filter((r) => r.day === day)
    if (kind === 'transcript_commit') {
      // Hash only when the transcript shows it (read-only lookahead after the event's line).
      const roots = deps.transcriptRoots()
      const raw = new Map(a.transcriptRaw.map((r) => [r.row.id, r]))
      for (const r of picked.slice(0, 500)) {
        const src = raw.get(r.id)
        if (!src || !r.commit) continue
        const hash = await commitHashAt(src.absFile, src.line, roots)
        if (hash) r.commit = { ...r.commit, hash, hashSource: 'transcript' }
      }
    }
    return { kind, first: a.w.first, last: a.w.last, rows: picked, total: picked.length, source }
  }

  /** T10 source for the proactive layer: last ISO week's evidenced row ids, or null if nothing is known. */
  async function lastWeekSample(now: number, tz: string): Promise<{ weekStart: string; items: string[] } | null> {
    const a = await allRows('week', -1, { now, tz })
    const known = COUNT_KINDS.map((k) => a.byKind[k]).filter((x): x is PerformanceRow[] => x !== null)
    if (known.length === 0) return null
    return { weekStart: a.w.first, items: known.flat().map((r) => `${r.kind}:${r.id}`) }
  }

  // ── repos ─────────────────────────────────────────────────────────────────

  const repoViews = (repos: RepoEntry[]): RepoView[] =>
    repos.map((r) => ({ id: r.id, path: displayPath(r.path, home()), authorEmail: r.authorEmail, addedAt: r.addedAt }))

  async function addRepo(): Promise<RepoView[] | null> {
    const dir = deps.pickDirectory ? await deps.pickDirectory() : null
    if (!dir) return null
    const top = await repoToplevel(deps.git, dir)
    if (!top) throw new PerformanceStoreError(tr('The selected folder is not a git repo', '选的文件夹不是 git 仓库'))
    return repoViews(store.addRepo(top))
  }

  // ── activity (C) ──────────────────────────────────────────────────────────

  function snippet(text: string, max = 120): string {
    const one = text.replace(/\s+/g, ' ').trim()
    return one.length > max ? `${one.slice(0, max - 1)}…` : one
  }

  async function memoryActivity(p: Project, w: Window, tz: string): Promise<{ items: ActivityItem[]; state: SourceState }> {
    if (p.match.keywords.length === 0) return { items: [], state: unknown(tr('No keywords set', '未设置关键词')) }
    if (!deps.ossTool) return { items: [], state: unknown(tr('Not connected: Runtime search is unavailable', '未接入：Runtime 搜索不可用')) }
    const items = new Map<string, ActivityItem>()
    let failed = 0
    for (const kw of p.match.keywords.slice(0, 10)) {
      let hits: MemorySearchHit[]
      try {
        const parsed = JSON.parse(await deps.ossTool('search', { query: kw, top_k: 20 })) as { results?: unknown }
        hits = Array.isArray(parsed.results) ? (parsed.results as MemorySearchHit[]) : []
      } catch {
        failed += 1
        continue
      }
      const k = kw.toLowerCase()
      for (const h of hits) {
        if (!h || typeof h.id !== 'string' || typeof h.content !== 'string') continue
        // Literal only: a semantic neighbour that does not contain the keyword is not shown.
        if (!h.content.toLowerCase().includes(k) && !(typeof h.path === 'string' && h.path.toLowerCase().includes(k))) continue
        const ms = typeof h.timestamp === 'string' ? Date.parse(h.timestamp) : NaN
        if (!Number.isFinite(ms) || ms < w.start || ms >= w.end) continue
        if (items.has(h.id)) continue
        items.set(h.id, {
          kind: 'memory',
          id: h.id,
          at: new Date(ms).toISOString(),
          day: dayIn(ms, tz),
          matchedBy: `keyword:${kw}`,
          title: snippet(h.content),
          evidence: null,
          ref: typeof h.path === 'string' && h.path ? h.path : h.id
        })
      }
    }
    if (failed === Math.min(p.match.keywords.length, 10)) return { items: [], state: unknown(tr('Unknown: Runtime search failed (is Runtime running?)', '未知：Runtime 搜索失败（Runtime 未运行？）')) }
    return { items: [...items.values()], state: { state: 'ok', detail: failed > 0 ? tr(`Search failed for ${failed} keywords`, `${failed} 个关键词搜索失败`) : null } }
  }

  async function activity(projectId: string, days: number): Promise<ProjectActivity> {
    const p = store.readProjects().find((x) => x.id === projectId)
    if (!p) throw new PerformanceStoreError(tr('Project not found', '项目不存在'))
    const now = deps.now()
    const tz = deps.timezone()
    const w = lastDaysWindow(days, now, tz)
    const h = home()
    const items: ActivityItem[] = []

    const mem = await memoryActivity(p, w, tz)
    items.push(...mem.items)

    let hetState: SourceState
    if (p.match.paths.length === 0 && p.match.keywords.length === 0) hetState = unknown(tr('No paths or keywords set', '未设置路径或关键词'))
    else {
      const r = withHetDb(deps.hetDbFile, (db) => ({
        tasks: matchingTasks(db, w.start, w.end, p.match.paths, p.match.keywords, h),
        commits: p.match.paths.length > 0 ? transcriptCommitRows(db, w.start, w.end, tz, h, p.match.paths) : []
      }))
      hetState = r.state
      for (const t of r.value?.tasks ?? []) {
        items.push({
          kind: 'het_task',
          id: t.id,
          at: new Date(t.endMs).toISOString(),
          day: dayIn(t.endMs, tz),
          matchedBy: t.matchedBy,
          title: t.title ?? (t.project ? displayPath(t.project, h) : t.id),
          evidence: t.evidence,
          ref: t.id
        })
      }
      for (const c of r.value?.commits ?? []) {
        const pathHit = p.match.paths.find((x) => c.row.project !== null && (c.row.project === x || c.row.project.startsWith(`${x.replace(/\/+$/, '')}/`)))
        items.push({
          kind: 'transcript_commit',
          id: c.row.id,
          at: c.row.at,
          day: c.row.day,
          matchedBy: `path:${pathHit ?? ''}`,
          title: tr('git commit call in an Agent session', 'Agent 会话里的 git commit 调用'),
          evidence: c.row.evidence,
          ref: c.row.taskId ?? c.row.id
        })
      }
    }

    let gitState: SourceState
    if (p.match.repoIds.length === 0) gitState = unknown(tr('No repos selected', '未选择仓库'))
    else {
      const repos = store.readRepos().filter((r) => p.match.repoIds.includes(r.id))
      const g = await gitRows(repos, w, tz)
      gitState = g.state
      for (const r of g.rows) {
        const repoId = r.id.split(':')[0]
        items.push({
          kind: 'git_commit',
          id: r.id,
          at: r.at,
          day: r.day,
          matchedBy: `repo:${repoId}`,
          title: r.commit?.subject || tr('(no commit message)', '(无提交说明)'),
          evidence: null,
          ref: r.commit?.hash ?? r.id
        })
      }
    }

    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
    return { projectId, days, first: w.first, last: w.last, items, sources: { memory: mem.state, het: hetState, git: gitState } }
  }

  return {
    store,
    counts,
    rows,
    lastWeekSample,
    repos: (): RepoView[] => repoViews(store.readRepos()),
    addRepo,
    updateRepo: (id: string, email: string | null): RepoView[] => repoViews(store.updateRepo(id, email)),
    removeRepo: (id: string): RepoView[] => repoViews(store.removeRepo(id)),
    projects: (): Project[] => store.readProjects(),
    saveProject: (input: unknown): Project[] => store.saveProject(input),
    deleteProject: (id: string): Project[] => store.deleteProject(id),
    setMilestoneDone: (projectId: string, milestoneId: string, done: boolean): Project[] => store.setMilestoneDone(projectId, milestoneId, done),
    activity
  }
}

export type PerformanceService = ReturnType<typeof createPerformanceService>
