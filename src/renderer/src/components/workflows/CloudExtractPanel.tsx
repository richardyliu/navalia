// S1-FULL C15「云端抽取」: pick a local agent session → preview exactly what will be sent → send by
// ids → review / edit the draft → save as `cloud_extracted`. Nothing is saved until 「保存」.
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { CloudExtractDraftResult, CloudExtractPreview } from '../../../../main/workflows/api'
import type { CloudDraft } from '../../../../main/workflows/cloud-draft'
import { errorMessage } from '../../lib/api'
import { tr } from '../../lib/i18n'
import { workflowsApi } from './client'
import {
  addItem,
  allIds,
  citeLabels,
  cloudGate,
  cloudSaveSummary,
  draftProblem,
  editedLabels,
  moveItem,
  removeItem,
  selectedChars,
  sessionLabel,
  toggleId,
  updateItem,
  type DraftList
} from './cloudExtractView'

function Cites({ cites, sent }: { cites: string[]; sent: CloudExtractDraftResult['sent'] }) {
  if (!cites.length) return <span className="chip subtle tiny">{tr('No citations (added by you)', '无引用（你添加的）')}</span>
  return (
    <>
      {citeLabels(cites, sent).map((c) => (
        <span key={c.id} className="chip subtle tiny" title={c.title}>
          {c.id}
        </span>
      ))}
    </>
  )
}

function RowActions({ list, index, length, onChange, draft }: { list: DraftList; index: number; length: number; draft: CloudDraft; onChange: (d: CloudDraft) => void }) {
  return (
    <span className="wf-cloud-actions">
      <button className="btn ghost small" disabled={index === 0} onClick={() => onChange(moveItem(draft, list, index, -1))} title={tr('Move up', '上移')}>
        ↑
      </button>
      <button className="btn ghost small" disabled={index === length - 1} onClick={() => onChange(moveItem(draft, list, index, 1))} title={tr('Move down', '下移')}>
        ↓
      </button>
      <button className="btn ghost small" onClick={() => onChange(removeItem(draft, list, index))} title={tr('Delete', '删除')}>
        {tr('Delete', '删除')}
      </button>
    </span>
  )
}

