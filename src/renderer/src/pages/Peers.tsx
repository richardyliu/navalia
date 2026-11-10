import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LetterDraft, PeerDetail, PeerImportResult, PeerList, PeersApi } from '../../../main/peers/api'
import {
  activityRows,
  formatLocal,
  importNotice,
  peerTitle,
  shortFingerprint,
  TOPIC_SOURCE_LABEL,
  VERIFICATION_LABEL
} from '../components/peers/peersView'
import { SubscriptionSection } from '../components/peers/SubscriptionSection'
import { SharedMomentsSection } from '../components/peers/SharedMoments'
import { FriendMoments, MomentsPanel } from '../components/moments/MomentsPanel'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import '../components/peers/peers.css'
import { tr } from '../lib/i18n'
import { unwrap, errorMessage } from '../lib/api'

const peers = (): PeersApi['peers'] => (window.lens as unknown as PeersApi).peers

const timezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function Letter({ peer }: { peer: PeerDetail }) {
  const [draft, setDraft] = useState<LetterDraft | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    setDraft(null)
    setText('')
    setNote(null)
  }, [peer.fingerprint])
  const gen = useMutation({
    // S1-FULL C11: the letter lists only shared moments both of you signed (visibility 可写进周信).
    mutationFn: () => unwrap(peers().letterDraft(peer.fingerprint, timezone())),
    onSuccess: (d) => {
      setDraft(d)
      setText(d.markdown)
      setNote(null)
    },
    onError: (e) => setNote(errorMessage(e))
  })
  const exp = useMutation({
    mutationFn: () => unwrap(peers().exportLetter(peer.fingerprint, text)),
    onSuccess: (r) => setNote(r.path ? tr(`Exported to ${r.path}`, `已导出到 ${r.path}`) : null),
    onError: (e) => setNote(errorMessage(e))
  })
  const copy = async () => {
    try {
      // Main-process clipboard (lens:app:copy): the renderer gets no clipboard permission (OG1).
      await unwrap(window.lens.app.copy(text))
      setNote(tr('Copied to clipboard', '已复制到剪贴板'))
    } catch (e) {
      setNote(errorMessage(e))
    }
  }
  return (
    <section className="card peers-letter">
      <div className="section-head">
        <h3>{tr('Weekly letter draft', '每周信草稿')}</h3>
        <button className="btn" disabled={gen.isPending} onClick={() => gen.mutate()}>
          {gen.isPending ? tr('Generating…', '生成中…') : draft ? tr('Regenerate', '重新生成') : tr('Generate draft', '生成草稿')}
        </button>
      </div>
      <p className="muted tiny">
        {tr(
          'Built from your last 7 days of local records with a fixed template; no LLM is called. It is only a draft: copy it or export the .md and decide yourself how to send it. Navalia never sends it anywhere. The shared moments section lists only moments you both signed and marked as allowed in weekly letters; keyword overlap never goes into the letter.',
          '按固定模板从你最近 7 天的本地记录生成，未调用 LLM。只生成草稿：复制或导出 .md 后由你自己决定怎么寄，Navalia 不会发送到任何地方。 「这周和你的共同经历」只列出你们双方都签名确认、并且选了「可以写进周信」的共同经历；关键词重合不会写进信里。'
        )}
      </p>
      {draft ? (
        <>
          <div className="muted tiny">
            {tr(
              `${draft.range.start} to ${draft.range.end} (${draft.timezone}) · ${draft.counts.inWindow} in 7 days · ${draft.counts.experiences} shared moments`,
              `${draft.range.start} 至 ${draft.range.end}（${draft.timezone}）· 7 天内 ${draft.counts.inWindow} 条 · 共同经历 ${draft.counts.experiences} 条`
            )}
          </div>
          <textarea className="textarea peers-letter-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <div className="page-actions">
            <button className="btn" disabled={!text} onClick={() => void copy()}>
              {tr('Copy', '复制')}
            </button>
            <button className="btn" disabled={!text || exp.isPending} onClick={() => exp.mutate()}>
              {tr('Export .md', '导出 .md')}
            </button>
          </div>
        </>
      ) : null}
      {note ? <div className="muted tiny">{note}</div> : null}
    </section>
  )
}

