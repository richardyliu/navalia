// S1-FULL C16: read-only `git` for repos the user explicitly added on the 「表现」 page.
//
// - execFile with shell:false, fixed argument vectors, no user text interpolated into a shell.
// - Only read commands: `rev-parse --show-toplevel`, `config --get user.email`, `log`. No fetch, no
//   network, no write (GIT_OPTIONAL_LOCKS=0 so `git log` does not even refresh the index), no prompt.
// - Author filter: exact (case-insensitive) match on the author email, done here in JS (not
//   `--author`, which is a regex). Local branches + tags only (`--branches --tags`): stash and
//   remote-tracking refs are not the user's commits.
import { execFile } from 'node:child_process'
import path from 'node:path'

export type GitRunner = (args: string[], opts?: { cwd?: string }) => Promise<string>

export const GIT_TIMEOUT_MS = 15_000
export const GIT_MAX_BUFFER = 16 * 1024 * 1024
export const GIT_MAX_COMMITS = 5000

/** Production runner. `extraEnv` exists for tests (e.g. GIT_CONFIG_GLOBAL pointing at a temp file). */
export function createGitRunner(extraEnv: Record<string, string> = {}): GitRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          shell: false,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C', ...extraEnv }
        },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
      )
    })
}

/** Absolute toplevel of the repo containing `dir`, or null when it is not a git work tree. */
export async function repoToplevel(git: GitRunner, dir: string): Promise<string | null> {
  if (!path.isAbsolute(dir)) return null
  try {
    const out = (await git(['-C', dir, 'rev-parse', '--show-toplevel'])).trim()
    return out && path.isAbsolute(out) ? out : null
  } catch {
    return null
  }
}

export async function configuredEmail(git: GitRunner, repo: string): Promise<string | null> {
  try {
    const out = (await git(['-C', repo, 'config', '--get', 'user.email'])).trim()
    return out && out.length <= 320 ? out : null
  } catch {
    return null
  }
}

export interface GitCommit {
  hash: string
  authorMs: number
  authorEmail: string
  subject: string
}

const FS = '\u001f'
const RS = '\u001e'

export function parseGitLog(out: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const rec of out.split(RS)) {
    const r = rec.replace(/^\s+/, '')
    if (!r) continue
    const [hash, date, email, ...rest] = r.split(FS)
    const ms = Date.parse(date ?? '')
    if (!/^[0-9a-f]{40}$/.test(hash ?? '') || !Number.isFinite(ms)) continue
    commits.push({ hash, authorMs: ms, authorEmail: email ?? '', subject: rest.join(FS).replace(/\s+$/, '').slice(0, 200) })
  }
  return commits
}

/** Commits authored by `email` with author date in [start, end). */
export async function commitsBy(git: GitRunner, repo: string, email: string, start: number, end: number): Promise<GitCommit[]> {
  const out = await git([
    '-C',
    repo,
    'log',
    '--branches',
    '--tags',
    '--no-merges',
    // Author-date window; --since/--until filter on committer date, so the exact filter is below.
    `--since=${new Date(start - 86_400_000).toISOString()}`,
    `--max-count=${GIT_MAX_COMMITS}`,
    `--format=%H${FS}%aI${FS}%ae${FS}%s${RS}`
  ])
  const want = email.trim().toLowerCase()
  return parseGitLog(out).filter((c) => c.authorEmail.trim().toLowerCase() === want && c.authorMs >= start && c.authorMs < end)
}
