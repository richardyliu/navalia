// S1-FULL C16 「表现」 C: projects the user writes (goal + milestones) and their dated activity.
// No "how far along" number, no guessed end date; only the user ticks a milestone.
import { useEffect, useState } from 'react'
import { tr } from '../../lib/i18n'
import { ACTIVITY_WINDOWS, activityOnlyNote, type Project, type ProjectActivity, type ProjectInput, type RepoView } from '../../../../main/performance/api'
import {
  activityKindLabel,
  emptyProjectInput,
  evidenceText,
  groupByDay,
  matchedByText,
  parseList,
  performanceBridge,
  sourceText,
  sourceTone,
  targetText,
  toInput
} from '../../pages/performanceView'

type Result<T> = { ok: true; data: T } | { ok: false; error: { message: string } }

function ProjectEditor({ initial, repos, busy, onSave, onCancel }: { initial: ProjectInput; repos: RepoView[]; busy: boolean; onSave: (p: ProjectInput) => void; onCancel: () => void }) {
  const [p, setP] = useState<ProjectInput>(initial)
  const [keywords, setKeywords] = useState(initial.match.keywords.join('\n'))
  const [paths, setPaths] = useState(initial.match.paths.join('\n'))
  const setMs = (i: number, patch: Partial<ProjectInput['milestones'][number]>): void =>
    setP({ ...p, milestones: p.milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)) })
  return (
    <div className="perf-editor" data-testid="perf-editor">
      <label className="small">
        {tr('Project name', '项目名')}
        <input value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} />
      </label>
      <label className="small">
        {tr('Goal (in your own words)', '目标（你自己的话）')}
        <textarea rows={3} value={p.goal} onChange={(e) => setP({ ...p, goal: e.target.value })} />
      </label>
      <div className="small">{tr('Milestones', '里程碑')}</div>
      {p.milestones.map((m, i) => (
        <div className="perf-row" key={m.id ?? `new-${i}`}>
          <input placeholder={tr('Title', '标题')} value={m.title} onChange={(e) => setMs(i, { title: e.target.value })} />
          <input type="date" value={m.targetDate ?? ''} onChange={(e) => setMs(i, { targetDate: e.target.value || null })} />
          <input placeholder={tr('Note', '备注')} value={m.note} onChange={(e) => setMs(i, { note: e.target.value })} />
          <button className="btn ghost small" onClick={() => setP({ ...p, milestones: p.milestones.filter((_, j) => j !== i) })}>
            {tr('Delete', '删除')}
          </button>
        </div>
      ))}
      <button className="btn ghost small" onClick={() => setP({ ...p, milestones: [...p.milestones, { title: '', targetDate: null, note: '' }] })}>
        {tr('+ Milestone', '+ 里程碑')}
      </button>
      <label className="small">
        {tr('Keywords (one per line; literal match against memory and Agent session titles only)', '关键词（每行一个；只按字面匹配记忆和 Agent 会话标题）')}
        <textarea rows={2} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      </label>
      <label className="small">
        {tr('Paths (one absolute path per line; matched against Agent session working directories)', '路径（每行一个绝对路径；匹配 Agent 会话的工作目录）')}
        <textarea rows={2} className="mono" value={paths} onChange={(e) => setPaths(e.target.value)} />
      </label>
      <div className="small">{tr('Repos', '仓库')}</div>
      {repos.length === 0 ? <p className="tiny muted">{tr('Add them under "Local repos" first.', '先在「本地仓库」里添加。')}</p> : null}
      {repos.map((r) => (
        <label key={r.id} className="tiny">
          <input
            type="checkbox"
            checked={p.match.repoIds.includes(r.id)}
            onChange={(e) =>
              setP({ ...p, match: { ...p.match, repoIds: e.target.checked ? [...p.match.repoIds, r.id] : p.match.repoIds.filter((x) => x !== r.id) } })
            }
          />{' '}
          <span className="mono">{r.path}</span>
        </label>
      ))}
      <div className="card-foot wrap">
        <button
          className="btn small"
          disabled={busy || !p.title.trim()}
          onClick={() => onSave({ ...p, match: { ...p.match, keywords: parseList(keywords), paths: parseList(paths) } })}
        >
          {tr('Save', '保存')}
        </button>
        <button className="btn ghost small" disabled={busy} onClick={onCancel}>
          {tr('Cancel', '取消')}
        </button>
      </div>
    </div>
  )
}