function Detail({ fingerprint, onRemoved }: { fingerprint: string; onRemoved: () => void }) {
  const qc = useQueryClient()
  const detail = useQuery<PeerDetail | null>({ queryKey: ['peers', 'get', fingerprint], queryFn: () => unwrap(peers().get(fingerprint)) })
  const [confirm, setConfirm] = useState(false)
  const [evidence, setEvidence] = useState<string | null>(null)
  const remove = useMutation({
    mutationFn: () => unwrap(peers().remove(fingerprint)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['peers'] })
      onRemoved()
    }
  })
  useEffect(() => {
    setConfirm(false)
    setEvidence(null)
  }, [fingerprint])

  if (detail.isError) return <div className="banner bad compact">{errorMessage(detail.error)}</div>
  const p = detail.data
  if (!p) return <div className="muted">{detail.isLoading ? tr('Loading…', '读取中…') : tr('Peer not found', '找不到这位朋友')}</div>
  const v = VERIFICATION_LABEL[p.verification]
  return (
    <div className="peers-detail">
      <section className="card">
        <div className="section-head">
          <div>
            <h3>{peerTitle(p)}</h3>
            <div className="mono tiny muted">{p.fingerprint}</div>
          </div>
          <span className={`chip ${v.tone}`}>{v.text}</span>
        </div>
        <p className="muted tiny">{v.note}</p>
        {p.headline ? <blockquote className="peers-headline">“{p.headline}”</blockquote> : <p className="muted">{tr('The card has no summary.', '卡片上没有概述。')}</p>}
        <h4>{tr('What their card says they work on', '卡片上写着 TA 在做的事')}</h4>
        {p.topics.length ? (
          <ul className="peers-topics">
            {p.topics.map((t) => (
              <li key={`${t.source}:${t.text}`}>
                <span className="chip subtle">{TOPIC_SOURCE_LABEL[t.source]}</span> {t.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{tr('The card lists no topics.', '卡片没有列出话题。')}</p>
        )}
        <div className="muted tiny">
          {tr(
            `Card ${p.cardId} · issued ${formatLocal(p.cardIssuedAt)} · model as of ${formatLocal(p.cardAsOf)}`,
            `卡片 ${p.cardId} · 签发于 ${formatLocal(p.cardIssuedAt)} · 模型截至 ${formatLocal(p.cardAsOf)}`
          )}
          {p.cardDegraded ? tr(" · their model build is incomplete", ' · 对方的模型构建不完整') : ''} · {tr(`${p.versions} versions`, `共 ${p.versions} 个版本`)}
        </div>
        <div className="page-actions">
          {confirm ? (
            <>
              <span className="tiny">{tr('Remove this peer and all past versions from this Mac?', '从本机移除这位朋友和所有历史版本？')}</span>
              <button className="btn danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {tr('Confirm removal', '确认移除')}
              </button>
              <button className="btn" onClick={() => setConfirm(false)}>
                {tr('Cancel', '取消')}
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirm(true)}>
              {tr('Remove', '移除')}
            </button>
          )}
        </div>
      </section>

      <FriendMoments fingerprint={p.fingerprint} name={peerTitle(p)} />

      <section className="card">
        <h3>{tr('Keyword overlap / Activity', '关键词重合 / 动态')}</h3>
        <SharedMomentsSection fingerprint={p.fingerprint} timezone={timezone()} onEvidence={setEvidence} />
        <h4>{tr('Activity (local events only)', '动态（仅本机事件）')}</h4>
        <ul className="peers-activity">
          {activityRows(p.events).map((r) => (
            <li key={`${r.at}:${r.text}`}>
              <span className="mono tiny muted">{formatLocal(r.at)}</span> {r.text}
            </li>
          ))}
        </ul>
      </section>

      <Letter peer={p} />
      {evidence ? <EvidenceDrawer reference={evidence} onClose={() => setEvidence(null)} onNavigate={setEvidence} /> : null}
    </div>
  )
}

export function Peers() {
  const qc = useQueryClient()
  const list = useQuery<PeerList>({ queryKey: ['peers', 'list'], queryFn: () => unwrap(peers().list()) })
  const [selected, setSelected] = useState<string | null>(null)
  const [result, setResult] = useState<PeerImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const imp = useMutation({
    mutationFn: () => unwrap(peers().importFile()),
    onSuccess: (r) => {
      setResult(r)
      setError(null)
      if (r?.ok) setSelected(r.peer.fingerprint)
      void qc.invalidateQueries({ queryKey: ['peers'] })
    },
    onError: (e) => setError(errorMessage(e))
  })
  const notice = importNotice(result)
  const items = list.data?.peers ?? []
  const current = selected && items.some((p) => p.fingerprint === selected) ? selected : (items[0]?.fingerprint ?? null)

  return (
    <div className="page peers-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Peers</div>
          <h2>{tr('Peer cards', '朋友卡片')}</h2>
          <p className="muted">
            {tr(
              'Import a .navaliacard a peer sent you. It is verified offline and saved on this Mac (readable only by you). Modified cards are rejected outright. A newer card from the same key updates in place and keeps the history.',
              '导入朋友发给你的 .navaliacard，离线验签后保存在本机（只有你能读）。被改动过的卡片直接拒绝。同一把密钥的新卡片会原地更新并保留历史。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" disabled={imp.isPending} onClick={() => imp.mutate()}>
            {imp.isPending ? tr('Importing…', '导入中…') : tr('Import card', '导入卡片')}
          </button>
        </div>
      </header>

      {notice ? <div className={`banner compact ${notice.tone}`}>{notice.text}</div> : null}
      {result && !result.ok ? <div className="mono tiny muted">{result.detail}</div> : null}
      {error ? <div className="banner bad compact">{error}</div> : null}
      {list.isError ? <div className="banner bad compact">{errorMessage(list.error)}</div> : null}
      {list.data?.unreadable ? (
        <div className="banner warn compact">
          {tr(
            `${list.data.unreadable} peer file(s) on this Mac no longer pass signature verification (they may have been modified) and are not listed. Re-import their card to replace them.`,
            `本机有 ${list.data.unreadable} 个朋友文件已无法通过验签（可能被改动过），没有列出。重新导入对方的卡片即可替换。`
          )}
        </div>
      ) : null}

      <SubscriptionSection />

      <MomentsPanel />

      <div className="peers-layout">
        <aside className="peers-list">
          {items.length === 0 && !list.isLoading ? <div className="muted">{tr('No peer cards yet.', '还没有朋友卡片。')}</div> : null}
          {items.map((p) => {
            const v = VERIFICATION_LABEL[p.verification]
            return (
              <button key={p.fingerprint} className={`card peers-item ${p.fingerprint === current ? 'active' : ''}`} onClick={() => setSelected(p.fingerprint)}>
                <div className="peers-item-head">
                  <strong>{peerTitle(p)}</strong>
                  <span className={`chip ${v.tone}`}>{v.text}</span>
                </div>
                {p.headline ? <div className="tiny ellipsis">{p.headline}</div> : null}
                {p.topics.length > 1 ? (
                  <div className="tiny muted ellipsis">
                    {tr('Working on: ', '在做：')}{p.topics.filter((t) => t.source !== 'summary').slice(0, 3).map((t) => t.text).join(' · ')}
                  </div>
                ) : null}
                <div className="mono tiny muted">{shortFingerprint(p.fingerprint)}</div>
              </button>
            )
          })}
        </aside>
        <main className="peers-main">
          {current ? <Detail fingerprint={current} onRemoved={() => setSelected(null)} /> : null}
        </main>
      </div>
    </div>
  )
}
