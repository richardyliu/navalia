import { useState } from 'react'
import '../components/library/library.css'
import { libraryHeadline } from '../../../main/library/aggregate'
import type { LibraryEntity, LibraryOverview, LibrarySectionError } from '../../../main/library/api'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { Skeleton } from '../components/Skeleton'
import { EntityCard } from '../components/library/EntityCard'
import { useLibraryOverview } from '../components/library/useLibrary'
import {
  libraryAllEmpty,
  librarySkillsHeadline,
  portraitCountsLine,
  portraitState,
  skillBadges,
  skillCountChips
} from '../components/library/viewModel'
import { confidence, formatDateTime, formatNumber, truncate } from '../lib/format'
import { tr } from '../lib/i18n'
import { useNav } from '../lib/nav'

function Column({
  title,
  items,
  empty,
  error,
  expanded,
  setExpanded,
  onEvidence
}: {
  title: string
  items: LibraryEntity[]
  empty: string
  error?: LibrarySectionError | null
  expanded: string | null
  setExpanded: (key: string | null) => void
  onEvidence: (reference: string) => void
}) {
  return (
    <section className="card lib-col">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="chip subtle">{items.length}</span>
      </div>
      {error ? <div className="banner bad compact">{tr(`Failed to read the model: ${error.message}`, `模型读取失败：${error.message}`)}</div> : null}
      {!error && items.length === 0 ? <p className="muted small">{empty}</p> : null}
      {items.map((e) => (
        <EntityCard
          key={e.key}
          entity={e}
          expanded={expanded === e.key}
          onToggle={() => setExpanded(expanded === e.key ? null : e.key)}
          onEvidence={onEvidence}
        />
      ))}
    </section>
  )
}

function PortraitSection({ o }: { o: LibraryOverview }) {
  const { go } = useNav()
  const state = portraitState(o)
  return (
    <section className="card lib-col">
      <div className="card-head">
        <h3>{tr('Profile', '画像')}</h3>
        <button className="btn small" onClick={() => go('model')}>
          {tr('Open model', '打开模型')}
        </button>
      </div>
      {state.kind === 'error' ? <div className="banner bad compact">{tr(`Failed to read the model: ${state.message}`, `模型读取失败：${state.message}`)}</div> : null}
      {state.kind === 'empty' ? <p className="muted small">{state.message}</p> : null}
      {state.kind === 'ok' ? (
        <>
          <article className="lib-item">
            <header className="lib-item-head">
              <strong>Root</strong>
              {state.portrait.root ? (
                <span className="tiny muted">
                  {tr(
                    `Observed ${formatNumber(state.portrait.root.observations)} · confidence ${confidence(state.portrait.root.confidence)}`,
                    `观察 ${formatNumber(state.portrait.root.observations)} · 置信度 ${confidence(state.portrait.root.confidence)}`
                  )}
                </span>
              ) : null}
            </header>
            <p className="lib-item-body small">{state.portrait.root ? state.portrait.root.signature : tr('No Root formed yet.', 'Root 还没形成。')}</p>
          </article>
          <article className="lib-item">
            <header className="lib-item-head">
              <strong>Top 3 Faces</strong>
              <span className="tiny muted">{tr('In Runtime order: observations, confidence', '按 Runtime 的排序：观察次数、置信度')}</span>
            </header>
            {state.portrait.topFaces.length === 0 ? <p className="muted small">{tr('No Faces yet.', '还没有 Face。')}</p> : null}
            <ol className="lib-faces">
              {state.portrait.topFaces.map((f, i) => (
                <li key={f.id ?? `${i}:${f.signature}`} className="small">
                  {f.signature}
                  <span className="tiny muted">
                    {' '}
                    {tr(`· observed ${formatNumber(f.observations)} · confidence ${confidence(f.confidence)}`, `· 观察 ${formatNumber(f.observations)} · 置信度 ${confidence(f.confidence)}`)}
                  </span>
                </li>
              ))}
            </ol>
          </article>
          <p className="tiny muted">{portraitCountsLine(state.portrait)}</p>
        </>
      ) : null}
    </section>
  )
}

