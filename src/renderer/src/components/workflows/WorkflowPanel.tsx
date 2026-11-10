import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Workflow } from '../../../../main/workflows/schema'
import { errorMessage } from '../../lib/api'
import { EvidenceDrawer } from '../EvidenceDrawer'
import { EvidenceLinks } from './EvidenceLinks'
import { formatDateTime } from '../../lib/format'
import { tr } from '../../lib/i18n'
import { workflowsApi } from './client'
import { ExtractPanel } from './ExtractPanel'
import { CloudExtractPanel } from './CloudExtractPanel'
import { skillsHeadline } from './headline'
import {
  SOURCE_LABEL,
  draftDirty,
  draftFromWorkflow,
  editFromDraft,
  formatFingerprint,
  provenanceBadge,
  provenanceBadgeKey,
  cloudExtractionLine,
  fieldEdited,
  skillExportSummary,
  skillImportSummary,
  habitChipClass,
  habitOfWorkflow,
  importSummary,
  provenanceLine,
  sourceWarnings,
  stepEvidenceLinks,
  workflowListItems,
  type WorkflowDraft
} from './viewModel'
import './workflows.css'

const DRAFT_FIELDS: Array<{ key: keyof WorkflowDraft; readonly label: string; rows: number; readonly hint?: string }> = [
  {
    key: 'title',
    get label() {
      return tr('Title', '标题')
    },
    rows: 1
  },
  {
    key: 'goal',
    get label() {
      return tr('Goal', '目标')
    },
    rows: 2
  },
  {
    key: 'context',
    get label() {
      return tr('Context / trigger', '情境 / 触发')
    },
    rows: 2
  },
  {
    key: 'inputs',
    get label() {
      return tr('Inputs (one per line)', '输入（每行一项）')
    },
    rows: 3
  },
  {
    key: 'tools',
    get label() {
      return tr('Tools (one per line)', '工具（每行一项）')
    },
    rows: 3
  },
  {
    key: 'steps',
    get label() {
      return tr('Steps (one per line, in order)', '步骤（每行一步，按顺序）')
    },
    rows: 5
  },
  {
    key: 'artifacts',
    get label() {
      return tr('Artifacts (one per line)', '产出（每行一项）')
    },
    rows: 3
  },
  {
    key: 'rules',
    get label() {
      return tr('Rules / boundaries (one per line)', '规则 / 边界（每行一条）')
    },
    rows: 3
  },
  {
    key: 'problems',
    get label() {
      return tr('Problems → fixes (one per line)', '问题 → 解决（每行一条）')
    },
    rows: 3,
    get hint() {
      return tr('Format: problem → fix', '格式：问题 → 解决办法')
    }
  },
  {
    key: 'tags',
    get label() {
      return tr('Tags (one per line)', '标签（每行一个）')
    },
    rows: 2
  }
]

/** C15: 「用户已编辑」 marker on a field of a cloud-extracted Workflow. */
function editedMark(w: Workflow, key: Parameters<typeof fieldEdited>[1]) {
  return fieldEdited(w, key) ? <span className="chip warn tiny wf-edited-mark">{tr('Edited by user', '用户已编辑')}</span> : null
}

function ListBlock({ title, items, mark = null }: { title: string; items: string[]; mark?: ReactNode }) {
  return (
    <div className="wf-block">
      <div className="wf-block-title">
        {title}
        {mark}
      </div>
      {items.length ? (
        <ul>
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        <div className="muted small">{tr('Not observed', '未观察到')}</div>
      )}
    </div>
  )
}

