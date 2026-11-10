// S1-FULL C16 B: owner-only counts from a fixture het.db, fixture transcripts and a temp git repo.
// Every count equals the rows listed for it; unknown sources are null (「未知 / 未接入」), never 0;
// het.db is opened read-only and not modified.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COUNT_KINDS, type CountKind } from '../../src/main/performance/api'
import { commitHashAt, hashFromText } from '../../src/main/performance/transcriptHash'
import { at10, buildFixture, commit, gitAvailable, NOW, safeRm, service, type Fixture } from './helpers'

const fixtures: Fixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) safeRm(f.root)
})
const HAS_GIT = gitAvailable()

function fx(withGit = false): Fixture {
  const f = buildFixture({ withGit })
  fixtures.push(f)
  return f
}

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

describe('HET corrections + transcript commits (fixture het.db)', () => {
  it('week counts: accepted / rejected / not_agent separate, counted at the latest matching correction time', async () => {
    const f = fx()
    const svc = service(f)
    const c = await svc.counts('week', 0)
    expect(c.first).toBe('2026-11-02')
    expect(c.last).toBe('2026-11-08')
    expect(c.totals).toMatchObject({ accepted: 3, rejected: 1, not_agent: 1, transcript_commit: 3 })
    // t7 was rejected on Monday, then accepted on Thursday: it is one accepted row, on Thursday.
    const acc = await svc.rows('week', 0, 'accepted')
    expect(acc.rows.map((r) => r.id).sort()).toEqual(['t1', 't6', 't7'])
    expect(acc.rows.find((r) => r.id === 't7')).toMatchObject({ day: '2026-11-05', atSource: 'corrected_at' })
    expect(acc.rows.find((r) => r.id === 't6')).toMatchObject({ atSource: 'task_end' })
    expect(c.days.find((d) => d.day === '2026-11-02')!.counts.rejected).toBe(0)
  })

  it('traceability: every total and every per-day number equals the rows listed for it', async () => {
    const f = fx(HAS_GIT)
    const svc = service(f)
    if (HAS_GIT) await svc.addRepo()
    for (const range of ['day', 'week'] as const) {
      for (const offset of range === 'week' ? [0, -1] : [0]) {
        const c = await svc.counts(range, offset)
        for (const k of COUNT_KINDS as readonly CountKind[]) {
          const all = await svc.rows(range, offset, k)
          expect(all.total, `${range}${offset} ${k}`).toBe(c.totals[k])
          if (all.total !== null) expect(all.rows.length).toBe(all.total)
          for (const d of c.days) {
            const perDay = await svc.rows(range, offset, k, d.day)
            expect(perDay.total).toBe(d.counts[k])
            for (const r of perDay.rows) expect(r.day).toBe(d.day)
          }
        }
      }
    }
  }, 120_000)

  it('rows carry session id, timestamp, transcript file:line (home shown as ~) and the hash when the transcript shows it', async () => {
    const f = fx()
    const svc = service(f)
    const tc = await svc.rows('week', 0, 'transcript_commit')
    const byId = Object.fromEntries(tc.rows.map((r) => [r.id, r]))
    expect(Object.keys(byId).sort()).toEqual(['ev_commit1', 'ev_commit2', 'ev_commit_out'])
    expect(byId.ev_commit1).toMatchObject({
      taskId: 't1',
      sessionIds: ['sess-t1'],
      evidence: { file: '~/claude/proj/s1.jsonl', line: 2 },
      commit: { hash: '1a2b3c4', hashSource: 'transcript' }
    })
    expect(byId.ev_commit2.commit).toMatchObject({ hash: null, hashSource: null })
    // Outside the transcript roots: never opened, so no hash.
    expect(byId.ev_commit_out.commit?.hash).toBeNull()
    for (const r of tc.rows) expect(Number.isFinite(Date.parse(r.at))).toBe(true)
  })

  it('het.db is opened read-only: bytes unchanged after counts and rows', async () => {
    const f = fx()
    const before = sha(f.hetDb)
    const svc = service(f)
    await svc.counts('week', 0)
    await svc.rows('week', 0, 'transcript_commit')
    expect(sha(f.hetDb)).toBe(before)
  })
})

