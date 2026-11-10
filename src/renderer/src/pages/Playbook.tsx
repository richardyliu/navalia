import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { copiedToast } from '../components/Toaster'
import { EvidenceLinks } from '../components/workflows/EvidenceLinks'
import { WorkflowPanel } from '../components/workflows/WorkflowPanel'
import { workflowsApi } from '../components/workflows/client'
import { workflowIdFromParams } from '../components/workflows/extractView'
import { useNav } from '../lib/nav'
import { habitChipClass, habitOfFace, habitOfPatternSkill, playbookStructure } from '../components/workflows/viewModel'
import { api, errorMessage } from '../lib/api'
import { confidence, formatDateTime, formatNumber } from '../lib/format'
import { getLocale, tr } from '../lib/i18n'
import { usePatterns } from '../lib/queries'

export function Playbook() {
  const queryClient = useQueryClient()
  // S2-07 deep link: Library / Today call go('playbook', { workflowId }).
  const deepLinkId = workflowIdFromParams(useNav().params)
  const patterns = usePatterns()
  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: workflowsApi.list,
    staleTime: 30_000
  })
  const data = patterns.data
  // S1-R3-03: evidence pointer of a Runtime R8 step / artifact / rule / problem, opened in the drawer.
  const [evidenceRef, setEvidenceRef] = useState<string | null>(null)
  const empty = data && !data.root && data.faces.length === 0 && data.skills.length === 0

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Playbook</div>
          <h2>{tr('Behavior patterns and workflows', '行为模式与工作流')}</h2>
          <p className="muted">{tr("Runtime's resident layer: Root, Faces, and Playbooks drawn from repeated work. Read with zero LLM calls.", 'Runtime 的常驻层：Root、Faces、以及从重复工作里抽出的 Playbook。零 LLM 读取。')}</p>
        </div>
        <div className="page-actions">
          <button
            className="btn ghost"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['patterns'] })
              void queryClient.invalidateQueries({ queryKey: ['workflows'] })
              void queryClient.invalidateQueries({ queryKey: ['workflow'] })
            }}
          >
            {tr('Refresh', '刷新')}
          </button>
          {data ? (
            <span className="chip subtle">
              {formatNumber(data.faces.length)} Faces · {formatNumber(data.skills.length)} Playbooks
            </span>
          ) : null}
        </div>
      </header>

      {patterns.isError ? <div className="banner bad compact">{errorMessage(patterns.error)}</div> : null}

      {empty ? (
        <div className="banner warn">
          <div>
            <strong>{tr('No behavior patterns yet', '还没有形成行为模式')}</strong>
            {getLocale() === 'zh' ? (
              <p>
                Face / Volume / Playbook 需要跨会话重复证据，再跑一次
                <code> persome model build</code>。当前模型里还没有 Faces。Runtime（schema 2026-11-05.3
                起）要求 Face 的观察覆盖至少 3 个不同日期才晋升；Navalia 对 Playbook 用同样的规则，不足 3
                个日期的标为“观察中”。
              </p>
            ) : (
              <p>
                Faces / Volumes / Playbooks need repeated evidence across sessions, followed by another run of
                <code> persome model build</code>. The current model has no Faces yet. Runtime (schema 2026-11-05.3 and later) promotes a Face only
                when its observations cover at least 3 distinct dates; Navalia applies the same rule to Playbooks and marks those with fewer than 3
                dates as "Observing".
              </p>
            )}
          </div>
        </div>
      ) : null}

      <WorkflowPanel initialId={deepLinkId} />

      {data?.root ? (
        <section className="card root-card">
          <div className="card-head">
            <h3>Root</h3>
            <span className="chip ok">active</span>
          </div>
          <p className="root-text">{data.root.signature}</p>
          <div className="root-meta">
            <span>{tr(`Confidence ${confidence(data.root.confidence)}`, `置信度 ${confidence(data.root.confidence)}`)}</span>
            {data.root.created_at ? <span>{tr(`Generated ${formatDateTime(data.root.created_at)}`, `生成于 ${formatDateTime(data.root.created_at)}`)}</span> : null}
          </div>
        </section>
      ) : null}

      {data?.faces.length ? (
        <section className="card">
          <div className="card-head">
            <h3>{tr('Faces (behavior patterns)', 'Faces（行为模式）')}</h3>
            <span className="muted small">{tr('Sorted by confidence', '按置信度排序')}</span>
          </div>
          <div className="schema-list">
            {data.faces.map((face, index) => {
              const faceHabit = habitOfFace(face)
              return (
              <div key={`${face.signature}-${index}`} className="schema-item">
                <div className="schema-title">{face.signature}</div>
                <div className="schema-meta">
                  <span>confidence {confidence(face.confidence)}</span>
                  <span>observations {formatNumber(face.observations)}</span>
                  {face.provenance ? <span className="chip subtle">{face.provenance}</span> : null}
                  {typeof face.level === 'number' ? <span>L{face.level}</span> : null}
                  <span className={habitChipClass(faceHabit)} title={faceHabit.detail}>
                    {faceHabit.label}
                  </span>
                </div>
              </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {data?.skills.length ? (
        <section className="card">
          <div className="card-head">
            <h3>{tr('Playbooks (observed workflows)', 'Playbooks（观察到的工作流）')}</h3>
            <span className="muted small">{tr(`${formatNumber(data.skills.length)} total`, `${formatNumber(data.skills.length)} 个`)}</span>
          </div>
          <div className="playbook-list">
            {data.skills.map((skill) => {
              const habit = habitOfPatternSkill(skill, workflows.data)
              const structure = playbookStructure(skill)
              return (
                <article key={skill.path} className="playbook-item">
                  <div className="playbook-head">
                    <div>
                      <div className="schema-title">{skill.description || skill.path}</div>
                      <div className="schema-meta">
                        <span className="mono">{skill.path}</span>
                        {skill.observed_at ? <span>{tr(`Observed ${formatDateTime(skill.observed_at)}`, `观察于 ${formatDateTime(skill.observed_at)}`)}</span> : null}
                        <span className={habitChipClass(habit)} title={habit.detail}>
                          {habit.label}
                        </span>
                      </div>
                    </div>
                    <button className="btn ghost small" onClick={() => void api.copy(skill.playbook).then(() => copiedToast(tr('skill', '技能')))}>
                      {tr('Copy', '复制')}
                    </button>
                  </div>
                  {structure.empty ? null : (
                    <div className="playbook-structure">
                      {structure.steps.length ? (
                        <ol>
                          {structure.steps.map((s) => (
                            <li key={s.order}>
                              {s.text} <EvidenceLinks links={s.links} onOpen={setEvidenceRef} />
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      {structure.artifacts.length ? (
                        <div className="small">
                          {tr('Artifacts:', '产出：')}
                          {structure.artifacts.map((a) => (
                            <span key={`${a.kind}:${a.value}`}>
                              <span className="mono">{a.value}</span> <EvidenceLinks links={a.links} onOpen={setEvidenceRef} />
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {structure.rules.map((r) => (
                        <div key={r.text} className="small">
                          {tr(`Rule: ${r.text}`, `规则：${r.text}`)} <EvidenceLinks links={r.links} onOpen={setEvidenceRef} />
                        </div>
                      ))}
                      {structure.problems.map((p) => (
                        <div key={p.problem} className="small">
                          {tr(`Problem: ${p.problem}`, `问题：${p.problem}`)}
                          {p.solution ? ` → ${p.solution}` : ''} <EvidenceLinks links={p.links} onOpen={setEvidenceRef} />
                        </div>
                      ))}
                    </div>
                  )}
                  <pre className="playbook-text">{skill.playbook}</pre>
                </article>
              )
            })}
          </div>
        </section>
      ) : null}

      {evidenceRef ? <EvidenceDrawer reference={evidenceRef} onClose={() => setEvidenceRef(null)} onNavigate={setEvidenceRef} /> : null}

      {data?.rendered ? (
        <section className="card">
          <div className="card-head">
            <h3>{tr('Runtime rendered block', 'Runtime 渲染块')}</h3>
            <button className="btn ghost small" onClick={() => void api.copy(data.rendered).then(() => copiedToast(tr('rendered block', '渲染块')))}>
              {tr('Copy', '复制')}
            </button>
          </div>
          <pre className="playbook-text rendered">{data.rendered}</pre>
        </section>
      ) : null}
    </div>
  )
}