function WorkflowView({ w }: { w: Workflow }) {
  const habit = habitOfWorkflow(w)
  // S1-R3-03: a step's evidence pointer opens the drawer (resolve_evidence) in place.
  const [evidenceRef, setEvidenceRef] = useState<string | null>(null)
  return (
    <div className="wf-view">
      {evidenceRef ? <EvidenceDrawer reference={evidenceRef} onClose={() => setEvidenceRef(null)} onNavigate={setEvidenceRef} /> : null}
      <div className="wf-block">
        <div className="wf-block-title">{tr('Goal', '目标')}</div>
        <div>{w.goal || <span className="muted small">{tr('Not observed', '未观察到')}</span>}</div>
      </div>
      {w.context ? (
        <div className="wf-block">
          <div className="wf-block-title">{tr('Context / trigger', '情境 / 触发')}</div>
          <div>{w.context}</div>
        </div>
      ) : null}
      <div className="wf-block">
        <div className="wf-block-title">{tr('Steps', '步骤')}{editedMark(w, 'steps')}</div>
        {w.steps.length ? (
          <ol>
            {w.steps.map((s) => (
              <li key={s.order}>
                {s.text} <EvidenceLinks links={stepEvidenceLinks(s)} onOpen={setEvidenceRef} />
              </li>
            ))}
          </ol>
        ) : (
          <div className="muted small">{tr('Not observed', '未观察到')}</div>
        )}
      </div>
      <div className="wf-grid">
        <ListBlock title={tr('Inputs', '输入')} items={w.inputs} />
        <ListBlock title={tr('Tools', '工具')} items={w.tools} />
        <ListBlock title={tr('Artifacts', '产出')} items={w.artifacts} mark={editedMark(w, 'artifacts')} />
        <ListBlock title={tr('Rules / boundaries', '规则 / 边界')} items={w.rules} mark={editedMark(w, 'rules')} />
      </div>
      <ListBlock title={tr('Problems → fixes', '问题 → 解决')} mark={editedMark(w, 'problems')} items={w.problems.map((p) => (p.solution ? `${p.problem} → ${p.solution}` : tr(`${p.problem} → (no fix recorded)`, `${p.problem} → （未记录解决办法）`)))} />
      <div className="wf-block">
        <div className="wf-block-title">{tr(`Evidence (${w.evidence.length})`, `证据（${w.evidence.length}）`)}</div>
        <div className="schema-meta">
          <span className={habitChipClass(habit)} title={habit.detail}>
            {habit.label}
          </span>
          {w.evidence_note ? <span>{w.evidence_note}</span> : null}
          {w.source.confidence ? <span>{tr(`Confidence ${w.source.confidence}`, `置信度 ${w.source.confidence}`)}</span> : null}
        </div>
        {w.evidence.length ? (
          <ul className="wf-evidence">
            {w.evidence.slice(0, 50).map((e) => (
              <li key={`${e.kind}:${e.ref}`} className="mono tiny">
                {e.ref}
                {e.timestamp ? ` · ${e.timestamp}` : ''}
                {e.origin === 'imported' ? tr(' · imported (may not resolve on this machine)', ' · 导入（本机可能无法解析）') : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

/** `initialId`: Playbook deep link (`go('playbook', { workflowId })`) — select and scroll to it. */
export function WorkflowPanel({ initialId = null }: { initialId?: string | null } = {}) {
  const queryClient = useQueryClient()
  const sectionRef = useRef<HTMLElement | null>(null)
  const [extractOpen, setExtractOpen] = useState(false)
  const [cloudOpen, setCloudOpen] = useState(false)
  const catalog = useQuery({ queryKey: ['workflows'], queryFn: workflowsApi.list, staleTime: 30_000 })
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<WorkflowDraft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const items = useMemo(() => workflowListItems(catalog.data, filter), [catalog.data, filter])
  const currentId = selected ?? items[0]?.id ?? null
  const detail = useQuery({ queryKey: ['workflow', currentId], queryFn: () => workflowsApi.get(currentId as string), enabled: !!currentId })
  const w = detail.data?.workflow ?? null

  useEffect(() => setDraft(null), [currentId])
  useEffect(() => {
    if (!initialId) return
    setSelected(initialId)
    sectionRef.current?.scrollIntoView({ block: 'start' })
  }, [initialId])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['workflows'] })
    void queryClient.invalidateQueries({ queryKey: ['workflow'] })
  }
  const save = useMutation({
    mutationFn: () => workflowsApi.save(w!.id, w!.version, editFromDraft(draft!)),
    onSuccess: (r) => {
      setNotice(r.unchanged ? tr('No changes', '没有改动') : tr(`Saved as v${r.workflow.version} (the original observed version is kept)`, `已保存为 v${r.workflow.version}（原观察版本保留）`))
      setDraft(null)
      refresh()
    },
    onError: (e) => setNotice(errorMessage(e))
  })
  const exportMut = useMutation({
    mutationFn: (ids: string[]) => workflowsApi.export(ids),
    onSuccess: (r) => setNotice(r.path ? tr(`Exported ${r.count} to ${r.path}`, `已导出 ${r.count} 个到 ${r.path}`) : tr('Export cancelled', '已取消导出')),
    onError: (e) => setNotice(errorMessage(e))
  })
  const importMut = useMutation({
    mutationFn: workflowsApi.import,
    onSuccess: (r) => {
      setNotice(importSummary(r))
      refresh()
    },
    onError: (e) => setNotice(tr(`Import rejected: ${errorMessage(e)}`, `导入被拒绝：${errorMessage(e)}`))
  })

  const exportSkill = useMutation({
    mutationFn: (id: string) => workflowsApi.exportSkill(id),
    onSuccess: (r) => setNotice(skillExportSummary(r)),
    onError: (e) => setNotice(tr(`Export failed: ${errorMessage(e)}`, `导出失败：${errorMessage(e)}`))
  })
  const importSkill = useMutation({
    mutationFn: workflowsApi.importSkill,
    onSuccess: (r) => {
      setNotice(skillImportSummary(r))
      refresh()
    },
    onError: (e) => setNotice(errorMessage(e))
  })

  const warnings = sourceWarnings(catalog.data?.sources)
  const headline = catalog.data ? skillsHeadline(catalog.data.workflows) : null

  return (
    <section className="card" ref={sectionRef}>
      <div className="card-head">
        <div>
          {headline ? (
            <div className="wf-headline" title={tr('M = distinct calendar weeks (ISO weeks) covered by evidence dates; shows — when there are no real dates', 'M = 证据日期覆盖的不同自然周（ISO 周）；没有真实日期时显示 —')}>
              {headline.text}
            </div>
          ) : null}
          <h3>{tr('Workflows (reusable)', 'Workflows（可复用的工作流）')}</h3>
        </div>
        <div className="page-actions">
          <input className="input" placeholder={tr('Filter', '筛选')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className={`btn small ${cloudOpen ? 'primary' : 'ghost'}`} onClick={() => setCloudOpen(!cloudOpen)} title={tr('Send selected session excerpts to your Navalia cloud (when on) and get back an editable draft', '把选中的会话片段发给你开启的 Navalia 云端，返回可编辑的草稿')}>
            {tr('Cloud extract', '云端抽取')}
          </button>
          <button className={`btn small ${extractOpen ? 'primary' : 'ghost'}`} onClick={() => setExtractOpen(!extractOpen)}>
            {tr('Extract from session / text', '从会话 / 文本抽取')}
          </button>
          <button className="btn ghost small" onClick={() => importMut.mutate()} disabled={importMut.isPending}>
            {tr('Import JSON', '导入 JSON')}
          </button>
          <button className="btn ghost small" onClick={() => importSkill.mutate()} disabled={importSkill.isPending}>
            {tr('Import .navaliaskill', '导入 .navaliaskill')}
          </button>
          <button className="btn ghost small" onClick={() => exportMut.mutate(items.map((i) => i.id))} disabled={!items.length || exportMut.isPending}>
            {tr('Export all', '导出全部')}
          </button>
        </div>
      </div>
      <p className="muted small">
        {tr('Skills observed by Runtime (skills/skill-*.md, behavior_patterns), structured as goal / steps / artifacts / rules / problems → fixes. Fields that were not observed stay empty; nothing is guessed. Editing creates a new version and keeps the original observed one.', '从 Runtime 观察到的技能（skills/skill-*.md、behavior_patterns）结构化为目标 / 步骤 / 产出 / 规则 / 问题→解决。未观察到的字段留空，不推测。编辑会生成新版本，原观察版本保留。')}
      </p>
      {catalog.isError ? <div className="banner bad compact">{errorMessage(catalog.error)}</div> : null}
      {warnings.map((m) => (
        <div key={m} className="banner warn compact">
          {m}
        </div>
      ))}
      {notice ? <div className="banner ok compact">{notice}</div> : null}
      {cloudOpen ? (
        <CloudExtractPanel
          onSaved={(id, message) => {
            setNotice(message)
            setSelected(id)
            refresh()
          }}
        />
      ) : null}
      {extractOpen ? (
        <ExtractPanel
          onSaved={(id, message) => {
            setNotice(message)
            setSelected(id)
            refresh()
          }}
        />
      ) : null}

      {catalog.data && items.length === 0 ? (
        <div className="muted small">{tr('No Workflows yet: Runtime has not written skills/skill-*.md and nothing has been imported.', '还没有 Workflow：Runtime 还没写出 skills/skill-*.md，也没有导入过。')}</div>
      ) : null}

      {items.length ? (
        <div className="wf-layout">
          <ul className="wf-list">
            {items.map((it) => (
              <li key={it.id}>
                <button className={`wf-item${it.id === currentId ? ' active' : ''}`} onClick={() => setSelected(it.id)}>
                  <div className="schema-title">{it.title}</div>
                  <div className="schema-meta">
                    <span className={`chip wf-badge wf-badge-${provenanceBadgeKey(it.badge) ?? 'observed'}`}>
                      {it.badge}
                      {it.badgeEdited ? tr(' (edited)', '（已编辑）') : ''}
                    </span>
                    <span>v{it.version}</span>
                    <span>{tr(`${it.steps} steps`, `${it.steps} 步`)}</span>
                    <span>{tr(`${it.filled}/7 fields`, `${it.filled}/7 字段`)}</span>
                    {it.habit ? (
                      <span className={habitChipClass(it.habit)} title={it.habit.detail}>
                        {it.habit.label}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="wf-detail">
            {detail.isError ? <div className="banner bad compact">{errorMessage(detail.error)}</div> : null}
            {w ? (
              <>
                <div className="playbook-head">
                  <div>
                    <div className="schema-title">{w.title || w.id}</div>
                    <div className="schema-meta">
                      <span>{provenanceLine(w)}</span>
                      <span>{SOURCE_LABEL[w.source.type]}</span>
                      {w.source.path ? <span className="mono">{w.source.path}</span> : null}
                      {w.updated_at ? <span>{tr(`Updated ${formatDateTime(w.updated_at)}`, `更新于 ${formatDateTime(w.updated_at)}`)}</span> : null}
                    </div>
                  </div>
                  <div className="page-actions">
                    {draft ? null : (
                      <button className="btn ghost small" onClick={() => setDraft(draftFromWorkflow(w))}>
                        {tr('Edit', '编辑')}
                      </button>
                    )}
                    <button className="btn ghost small" onClick={() => exportMut.mutate([w.id])} disabled={exportMut.isPending}>
                      {tr('Export', '导出')}
                    </button>
                    <button className="btn ghost small" onClick={() => exportSkill.mutate(w.id)} disabled={exportSkill.isPending} title={tr('Signed with your identity key; redacted by the Broker rules before export', '用你的身份密钥签名；导出前按 Broker 规则脱敏')}>
                      {tr('Export .navaliaskill', '导出 .navaliaskill')}
                    </button>
                  </div>
                </div>
                {w.provenance.signer_fingerprint ? (
                  <div className="banner warn compact wf-signer">
                    <div>
                      {provenanceBadge(w).label} · {tr('Signer fingerprint', '签名指纹')} <span className="mono tiny">{formatFingerprint(w.provenance.signer_fingerprint)}</span>
                    </div>
                    <div className="small">
                      {tr(
                        'Self-signed: proves integrity and key consistency only, not identity. Verify the fingerprint with the sender through another channel.',
                        '自签名：只证明完整性与密钥一致，不证明身份。请通过其他渠道向对方核对指纹。'
                      )}
                    </div>
                  </div>
                ) : null}
                {w.provenance.extraction?.source === 'cloud_extracted' ? (
                  <div className="banner warn compact">
                    <div>{cloudExtractionLine(w.provenance.extraction)}</div>
                    <div className="small">
                      {tr(
                        'Drafted by the cloud model from the session excerpts you picked, not observed by Runtime. Citations point to the excerpt snapshots taken at save time.',
                        '由云端模型根据你选中的会话片段起草，不是 Runtime 的观察；引用指向保存时的片段快照。'
                      )}
                    </div>
                  </div>
                ) : null}
                {detail.data?.runtimeChanged ? (
                  <div className="banner warn compact">
                    {tr('The observed version in Runtime changed after your edit; this shows your edited version.', 'Runtime 里的观察版本在你编辑之后有更新；这里显示的是你的编辑版本。')}
                  </div>
                ) : null}
                {detail.data && detail.data.versions.length > 1 ? (
                  <div className="schema-meta">
                    {tr('Versions:', '版本：')}
                    {detail.data.versions.map((v) => (
                      <span key={v.version} className="chip subtle">
                        v{v.version} {v.provenance}
                      </span>
                    ))}
                  </div>
                ) : null}
                {draft ? (
                  <div className="wf-edit">
                    {DRAFT_FIELDS.map((f) => (
                      <label key={f.key} className="wf-field">
                        <span>{f.label}</span>
                        <textarea rows={f.rows} value={draft[f.key]} placeholder={f.hint} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                      </label>
                    ))}
                    <div className="card-foot">
                      <button className="btn primary small" onClick={() => save.mutate()} disabled={save.isPending || !draftDirty(draft, w)}>
                        {tr('Save as new version', '保存为新版本')}
                      </button>
                      <button className="btn ghost small" onClick={() => setDraft(null)}>
                        {tr('Cancel', '取消')}
                      </button>
                      <span className="muted small">{tr('Evidence and source cannot be edited.', '证据与来源不可编辑。')}</span>
                    </div>
                  </div>
                ) : (
                  <WorkflowView w={w} />
                )}
              </>
            ) : detail.isLoading ? (
              <div className="muted small">{tr('Loading…', '加载中…')}</div>
            ) : detail.data === null && currentId ? (
              <div className="banner warn compact">{tr(`Workflow ${currentId} not found (Runtime may have removed it).`, `找不到 Workflow ${currentId}（可能已被 Runtime 移除）。`)}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
