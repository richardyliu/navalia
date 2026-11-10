// S1-FULL C18 共同经历: page-level panel (incoming proposals, my pending ones, all accepted) and the
// per-friend section for the Peers detail. Network only via main (window.lens.moments → client.ts).
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CloudStatus } from '../../../../main/cloud/api'
import type { IncomingMoment, LocalMomentsResult, MomentAcceptPreview, MomentsSyncResult } from '../../../../main/cloud/moments-api'
import { errText, momentsApi, unwrapCloud } from './api'
import { MomentItem } from './MomentItem'
import { ProposeMoment } from './ProposeMoment'
import { dateText, droppedText, friendLabel, noInferenceNote, rejectedBanner, unknownSignerText } from './momentsView'
import { tr } from '../../lib/i18n'
import './moments.css'

export function useCloudReady(): boolean {
  const [st, setSt] = useState<CloudStatus | null>(null)
  useEffect(() => {
    void window.lens.cloud.status().then((r) => r.ok && setSt(r.data))
  }, [])
  return !!st?.enabled && !!st.signedIn
}

export function useLocalMoments() {
  return useQuery<LocalMomentsResult>({ queryKey: ['moments', 'local'], queryFn: () => unwrapCloud(momentsApi().local()), retry: false })
}

function Incoming({ m, onDone }: { m: IncomingMoment; onDone: (t: string) => void }) {
  const [preview, setPreview] = useState<MomentAcceptPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      onDone(await fn())
    } catch (e) {
      onDone(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="moment-item" data-testid="moment-incoming">
      <div>
        <strong>{m.title}</strong> {m.canAccept ? <span className="chip ok">{tr('Proposer signature verified', '发起者签名已验证')}</span> : <span className="chip warn">{unknownSignerText()}</span>}
      </div>
      <div className="tiny muted">
        {dateText(m)}
        {m.place ? ` · ${m.place}` : ''} · {tr(`Proposed by ${friendLabel(m)}`, `${friendLabel(m)} 发起`)} · {m.visibility === 'letters' ? tr('Can go in weekly letters', '可写进周信') : tr('Just the two of us', '仅我们两人')}
      </div>
      {m.note ? <div className="tiny">{tr('Note: ', '附言：')}{m.note}</div> : null}
      {!m.canAccept ? <div className="tiny muted">{tr(`Import their card first (fingerprint ${m.proposerFingerprint.slice(0, 16)}…) to confirm.`, `先导入 TA 的卡片（指纹 ${m.proposerFingerprint.slice(0, 16)}…），才能确认。`)}</div> : null}
      <div className="page-actions">
        <button className="btn small" disabled={!m.canAccept || busy} onClick={() => void act(async () => (setPreview(await unwrapCloud(momentsApi().acceptPreview(m.momentId))), tr('Check the confirmation you are about to sign', '请检查将要签名的确认内容')))}>
          {tr('Confirm…', '确认…')}
        </button>
        <button className="btn ghost small" disabled={busy} onClick={() => void act(async () => (await unwrapCloud(momentsApi().decline(m.momentId)), tr('Declined', '已拒绝')))}>
          {tr('Decline…', '拒绝…')}
        </button>
      </div>
      {preview ? (
        <div className="moment-preview">
          <p className="tiny muted">{tr('Your confirmation signs the content below (moment_sha256 is the digest of the shared moment you see):', '你的确认会签名下面的内容（moment_sha256 是你看到的这条共同经历的摘要）：')}</p>
          <pre className="mono tiny moment-pre">{preview.signingText}</pre>
          <button className="btn small primary" disabled={busy} onClick={() => void act(async () => (await unwrapCloud(momentsApi().accept(preview.previewId)), setPreview(null), tr('Confirmed; both sides have saved it locally', '已确认，双方都已在本机保存')))}>
            {tr('Sign and confirm…', '签名确认…')}
          </button>
        </div>
      ) : null}
    </li>
  )
}

