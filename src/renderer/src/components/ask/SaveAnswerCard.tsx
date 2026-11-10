// S1-R3-09 「把回答保存到记忆」. Paste → preview (redacted in main) → 保存到记忆… (native confirm in main).
// No LLM; the text is saved as pasted, minus redactions, with a provenance header.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ASK_SAVE_AGENTS, ASK_SAVE_MAX_CHARS, type AskSaveAgent, type AskSaveApi, type AskSavePreview } from '../../../../main/mcp/save-answer-api'
import { tr } from '../../lib/i18n'
import { unwrap } from '../../lib/api'

const askSave = (): AskSaveApi['askSave'] => (window.lens as unknown as AskSaveApi).askSave

const AGENT_LABEL: Record<AskSaveAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  get other() {
    return tr('Other', '其他')
  }
}

type Notice = { tone: 'ok' | 'bad' | 'muted'; text: string }

export function SaveAnswerCard() {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [agent, setAgent] = useState<AskSaveAgent | ''>('')
  const [preview, setPreview] = useState<AskSavePreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  function dropPreview(): void {
    if (preview) void askSave().discard(preview.token)
    setPreview(null)
  }

  async function doPreview(): Promise<void> {
    setNotice(null)
    dropPreview()
    setBusy('preview')
    try {
      setPreview(await unwrap(askSave().preview(text, agent || undefined)))
    } catch (error) {
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  async function doSave(): Promise<void> {
    if (!preview) return
    setNotice(null)
    setBusy('save')
    try {
      const r = await unwrap(askSave().save(preview.token))
      if (!r.saved) {
        setNotice({ tone: 'muted', text: tr('Cancelled; nothing was written.', '已取消，没有写入。') })
        return
      }
      setNotice({ tone: 'ok', text: tr(`Saved to ${r.file}, entry id ${r.entryId}`, `已写入 ${r.file}，entry id ${r.entryId}`) })
      setPreview(null)
      setText('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['search-memory'] }),
        qc.invalidateQueries({ queryKey: ['recent'] })
      ])
    } catch (error) {
      setNotice({ tone: 'bad', text: tr(
          `Save failed: ${error instanceof Error ? error.message : String(error)}`,
          `保存失败：${error instanceof Error ? error.message : String(error)}`
        )
      })
    } finally {
      setBusy(null)
    }
  }

  const tooLong = text.trim().length > ASK_SAVE_MAX_CHARS

  return (
    <section className="card ask-save" data-testid="ask-save">
      <div className="card-head">
        <h3>{tr('Save an answer to memory', '把回答保存到记忆')}</h3>
        <span className="muted small">
          {tr(
            "Paste an external Agent's answer → preview → confirm to write it to Persome memory",
            '粘贴外部 Agent 的回答 → 预览 → 确认后写入 Persome 记忆'
          )}
        </span>
      </div>
      <p className="tiny muted">
        {tr(
          'Navalia does not call an LLM or rewrite anything: it saves the text you pasted, minus likely keys / tokens / emails / home paths, plus a provenance line. It is written through the Runtime MCP tool ',
          'Navalia 不调用 LLM，不改写内容：保存的就是你粘贴的文字，去掉疑似密钥 / token / 邮箱 / 用户目录后，加一行来源说明。写入走 Runtime 的 MCP 工具'
        )}
        <code>remember</code>
        {tr(' (Runtime adds the ', '（Runtime 会自动加 ')}
        <code>source:agent-run</code>
        {tr(
          ' tag automatically). After clicking "Save to memory…" you still confirm in a system dialog.',
          ' 标签）。点「保存到记忆…」后还要在系统对话框里确认。'
        )}
      </p>
      <textarea
        className="textarea"
        rows={6}
        data-testid="ask-save-input"
        placeholder={tr('Paste the Claude Code / Codex / Cursor answer here', '把 Claude Code / Codex / Cursor 的回答粘贴到这里')}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (preview) dropPreview()
        }}
      />
      <div className="ask-actions">
        <select className="input" style={{ width: 'auto' }} value={agent} onChange={(e) => setAgent(e.target.value as AskSaveAgent | '')}>
          <option value="">{tr('Source Agent (optional)', '来源 Agent（可选）')}</option>
          {ASK_SAVE_AGENTS.map((a) => (
            <option key={a} value={a}>
              {AGENT_LABEL[a]}
            </option>
          ))}
        </select>
        <button className="btn small" data-testid="ask-save-preview" disabled={!text.trim() || tooLong || busy !== null} onClick={() => void doPreview()}>
          {busy === 'preview' ? tr('Previewing…', '预览中…') : tr('Preview', '预览')}
        </button>
        {tooLong ? <span className="tiny tone-bad">
            {tr(`Over ${ASK_SAVE_MAX_CHARS} characters`, `超过 ${ASK_SAVE_MAX_CHARS} 字`)}
          </span> : null}
      </div>
      {preview ? (
        <div className="ask-save-preview" data-testid="ask-save-preview-box">
          <div className="tiny muted">
            {tr(
              `Content to be written (${preview.chars} characters; ${preview.redactions} likely sensitive items hidden; tags ${preview.tags.join(', ')}):`,
              `将写入的内容（${preview.chars} 字；隐藏了 ${preview.redactions} 处疑似敏感信息；标签 ${preview.tags.join(', ')}）：`
            )}
          </div>
          <pre className="ask-prompt">{preview.content}</pre>
          {preview.dropped ? (
            <div className="banner bad compact">
              {tr(
                'This looks like environment variable / credential output, so it was omitted entirely and cannot be saved.',
                '内容看起来是环境变量 / 凭据输出，已整体省略，不能保存。'
              )}
            </div>
          ) : null}
          <div className="ask-actions">
            <button
              className="btn small primary"
              data-testid="ask-save-confirm"
              disabled={preview.dropped || busy !== null}
              onClick={() => void doSave()}
            >
              {busy === 'save' ? tr('Waiting for confirmation…', '等待确认…') : tr('Save to memory…', '保存到记忆…')}
            </button>
            <button className="btn small ghost" disabled={busy !== null} onClick={dropPreview}>
              {tr('Discard preview', '放弃预览')}
            </button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <div className={`tiny ${notice.tone === 'muted' ? 'muted' : `tone-${notice.tone}`}`} data-testid="ask-save-notice">
          {notice.text}
        </div>
      ) : null}
    </section>
  )
}
