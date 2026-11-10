// S1-FULL C16: local repos the user adds for commit counts (read-only git log, no network).
import { useEffect, useState } from 'react'
import type { RepoView } from '../../../../main/performance/api'
import { tr } from '../../lib/i18n'
import { performanceBridge } from '../../pages/performanceView'

export function ReposPanel({ onChange }: { onChange?: (repos: RepoView[]) => void }) {
  const api = performanceBridge()
  const [repos, setRepos] = useState<RepoView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [emails, setEmails] = useState<Record<string, string>>({})

  function accept(list: RepoView[]): void {
    setRepos(list)
    setEmails(Object.fromEntries(list.map((r) => [r.id, r.authorEmail ?? ''])))
    onChange?.(list)
  }

  async function call(fn: () => Promise<{ ok: true; data: RepoView[] | null } | { ok: false; error: { message: string } }>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (r.ok) {
        if (r.data) accept(r.data)
      } else setError(r.error.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (api) void call(() => api.repos())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  if (!api) return null
  return (
    <section className="card" data-testid="perf-repos">
      <div className="card-head">
        <h3>{tr('Local repos (source of commit counts)', '本地仓库（提交计数来源）')}</h3>
        <button className="btn ghost small" disabled={busy} onClick={() => void call(() => api.addRepo())}>
          {tr('Add repo…', '添加仓库…')}
        </button>
      </div>
      <p className="muted small">
        {tr('Runs ', '只读运行 ')}
        <span className="mono">git log</span>
        {tr(
          ' read-only, offline, and never writes to the repo. Only commits whose author email equals your git user.email (or the email you enter below) are counted. With no repos added, the commit count shows "Unknown / not connected".',
          '，不联网、不写仓库。只数作者邮箱等于你的 git user.email（或你在下面填的邮箱）的提交。没有添加仓库时，提交计数显示「未知 / 未接入」。'
        )}
      </p>
      {error ? <div className="banner bad compact">{error}</div> : null}
      {repos.length === 0 ? <p className="muted small">{tr('No repos added yet.', '还没有添加仓库。')}</p> : null}
      <ul className="perf-repo-list small">
        {repos.map((r) => (
          <li key={r.id}>
            <span className="mono">{r.path}</span>
            <input
              className="mono small"
              placeholder={tr('Author email (empty = git user.email)', '作者邮箱（留空 = git user.email）')}
              value={emails[r.id] ?? ''}
              onChange={(e) => setEmails({ ...emails, [r.id]: e.target.value })}
            />
            <button
              className="btn ghost small"
              disabled={busy || (emails[r.id] ?? '') === (r.authorEmail ?? '')}
              onClick={() => void call(() => api.updateRepo(r.id, (emails[r.id] ?? '').trim() || null))}
            >
              {tr('Save email', '保存邮箱')}
            </button>
            <button className="btn ghost small" disabled={busy} onClick={() => void call(() => api.removeRepo(r.id))}>
              {tr('Remove', '移除')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
