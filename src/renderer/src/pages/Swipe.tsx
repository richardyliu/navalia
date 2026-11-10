import { useRef, useState } from 'react'
import '../components/card/card.css'
import '../components/connections/connections.css'
import { PersonalCard } from '../components/card/PersonalCard'
import { QrSvg } from '../components/card/QrSvg'
import { SwipeAgents } from '../components/card/SwipeAgents'
import { SwipeImport } from '../components/card/SwipeImport'
import { useLatestCard } from '../components/card/useIdentity'
import { useExport, useSwipeQr } from '../components/card/useSwipe'
import { useAgentAction, useConnections } from '../components/connections/useConnections'
import { tr } from '../lib/i18n'

export function Swipe() {
  const latest = useLatestCard()
  const card = latest.data ?? null
  const qr = useSwipeQr(Boolean(card))
  const exp = useExport()
  const conns = useConnections()
  const agentAction = useAgentAction()
  const [flipped, setFlipped] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  function doExport(kind: 'card' | 'qr' | 'png') {
    setNotice(null)
    const arg = kind === 'png' ? { kind, el: cardRef.current?.querySelector('.pcard') as Element } : { kind }
    exp.mutate(arg as never, { onSuccess: (r: { saved: string | null }) => setNotice(r.saved ? tr(`Saved to ${r.saved}`, `已保存到 ${r.saved}`) : tr('Cancelled', '已取消')) })
  }

  return (
    <div className="page swipe-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Swipe Your Card</div>
          <h2>{tr('Hand your card to an Agent or a person', '把卡片交给 Agent 或别人')}</h2>
          <p className="muted">{tr('Connect a local Agent (full access), or export the card file and QR code for someone to verify offline.', '选一个本机 Agent 连接（full access），或导出卡片文件与二维码给别人离线验证。')}</p>
        </div>
      </header>

      {notice ? <div className="banner ok compact swipe-notice">{notice}</div> : null}
      {exp.isError ? <div className="banner bad compact">{exp.error instanceof Error ? exp.error.message : String(exp.error)}</div> : null}
      {agentAction.isError ? <div className="banner bad compact">{agentAction.error instanceof Error ? agentAction.error.message : ''}</div> : null}

      <section className="card">
        <div className="card-head">
          <h3>{tr('Choose a local Agent', '选择本机 Agent')}</h3>
          <span className="tiny muted">{tr('Restart the client after connecting. More options in Connections.', '连接后需要重启该客户端。更多操作在 Connections。')}</span>
        </div>
        <SwipeAgents
          agents={conns.data?.agents ?? []}
          pending={agentAction.isPending}
          onAction={(action, a) =>
            agentAction.mutate(
              { action, agent: a.id },
              {
                onSuccess: () =>
                  setNotice(
                    action === 'connect'
                      ? tr(`Connected ${a.name} (full access). Restart ${a.name}.`, `已连接 ${a.name}（full access）。请重启 ${a.name}。`)
                      : tr(`Disconnected ${a.name}: removed only the navalia entry and revoked its token.`, `已断开 ${a.name}：只移除了 navalia 这一条配置，并撤销了它的 token。`)
                  )
              }
            )
          }
        />
      </section>

      {card ? (
        <div className="swipe-layout">
          <div ref={cardRef}>
            <PersonalCard signed={card.signed} issuer={card.issuer} flipped={flipped} onFlip={() => setFlipped((f) => !f)} />
          </div>
          <section className="card swipe-share">
            <div className="card-head">
              <h3>{tr('QR code', '二维码')}</h3>
              <span className="tiny muted">{tr('Contains only the card ID and public key fingerprint, no content', '只含卡片 ID 和公钥指纹，不含任何内容')}</span>
            </div>
            {qr.data ? <QrSvg text={qr.data.payload} size={196} /> : <p className="muted">{tr('Generating…', '生成中…')}</p>}
            {qr.data ? <code className="swipe-payload">{qr.data.payload}</code> : null}
            <div className="swipe-actions">
              <button className="btn primary small swipe-export-card" onClick={() => doExport('card')} disabled={exp.isPending}>
                {tr('Export .navaliacard', '导出 .navaliacard')}
              </button>
              <button className="btn small swipe-export-png" onClick={() => doExport('png')} disabled={exp.isPending}>
                {tr('Export card PNG', '导出卡片 PNG')}
              </button>
              <button className="btn small swipe-export-qr" onClick={() => doExport('qr')} disabled={exp.isPending}>
                {tr('Export QR SVG', '导出二维码 SVG')}
              </button>
            </div>
            <p className="tiny muted">{tr('No public link: share locally by file, AirDrop and so on.', '没有公网链接：通过文件、AirDrop 等方式本地分享。')}</p>
          </section>
        </div>
      ) : latest.isLoading ? null : (
        <section className="card">
          <p className="muted">{tr('No Personal Card yet. Create one on the Personal Card page first.', '还没有个人卡片。先到“个人卡片”页创建。')}</p>
        </section>
      )}

      <SwipeImport />
    </div>
  )
}
