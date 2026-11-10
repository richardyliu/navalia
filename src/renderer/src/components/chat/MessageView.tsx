// One chat message: answer text with clickable [ctx-N] chips (parsed from the accumulated text),
// the context chips sent with that reply, copy, and 「记住这条」 (C6: preview → native confirm in main).
import { useState } from 'react'
import type { ChatContextItem, ChatMessage, ChatRememberPreview } from '../../../../main/cloud/chat-api'
import { tr } from '../../lib/i18n'
import { errorText, kindLabel, parseCitations, replyUsageText, statusLabel } from '../../pages/chatView'

export function AnswerText({ text, context, onCite }: { text: string; context: readonly ChatContextItem[]; onCite: (item: ChatContextItem) => void }) {
  const byId = new Map(context.map((i) => [i.id, i]))
  return (
    <div className="chat-msg-text">
      {parseCitations(text, new Set(byId.keys())).map((s, i) =>
        s.type === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : s.known ? (
          <button key={i} className="chat-cite" onClick={() => onCite(byId.get(s.id)!)}>
            {s.id}
          </button>
        ) : (
          <span key={i} className="chat-cite unknown" title={tr('This citation is not in the context that was sent', '这条引用不在发送的上下文里')}>
            {s.id}?
          </span>
        )
      )}
    </div>
  )
}

export function ItemDetail({ item, onClose }: { item: ChatContextItem; onClose: () => void }) {
  return (
    <div className="card" data-testid="chat-item-detail">
      <div className="chat-row">
        <span className="chip mono">{item.id}</span>
        <span className="chip">{kindLabel(item.kind)}</span>
        <strong className="small">{item.title}</strong>
        <span className="tiny muted">{item.ref ? `ref: ${item.ref}` : tr('no ref', '无 ref')}</span>
        <button className="btn small ghost" onClick={onClose}>
          {tr('Close', '关闭')}
        </button>
      </div>
      <p className="tiny muted">{tr('Original text sent to the cloud:', '发送到云端的原文：')}</p>
      <pre className="chat-item-text">{item.text}</pre>
    </div>
  )
}

export function MessageView({ conversationId, index, message }: { conversationId: string; index: number; message: ChatMessage }) {
  const [detail, setDetail] = useState<ChatContextItem | null>(null)
  const [showContext, setShowContext] = useState(false)
  const [remember, setRemember] = useState<ChatRememberPreview | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [entryId, setEntryId] = useState<string | null>(message.role === 'assistant' ? message.rememberedEntryId : null)

  if (message.role === 'user') {
    return (
      <div className="chat-msg user">
        <div className="chat-msg-text">{message.content}</div>
      </div>
    )
  }

  async function copy(): Promise<void> {
    const r = await window.lens.app.copy(message.content)
    setNote(r.ok ? tr('Copied', '已复制') : tr('Copy failed', '复制失败'))
  }

  async function previewRemember(): Promise<void> {
    setNote(null)
    const r = await window.lens.chat.rememberPreview({ conversationId, messageIndex: index })
    if (r.ok) setRemember(r.data)
    else setNote(errorText(r.error))
  }

  async function confirmRemember(): Promise<void> {
    if (!remember) return
    const r = await window.lens.chat.remember(remember.rememberId)
    if (r.ok) {
      setEntryId(r.data.entryId)
      setRemember(null)
      setNote(tr('Written to memory', '已写入记忆'))
    } else setNote(errorText(r.error))
  }

  const status = statusLabel(message.status)
  return (
    <div className="chat-msg">
      {status ? <div className="banner warn compact">{status}{message.errorCode ? tr(` (${message.errorCode})`, `（${message.errorCode}）`) : ''}</div> : null}
      <AnswerText text={message.content || tr('(no content)', '（没有内容）')} context={message.context} onCite={setDetail} />
      <div className="chat-row" style={{ marginTop: 8 }}>
        <button className="btn small ghost" onClick={() => setShowContext(!showContext)}>
          {tr(
            `Context: ${message.context.length}${message.citations.length ? ` · citations: ${message.citations.length}` : ''}`,
            `上下文 ${message.context.length} 条${message.citations.length ? ` · 引用 ${message.citations.length}` : ''}`
          )}
        </button>
        <button className="btn small ghost" onClick={() => void copy()}>
          {tr('Copy', '复制')}
        </button>
        {message.content.trim() ? (
          entryId ? (
            <span className="tiny tone-ok">{tr(`Remembered (${entryId})`, `已记住（${entryId}）`)}</span>
          ) : (
            <button className="btn small ghost" onClick={() => void previewRemember()}>
              {tr('Remember this', '记住这条')}
            </button>
          )
        ) : null}
        <span className="tiny muted">{replyUsageText(message.usage)}</span>
        {note ? <span className="tiny">{note}</span> : null}
      </div>
      {showContext ? (
        <div className="chat-row" style={{ marginTop: 6 }}>
          {message.context.map((c) => (
            <button key={c.id} className="chip" onClick={() => setDetail(c)} title={c.title}>
              {c.id} · {kindLabel(c.kind)}
            </button>
          ))}
          {message.context.length === 0 ? <span className="tiny muted">{tr('No context was sent this time', '这次没有发送上下文')}</span> : null}
        </div>
      ) : null}
      {detail ? <ItemDetail item={detail} onClose={() => setDetail(null)} /> : null}
      {remember ? (
        <div className="card" style={{ marginTop: 8 }} data-testid="chat-remember-preview">
          <p className="small">
            {tr(
              `Will write to Persome memory (tags: ${remember.tags.join(', ')}; ${remember.redactions} likely sensitive item(s) hidden):`,
              `将写入 Persome 记忆（标签：${remember.tags.join(', ')}；已隐藏 ${remember.redactions} 处疑似敏感信息）：`
            )}
          </p>
          <pre className="chat-item-text">{remember.content}</pre>
          <div className="chat-row">
            <button className="btn small primary" onClick={() => void confirmRemember()}>
              {tr('Write to memory (needs confirmation)', '写入记忆（需确认）')}
            </button>
            <button className="btn small ghost" onClick={() => setRemember(null)}>
              {tr('Cancel', '取消')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
