// 我订阅的朋友: pick a peer (or paste a fingerprint) → fetch → offline verify in main → verified
// letters shown, forged ones reported (「签名无效，已丢弃」). The local cache is readable offline.
import { useEffect, useState } from 'react'
import type { PeerSummary } from '../../../../main/peers/api'
import type { FriendLetter } from '../../../../main/cloud/subs-api'
import { tr } from '../../lib/i18n'
import { droppedLines, formatTime, parseFingerprint, shortFp, subsErrorText, verifyNote } from '../../pages/subscriptionsView'

export function FriendLettersSection({ ready }: { ready: boolean }) {
  const [peers, setPeers] = useState<PeerSummary[]>([])
  const [input, setInput] = useState('')
  const [fp, setFp] = useState<string | null>(null)
  const [letters, setLetters] = useState<FriendLetter[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.lens.peers.list().then((r) => r.ok && setPeers(r.data.peers))
  }, [])

  async function show(target: string, online: boolean): Promise<void> {
    setFp(target)
    setBusy(true)
    setNotes([])
    setOpenId(null)
    try {
      if (online) {
        const r = await window.lens.subs.friendLetters(target)
        if (!r.ok) {
          setNotes([subsErrorText(r.error)])
        } else {
          setLetters(r.data.letters)
          setNotes([
            tr(`${r.data.letters.length} letter(s) verified and cached on this Mac.`, `验签通过 ${r.data.letters.length} 封，已缓存到本机。`),
            ...droppedLines(r.data.dropped)
          ])
          return
        }
      }
      const c = await window.lens.subs.cachedLetters(target)
      if (c.ok) {
        setLetters(c.data.letters)
        setNotes((n) => [
          ...n,
          tr(
            `${c.data.letters.length} letter(s) cached on this Mac${c.data.unreadable ? `; ${c.data.unreadable} cached file(s) failed verification and were ignored` : ''}.`,
            `本机缓存 ${c.data.letters.length} 封${c.data.unreadable ? `；${c.data.unreadable} 个缓存文件验签失败，已忽略` : ''}。`
          )
        ])
      }
    } finally {
      setBusy(false)
    }
  }

  const pasted = parseFingerprint(input)

  return (
    <section className="card subs-section" data-testid="subs-friends">
      <h2>{tr('Friends I subscribe to', '我订阅的朋友')}</h2>
      <p className="tiny muted">{verifyNote()}</p>
      <div className="subs-row">
        <select className="input" value="" onChange={(e) => e.target.value && void show(e.target.value, ready)} aria-label={tr('Choose a friend', '选择朋友')}>
          <option value="">{tr('Choose from Peers…', '从朋友列表选择…')}</option>
          {peers.map((p) => (
            <option key={p.fingerprint} value={p.fingerprint}>
              {p.displayName ?? shortFp(p.fingerprint)}
            </option>
          ))}
        </select>
        <input className="input mono" style={{ flex: 1 }} placeholder={tr('Or paste a 64-character fingerprint', '或粘贴 64 位指纹')} value={input} onChange={(e) => setInput(e.target.value)} aria-label={tr('Friend fingerprint', '朋友指纹')} />
        <button className="btn small" disabled={busy || !pasted} onClick={() => pasted && void show(pasted, ready)}>
          {ready ? tr('Fetch and verify', '获取并验签') : tr('View local cache', '查看本机缓存')}
        </button>
      </div>
      {fp ? <p className="tiny muted mono">{fp}</p> : null}
      {notes.map((n) => (
        <p key={n} className={n.startsWith(tr('Invalid signature', '签名无效')) ? 'tiny subs-warn' : 'tiny'}>
          {n}
        </p>
      ))}
      <ul className="subs-list">
        {letters.map((l) => (
          <li key={l.issueId}>
            <button className="subs-link" onClick={() => setOpenId(openId === l.issueId ? null : l.issueId)}>
              {l.week} · {l.title}
            </button>
            <span className="tiny muted"> {formatTime(l.createdAt)} · {tr('verified', '已验签')}</span>
            {openId === l.issueId ? <pre className="subs-pre">{l.markdown}</pre> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
