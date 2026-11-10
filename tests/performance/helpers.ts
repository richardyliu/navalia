// S1-FULL C16 test fixtures: a temp het.db with synthetic rows, synthetic transcripts, and a temp git
// repo built in a mkdtemp dir. Nothing reads or writes ~/.persome, ~/.claude, ~/.codex, the real
// Lens Store or any real repo. Git runs with an empty global config (no user hooks / signing).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHetDb } from '../../src/main/het/ledger'
import { createGitRunner } from '../../src/main/performance/git'
import { createPerformanceService } from '../../src/main/performance/service'

export const TMP_PREFIX = 'lens-pp-'
export const TZ = 'Asia/Shanghai'
/** Thu 2026-11-05 10:00 Asia/Shanghai. ISO week 2026-W45 = Mon 11-02 .. Sun 11-08. */
export const NOW = Date.parse('2026-11-05T02:00:00Z')
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
/** 10:00 Shanghai on the given local date. */
export const at10 = (label: string): number => Date.parse(`${label}T02:00:00Z`)

export function tempDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}${tag}-`))
}

/** Removes only a dir this suite created: basename prefix + directly under the OS temp dir. */
export function safeRm(dir: string): void {
  const resolved = path.resolve(dir)
  const tmp = path.resolve(os.tmpdir())
  if (!path.basename(resolved).startsWith(TMP_PREFIX)) throw new Error(`refusing to remove ${resolved}`)
  if (resolved === tmp || path.dirname(resolved) !== tmp) throw new Error(`refusing to remove ${resolved}`)
  fs.rmSync(resolved, { recursive: true, force: true })
}

export function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface Fixture {
  root: string
  store: string
  hetDb: string
  transcripts: string
  repo: string
  gitEnv: Record<string, string>
}

interface TaskSpec {
  id: string
  project: string
  title?: string | null
  end: number
  correction?: 'accepted' | 'rejected' | 'not_agent' | null
  /** het_events `corrected` rows: [at, action|null]. */
  corrections?: Array<[number, 'accepted' | 'rejected' | 'not_agent' | null]>
}

interface EvidenceSpec {
  task: string
  id: string
  ts: number
  signals: string[]
  file: string
  line: number
}

export function writeHetDb(file: string, tasks: TaskSpec[], evidence: EvidenceSpec[]): void {
  const db = openHetDb(file, NOW - 30 * DAY)
  for (const t of tasks) {
    db.prepare(
      `INSERT INTO het_tasks (id, agent, project, title, start_ms, end_ms, status, correction, fingerprint, session_ids, stats, signals, created_ms, updated_ms)
       VALUES (?, 'claude-code', ?, ?, ?, ?, 'needs_assessment', ?, 'fp', ?, '{}', '[]', ?, ?)`
    ).run(t.id, t.project, t.title ?? null, t.end - HOUR, t.end, t.correction ?? null, JSON.stringify([`sess-${t.id}`]), t.end, t.end)
    for (const [atMs, action] of t.corrections ?? []) {
      db.prepare(`INSERT INTO het_events (task_id, at_ms, kind, actor, payload) VALUES (?, ?, 'corrected', 'user', ?)`).run(
        t.id,
        atMs,
        JSON.stringify(action === null ? { action: null, reverted: true } : { action })
      )
    }
  }
  for (const e of evidence) {
    db.prepare(
      `INSERT INTO het_evidence (task_id, event_id, ts_ms, role, tool_names, files_written, signals, summary, source_file, source_line)
       VALUES (?, ?, ?, 'assistant', '["Bash"]', '[]', ?, '', ?, ?)`
    ).run(e.task, e.id, e.ts, JSON.stringify(e.signals), e.file, e.line)
  }
  db.close()
}

export function git(repo: string, env: Record<string, string>, args: string[], date?: number, email = 'me@example.test'): string {
  const iso = date === undefined ? undefined : new Date(date).toISOString()
  return execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      ...env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: email,
      ...(iso ? { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } : {})
    },
    encoding: 'utf8'
  })
}

export function commit(repo: string, env: Record<string, string>, name: string, date: number, email = 'me@example.test'): void {
  fs.writeFileSync(path.join(repo, name), `${name}\n`)
  git(repo, env, ['add', name])
  git(repo, env, ['commit', '-q', '--no-verify', '-m', `add ${name}`], date, email)
}

/** Standard fixture used by most tests. */
export function buildFixture(opts: { withGit?: boolean } = {}): Fixture {
  const root = tempDir('perf')
  const store = path.join(root, 'store')
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  const transcripts = path.join(root, 'claude')
  fs.mkdirSync(path.join(transcripts, 'proj'), { recursive: true })
  const s1 = path.join(transcripts, 'proj', 's1.jsonl')
  fs.writeFileSync(
    s1,
    [
      JSON.stringify({ type: 'user', message: 'commit it' }),
      JSON.stringify({ type: 'assistant', tool: 'Bash', command: 'git commit -m "fix: thing"' }),
      JSON.stringify({ type: 'user', tool_result: '[main 1a2b3c4] fix: thing\n 1 file changed, 2 insertions(+)' })
    ].join('\n') + '\n'
  )
  const s2 = path.join(transcripts, 'proj', 's2.jsonl')
  fs.writeFileSync(s2, [JSON.stringify({ type: 'assistant', command: 'git commit -m wip' }), JSON.stringify({ type: 'user', tool_result: 'nothing to commit' })].join('\n') + '\n')
  const outside = path.join(root, 'elsewhere.jsonl')
  fs.writeFileSync(outside, `${JSON.stringify({ command: 'git commit' })}\n${JSON.stringify({ r: '[main deadbee] x' })}\n`)

  const hetDb = path.join(store, 'het.db')
  writeHetDb(
    hetDb,
    [
      { id: 't1', project: '/work/alpha', title: 'alpha fix', end: at10('2026-11-03') - HOUR, correction: 'accepted', corrections: [[at10('2026-11-03'), 'accepted']] },
      { id: 't2', project: '/work/alpha-other', end: at10('2026-11-04') - HOUR, correction: 'rejected', corrections: [[at10('2026-11-04'), 'rejected']] },
      { id: 't3', project: '/work/beta', end: at10('2026-11-02'), correction: 'not_agent', corrections: [[at10('2026-11-02'), 'not_agent']] },
      { id: 't4', project: '/work/beta', end: at10('2026-10-28'), correction: 'accepted', corrections: [[at10('2026-10-28'), 'accepted']] },
      { id: 't5', project: '/work/beta', end: at10('2026-11-03'), correction: null, corrections: [[at10('2026-11-03'), 'accepted'], [at10('2026-11-03') + HOUR, null]] },
      { id: 't6', project: '/work/beta', end: at10('2026-11-05') - HOUR, correction: 'accepted' },
      { id: 't7', project: '/elsewhere', title: 'Notes for Lens-Alpha launch', end: at10('2026-11-02'), correction: 'accepted', corrections: [[at10('2026-11-02'), 'rejected'], [at10('2026-11-05') - 2 * HOUR, 'accepted']] }
    ],
    [
      { task: 't1', id: 'ev_commit1', ts: at10('2026-11-03') - 2 * HOUR, signals: ['git_commit'], file: s1, line: 2 },
      { task: 't1', id: 'ev_write1', ts: at10('2026-11-03') - 3 * HOUR, signals: [], file: s1, line: 1 },
      { task: 't2', id: 'ev_commit2', ts: at10('2026-11-04') - 2 * HOUR, signals: ['git_commit'], file: s2, line: 1 },
      { task: 't4', id: 'ev_commit_old', ts: at10('2026-10-28'), signals: ['git_commit'], file: s2, line: 1 },
      { task: 't3', id: 'ev_commit_out', ts: at10('2026-11-02'), signals: ['git_commit', 'git_push'], file: outside, line: 1 }
    ]
  )

  const repo = path.join(root, 'repo')
  const gitEnv: Record<string, string> = {}
  if (opts.withGit) {
    const emptyCfg = path.join(root, 'gitconfig-empty')
    fs.writeFileSync(emptyCfg, '')
    Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_NOSYSTEM: '1', HOME: root })
    fs.mkdirSync(repo)
    git(repo, gitEnv, ['init', '-q', '-b', 'main'])
    git(repo, gitEnv, ['config', 'user.email', 'me@example.test'])
    git(repo, gitEnv, ['config', 'commit.gpgsign', 'false'])
    commit(repo, gitEnv, 'old.txt', at10('2026-10-29'))
    commit(repo, gitEnv, 'a.txt', at10('2026-11-03'))
    git(repo, gitEnv, ['checkout', '-q', '-b', 'side'])
    commit(repo, gitEnv, 'side.txt', at10('2026-11-04'), 'other@example.test')
    git(repo, gitEnv, ['checkout', '-q', 'main'])
    git(repo, gitEnv, ['merge', '-q', '--no-ff', '--no-edit', 'side'], at10('2026-11-04') + HOUR)
    commit(repo, gitEnv, 'b.txt', at10('2026-11-05') - HOUR)
    fs.mkdirSync(path.join(repo, 'sub'))
  }
  return { root, store, hetDb, transcripts, repo, gitEnv }
}

export function service(f: Fixture, over: Partial<Parameters<typeof createPerformanceService>[0]> = {}) {
  return createPerformanceService({
    storeRoot: f.store,
    hetDbFile: f.hetDb,
    now: () => NOW,
    timezone: () => TZ,
    homeDir: () => f.root,
    transcriptRoots: () => [f.transcripts],
    git: createGitRunner(f.gitEnv),
    pickDirectory: async () => path.join(f.repo, 'sub'),
    ...over
  })
}
