// S1-FULL C16 C: projects CRUD in <LensStore>/performance/projects.json (0600, dir 0700), milestone
// done only through the user's explicit tick, activity matching (literal keywords, path-aware
// prefixes, chosen repos) as a dated list with evidence, and IPC validation.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PERFORMANCE_CHANNELS, type Project } from '../../src/main/performance/api'
import { registerPerformanceIpc } from '../../src/main/performance/ipc'
import { PROJECTS_FILENAME, PERFORMANCE_DIR, REPOS_FILENAME } from '../../src/main/performance/store'
import { buildFixture, DAY, gitAvailable, NOW, safeRm, service, type Fixture } from './helpers'

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
const mode = (p: string): number => fs.statSync(p).mode & 0o777

const input = (over: Record<string, unknown> = {}) => ({
  title: 'Lens Alpha',
  goal: '把 alpha 发出去',
  milestones: [
    { title: '内测', targetDate: '2026-11-20', note: '' },
    { title: '公开', targetDate: null, note: '看反馈' }
  ],
  match: { keywords: ['lens-alpha'], paths: ['/work/alpha'], repoIds: [] },
  ...over
})

describe('projects CRUD', () => {
  it('create → file 0600 in a 0700 dir; edit keeps ids; delete', () => {
    const f = fx()
    const svc = service(f)
    const [p] = svc.saveProject(input())
    const file = path.join(f.store, PERFORMANCE_DIR, PROJECTS_FILENAME)
    expect(mode(file)).toBe(0o600)
    expect(mode(path.dirname(file))).toBe(0o700)
    expect(p.milestones.every((m) => m.done === false && m.doneAt === null)).toBe(true)
    const edited = svc.saveProject({ ...input({ title: 'Lens Alpha 2' }), id: p.id, milestones: p.milestones.map((m) => ({ id: m.id, title: m.title, targetDate: m.targetDate, note: m.note })) })
    expect(edited[0]).toMatchObject({ id: p.id, title: 'Lens Alpha 2', createdAt: p.createdAt })
    expect(edited[0].milestones.map((m) => m.id)).toEqual(p.milestones.map((m) => m.id))
    expect(svc.deleteProject(p.id)).toEqual([])
    expect(() => svc.deleteProject(p.id)).toThrow('Project not found')
  })

  it('done can only be set by the explicit tick; saving cannot set or clear it', () => {
    const f = fx()
    const svc = service(f)
    const [p] = svc.saveProject(input())
    // The input schema is strict: a `done` field is rejected outright.
    expect(() => svc.saveProject({ ...input(), milestones: [{ title: 'x', targetDate: null, note: '', done: true }] })).toThrow()
    const ticked = svc.setMilestoneDone(p.id, p.milestones[0].id, true)[0]
    expect(ticked.milestones[0]).toMatchObject({ done: true, doneAt: new Date(NOW).toISOString() })
    // An edit keeps the user's tick.
    const kept = svc.saveProject({ ...input(), id: p.id, milestones: ticked.milestones.map((m) => ({ id: m.id, title: `${m.title}!`, targetDate: m.targetDate, note: m.note })) })[0]
    expect(kept.milestones[0]).toMatchObject({ title: '内测!', done: true })
    expect(svc.setMilestoneDone(p.id, p.milestones[0].id, false)[0].milestones[0]).toMatchObject({ done: false, doneAt: null })
  })

  it('a corrupt projects.json is reported and never overwritten', () => {
    const f = fx()
    const dir = path.join(f.store, PERFORMANCE_DIR)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, PROJECTS_FILENAME)
    fs.writeFileSync(file, '{"version":1,"projects":[{"oops":true}]}')
    const svc = service(f)
    expect(() => svc.projects()).toThrow('is invalid')
    expect(() => svc.saveProject(input())).toThrow('is invalid')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1,"projects":[{"oops":true}]}')
  })

  it('a project cannot reference an unknown repo; removing a repo removes it from projects', async () => {
    const f = fx(HAS_GIT)
    const svc = service(f)
    expect(() => svc.saveProject(input({ match: { keywords: [], paths: [], repoIds: ['abcd1234abcd1234'] } }))).toThrow('references a repo that does not exist')
    if (!HAS_GIT) return
    const [repo] = (await svc.addRepo())!
    expect(mode(path.join(f.store, PERFORMANCE_DIR, REPOS_FILENAME))).toBe(0o600)
    const [p] = svc.saveProject(input({ match: { keywords: [], paths: [], repoIds: [repo.id] } }))
    svc.removeRepo(repo.id)
    expect(svc.projects().find((x) => x.id === p.id)!.match.repoIds).toEqual([])
  })
})

