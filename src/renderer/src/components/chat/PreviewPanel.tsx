// Context preview before sending (C3 / C7): every item exactly as it will be sent, one checkbox
// each, totals, and an explicit 「发送到云端」 button. The renderer only sends ids back to main.
import { useState } from 'react'
import type { ChatPreview } from '../../../../main/cloud/chat-api'
import { tr } from '../../lib/i18n'
import { kindLabel, neverSentNote, totalsText, wechatCoverageNote } from '../../pages/chatView'

export function PreviewPanel({
  preview,
  canSend,
  sending,
  onSend,
  onCancel
}: {
  preview: ChatPreview
  canSend: boolean
  sending: boolean
  onSend: (includeIds: string[]) => void
  onCancel: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preview.items.map((i) => i.id)))
  const [open, setOpen] = useState<string | null>(null)
  const toggle = (id: string): void =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const digest = preview.task === 'group_digest'
  return (
    <section className="card" data-testid="chat-preview">
      <div className="chat-row">
        <strong>{digest ? tr('WeChat group digest · preview before sending', '微信群整理 · 发送前预览') : tr('Preview before sending', '发送前预览')}</strong>
        <span className="muted small">{totalsText(preview.items, selected)}</span>
      </div>
      <p className="small" style={{ margin: '6px 0' }}>
        {tr('Question: ', '问题：')}
        {preview.question}
      </p>
      {digest ? <div className="banner warn compact">{wechatCoverageNote()}</div> : null}
      <p className="tiny muted">{neverSentNote()}</p>
      {preview.warnings.map((w) => (
        <div key={w} className="banner compact">
          {w}
        </div>
      ))}
      {preview.items.length === 0 ? <p className="muted small">
          {tr('No context to attach.', '没有可附带的上下文。')}
          {digest ? '' : tr(' You can still send just the question.', '仍可以只发送问题。')}
        </p> : null}
      {preview.items.map((item) => (
        <div key={item.id} className="chat-preview-item">
          <label>
            <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
            <span className="chip mono">{item.id}</span>
            <span className="chip">{kindLabel(item.kind)}</span>
            <span className="small" style={{ flex: 1 }}>
              {item.title}
            </span>
            <span className="tiny muted">{tr(`${item.chars} chars`, `${item.chars} 字符`)}</span>
          </label>
          <button className="btn small ghost" onClick={() => setOpen(open === item.id ? null : item.id)}>
            {open === item.id ? tr('Hide', '收起') : tr('View original', '查看原文')}
          </button>
          {open === item.id ? <pre className="chat-item-text">{item.text}</pre> : null}
        </div>
      ))}
      <div className="chat-row" style={{ marginTop: 10 }}>
        <button
          className="btn small primary"
          disabled={!canSend || sending || (digest && selected.size === 0)}
          onClick={() => onSend(preview.items.filter((i) => selected.has(i.id)).map((i) => i.id))}
          data-testid="chat-send"
        >
          {tr('Send to cloud', '发送到云端')}
        </button>
        <button className="btn small ghost" onClick={onCancel}>
          {tr('Discard', '放弃')}
        </button>
        {!canSend ? <span className="tiny muted">{tr('Cloud is off or you are not signed in, so you can only preview.', '云端未开启或未登录，只能预览。')}</span> : null}
      </div>
    </section>
  )
}
