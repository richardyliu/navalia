// S1-FULL C16: `<LensStore>/performance/` (dir 0700, files 0600 via writeFileSecure).
//   projects.json — the user's projects (goal, milestones, match rules).
//   repos.json    — local repos the user added for commit counts.
// zod strict on read and write. A corrupt file reads as an error (never silently replaced by []):
// the page shows it and a save is refused until the user decides, so nothing the user wrote is lost.
//
// Milestone `done` / `doneAt` change ONLY in setMilestoneDone (the user's tick). saveProject keeps
// the stored done state of existing milestones and creates new ones as not done.
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { readFileIfExists, writeFileSecure } from '../store/paths'
import type { Milestone, Project, ProjectInput, RepoEntry } from './api'

export const PERFORMANCE_DIR = 'performance'
export const PROJECTS_FILENAME = 'projects.json'
export const REPOS_FILENAME = 'repos.json'
export const MAX_PROJECTS = 100
export const MAX_MILESTONES = 100
export const MAX_REPOS = 50

const Id = z.string().regex(/^[a-z0-9-]{4,64}$/)
const DateLabel = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Iso = z.string().max(40)
const Keyword = z.string().trim().min(1).max(80)
const AbsPath = z.string().min(1).max(1024).refine((p) => path.isAbsolute(p), { error: () => tr('Path must be absolute', '路径必须是绝对路径') })

const MilestoneSchema = z.strictObject({
  id: Id,
  title: z.string().trim().min(1).max(200),
  targetDate: DateLabel.nullable(),
  note: z.string().max(2000),
  done: z.boolean(),
  doneAt: Iso.nullable()
})

const MatchSchema = z.strictObject({
  keywords: z.array(Keyword).max(10),
  paths: z.array(AbsPath).max(10),
  repoIds: z.array(Id).max(10)
})

export const ProjectSchema = z.strictObject({
  id: Id,
  title: z.string().trim().min(1).max(200),
  goal: z.string().max(4000),
  milestones: z.array(MilestoneSchema).max(MAX_MILESTONES),
  match: MatchSchema,
  createdAt: Iso,
  updatedAt: Iso
})

const ProjectsFile = z.strictObject({ version: z.literal(1), projects: z.array(ProjectSchema).max(MAX_PROJECTS) })

export const ProjectInputSchema = z.strictObject({
  id: Id.optional(),
  title: z.string().trim().min(1, { error: () => tr('Project name cannot be empty', '项目名不能为空') }).max(200),
  goal: z.string().max(4000),
  milestones: z
    .array(z.strictObject({ id: Id.optional(), title: z.string().trim().min(1, { error: () => tr('Milestone title cannot be empty', '里程碑标题不能为空') }).max(200), targetDate: DateLabel.nullable(), note: z.string().max(2000) }))
    .max(MAX_MILESTONES),
  match: MatchSchema
})

const RepoSchema = z.strictObject({ id: Id, path: AbsPath, authorEmail: z.string().trim().min(3).max(320).nullable(), addedAt: Iso })
const ReposFile = z.strictObject({ version: z.literal(1), repos: z.array(RepoSchema).max(MAX_REPOS) })

export class PerformanceStoreError extends Error {}

export function newId(): string {
  return randomBytes(8).toString('hex')
}