describe('activity matching', () => {
  function fakeSearch(calls: string[]) {
    const recent = new Date(NOW - 2 * DAY).toISOString()
    return async (name: string, args: Record<string, unknown>): Promise<string> => {
      calls.push(`${name}:${String(args.query)}`)
      return JSON.stringify({
        query: args.query,
        results: [
          { id: 'm1', path: 'memories/alpha.md', timestamp: recent, content: '决定 lens-alpha 先内测' },
          { id: 'm2', path: 'memories/other.md', timestamp: recent, content: '语义相近但没有这个词' },
          { id: 'm3', path: 'memories/old.md', timestamp: new Date(NOW - 100 * DAY).toISOString(), content: 'lens-alpha 很久以前' },
          { id: 'm4', path: 'memories/undated.md', content: 'lens-alpha 没有时间' }
        ]
      })
    }
  }

  it('memory (literal, dated, in window) + HET tasks (path-aware, keyword in title) + transcript commits, newest first', async () => {
    const f = fx()
    const calls: string[] = []
    const svc = service(f, { ossTool: fakeSearch(calls) })
    const [p] = svc.saveProject(input())
    const a = await svc.activity(p.id, 30)
    expect(calls).toEqual(['search:lens-alpha'])
    const ids = a.items.map((i) => `${i.kind}:${i.id}`)
    expect(ids.sort()).toEqual(['het_task:t1', 'het_task:t7', 'memory:m1', 'transcript_commit:ev_commit1'].sort())
    // '/work/alpha-other' is NOT under '/work/alpha'.
    expect(ids).not.toContain('het_task:t2')
    for (let i = 1; i < a.items.length; i++) expect(a.items[i - 1].at >= a.items[i].at).toBe(true)
    const t1 = a.items.find((i) => i.id === 't1')!
    expect(t1).toMatchObject({ matchedBy: 'path:/work/alpha', evidence: { file: '~/claude/proj/s1.jsonl', line: 1 } })
    expect(a.items.find((i) => i.id === 't7')!.matchedBy).toBe('keyword:lens-alpha')
    expect(a.items.find((i) => i.id === 'm1')).toMatchObject({ ref: 'memories/alpha.md', matchedBy: 'keyword:lens-alpha' })
    expect(a.sources.git).toMatchObject({ state: 'unknown' })
  })

  it('unset rules and a down Runtime are unknown sources, not empty successes', async () => {
    const f = fx()
    const svc = service(f, {
      ossTool: async () => {
        throw new Error('runtime down')
      }
    })
    const [p] = svc.saveProject(input({ match: { keywords: ['lens-alpha'], paths: [], repoIds: [] } }))
    const a = await svc.activity(p.id, 7)
    expect(a.sources.memory).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Runtime') })
    const [q] = svc.saveProject(input({ title: 'empty', match: { keywords: [], paths: [], repoIds: [] } })).filter((x) => x.title === 'empty')
    const b = await svc.activity(q.id, 7)
    expect(b.items).toEqual([])
    expect(Object.values(b.sources).every((s) => s.state === 'unknown')).toBe(true)
  })

  it.skipIf(!HAS_GIT)('commits of the chosen repo by the user appear with their hash', async () => {
    const f = fx(true)
    const svc = service(f)
    const [repo] = (await svc.addRepo())!
    const [p] = svc.saveProject(input({ match: { keywords: [], paths: [], repoIds: [repo.id] } }))
    const a = await svc.activity(p.id, 30)
    const commits = a.items.filter((i) => i.kind === 'git_commit')
    expect(commits.map((c) => c.title).sort()).toEqual(['add a.txt', 'add b.txt', 'add old.txt'])
    for (const c of commits) expect(c.ref).toMatch(/^[0-9a-f]{40}$/)
    expect(commits.find((c) => c.title === 'add b.txt')!.day).toBe('2026-11-05')
  })
})

describe('IPC', () => {
  function ipcHarness(f: Fixture) {
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
    registerPerformanceIpc({ handle: (ch: string, fn: (e: unknown, raw: unknown) => Promise<unknown>) => void handlers.set(ch, fn) } as never, service(f))
    expect([...handlers.keys()].sort()).toEqual(Object.values(PERFORMANCE_CHANNELS).sort())
    return (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw) as Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>
  }

  it('every channel is registered and validates input', async () => {
    const f = fx()
    const call = ipcHarness(f)
    for (const ch of Object.values(PERFORMANCE_CHANNELS)) expect(ch).toMatch(/^lens:performance:/)
    expect((await call(PERFORMANCE_CHANNELS.counts, { range: 'year', offset: 0 })).ok).toBe(false)
    expect((await call(PERFORMANCE_CHANNELS.counts, { range: 'week', offset: 1 })).ok).toBe(false)
    expect((await call(PERFORMANCE_CHANNELS.rows, { range: 'week', offset: 0, kind: 'score' })).ok).toBe(false)
    expect((await call(PERFORMANCE_CHANNELS.counts, { range: 'week', offset: 0, extra: 1 })).ok).toBe(false)
    const ok = await call(PERFORMANCE_CHANNELS.counts, { range: 'week', offset: 0 })
    expect(ok.ok).toBe(true)
    const saved = await call(PERFORMANCE_CHANNELS.saveProject, { input: input() })
    expect(saved.ok).toBe(true)
    const p = (saved.data as Project[])[0]
    expect((await call(PERFORMANCE_CHANNELS.setMilestoneDone, { projectId: p.id, milestoneId: p.milestones[0].id, done: 'yes' })).ok).toBe(false)
    expect((await call(PERFORMANCE_CHANNELS.activity, { projectId: p.id, days: 365 })).ok).toBe(false)
    const err = await call(PERFORMANCE_CHANNELS.deleteProject, { id: 'ffffffffffffffff' })
    expect(err).toMatchObject({ ok: false, error: { message: 'Project not found' } })
  })
})