function ActivityList({ project }: { project: Project }) {
  const api = performanceBridge()
  const [days, setDays] = useState<number>(30)
  const [data, setData] = useState<ProjectActivity | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!api) return
    let live = true
    setData(null)
    setError(null)
    void api.activity(project.id, days).then((r) => {
      if (!live) return
      if (r.ok) setData(r.data)
      else setError(r.error.message)
    })
    return () => {
      live = false
    }
  }, [api, project.id, project.updatedAt, days])
  return (
    <div className="perf-activity" data-testid="perf-activity">
      <div className="perf-row">
        <strong className="small">{tr('Activity', '活动')}</strong>
        <div className="segmented">
          {ACTIVITY_WINDOWS.map((d) => (
            <button key={d} className={`seg-btn ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>
              {tr(`Last ${d} days`, `近 ${d} 天`)}
            </button>
          ))}
        </div>
      </div>
      {error ? <div className="banner bad compact">{error}</div> : null}
      {data ? (
        <>
          <ul className="perf-sources tiny">
            {(['memory', 'het', 'git'] as const).map((k) => (
              <li key={k}>
                <span className={`chip ${sourceTone(data.sources[k])}`}>{k === 'memory' ? tr('Memory', '记忆') : k === 'het' ? tr('Agent sessions', 'Agent 会话') : tr('Repos', '仓库')}</span> {sourceText(data.sources[k])}
              </li>
            ))}
          </ul>
          {data.items.length === 0 ? <p className="muted small">
              {tr(
                "No matching activity found in this period (this doesn't mean the project stalled; Navalia just didn't see any).",
                '这段时间没有找到匹配的活动（不代表项目没有进展，只是 Navalia 没看到）。'
              )}
            </p> : null}
          {groupByDay(data.items).map((g) => (
            <div key={g.day} className="perf-day">
              <div className="mono tiny muted">{g.day}</div>
              <ul className="small">
                {g.items.map((it) => (
                  <li key={`${it.kind}:${it.id}`}>
                    <span className="chip subtle">{activityKindLabel(it.kind)}</span> {it.title}
                    <div className="tiny muted mono">
                      {matchedByText(it.matchedBy)} · {it.ref}
                      {it.evidence ? ` · ${evidenceText(it.evidence)}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : !error ? (
        <p className="muted small">{tr('Loading…', '读取中…')}</p>
      ) : null}
    </div>
  )
}

export function ProjectsPanel({ repos }: { repos: RepoView[] }) {
  const api = performanceBridge()
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<ProjectInput | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  async function call(fn: () => Promise<Result<Project[]>>, after?: () => void): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (r.ok) {
        setProjects(r.data)
        after?.()
      } else setError(r.error.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (api) void call(() => api.projects())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  if (!api) return null
  return (
    <section className="card" data-testid="perf-projects">
      <div className="card-head">
        <h3>{tr('Projects', '项目')}</h3>
        <button className="btn ghost small" disabled={busy || editing !== null} onClick={() => setEditing(emptyProjectInput())}>
          {tr('New project', '新建项目')}
        </button>
      </div>
      <p className="muted small">{activityOnlyNote()}</p>
      {error ? <div className="banner bad compact">{error}</div> : null}
      {editing ? (
        <ProjectEditor
          initial={editing}
          repos={repos}
          busy={busy}
          onSave={(p) => void call(() => api.saveProject(p), () => setEditing(null))}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {projects.length === 0 && !editing ? <p className="muted small">
          {tr('No projects yet. Write a goal and a few milestones, and Navalia will list related activity.', '还没有项目。写一个目标和几个里程碑，Navalia 会列出相关的活动。')}
        </p> : null}
      {projects.map((p) => (
        <article key={p.id} className="perf-project">
          <div className="card-head">
            <h3 className="small">{p.title}</h3>
            <div className="perf-row">
              <button className="btn ghost small" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                {openId === p.id ? tr('Hide activity', '收起活动') : tr('View activity', '查看活动')}
              </button>
              <button className="btn ghost small" disabled={busy || editing !== null} onClick={() => setEditing(toInput(p))}>
                {tr('Edit', '编辑')}
              </button>
              <button className="btn ghost small" disabled={busy} onClick={() => void call(() => api.deleteProject(p.id))}>
                {tr('Delete', '删除')}
              </button>
            </div>
          </div>
          {p.goal ? <p className="small">{p.goal}</p> : null}
          <ul className="perf-milestones small">
            {p.milestones.map((m) => (
              <li key={m.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={m.done}
                    disabled={busy}
                    onChange={(e) => void call(() => api.setMilestoneDone(p.id, m.id, e.target.checked))}
                  />{' '}
                  {m.title}
                </label>
                <span className="tiny muted">
                  {' '}
                  · {targetText(m.targetDate)}
                  {m.done && m.doneAt ? tr(` · Ticked by you on ${m.doneAt.slice(0, 10)}`, ` · 你在 ${m.doneAt.slice(0, 10)} 勾选`) : ''}
                </span>
                {m.note ? <div className="tiny muted">{m.note}</div> : null}
              </li>
            ))}
          </ul>
          {openId === p.id ? <ActivityList project={p} /> : null}
        </article>
      ))}
    </section>
  )
}
