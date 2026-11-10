// S2-07「从会话 / 文本抽取」: Lens gives a prompt + JSON Schema, the user runs it in an external
// agent, pastes JSON back; Lens only validates and saves (no LLM, no network — X7).
import { useMutation } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { buildExtractionPrompt, extractionJsonSchema, type ExtractSaveAs } from '../../../../main/workflows/extract'
import { api, errorMessage } from '../../lib/api'
import { tr } from '../../lib/i18n'
import { workflowsApi } from './client'
import { AGENT_OPTIONS, SAVE_AS_LABEL, agentOptionLabel, extractPreview, extractSaveSummary, resolveAgent, type AgentOption } from './extractView'

export function ExtractPanel({ onSaved }: { onSaved: (id: string, message: string) => void }) {
  const [task, setTask] = useState('')
  const [text, setText] = useState('')
  const [agent, setAgent] = useState<AgentOption>('Claude Code')
  const [customAgent, setCustomAgent] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const prompt = useMemo(() => buildExtractionPrompt(task), [task])
  const schema = useMemo(() => extractionJsonSchema(), [])
  const preview = useMemo(() => extractPreview(text), [text])
  const agentLabel = resolveAgent(agent, customAgent)

  const save = useMutation({
    mutationFn: (as: ExtractSaveAs) => workflowsApi.extract(text, as, agentLabel),
    onSuccess: (r) => {
      const msg = extractSaveSummary(r)
      setNotice(msg)
      if (r.item.outcome === 'imported') setText('')
      onSaved(r.item.outcome === 'imported' ? r.item.id : (r.item.detail ?? r.item.id), msg)
    },
    onError: (e) => setNotice(tr(`Not saved: ${errorMessage(e)}`, `没有保存：${errorMessage(e)}`))
  })
  const copy = (value: string, done: string) =>
    void api.copy(value).then(
      () => setNotice(done),
      (e) => setNotice(errorMessage(e))
    )

  return (
    <div className="wf-extract">
      <p className="muted small">
        {tr(
          'Navalia calls no model. Copy the prompt below into Claude Code / Codex (it can use the Persome MCP tools search, read_memory and read_receipt, or you can attach a transcript), then paste the JSON it outputs back here. Navalia only validates it; missing fields stay empty.',
          'Navalia 不调用任何模型。复制下面的提示词到 Claude Code / Codex（可让它用 Persome MCP 的 search、read_memory、read_receipt，或附上会话记录），把它输出的 JSON 粘贴回来。Navalia 只做校验；缺的字段保持为空。'
        )}
      </p>
      <label className="wf-field">
        <span>{tr('1. Which work to extract (optional; goes into the prompt)', '1. 要抽取哪项工作（可选，会写进提示词）')}</span>
        <input className="input" value={task} onChange={(e) => setTask(e.target.value)} placeholder={tr('e.g. write the weekly report every Friday', '例如：每周五写周报')} />
      </label>
      <div className="card-foot">
        <button className="btn ghost small" onClick={() => copy(prompt, tr('Copied the prompt (with JSON Schema)', '已复制提示词（含 JSON Schema）'))}>
          {tr('Copy prompt', '复制提示词')}
        </button>
        <button className="btn ghost small" onClick={() => copy(schema, tr('Copied the JSON Schema', '已复制 JSON Schema'))}>
          {tr('Copy JSON Schema only', '只复制 JSON Schema')}
        </button>
      </div>
      <details>
        <summary className="small">{tr('View prompt', '查看提示词')}</summary>
        <pre className="playbook-text wf-extract-pre">{prompt}</pre>
      </details>

      <label className="wf-field">
        <span>{tr("2. Paste the agent's JSON output", '2. 粘贴 agent 输出的 JSON')}</span>
        <textarea rows={8} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"goal": "…", "steps": ["…"], "evidence": [{"kind": "receipt", "ref": "⟨…⟩"}]}' />
      </label>
      {preview.status === 'invalid' ? (
        <div className="banner bad compact">
          <ul className="wf-extract-errors">
            {preview.errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.status === 'valid' ? (
        <div className="schema-meta">
          <span className="chip ok">{tr('Valid', '校验通过')} · {preview.formLabel}</span>
          {preview.title ? <span>{tr(`"${preview.title}"`, `「${preview.title}」`)}</span> : null}
          {preview.fields
            .filter((f) => f.count > 0)
            .map((f) => (
              <span key={f.key}>
                {f.label} {f.count}
              </span>
            ))}
          {preview.empty.length ? <span className="muted">{tr(`Left empty: ${preview.empty.join(', ')}`, `留空：${preview.empty.join('、')}`)}</span> : null}
        </div>
      ) : null}

      <div className="card-foot">
        <span className="small">{tr('3. Agent used for extraction', '3. 抽取用的 agent')}</span>
        <select className="input" value={agent} onChange={(e) => setAgent(e.target.value as AgentOption)}>
          {AGENT_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {agentOptionLabel(a)}
            </option>
          ))}
        </select>
        {agent === '其他' ? <input className="input" value={customAgent} maxLength={100} onChange={(e) => setCustomAgent(e.target.value)} placeholder={tr('Agent name', 'agent 名称')} /> : null}
      </div>
      <div className="card-foot">
        {(['user_edited', 'imported'] as const).map((as) => (
          <button key={as} className={`btn small ${as === 'user_edited' ? 'primary' : 'ghost'}`} disabled={preview.status !== 'valid' || !agentLabel || save.isPending} onClick={() => save.mutate(as)}>
            {SAVE_AS_LABEL[as]}
          </button>
        ))}
      </div>
      {notice ? <div className="banner ok compact">{notice}</div> : null}
    </div>
  )
}
