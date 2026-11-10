// Propose a shared moment to ONE friend: form → preview of the exact object main will sign →
// 签名并发出 (native confirm in main). The renderer never builds or signs the object.
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MomentProposePreview } from '../../../../main/cloud/moments-api'
import { errText, momentsApi, unwrapCloud } from './api'
import { VISIBILITY_LABEL, emptyForm, formProblem, localToday, proposeArgs, type ProposeForm } from './momentsView'
import { tr } from '../../lib/i18n'

export function ProposeMoment({ friendFingerprint, friendName, cloudReady }: { friendFingerprint: string; friendName: string; cloudReady: boolean }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<ProposeForm>(() => emptyForm(localToday()))
  const [preview, setPreview] = useState<MomentProposePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    setForm(emptyForm(localToday()))
    setPreview(null)
    setMsg(null)
  }, [friendFingerprint])
  const set = (patch: Partial<ProposeForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    if (preview) void momentsApi().discardPreview(preview.previewId)
    setPreview(null)
  }
  const problem = formProblem(form)

  async function doPreview(): Promise<void> {
    setMsg(null)
    try {
      setPreview(await unwrapCloud(momentsApi().proposePreview(proposeArgs(friendFingerprint, form))))
    } catch (e) {
      setMsg(errText(e))
    }
  }
  async function send(): Promise<void> {
    if (!preview) return
    setBusy(true)
    try {
      await unwrapCloud(momentsApi().propose(preview.previewId))
      setMsg(tr(`Sent to ${friendName}. It becomes a shared moment once they confirm.`, `已发给 ${friendName}，等 TA 确认后才会成为共同经历。`))
      setPreview(null)
      setForm(emptyForm(localToday()))
      void qc.invalidateQueries({ queryKey: ['moments'] })
    } catch (e) {
      setMsg(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="moment-propose" data-testid="moment-propose">
      <h4>{tr(`Record a shared moment with ${friendName}`, `和 ${friendName} 记一条共同经历`)}</h4>
      <div className="moment-form">
        <input className="input" placeholder={tr('Title (one line, required)', '标题（单行，必填）')} value={form.title} onChange={(e) => set({ title: e.target.value })} />
        <label className="tiny">
          {tr('From', '从')} <input className="input" type="date" value={form.start} onChange={(e) => set({ start: e.target.value, end: form.end < e.target.value ? e.target.value : form.end })} />
        </label>
        <label className="tiny">
          {tr('To', '到')} <input className="input" type="date" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </label>
        <input className="input" placeholder={tr('Place (optional)', '地点（可选）')} value={form.place} onChange={(e) => set({ place: e.target.value })} />
        <textarea className="textarea" placeholder={tr('Note (optional; visible to them and the server)', '附言（可选；对方和服务器都能看到）')} value={form.note} onChange={(e) => set({ note: e.target.value })} />
        <label className="tiny">
          <input type="radio" checked={form.visibility === 'private'} onChange={() => set({ visibility: 'private' })} /> {VISIBILITY_LABEL.private}
        </label>
        <label className="tiny">
          <input type="radio" checked={form.visibility === 'letters'} onChange={() => set({ visibility: 'letters' })} /> {VISIBILITY_LABEL.letters}
        </label>
      </div>
      <div className="page-actions">
        <span className="tiny muted">{problem ?? ''}</span>
        <button className="btn small" disabled={problem !== null} onClick={() => void doPreview()}>
          {tr('Preview what will be signed', '预览将要签名的内容')}
        </button>
      </div>
      {preview ? (
        <div className="moment-preview">
          <p className="tiny muted">{tr('Below is the full content your key will sign (the signature is appended as the signature field). Once you confirm, it is sent to them through your Cloud:', '下面是将被你的密钥签名的完整内容（签名会作为 signature 字段附在后面），确认后经你的云端发给对方：')}</p>
          <pre className="mono tiny moment-pre">{preview.signingText}</pre>
          <button className="btn small primary" disabled={busy || !cloudReady} onClick={() => void send()}>
            {tr('Sign and send…', '签名并发出…')}
          </button>
          {!cloudReady ? <span className="tiny muted"> {tr('Turn on Cloud and sign in on the Subscriptions or Cloud chat page first', '需要先在「订阅」或「云端对话」页开启云端并登录')}</span> : null}
        </div>
      ) : null}
      {msg ? <div className="tiny">{msg}</div> : null}
    </div>
  )
}