export function MomentsPanel() {
  const qc = useQueryClient()
  const ready = useCloudReady()
  const local = useLocalMoments()
  const [sync, setSync] = useState<MomentsSyncResult | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function refresh(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      setSync(await unwrapCloud(momentsApi().sync()))
      void qc.invalidateQueries({ queryKey: ['moments'] })
    } catch (e) {
      setMsg(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const banner = local.data ? rejectedBanner(local.data.rejected) : null
  const dropped = sync ? droppedText(sync.dropped.length) : null
  return (
    <section className="card moments-panel" data-testid="moments-panel">
      <div className="section-head">
        <h3>{tr('Shared moments', '共同经历')}</h3>
        <button className="btn small" disabled={!ready || busy} onClick={() => void refresh()}>
          {busy ? tr('Syncing…', '同步中…') : tr('Sync from Cloud', '从云端同步')}
        </button>
      </div>
      <p className="muted tiny">{noInferenceNote()}</p>
      {!ready ? <p className="tiny muted">{tr('Cloud is off or not signed in: showing only shared moments saved on this Mac.', '云端未开启或未登录：只显示本机已保存的共同经历。')}</p> : null}
      {msg ? <div className="tiny">{msg}</div> : null}
      {banner ? <div className="banner warn compact">{banner}</div> : null}
      {dropped ? <div className="banner warn compact">{dropped}</div> : null}
      {sync?.incoming.length ? (
        <>
          <h4>{tr('Waiting for you', '等你确认')}</h4>
          <ul className="moment-list">
            {sync.incoming.map((m) => (
              <Incoming key={m.momentId} m={m} onDone={(t) => (setMsg(t), void refresh())} />
            ))}
          </ul>
        </>
      ) : null}
      {sync?.outgoing.length ? (
        <>
          <h4>{tr('Proposed by me', '我发起的')}</h4>
          <ul className="moment-list">
            {sync.outgoing.map((m) => (
              <li key={m.momentId} className="tiny">
                {m.title} · {dateText(m)} · {tr(`To ${friendLabel(m)}`, `发给 ${friendLabel(m)}`)} · {m.status === 'pending' ? tr('Waiting for them', '等对方确认') : tr('They declined', '对方已拒绝')}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {sync?.remoteMissing.length ? <div className="tiny muted">{tr(`${sync.remoteMissing.length} shared moment(s) on this Mac are gone from the Cloud (the other person may have deleted them). You can use “Delete local copy only” in the list.`, `本机有 ${sync.remoteMissing.length} 条共同经历云端已经没有了（可能被对方删除），可以在列表里「只删本机副本」。`)}</div> : null}
      <h4>{tr('Confirmed (saved on this Mac; both signatures re-verified every time)', '已确认（本机保存，双方签名每次重新验证）')}</h4>
      {local.isError ? <div className="banner bad compact">{errText(local.error)}</div> : null}
      {local.data && local.data.moments.length === 0 ? <div className="tiny muted">{tr('No shared moments yet. Propose one from a peer’s details below.', '还没有共同经历。在下面某位朋友的详情里发起一条。')}</div> : null}
      <ul className="moment-list">
        {local.data?.moments.map((m) => (
          <MomentItem key={m.momentId} m={m} showFriend cloudReady={ready} />
        ))}
      </ul>
    </section>
  )
}

/** Peers detail: accepted moments with this friend + propose form. */
export function FriendMoments({ fingerprint, name }: { fingerprint: string; name: string }) {
  const ready = useCloudReady()
  const local = useLocalMoments()
  const mine = (local.data?.moments ?? []).filter((m) => m.friendFingerprint === fingerprint)
  return (
    <section className="card" data-testid="friend-moments">
      <h3>{tr(`Shared moments with ${name}`, `和 ${name} 的共同经历`)}</h3>
      {mine.length === 0 ? <p className="tiny muted">{tr('No shared moments confirmed by both of you yet.', '还没有双方确认的共同经历。')}</p> : null}
      <ul className="moment-list">
        {mine.map((m) => (
          <MomentItem key={m.momentId} m={m} showFriend={false} cloudReady={ready} />
        ))}
      </ul>
      <ProposeMoment friendFingerprint={fingerprint} friendName={name} cloudReady={ready} />
    </section>
  )
}