describe('unknown is not 0', () => {
  it('no het.db and no repos: every count is null, with a reason; het.db is not created', async () => {
    const f = fx()
    fs.renameSync(f.hetDb, `${f.hetDb}.moved`)
    const svc = service(f)
    const c = await svc.counts('week', 0)
    for (const k of COUNT_KINDS) expect(c.totals[k]).toBeNull()
    for (const d of c.days) for (const k of COUNT_KINDS) expect(d.counts[k]).toBeNull()
    expect(c.sources.het.state).toBe('unknown')
    expect(c.sources.git).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Not connected') })
    expect(fs.existsSync(f.hetDb)).toBe(false)
    expect((await svc.rows('week', 0, 'accepted')).total).toBeNull()
  })

  it('het.db with no HET task at all is unknown, not 0', async () => {
    const f = fx()
    fs.renameSync(f.hetDb, `${f.hetDb}.moved`)
    const { writeHetDb } = await import('./helpers')
    writeHetDb(f.hetDb, [], [])
    const c = await service(f).counts('week', 0)
    expect(c.totals.accepted).toBeNull()
    expect(c.sources.het).toMatchObject({ state: 'unknown' })
  })

  it('a known source with no rows in the window is a real 0', async () => {
    const f = fx()
    const c = await service(f).counts('day', -30)
    expect(c.totals.accepted).toBe(0)
    expect(c.totals.git_commit).toBeNull()
  })
})

describe.skipIf(!HAS_GIT)('git commits (temp repo, read-only git log)', () => {
  it('counts only the configured author, no merges, no other authors, within the window', async () => {
    const f = fx(true)
    const svc = service(f)
    const repos = await svc.addRepo()
    expect(repos).toHaveLength(1)
    const c = await svc.counts('week', 0)
    expect(c.totals.git_commit).toBe(2)
    expect(c.sources.git.state).toBe('ok')
    const rows = await svc.rows('week', 0, 'git_commit')
    expect(rows.rows.map((r) => r.commit?.subject).sort()).toEqual(['add a.txt', 'add b.txt'])
    for (const r of rows.rows) expect(r.commit?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect((await svc.counts('week', -1)).totals.git_commit).toBe(1)
  })

  it('an explicit author email overrides git config; a vanished repo is unknown', async () => {
    const f = fx(true)
    const svc = service(f)
    const [repo] = (await svc.addRepo())!
    svc.updateRepo(repo.id, 'other@example.test')
    expect((await svc.counts('week', 0)).totals.git_commit).toBe(1)
    commit(f.repo, f.gitEnv, 'c.txt', at10('2026-11-05') - 30 * 60_000, 'other@example.test')
    expect((await svc.counts('week', 0)).totals.git_commit).toBe(2)
    fs.renameSync(path.join(f.repo, '.git'), path.join(f.repo, '.git-moved'))
    const c = await svc.counts('week', 0)
    expect(c.totals.git_commit).toBeNull()
    expect(c.sources.repos[0].state.state).toBe('unknown')
  })

  it('adding a folder that is not a repo is refused', async () => {
    const f = fx(true)
    const svc = service(f, { pickDirectory: async () => f.transcripts })
    await expect(svc.addRepo()).rejects.toThrow('not a git repo')
  })
})

describe('transcript hash parsing', () => {
  it('recognises git commit output, including root commits; nothing else', () => {
    expect(hashFromText('[main 1a2b3c4] msg')).toBe('1a2b3c4')
    expect(hashFromText('[feat/x (root-commit) abcdef0123] msg')).toBe('abcdef0123')
    expect(hashFromText('see [1] and [note] abc')).toBeNull()
    expect(hashFromText('nothing to commit')).toBeNull()
  })

  it('stops at the next git commit call (no borrowing a later hash)', async () => {
    const f = fx()
    const file = path.join(f.transcripts, 'proj', 's3.jsonl')
    fs.writeFileSync(file, ['git commit -m a', 'error: failed', 'git commit -m b', '[main 9999999] b'].join('\n'))
    expect(await commitHashAt(file, 1, [f.transcripts])).toBeNull()
    expect(await commitHashAt(file, 3, [f.transcripts])).toBe('9999999')
  })

  it('refuses symlinks and files outside the roots', async () => {
    const f = fx()
    const link = path.join(f.transcripts, 'proj', 'link.jsonl')
    fs.symlinkSync(path.join(f.root, 'elsewhere.jsonl'), link)
    expect(await commitHashAt(link, 1, [f.transcripts])).toBeNull()
    expect(await commitHashAt(path.join(f.root, 'elsewhere.jsonl'), 1, [f.transcripts])).toBeNull()
  })
})

it('NOW is the fixture Thursday', () => {
  expect(new Date(NOW).toISOString()).toBe('2026-11-05T02:00:00.000Z')
})