function SkillsSection({ o, onEvidence }: { o: LibraryOverview; onEvidence: (reference: string) => void }) {
  const { go } = useNav()
  const headline = librarySkillsHeadline(o.skills)
  return (
    <section className="card lib-col">
      <div className="card-head">
        <h3>{tr('Skills', '技能')}</h3>
        <span className="chip subtle">{o.skills.length}</span>
      </div>
      <p className="small">{headline.text}</p>
      <div className="lib-chips">
        {skillCountChips(o.skillCounts).map((c) => (
          <span key={c.label} className="chip subtle">
            {c.label} {c.count}
          </span>
        ))}
      </div>
      {o.workflowError ? <div className="banner bad compact">{tr(`Failed to read the Workflow library: ${o.workflowError.message}`, `Workflow 库读取失败：${o.workflowError.message}`)}</div> : null}
      {o.skillsError ? <div className="banner bad compact">{tr(`Failed to read behavior_patterns: ${o.skillsError.message}`, `behavior_patterns 读取失败：${o.skillsError.message}`)}</div> : null}
      {!o.workflowError && !o.skillsError && o.skills.length === 0 ? (
        <p className="muted small">
          {tr('No skills yet: Runtime has not observed a playbook, and no Workflows were imported or shared with you.', '还没有技能：Runtime 还没观察到 playbook，也没有导入 / 别人分享的 Workflow。')}
        </p>
      ) : null}
      {o.skills.map((s) => (
        <article className="lib-item" key={s.id}>
          <header className="lib-item-head">
            <button className="btn ghost small lib-item-name lib-skill-link" title={tr(`Open ${s.id} in Playbook`, `在 Playbook 打开 ${s.id}`)} onClick={() => go('playbook', { workflowId: s.id })}>
              {s.title}
            </button>
            {skillBadges(s).map((b) => (
              <span key={b} className="chip subtle">
                {b}
              </span>
            ))}
          </header>
          <p className="lib-item-body small">{s.summary ? truncate(s.summary, 160) : <span className="muted">{tr('No goal to map.', '没有可映射的目标。')}</span>}</p>
          {s.sameContentAs ? <p className="tiny muted">{tr(`Same content as ${s.sameContentAs}`, `与 ${s.sameContentAs} 内容相同`)}</p> : null}
          <div className="lib-item-actions">
            <span className="tiny muted mono">{s.id}</span>
            <span className="tiny muted">{s.updated ? formatDateTime(s.updated) : tr('Time unknown', '时间未知')}</span>
            <button
              className="btn small"
              disabled={!s.evidenceRef}
              title={s.evidenceRef ?? tr('No evidence reference', '没有证据引用')}
              onClick={() => s.evidenceRef && onEvidence(s.evidenceRef)}
            >
              {tr(`Evidence ${s.evidenceCount}`, `证据 ${s.evidenceCount}`)}
            </button>
          </div>
        </article>
      ))}
    </section>
  )
}

export function Library() {
  const overview = useLibraryOverview()
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const o = overview.data

  return (
    <div className="page lib-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Library</div>
          <h2>{o && !o.graphError ? libraryHeadline(o.counts) : tr('Library', '资料库')}</h2>
          <p className="muted">
            {tr('People / Projects are grouped only by the type Runtime itself reports (entity file prefix and relation endpoint type); anything without a type goes to "Unclassified", with no guessing. Profile is the Root / Faces text from the model. Skills = playbooks observed by Runtime + Workflows imported or shared with you.', '人 / 项目只按 Runtime 自己给出的类型分组（实体文件前缀与关系端点类型）；Runtime 没给类型的放进「未分类」，不猜。画像是模型里的 Root / Faces 原文。技能 = Runtime 观察到的 playbook + 导入 / 别人分享的 Workflow。')}
            {o ? tr(` Also ${o.counts.unclassified} unclassified and ${o.counts.skills} skills.`, ` 另有 ${o.counts.unclassified} 个未分类、${o.counts.skills} 个技能。`) : ''}
          </p>
        </div>
        <div className="page-actions">
          {o?.generatedAt ? <span className="tiny muted">{tr(`Model generated ${formatDateTime(o.generatedAt)}`, `模型生成于 ${formatDateTime(o.generatedAt)}`)}</span> : null}
          <button className="btn small" disabled={overview.isFetching} onClick={() => void overview.refetch()}>
            {tr('Refresh', '刷新')}
          </button>
        </div>
      </header>

      <div className="banner compact lib-hint">
        {tr('Use it in Claude Code: first connect Claude Code to the local Broker on the Connections page. Then ask Claude Code "who is X" or "what projects am I working on", and it reads the same data shown here through MCP (entity_graph / behavior_patterns).', '在 Claude Code 里使用：先到「Connections」页把 Claude Code 连接到本地 Broker；之后在 Claude Code 里问“X 是谁”“我在做哪些项目”，它会通过 MCP（entity_graph / behavior_patterns）读到这里的同一份资料。')}
      </div>

      {overview.isLoading ? (
        <section className="grid two">
          <div className="card">
            <Skeleton rows={3} />
          </div>
          <div className="card">
            <Skeleton rows={3} />
          </div>
        </section>
      ) : null}
      {overview.isError ? (
        <div className="banner bad">
          <p>{tr(`Failed to read the library: ${overview.error.message}`, `读取资料库失败：${overview.error.message}`)}</p>
        </div>
      ) : null}

      {o ? (
        <>
          {libraryAllEmpty(o) ? (
            <div className="banner warn compact">
              {tr('Runtime has no people / projects / profile / skills yet. Check back after capture and model builds have run for a while, or import Claude Code / Codex history on the Import page.', 'Runtime 里还没有人 / 项目 / 画像 / 技能。等采集和模型构建跑过一段时间后再来看；也可以去「导入」页导入 Claude Code / Codex 历史。')}
            </div>
          ) : null}
          <div className="lib-grid lib-grid-4">
            <Column title={tr('People', '人')} items={o.people} empty={tr('No people yet.', '还没有人。')} error={o.graphError} expanded={expanded} setExpanded={setExpanded} onEvidence={setSelected} />
            <Column title={tr('Projects', '项目')} items={o.projects} empty={tr('No projects yet.', '还没有项目。')} error={o.graphError} expanded={expanded} setExpanded={setExpanded} onEvidence={setSelected} />
            <PortraitSection o={o} />
            <SkillsSection o={o} onEvidence={setSelected} />
          </div>
          {o.unclassified.length > 0 ? (
            <Column
              title={tr('Unclassified', '未分类')}
              items={o.unclassified}
              empty=""
              expanded={expanded}
              setExpanded={setExpanded}
              onEvidence={setSelected}
            />
          ) : null}
        </>
      ) : null}

      {selected ? <EvidenceDrawer reference={selected} onClose={() => setSelected(null)} onNavigate={setSelected} /> : null}
    </div>
  )
}
