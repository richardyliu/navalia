import type { AgentView } from '../../../../main/broker/api'
import { tr } from '../../lib/i18n'

/** Original Swipe states (reference §5.2 / §9.3): connected / not installed / mismatch / partial. */
export const SWIPE_STATE_LABEL: Record<AgentView['state'], string> = {
  connected: 'Connected',
  not_installed: 'Not installed',
  mismatch: 'Mismatch',
  partial: 'Partial',
  get available() {
    return tr('Not connected', '未连接')
  }
}

export type SwipeAgentAction = 'connect' | 'disconnect'

/**
 * Pure list for Swipe Your Card: pick a local agent → connect (full access) / repair / disconnect.
 * Not-installed agents get no action (ID-04: never connect something that is not there).
 */
export function SwipeAgents({ agents, pending, onAction }: { agents: AgentView[]; pending: boolean; onAction: (action: SwipeAgentAction, agent: AgentView) => void }) {
  return (
    <div className="swipe-agents">
      {agents.map((a) => (
        <div key={a.id} className={`swipe-agent ${a.state}`} data-state={a.state}>
          <strong>{a.name}</strong>
          <span className={`chip ${a.state === 'connected' ? 'ok' : a.state === 'mismatch' || a.state === 'partial' ? 'warn' : 'subtle'}`} title={a.detail}>
            {SWIPE_STATE_LABEL[a.state]}
          </span>
          {a.state === 'connected' ? <span className="chip subtle">{a.access === 'full' ? 'full access' : 'scoped · Extension'}</span> : null}
          {a.autoConnect && a.state !== 'not_installed' && a.state !== 'connected' ? (
            <button className="btn primary small swipe-connect" disabled={pending} onClick={() => onAction('connect', a)}>
              {a.state === 'available' ? tr('Connect', '连接') : tr('Repair', '修复')}
            </button>
          ) : null}
          {a.state === 'connected' || a.state === 'mismatch' || a.state === 'partial' ? (
            <button className="btn ghost small swipe-disconnect" disabled={pending} onClick={() => onAction('disconnect', a)}>
              {tr('Disconnect', '断开')}
            </button>
          ) : null}
          {!a.autoConnect && a.state !== 'not_installed' ? <span className="tiny muted">{tr('Manual setup (see Connections)', '手动配置（见 Connections）')}</span> : null}
        </div>
      ))}
    </div>
  )
}
