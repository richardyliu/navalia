// S1-FULL C10 「订阅」page (+ C8 云端名片). Logic lives in subscriptionsView.ts (pure, tested) and in
// main (subs.ts / cards.ts); this file only lays out the four sections. All network is in main.
import { useEffect, useState } from 'react'
import './Subscriptions.css'
import type { CloudStatus } from '../../../main/cloud/api'
import { CloudSetup } from '../components/chat/CloudSetup'
import { CloudCardSection } from '../components/subs/CloudCardSection'
import { FriendLettersSection } from '../components/subs/FriendLettersSection'
import { LetterSection } from '../components/subs/LetterSection'
import { SubscribersSection } from '../components/subs/SubscribersSection'
import { useNav } from '../lib/nav'
import { tr } from '../lib/i18n'
import { serverVisibleNote, subsGate } from './subscriptionsView'

export function Subscriptions() {
  const { go } = useNav()
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const gate = subsGate(status)
  const ready = gate.state === 'ready'

  useEffect(() => {
    void window.lens.cloud.status().then((r) => r.ok && setStatus(r.data))
  }, [])

  return (
    <div className="page subs-page">
      <header className="subs-header">
        <h1>{tr('Subscriptions', '订阅')}</h1>
        <p className="muted small">
          {tr(
            `Your weekly letter goes to subscribers through your own cloud; friends' weekly letters and cards are verified offline on this Mac. ${serverVisibleNote()}`,
            `每周信通过你自己的云端发给订阅者；朋友的周信和卡片在本机离线验签。${serverVisibleNote()}`
          )}
        </p>
      </header>
      {gate.state !== 'loading' && !ready ? (
        <div className="subs-gate">
          <p className="small">{gate.text}</p>
          <button className="btn small ghost" onClick={() => go('chat')}>
            {tr('Go to Cloud chat', '去「云端对话」页')}
          </button>
          <CloudSetup status={status} onChange={setStatus} />
        </div>
      ) : null}
      <LetterSection ready={ready} />
      <SubscribersSection ready={ready} enabled={!!status?.enabled && !!status.baseUrl} />
      <FriendLettersSection ready={ready} />
      <CloudCardSection ready={ready} />
    </div>
  )
}