export function CloudExtractPanel({ onSaved }: { onSaved: (id: string, message: string) => void }) {
  const status = useQuery({ queryKey: ['workflows-cloud-status'], queryFn: workflowsApi.cloudStatus, staleTime: 10_000 })
  const gate = cloudGate(status.data)
  const sessions = useQuery({ queryKey: ['workflows-cloud-sessions'], queryFn: workflowsApi.cloudSessions, enabled: gate.ready, staleTime: 60_000 })
  const [sessionKey, setSessionKey] = useState('')
  const [hint, setHint] = useState('')
  const [preview, setPreview] = useState<CloudExtractPreview | null>(null)
  const [ids, setIds] = useState<string[]>([])
  const [result, setResult] = useState<CloudExtractDraftResult | null>(null)
  const [draft, setDraft] = useState<CloudDraft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const previewMut = useMutation({
    mutationFn: () => workflowsApi.cloudPreview(sessionKey, hint.trim() || undefined),
    onSuccess: (p) => {
      setPreview(p)
      setIds(allIds(p.items))
      setResult(null)
      setDraft(null)
      setNotice(null)
    },
    onError: (e) => setNotice(errorMessage(e))
  })
  const runMut = useMutation({
    mutationFn: () => workflowsApi.cloudRun(preview!.previewId, ids),
    onSuccess: (r) => {
      setResult(r)
      setDraft(r.draft)
      setPreview(null)
      setNotice(r.droppedItems || r.strippedCites ? tr(`Dropped ${r.droppedItems} items without valid citations and removed ${r.strippedCites} invalid citations`, `已丢弃 ${r.droppedItems} 项没有有效引用的内容，去掉 ${r.strippedCites} 个无效引用`) : null)
    },
    onError: (e) => {
      setPreview(null) // a preview is single use
      setNotice(tr(`No draft generated: ${errorMessage(e)}`, `没有生成草稿：${errorMessage(e)}`))
    }
  })
  const saveMut = useMutation({
    mutationFn: () => workflowsApi.cloudSave(result!.extractionId, draft!),
    onSuccess: (r) => {
      const msg = cloudSaveSummary(r)
      setResult(null)
      setDraft(null)
      onSaved(r.item.outcome === 'imported' ? r.item.id : (r.item.detail ?? r.item.id), msg)
    },
    onError: (e) => setNotice(tr(`Not saved: ${errorMessage(e)}`, `没有保存：${errorMessage(e)}`))
  })

  if (!gate.ready) {
    return (
      <div className="wf-extract">
        <div className="banner warn compact">{status.isError ? errorMessage(status.error) : gate.message}</div>
      </div>
    )
  }

  const problem = draft ? draftProblem(draft) : null
  const edited = result && draft ? editedLabels(result.draft, draft) : []

  return (
    <div className="wf-extract">
      <p className="muted small">
        {tr('Pick a local Claude Code / Codex session. Navalia organizes and redacts it on this machine first, and sends only the items you confirm to your cloud. You can edit the draft the cloud returns; nothing is written until you click Save.', '选一个本机的 Claude Code / Codex 会话。Navalia 先在本机整理并脱敏，你确认要发送的条目后才会发给你的云端；云端返回的草稿可以修改，点「保存」前不会写入。')}
      </p>

      {!draft ? (
        <>
          <label className="wf-field">
            <span>{tr('1. Session', '1. 会话')}</span>
            <select className="input" value={sessionKey} onChange={(e) => setSessionKey(e.target.value)}>
              <option value="">{sessions.isLoading ? tr('Loading…', '读取中…') : tr('Choose a session', '选择会话')}</option>
              {(sessions.data?.sessions ?? []).map((s) => (
                <option key={s.key} value={s.key}>
                  {sessionLabel(s)}
                </option>
              ))}
            </select>
          </label>
          {sessions.data && sessions.data.sessions.length === 0 ? <div className="muted small">{tr('No recent sessions found.', '没有找到最近的会话。')}</div> : null}
          <label className="wf-field">
            <span>{tr('Which work to focus on (optional)', '关注哪项工作（可选）')}</span>
            <input className="input" maxLength={200} value={hint} onChange={(e) => setHint(e.target.value)} placeholder={tr('e.g. the pre-release checklist', '例如：发版前的检查流程')} />
          </label>
          <div className="card-foot">
            <button className="btn ghost small" disabled={!sessionKey || previewMut.isPending} onClick={() => previewMut.mutate()}>
              {tr('2. Preview what will be sent', '2. 预览要发送的内容')}
            </button>
          </div>
        </>
      ) : null}

      {preview ? (
        <div className="wf-cloud-preview">
          <div className="schema-meta">
            <span>
              {tr(
                `Will send ${ids.length}/${preview.items.length} items · ${selectedChars(preview.items, ids)} chars`,
                `将发送 ${ids.length}/${preview.items.length} 条 · ${selectedChars(preview.items, ids)} 字`
              )}
            </span>
            <button className="btn ghost small" onClick={() => setIds(allIds(preview.items))}>
              {tr('Select all', '全选')}
            </button>
            <button className="btn ghost small" onClick={() => setIds([])}>
              {tr('Select none', '全不选')}
            </button>
          </div>
          {preview.warnings.map((w) => (
            <div key={w} className="banner warn compact">
              {w}
            </div>
          ))}
          <ul className="wf-cloud-items">
            {preview.items.map((it) => (
              <li key={it.id}>
                <label>
                  <input type="checkbox" checked={ids.includes(it.id)} onChange={() => setIds(toggleId(ids, it.id))} /> <span className="mono tiny">{it.id}</span> {it.title}
                </label>
                <pre className="playbook-text wf-extract-pre">{it.text}</pre>
              </li>
            ))}
          </ul>
          <div className="card-foot">
            <button className="btn primary small" disabled={!ids.length || runMut.isPending} onClick={() => runMut.mutate()}>
              {runMut.isPending ? tr('Extracting…', '抽取中…') : tr('3. Send selected items and extract', '3. 发送选中的条目并抽取')}
            </button>
            {runMut.isPending ? (
              <button className="btn ghost small" onClick={() => void workflowsApi.cloudCancel(preview.previewId)}>
                {tr('Cancel', '取消')}
              </button>
            ) : (
              <button
                className="btn ghost small"
                onClick={() => {
                  void workflowsApi.cloudDiscard(preview.previewId)
                  setPreview(null)
                }}
              >
                {tr('Discard preview', '放弃预览')}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {draft && result ? (
        <div className="wf-cloud-draft">
          <div className="schema-meta">
            <span className="chip wf-badge wf-badge-cloud">{tr('Cloud extracted · draft (not saved)', '云端抽取 · 草稿（未保存）')}</span>
            {result.model ? <span>{tr(`Model ${result.model}`, `模型 ${result.model}`)}</span> : null}
            <span>{tr(`Sent ${result.sent.length} items`, `发送 ${result.sent.length} 条`)}</span>
            {edited.length ? <span className="chip warn">{tr(`You edited: ${edited.join(', ')}`, `你改过：${edited.join('、')}`)}</span> : null}
          </div>
          <label className="wf-field">
            <span>{tr('Title', '标题')}</span>
            <input className="input" maxLength={500} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>

          <div className="wf-block-title">{tr('Steps', '步骤')}</div>
          <ol className="wf-cloud-list">
            {draft.steps.map((s, i) => (
              <li key={i}>
                <input className="input" maxLength={500} value={s.title} onChange={(e) => setDraft(updateItem(draft, 'steps', i, { title: e.target.value }))} />
                <textarea rows={2} maxLength={3500} value={s.detail} onChange={(e) => setDraft(updateItem(draft, 'steps', i, { detail: e.target.value }))} />
                <div className="schema-meta">
                  <Cites cites={s.cites} sent={result.sent} />
                  <RowActions list="steps" index={i} length={draft.steps.length} draft={draft} onChange={setDraft} />
                </div>
              </li>
            ))}
          </ol>
          <button className="btn ghost small" onClick={() => setDraft(addItem(draft, 'steps'))}>
            {tr('Add step', '添加步骤')}
          </button>

          <div className="wf-block-title">{tr('Artifacts', '产出')}</div>
          <ul className="wf-cloud-list">
            {draft.artifacts.map((a, i) => (
              <li key={i}>
                <input className="input" maxLength={400} value={a.name} onChange={(e) => setDraft(updateItem(draft, 'artifacts', i, { name: e.target.value }))} />
                <input className="input" maxLength={50} placeholder={tr('Type', '类型')} value={a.kind} onChange={(e) => setDraft(updateItem(draft, 'artifacts', i, { kind: e.target.value }))} />
                <div className="schema-meta">
                  <Cites cites={a.cites} sent={result.sent} />
                  <RowActions list="artifacts" index={i} length={draft.artifacts.length} draft={draft} onChange={setDraft} />
                </div>
              </li>
            ))}
          </ul>
          {draft.artifacts.length === 0 ? <div className="muted small">{tr('The cloud gave no cited artifacts (left empty)', '云端没有给出带引用的产出（留空）')}</div> : null}

          <div className="wf-block-title">{tr('Rules', '规则')}</div>
          <ul className="wf-cloud-list">
            {draft.rules.map((r, i) => (
              <li key={i}>
                <textarea rows={2} maxLength={4000} value={r.text} onChange={(e) => setDraft(updateItem(draft, 'rules', i, { text: e.target.value }))} />
                <div className="schema-meta">
                  <Cites cites={r.cites} sent={result.sent} />
                  <RowActions list="rules" index={i} length={draft.rules.length} draft={draft} onChange={setDraft} />
                </div>
              </li>
            ))}
          </ul>
          {draft.rules.length === 0 ? <div className="muted small">{tr('The cloud gave no cited rules (left empty)', '云端没有给出带引用的规则（留空）')}</div> : null}

          <div className="wf-block-title">{tr('Problems → fixes', '问题 → 解决')}</div>
          <ul className="wf-cloud-list">
            {draft.problems.map((p, i) => (
              <li key={i}>
                <textarea rows={2} maxLength={4000} value={p.text} onChange={(e) => setDraft(updateItem(draft, 'problems', i, { text: e.target.value }))} />
                <textarea rows={2} maxLength={4000} placeholder={tr('Fix', '解决办法')} value={p.resolution} onChange={(e) => setDraft(updateItem(draft, 'problems', i, { resolution: e.target.value }))} />
                <div className="schema-meta">
                  <Cites cites={p.cites} sent={result.sent} />
                  <RowActions list="problems" index={i} length={draft.problems.length} draft={draft} onChange={setDraft} />
                </div>
              </li>
            ))}
          </ul>
          {draft.problems.length === 0 ? <div className="muted small">{tr('The cloud gave no cited problems (left empty)', '云端没有给出带引用的问题（留空）')}</div> : null}

          <details>
            <summary className="small">{tr('Sent items (citations point to these)', '已发送的条目（引用指向这些）')}</summary>
            <ul className="wf-cloud-items">
              {result.sent.map((it) => (
                <li key={it.id}>
                  <span className="mono tiny">{it.id}</span> {it.title}
                  <pre className="playbook-text wf-extract-pre">{it.text}</pre>
                </li>
              ))}
            </ul>
          </details>

          <div className="card-foot">
            <button className="btn primary small" disabled={!!problem || saveMut.isPending} onClick={() => saveMut.mutate()}>
              {tr('Save as Workflow (source: cloud extracted)', '保存为 Workflow（来源：云端抽取）')}
            </button>
            <button
              className="btn ghost small"
              onClick={() => {
                setResult(null)
                setDraft(null)
              }}
            >
              {tr('Discard draft', '放弃草稿')}
            </button>
            {problem ? <span className="muted small">{problem}</span> : null}
          </div>
        </div>
      ) : null}

      {notice ? <div className="banner warn compact">{notice}</div> : null}
    </div>
  )
}