export function createPerformanceStore(storeRoot: string, now: () => number = Date.now) {
  const dir = path.join(storeRoot, PERFORMANCE_DIR)
  const projectsFile = path.join(dir, PROJECTS_FILENAME)
  const reposFile = path.join(dir, REPOS_FILENAME)
  const stamp = (): string => new Date(now()).toISOString()

  function read<T>(file: string, schema: z.ZodType<T>, empty: T, label: string): T {
    let raw: Buffer | null
    try {
      raw = readFileIfExists(file)
    } catch {
      throw new PerformanceStoreError(tr(`Cannot read ${label}`, `无法读取 ${label}`))
    }
    if (raw === null) return empty
    try {
      return schema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      throw new PerformanceStoreError(tr(`${label} is invalid. To avoid overwriting what you wrote, Navalia will not rewrite it automatically`, `${label} 无效：为避免覆盖你写的内容，Navalia 不会自动重写它`))
    }
  }

  const readProjects = (): Project[] => read(projectsFile, ProjectsFile, { version: 1 as const, projects: [] }, 'performance/projects.json').projects
  const writeProjects = (projects: Project[]): Project[] => {
    const parsed = ProjectsFile.parse({ version: 1, projects })
    writeFileSecure(projectsFile, `${JSON.stringify(parsed, null, 2)}\n`)
    return parsed.projects
  }
  const readRepos = (): RepoEntry[] => read(reposFile, ReposFile, { version: 1 as const, repos: [] }, 'performance/repos.json').repos
  const writeRepos = (repos: RepoEntry[]): RepoEntry[] => {
    const parsed = ReposFile.parse({ version: 1, repos })
    writeFileSecure(reposFile, `${JSON.stringify(parsed, null, 2)}\n`)
    return parsed.repos
  }

  return {
    dir,
    projectsFile,
    reposFile,
    readProjects,
    readRepos,

    saveProject(raw: unknown): Project[] {
      const input: ProjectInput = ProjectInputSchema.parse(raw)
      const projects = readProjects()
      const repoIds = new Set(readRepos().map((r) => r.id))
      const unknownRepo = input.match.repoIds.find((id) => !repoIds.has(id))
      if (unknownRepo) throw new PerformanceStoreError(tr('The project references a repo that does not exist', '项目引用了不存在的仓库'))
      const existing = input.id ? projects.find((p) => p.id === input.id) : undefined
      if (input.id && !existing) throw new PerformanceStoreError(tr('Project not found', '项目不存在'))
      if (!existing && projects.length >= MAX_PROJECTS) throw new PerformanceStoreError(tr(`At most ${MAX_PROJECTS} projects`, `最多 ${MAX_PROJECTS} 个项目`))
      const oldMs = new Map((existing?.milestones ?? []).map((m) => [m.id, m]))
      const milestones: Milestone[] = input.milestones.map((m) => {
        const prev = m.id ? oldMs.get(m.id) : undefined
        return {
          id: prev?.id ?? newId(),
          title: m.title,
          targetDate: m.targetDate,
          note: m.note,
          // Never from input: only setMilestoneDone changes these.
          done: prev?.done ?? false,
          doneAt: prev?.doneAt ?? null
        }
      })
      const t = stamp()
      const next: Project = {
        id: existing?.id ?? newId(),
        title: input.title,
        goal: input.goal,
        milestones,
        match: { keywords: [...new Set(input.match.keywords)], paths: [...new Set(input.match.paths)], repoIds: [...new Set(input.match.repoIds)] },
        createdAt: existing?.createdAt ?? t,
        updatedAt: t
      }
      return writeProjects(existing ? projects.map((p) => (p.id === next.id ? next : p)) : [...projects, next])
    },

    deleteProject(id: string): Project[] {
      const projects = readProjects()
      if (!projects.some((p) => p.id === id)) throw new PerformanceStoreError(tr('Project not found', '项目不存在'))
      return writeProjects(projects.filter((p) => p.id !== id))
    },

    /** The user's explicit tick. The only code path that changes `done`. */
    setMilestoneDone(projectId: string, milestoneId: string, done: boolean): Project[] {
      const projects = readProjects()
      const p = projects.find((x) => x.id === projectId)
      const m = p?.milestones.find((x) => x.id === milestoneId)
      if (!p || !m) throw new PerformanceStoreError(tr('Milestone not found', '里程碑不存在'))
      const t = stamp()
      const updated: Project = {
        ...p,
        updatedAt: t,
        milestones: p.milestones.map((x) => (x.id === milestoneId ? { ...x, done, doneAt: done ? t : null } : x))
      }
      return writeProjects(projects.map((x) => (x.id === projectId ? updated : x)))
    },

    addRepo(toplevel: string): RepoEntry[] {
      const repos = readRepos()
      if (repos.some((r) => r.path === toplevel)) return repos
      if (repos.length >= MAX_REPOS) throw new PerformanceStoreError(tr(`At most ${MAX_REPOS} repos`, `最多 ${MAX_REPOS} 个仓库`))
      return writeRepos([...repos, { id: newId(), path: toplevel, authorEmail: null, addedAt: stamp() }])
    },

    updateRepo(id: string, authorEmail: string | null): RepoEntry[] {
      const repos = readRepos()
      if (!repos.some((r) => r.id === id)) throw new PerformanceStoreError(tr('Repo not found', '仓库不存在'))
      return writeRepos(repos.map((r) => (r.id === id ? { ...r, authorEmail } : r)))
    },

    /** Also removes the repo from every project's match rules. */
    removeRepo(id: string): RepoEntry[] {
      const repos = readRepos()
      if (!repos.some((r) => r.id === id)) throw new PerformanceStoreError(tr('Repo not found', '仓库不存在'))
      const next = writeRepos(repos.filter((r) => r.id !== id))
      const projects = readProjects()
      if (projects.some((p) => p.match.repoIds.includes(id))) {
        writeProjects(projects.map((p) => ({ ...p, match: { ...p.match, repoIds: p.match.repoIds.filter((r) => r !== id) } })))
      }
      return next
    }
  }
}

export type PerformanceStore = ReturnType<typeof createPerformanceStore>
