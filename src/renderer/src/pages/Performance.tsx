// S1-FULL C16 「表现」 page (owner-only). B: traceable counts; C: user-written projects + activity.
// Not done: any time-saved / efficiency estimate (option A).
import { useState } from 'react'
import './Performance.css'
import { ownerOnlyNote, type RepoView } from '../../../main/performance/api'
import { tr } from '../lib/i18n'
import { CountsPanel } from '../components/performance/CountsPanel'
import { ProjectsPanel } from '../components/performance/ProjectsPanel'
import { ReposPanel } from '../components/performance/ReposPanel'

export function Performance() {
  const [repos, setRepos] = useState<RepoView[]>([])
  return (
    <div className="page perf-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">{tr('Performance · Only for you', '表现 · 只给你自己看')}</div>
          <h2>{tr('Performance', '表现')}</h2>
          <p>{ownerOnlyNote()}</p>
        </div>
      </header>
      <CountsPanel />
      <ReposPanel onChange={setRepos} />
      <ProjectsPanel repos={repos} />
    </div>
  )
}
