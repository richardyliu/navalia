// S1-FULL C5 / C7 「云端对话」page. Logic lives in chatView.ts (pure, tested); this file is thin.
// The renderer never sends context text: it previews what main assembled and sends ids back.
import { useCallback, useEffect, useState } from 'react'
import './Chat.css'
import type { CloudStatus } from '../../../main/cloud/api'
import type { ChatContextItem, ChatConversation, ChatConversationSummary, ChatPreview, ChatServerUsage } from '../../../main/cloud/chat-api'
import { CloudSetup } from '../components/chat/CloudSetup'
import { AnswerText, ItemDetail, MessageView } from '../components/chat/MessageView'
import { PreviewPanel } from '../components/chat/PreviewPanel'
import { tr } from '../lib/i18n'
import { conversationTitle, errorText, formatTime, gateOf, notStoredNote, reduceStream, replyUsageText, startStream, usageText, wechatCoverageNote, type StreamState } from './chatView'

export function Chat() {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [list, setList] = useState<ChatConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [conv, setConv] = useState<ChatConversation | null>(null)
  const [question, setQuestion] = useState('')
  const [keyword, setKeyword] = useState('')
  const [preview, setPreview] = useState<ChatPreview | null>(null)
  const [stream, setStream] = useState<StreamState | null>(null)
  const [sentItems, setSentItems] = useState<ChatContextItem[]>([])
  const [usage, setUsage] = useState<ChatServerUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [detail, setDetail] = useState<ChatContextItem | null>(null)
  const gate = gateOf(status)

  const refreshList = useCallback(async () => {
    const r = await window.lens.chat.list()
    if (r.ok) setList(r.data)
  }, [])
  const refreshUsage = useCallback(async () => {
    const r = await window.lens.chat.usage()
    setUsage(r.ok ? r.data : null)
  }, [])
  const loadConv = useCallback(async (id: string | null) => {
    if (!id) return setConv(null)
    const r = await window.lens.chat.get(id)
    setConv(r.ok ? r.data : null)
  }, [])

  useEffect(() => {
    void window.lens.cloud.status().then((r) => r.ok && setStatus(r.data))
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    if (gate.state === 'ready') void refreshUsage()
  }, [gate.state, refreshUsage])

  useEffect(() => {
    void loadConv(activeId)
    setConfirmDelete(false)
  }, [activeId, loadConv])

  useEffect(
    () =>
      window.lens.chat.onEvent((e) => {
        setStream((s) => reduceStream(s, e))
        if (e.type === 'end') {
          setStream(null)
          void loadConv(e.conversationId)
          void refreshList()
          void refreshUsage()
        }
      }),
    [loadConv, refreshList, refreshUsage]
  )

  async function doPreview(kind: 'chat' | 'wechat'): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const conversationId = activeId ?? undefined
      const r = kind === 'chat' ? await window.lens.chat.preview({ question, conversationId }) : await window.lens.chat.wechatPreview({ keyword: keyword.trim() || undefined, conversationId })
      if (r.ok) setPreview(r.data)
      else setError(errorText(r.error))
    } finally {
      setBusy(false)
    }
  }

  async function send(includeIds: string[]): Promise<void> {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.lens.chat.send({ previewId: preview.previewId, includeIds })
      if (!r.ok) return setError(errorText(r.error))
      setSentItems(preview.items.filter((i) => includeIds.includes(i.id)))
      setStream(startStream(r.data.streamId, r.data.conversationId))
      setPreview(null)
      setQuestion('')
      setActiveId(r.data.conversationId)
      await loadConv(r.data.conversationId)
      await refreshList()
    } finally {
      setBusy(false)
    }
  }

  async function discardPreview(): Promise<void> {
    if (preview) await window.lens.chat.discardPreview(preview.previewId)
    setPreview(null)
  }

  async function remove(): Promise<void> {
    if (!activeId) return
    const r = await window.lens.chat.delete(activeId)
    if (!r.ok) return setError(errorText(r.error))
    setActiveId(null)
    await refreshList()
  }

  const streaming = stream && stream.conversationId === activeId ? stream : null
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">{tr('Chat · optional cloud', 'Chat · 可选云端')}</div>
          <h2>{tr('Cloud chat', '云端对话')}</h2>
          <p className="muted">
            {tr(
              'Ask a cloud model questions with your personal database as context. Before sending, every piece of text that will be sent is listed, and you can remove any of them.',
              '用你的个人数据库作上下文向云端模型提问。发送前会列出每一条将要发送的文字，你可以逐条去掉。'
            )}
          </p>
          <p className="tiny muted">{notStoredNote()}</p>
        </div>
        {gate.state === 'ready' && usage ? <span className="tiny muted">{usageText(usage)}</span> : null}
      </header>

      <CloudSetup status={status} onChange={setStatus} offText={gate.state === 'off' ? gate.text : undefined} />

      <div className="chat-layout" style={{ marginTop: 12 }}>
        <aside className="chat-list" aria-label={tr('Conversations', '对话列表')}>
          <button className={`chat-list-item ${activeId === null ? 'active' : ''}`} onClick={() => setActiveId(null)}>
            {tr('+ New conversation', '+ 新对话')}
          </button>
          {list.map((c) => (
            <button key={c.id} className={`chat-list-item ${activeId === c.id ? 'active' : ''}`} onClick={() => setActiveId(c.id)}>
              <div className="small ellipsis">{conversationTitle(c.title) || tr('Untitled', '未命名')}</div>
              <div className="tiny muted">
                {formatTime(c.updatedAt)} · {tr(`${c.messages} messages`, `${c.messages} 条`)}
              </div>
            </button>
          ))}
          {list.length === 0 ? <p className="tiny muted">{tr('No conversations yet', '还没有对话')}</p> : null}
        </aside>

        <section className="chat-main">
          {conv ? (
            <div className="chat-row">
              <strong>{conversationTitle(conv.title)}</strong>
              <span className="tiny muted">{tr(`Created ${formatTime(conv.createdAt)}`, `创建于 ${formatTime(conv.createdAt)}`)}</span>
              {confirmDelete ? (
                <>
                  <span className="tiny">{tr('Delete the local file? (Nothing is saved in the cloud)', '删除本机文件？（云端没有保存）')}</span>
                  <button className="btn small ghost danger" onClick={() => void remove()}>
                    {tr('Confirm delete', '确认删除')}
                  </button>
                  <button className="btn small ghost" onClick={() => setConfirmDelete(false)}>
                    {tr('Cancel', '取消')}
                  </button>
                </>
              ) : (
                <button className="btn small ghost" onClick={() => setConfirmDelete(true)}>
                  {tr('Delete conversation', '删除对话')}
                </button>
              )}
            </div>
          ) : null}

          <div className="chat-messages">
            {conv?.messages.map((m, i) => <MessageView key={`${conv.id}-${i}-${m.at}`} conversationId={conv.id} index={i} message={m} />)}
            {streaming ? (
              <div className="chat-msg" data-testid="chat-streaming">
                <AnswerText text={streaming.text || '…'} context={sentItems} onCite={setDetail} />
                <div className="chat-row" style={{ marginTop: 8 }}>
                  <button className="btn small ghost" onClick={() => void window.lens.chat.cancel(streaming.streamId)}>
                    {tr('Stop', '停止')}
                  </button>
                  <span className="tiny muted">{replyUsageText(streaming.usage)}</span>
                  {streaming.error ? <span className="tiny tone-bad">{streaming.error.message}</span> : null}
                </div>
              </div>
            ) : null}
            {detail ? <ItemDetail item={detail} onClose={() => setDetail(null)} /> : null}
          </div>

          {error ? <div className="banner warn compact">{error}</div> : null}

          {preview ? (
            <PreviewPanel key={preview.previewId} preview={preview} canSend={gate.state === 'ready'} sending={busy} onSend={(ids) => void send(ids)} onCancel={() => void discardPreview()} />
          ) : (
            <>
              <div className="card chat-compose">
                <textarea
                  className="textarea"
                  placeholder={tr('Ask something, e.g. What have I mostly been busy with this week?', '问点什么，例如：我这周主要在忙什么？')}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={16000}
                />
                <div className="chat-row" style={{ marginTop: 8 }}>
                  <button className="btn small primary" disabled={busy || !question.trim() || Boolean(streaming)} onClick={() => void doPreview('chat')}>
                    {tr('Preview what will be sent', '预览将要发送的内容')}
                  </button>
                  <span className="tiny muted">{tr('The preview is assembled on this Mac and does not go online.', '预览只在本机整理，不联网。')}</span>
                </div>
              </div>
              <div className="card">
                <div className="chat-row">
                  <strong>{tr('WeChat group digest', '微信群整理')}</strong>
                  <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder={tr('Keyword (optional)', '关键词（可选）')} value={keyword} onChange={(e) => setKeyword(e.target.value)} maxLength={100} />
                  <button className="btn small" disabled={busy || Boolean(streaming)} onClick={() => void doPreview('wechat')}>
                    {tr('Preview this week’s WeChat content', '预览本周微信内容')}
                  </button>
                </div>
                <p className="tiny muted" style={{ marginBottom: 0 }}>
                  {tr(
                    `${wechatCoverageNote()}. Only OCR / read text is used; screenshots are never sent.`,
                    `${wechatCoverageNote()}。只用 OCR / 读取到的文字，不发送截图。`
                  )}
                </p>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
