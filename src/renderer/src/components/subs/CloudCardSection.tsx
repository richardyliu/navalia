// 云端名片 (C8): publish my latest card (preview → native confirm in main → PUT), unpublish, and
// fetch a friend's card by fingerprint into the Peers list (offline verify in main).
import { useCallback, useEffect, useState } from 'react'
import type { PeerSummary } from '../../../../main/peers/api'
import type { CardPublishPreview, CloudCardStatus } from '../../../../main/cloud/subs-api'
import { tr } from '../../lib/i18n'
import { cardFetchText, cloudCardStatusText, formatTime, parseFingerprint, shortFp, subsErrorText } from '../../pages/subscriptionsView'

export function CloudCardSection({ ready }: { ready: boolean }) {
  const [status, setStatus] = useState<CloudCardStatus | null>(null)
  const [preview, setPreview] = useState<CardPublishPreview | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [peers, setPeers] = useState<PeerSummary[]>([])
  const [input, setInput] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!ready) return setStatus(null)
    const r = await window.lens.cloudCards.status()
    setStatus(r.ok ? r.data : null)
    if (!r.ok) setMsg(subsErrorText(r.error))
  }, [ready])

  useEffect(() => {
    void refresh()
    void window.lens.peers.list().then((r) => r.ok && setPeers(r.data.peers))
  }, [refresh])

  async function act<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }>, done: (d: T) => string): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      setMsg(r.ok ? done(r.data) : subsErrorText(r.error))
    } finally {
      setBusy(false)
    }
  }

  async function makePreview(): Promise<void> {
    setMsg(null)
    const r = await window.lens.cloudCards.publishPreview()
    if (r.ok) setPreview(r.data)
    else setMsg(subsErrorText(r.error))
  }

  const pasted = parseFingerprint(input)

  return (
    <section className="card subs-section" data-testid="subs-cards">
      <h2>{tr('Cloud card', '云端名片')}</h2>
      {ready ? <p className="tiny">{cloudCardStatusText(status)}</p> : <p className="tiny muted">{tr('Sign in to Cloud to publish and fetch cards.', '登录云端后可以发布和获取卡片。')}</p>}
      <div className="subs-row">
        <button className="btn small" disabled={busy} onClick={() => void makePreview()}>
          {tr('Preview the card to publish', '预览要发布的卡片')}
        </button>
        {status?.published ? (
          <button className="btn small ghost" disabled={busy || !ready} onClick={() => void act(() => window.lens.cloudCards.unpublish(), () => tr('Withdrawn from the cloud', '已从云端撤回')).then(refresh)}>
            {tr('Withdraw…', '撤回发布…')}
          </button>
        ) : null}
      </div>
      {preview ? (
        <div className="subs-preview" data-testid="subs-card-preview">
          <p className="tiny subs-warn">{preview.audienceNote}</p>
          <dl className="subs-dl">
            <dt>{tr('Name', '名字')}</dt>
            <dd>{preview.displayName ?? tr('(not set)', '（未设置）')}</dd>
            <dt>{tr('Summary', '概述')}</dt>
            <dd>{preview.summary ?? tr('(none)', '（无）')}</dd>
            <dt>{tr('Highlights', '要点')}</dt>
            <dd>{preview.highlights.join(' · ') || tr('(none)', '（无）')}</dd>
            <dt>{tr('Model as of', '模型时间')}</dt>
            <dd>{formatTime(preview.asOf)}</dd>
            <dt>{tr('Issued', '签发')}</dt>
            <dd>
              {formatTime(preview.issuedAt)} · <span className="mono">{preview.cardId}</span>
            </dd>
            <dt>{tr('Fingerprint', '指纹')}</dt>
            <dd className="mono">{preview.fingerprint}</dd>
            <dt>{tr('Size', '规模')}</dt>
            <dd>
              {tr(
                `${preview.stats.points} memory points · ${preview.stats.faces} habits · ${preview.stats.volumes} topics · ${preview.bytes} bytes`,
                `${preview.stats.points} 个记忆点 · ${preview.stats.faces} 个习惯 · ${preview.stats.volumes} 个主题 · ${preview.bytes} 字节`
              )}
            </dd>
          </dl>
          <button className="btn small ghost" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? tr('Hide raw text', '收起原文') : tr('View the raw text to upload', '查看将上传的原文')}
          </button>
          {showRaw ? <pre className="subs-pre mono">{preview.cardText}</pre> : null}
          <div className="subs-row">
            <button
              className="btn small primary"
              disabled={busy || !ready}
              onClick={() =>
                void act(
                  () => window.lens.cloudCards.publish(preview.previewId),
                  (d) =>
                    d.unchanged
                      ? tr(`The cloud already has this card (version ${d.version})`, `云端已经是这张卡片（第 ${d.version} 版）`)
                      : tr(`Published (version ${d.version})`, `已发布（第 ${d.version} 版）`)
                ).then(() => (setPreview(null), refresh()))
              }
            >
              {tr('Publish to cloud…', '发布到云端…')}
            </button>
          </div>
        </div>
      ) : null}

      <h3>{tr("Fetch a friend's card", '获取朋友的卡片')}</h3>
      <div className="subs-row">
        <select className="input" value="" onChange={(e) => e.target.value && void act(() => window.lens.cloudCards.fetchFriend(e.target.value), cardFetchText)} disabled={!ready || busy} aria-label={tr('Refresh an existing friend', '刷新已有朋友')}>
          <option value="">{tr('Refresh an existing friend…', '刷新已有朋友…')}</option>
          {peers.map((p) => (
            <option key={p.fingerprint} value={p.fingerprint}>
              {p.displayName ?? shortFp(p.fingerprint)}
            </option>
          ))}
        </select>
        <input className="input mono" style={{ flex: 1 }} placeholder={tr("Paste a friend's 64-character fingerprint", '粘贴朋友的 64 位指纹')} value={input} onChange={(e) => setInput(e.target.value)} aria-label={tr('Friend fingerprint', '朋友指纹')} />
        <button className="btn small" disabled={!ready || busy || !pasted} onClick={() => pasted && void act(() => window.lens.cloudCards.fetchFriend(pasted), cardFetchText)}>
          {tr('Fetch and verify', '获取并验签')}
        </button>
      </div>
      {msg ? <p className="tiny">{msg}</p> : null}
    </section>
  )
}
