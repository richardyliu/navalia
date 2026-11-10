// 我的周信: deterministic draft → edit → preview of the exact bytes main will sign → publish
// (native confirm in main). Past letters with counts and a per-letter deliveries table.
import { useCallback, useEffect, useState } from 'react'
import type { LetterDelivery, LetterPreview, PublishedLetter, SubsLetterDraft } from '../../../../main/cloud/subs-api'
import { toggleNote } from '../moments/momentsView'
import { tr } from '../../lib/i18n'
import { countsText, deliveryStatusLabel, draftProblem, formatTime, noTrackingNote, placeholderCount, subsErrorText } from '../../pages/subscriptionsView'

export function LetterSection({ ready }: { ready: boolean }) {
  const [draft, setDraft] = useState<SubsLetterDraft | null>(null)
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [week, setWeek] = useState('')
  const [preview, setPreview] = useState<LetterPreview | null>(null)
  const [letters, setLetters] = useState<PublishedLetter[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<LetterDelivery[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  // C11: moment ids whose own note the user chose to include.
  const [notes, setNotes] = useState<ReadonlySet<string>>(() => new Set())

  const refresh = useCallback(async () => {
    if (!ready) return setLetters([])
    const r = await window.lens.subs.letters()
    if (r.ok) setLetters(r.data)
    else setMsg(subsErrorText(r.error))
  }, [ready])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function makeDraft(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.lens.subs.letterDraft({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })
      if (!r.ok) return setMsg(subsErrorText(r.error))
      setDraft(r.data)
      setTitle(r.data.title)
      setMarkdown(r.data.markdown)
      setWeek(r.data.week)
      setNotes(new Set())
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  async function doPreview(): Promise<void> {
    setMsg(null)
    if (preview) void window.lens.subs.letterDiscard(preview.previewId)
    const r = await window.lens.subs.letterPreview({ title, markdown, week })
    if (r.ok) setPreview(r.data)
    else setMsg(subsErrorText(r.error))
  }

  async function publish(): Promise<void> {
    if (!preview) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.lens.subs.letterPublish(preview.previewId)
      if (!r.ok) return setMsg(subsErrorText(r.error))
      setMsg(tr(`Signed and submitted; ${r.data.recipients} confirmed subscriber(s) will receive it.`, `已签名并提交，${r.data.recipients} 位已确认的订阅者会收到。`))
      setPreview(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function toggle(letterId: string): Promise<void> {
    if (openId === letterId) return setOpenId(null)
    setOpenId(letterId)
    setDeliveries(null)
    const r = await window.lens.subs.deliveries(letterId)
    if (r.ok) setDeliveries(r.data)
    else setMsg(subsErrorText(r.error))
  }

  const problem = draftProblem({ title, markdown, week })
  const holes = placeholderCount(markdown)

  return (
    <section className="card subs-section" data-testid="subs-letter">
      <h2>{tr('My weekly letter', '我的周信')}</h2>
      <p className="tiny muted">
        {tr(
          `The draft is built from recent activity on this Mac with a fixed template (no LLM). After you edit it, preview the exact content to be signed, then confirm to publish. ${noTrackingNote()}.`,
          `按固定模板从本机最近活动生成草稿（不调用 LLM）。你改完后，先预览将要签名的完整内容，再确认发布。${noTrackingNote()}。`
        )}
      </p>
      <div className="subs-row">
        <button className="btn small" disabled={busy} onClick={() => void makeDraft()}>
          {draft ? tr('Regenerate draft', '重新生成草稿') : tr("Generate this week's draft", '生成本周草稿')}
        </button>
        {draft ? (
          <span className="tiny muted">
            {tr(
              `${draft.range.start} to ${draft.range.end} (${draft.timezone}) · ${draft.counts.inWindow} activities in 7 days`,
              `${draft.range.start} 至 ${draft.range.end}（${draft.timezone}）· 7 天内 ${draft.counts.inWindow} 条活动`
            )}
          </span>
        ) : null}
      </div>
      {draft?.warnings.map((w) => (
        <p key={w} className="tiny subs-warn">
          {w}
        </p>
      ))}
      {draft ? (
        <div className="subs-editor">
          <div className="subs-row">
            <input className="input" style={{ flex: 1 }} value={title} onChange={(e) => (setTitle(e.target.value), setPreview(null))} aria-label={tr('Title', '标题')} />
            <input className="input mono" style={{ width: 110 }} value={week} onChange={(e) => (setWeek(e.target.value), setPreview(null))} aria-label={tr('Issue', '期号')} />
          </div>
          {draft.moments?.length ? (
            <div className="subs-moments" data-testid="subs-letter-moments">
              <p className="tiny muted">
                {tr(
                  "This week's shared moments with friends (signed by both, allowed in weekly letters). Your own notes are not attached by default:",
                  '这周和朋友的共同经历（双方签名确认、可写进周信）。你自己写的话默认不附上：'
                )}
              </p>
              {draft.moments.map((m) => (
                <label key={m.momentId} className="tiny" style={{ display: 'block' }}>
                  <input
                    type="checkbox"
                    disabled={!m.noteLine || !m.line}
                    checked={notes.has(m.momentId)}
                    onChange={(e) => {
                      const next = toggleNote(markdown, m.line, m.noteLine, e.target.checked)
                      if (next === null) return setMsg(tr('This shared moment is not in the draft anymore (you may have edited it). Paste it in by hand.', '草稿里找不到这条共同经历（可能已被你改动），请手动粘贴。'))
                      setMarkdown(next)
                      setPreview(null)
                      setNotes((prev) => {
                        const n = new Set(prev)
                        if (e.target.checked) n.add(m.momentId)
                        else n.delete(m.momentId)
                        return n
                      })
                    }}
                  />{' '}
                  {tr(
                    `${m.start} · ${m.title} · with ${m.friend}: ${m.noteLine ? 'attach my note' : '(you have not written a note yet)'}`,
                    `${m.start} · ${m.title} · 和 ${m.friend}：${m.noteLine ? '附上我写的话' : '（你还没写过话）'}`
                  )}
                </label>
              ))}
            </div>
          ) : null}
          <textarea className="input mono subs-textarea" value={markdown} onChange={(e) => (setMarkdown(e.target.value), setPreview(null))} aria-label={tr('Body Markdown', '正文 Markdown')} />
          <div className="subs-row">
            <span className="tiny muted">
              {tr(
                `${markdown.length} chars${holes ? ` · ${holes} <!-- --> placeholder(s) left` : ''}`,
                `${markdown.length} 字${holes ? ` · 还有 ${holes} 处 <!-- --> 占位` : ''}`
              )}
              {problem ? ` · ${problem}` : ''}
            </span>
            <button className="btn small" disabled={busy || problem !== null} onClick={() => void doPreview()}>
              {tr('Preview what will be signed', '预览将要签名的内容')}
            </button>
          </div>
        </div>
      ) : null}
      {preview ? (
        <div className="subs-preview" data-testid="subs-letter-preview">
          <p className="tiny muted">
            {tr(
              `Below are the exact bytes to be signed (${preview.signingText.length} characters; the request body is about ${preview.bodyBytes} bytes). The signature is made with this Mac's key after you confirm, and is attached as the signature field.`,
              `下面是将被签名的完整字节（${preview.signingText.length} 字符；发送体约 ${preview.bodyBytes} 字节）。签名由本机密钥在你确认后生成，作为 signature 字段附在后面。`
            )}
          </p>
          <pre className="subs-pre mono">{preview.signingText}</pre>
          <div className="subs-row">
            <button className="btn small primary" disabled={busy || !ready} onClick={() => void publish()}>
              {tr('Sign and publish…', '签名并发布…')}
            </button>
            {!ready ? <span className="tiny muted">{tr('Turn on Cloud and sign in first', '需要先开启云端并登录')}</span> : null}
          </div>
        </div>
      ) : null}
      {msg ? <p className="tiny">{msg}</p> : null}

      <h3>{tr('Published', '已发布')}</h3>
      {letters.length === 0 ? <p className="tiny muted">{ready ? tr('No weekly letters published yet.', '还没有发布过周信。') : tr('Shown after you sign in to Cloud.', '登录云端后显示。')}</p> : null}
      <ul className="subs-list">
        {letters.map((l) => (
          <li key={l.letterId}>
            <button className="subs-link" onClick={() => void toggle(l.letterId)}>
              {l.week} · {l.title}
            </button>
            <span className="tiny muted"> {formatTime(l.createdAt)} · {countsText(l.counts)}</span>
            {openId === l.letterId ? (
              deliveries === null ? (
                <p className="tiny muted">{tr('Loading…', '加载中…')}</p>
              ) : deliveries.length === 0 ? (
                <p className="tiny muted">{tr('No delivery records.', '没有投递记录。')}</p>
              ) : (
                <table className="subs-table">
                  <thead>
                    <tr>
                      <th>{tr('Email', '邮箱')}</th>
                      <th>{tr('Status', '状态')}</th>
                      <th>{tr('Attempts', '尝试')}</th>
                      <th>{tr('Updated', '更新')}</th>
                      <th>{tr('Error', '错误')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.subscriberId}>
                        <td className="mono">{d.emailMasked}</td>
                        <td>{deliveryStatusLabel(d.status)}</td>
                        <td>{d.attempts}</td>
                        <td>{formatTime(d.updatedAt)}</td>
                        <td className="mono">{d.errorCode ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
