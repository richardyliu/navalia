// One accepted (doubly-signed) shared moment: facts, the user's own note with fixed prompts, delete.
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { LocalMoment } from '../../../../main/cloud/moments-api'
import { MOMENT_LIMITS } from '../../../../main/cloud/moments-api'
import { errText, momentsApi, unwrapCloud } from './api'
import { deleteNote, MOMENT_PROMPTS, VISIBILITY_LABEL, dateText, friendLabel, helpExpressNote, insertPrompt } from './momentsView'
import { tr } from '../../lib/i18n'

export function MomentFacts({ m, showFriend }: { m: LocalMoment; showFriend: boolean }) {
  return (
    <div>
      <div>
        <strong>{m.title}</strong> <span className="chip ok">{tr('Both signatures verified', '双方签名已验证')}</span>{' '}
        <span className="chip subtle">{m.visibility === 'letters' ? tr('Can go in weekly letters', '可写进周信') : tr('Just the two of us', '仅我们两人')}</span>
      </div>
      <div className="tiny muted">
        {dateText(m)}
        {m.place ? ` · ${m.place}` : ''}
        {showFriend ? tr(` · with ${friendLabel(m)}`, ` · 和 ${friendLabel(m)}`) : ''} · {m.iAmProposer ? tr('Proposed by me', '我发起') : tr('Proposed by them', 'TA 发起')} · {tr(`Confirmed ${m.acceptedAt.slice(0, 10)}`, `确认于 ${m.acceptedAt.slice(0, 10)}`)}
      </div>
      {m.note ? <div className="tiny">{tr('Note (visible to both): ', '附言（双方可见）：')}{m.note}</div> : null}
      <div className="tiny muted">{VISIBILITY_LABEL[m.visibility]}</div>
    </div>
  )
}

export function MomentItem({ m, showFriend, cloudReady }: { m: LocalMoment; showFriend: boolean; cloudReady: boolean }) {
  const qc = useQueryClient()
  const [text, setText] = useState(m.myNote ?? '')
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => setText(m.myNote ?? ''), [m.momentId, m.myNote])
  const done = (t: string | null) => {
    setMsg(t)
    void qc.invalidateQueries({ queryKey: ['moments'] })
  }
  const save = useMutation({ mutationFn: () => unwrapCloud(momentsApi().setNote(m.momentId, text)), onSuccess: () => done(tr('Saved on this Mac', '已保存在本机')), onError: (e) => setMsg(errText(e)) })
  const del = useMutation({
    mutationFn: () => unwrapCloud(momentsApi().remove(m.momentId)),
    onSuccess: (r) => done(r.remote ? tr('Deleted (neither of you can see it now)', '已删除（双方都看不到了）') : tr('Already gone from the Cloud; deleted the local copy', '云端已经没有这条，已删除本机副本')),
    onError: (e) => setMsg(errText(e))
  })
  const forget = useMutation({ mutationFn: () => unwrapCloud(momentsApi().forgetLocal(m.momentId)), onSuccess: () => done(tr('Deleted from this Mac', '已从本机删除')), onError: (e) => setMsg(errText(e)) })
  return (
    <li className="moment-item" data-testid="moment-item">
      <MomentFacts m={m} showFriend={showFriend} />
      {m.myNote && !open ? <div className="tiny">{tr('What I wrote (this Mac only): ', '我写的（仅本机）：')}{m.myNote}</div> : null}
      <div className="page-actions">
        <button className="btn ghost small" onClick={() => setOpen(!open)}>
          {open ? tr('Collapse', '收起') : m.myNote ? tr('Edit what I wrote', '改我写的话') : tr('Write a few lines', '写几句')}
        </button>
        <button className="btn ghost small" disabled={!cloudReady || del.isPending} title={deleteNote()} onClick={() => del.mutate()}>
          {tr('Delete (both sides)…', '删除（双方）…')}
        </button>
        <button className="btn ghost small" disabled={forget.isPending} onClick={() => forget.mutate()}>
          {tr('Delete local copy only…', '只删本机副本…')}
        </button>
      </div>
      {open ? (
        <div className="moment-note">
          <p className="tiny muted">{helpExpressNote()}</p>
          <div className="moment-prompts">
            {MOMENT_PROMPTS.map((p) => (
              <button key={p} className="chip subtle" data-testid="moment-prompt" onClick={() => setText((t) => insertPrompt(t, p))}>
                {p}
              </button>
            ))}
          </div>
          <textarea className="textarea" maxLength={MOMENT_LIMITS.maxMyNoteChars} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('In your own words', '你自己的话')} />
          <button className="btn small" disabled={save.isPending} onClick={() => save.mutate()}>
            {tr('Save on this Mac', '保存在本机')}
          </button>
        </div>
      ) : null}
      {msg ? <div className="tiny muted">{msg}</div> : null}
    </li>
  )
}
