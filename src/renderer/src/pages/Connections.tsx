import { useState } from 'react'
import '../components/connections/connections.css'
import type { AgentView } from '../../../main/broker/api'
import { AccessChart } from '../components/connections/AccessChart'
import { AccessLogList } from '../components/connections/AccessLogList'
import { typingTimeCopy } from '../components/connections/stack'
import { useAccessDaily, useAccessLog, useAgentAction, useClearLog, useConnections, useGrantAction } from '../components/connections/useConnections'
import { Modal } from '../components/Modal'
import { formatDateTime, formatNumber } from '../lib/format'
import { getLocale, tr } from '../lib/i18n'

const STATE: Record<AgentView['state'], { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'ok' },
  not_installed: { label: 'Not installed', tone: 'subtle' },
  mismatch: { label: 'Mismatch', tone: 'warn' },
  partial: { label: 'Partial', tone: 'warn' },
  available: {
    get label() {
      return tr('Not connected', '未连接')
    },
    tone: 'subtle'
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function Connections() {
  const conns = useConnections()
  const [includeFailures, setIncludeFailures] = useState(false)
  const log = useAccessLog(includeFailures)
  const daily = useAccessDaily()
  const agentAction = useAgentAction()
  const grantAction = useGrantAction()
  const clear = useClearLog()
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [showExt, setShowExt] = useState(false)
  const [capFilter, setCapFilter] = useState<string>('')

  const allRows = log.data ?? []
  const capCounts = [...allRows.reduce((m, r) => m.set(r.capability, (m.get(r.capability) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])
  const shownRows = capFilter ? allRows.filter((r) => r.capability === capFilter) : allRows
  const okRows = allRows.filter((r) => r.outcome === 'ok')
  const chars = okRows.reduce((s, r) => s + r.responseChars, 0)
  const broker = conns.data?.broker

  function act(action: 'connect' | 'disconnect' | 'copy', agent: AgentView) {
    setNotice(null)
    agentAction.mutate(
      { action, agent: agent.id },
      {
        onSuccess: () =>
          setNotice(
            action === 'connect'
              ? tr(`Wrote ${agent.configPath}. Restart ${agent.name} for the new MCP config to take effect.`, `已写入 ${agent.configPath}。请重启 ${agent.name}，新的 MCP 配置才会生效。`)
              : action === 'copy'
                ? tr(
                    `Copied the MCP JSON for ${agent.name} (with a new token) to the clipboard. Paste it into the client, then restart it.`,
                    `已把 ${agent.name} 的 MCP JSON（含新 token）复制到剪贴板。粘贴到客户端后重启它。`
                  )
                : tr(`Disconnected ${agent.name}: removed only the navalia entry and revoked its token.`, `已断开 ${agent.name}：只移除了 navalia 这一条配置，并撤销了它的 token。`)
          )
      }
    )
  }

  return (
    <div className="page conn-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Connections</div>
          <h2>{tr('Connections & Access log', '连接与 Access log')}</h2>
          <p className="muted">
            {tr(
              'One row per Agent. Connecting grants full access: all 22 Runtime tools (including writes such as remember / correct_memory) + 3 Rewind tools + 4 Navalia extensions. Every call is recorded in the Access log.',
              '每个 Agent 一行；连接即 full access：Runtime 的全部 22 个工具（含 remember / correct_memory 等写入）+ 3 个 Rewind 工具 + 4 个 Navalia 扩展。每次调用都记在 Access log。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <span className={`chip ${broker?.running ? 'ok' : 'bad'}`} title={broker?.error ?? ''}>
            Broker {broker?.running ? broker.url : broker?.error ? tr(`not running: ${broker.error}`, `未启动：${broker.error}`) : '…'}
          </span>
        </div>
      </header>

      {conns.isError ? <div className="banner bad compact">{message(conns.error)}</div> : null}
      {agentAction.isError ? <div className="banner bad compact">{message(agentAction.error)}</div> : null}
      {grantAction.isError ? <div className="banner bad compact">{message(grantAction.error)}</div> : null}
      {notice ? <div className="banner ok compact conn-notice">{notice}</div> : null}

      <section className="card">
        <div className="card-head">
          <h3>Connections</h3>
          <span className="tiny muted">{tr('Only the navalia entry is written; disconnecting leaves other entries alone.', '配置只写入 navalia 这一条；断开不动其他条目。')}</span>
        </div>
        <table className="conn-table conn-agents">
          <tbody>
            {(conns.data?.agents ?? []).map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong>
                  <div className="tiny muted mono ellipsis conn-path" title={a.configPath}>
                    {a.configPath}
                  </div>
                </td>
                <td>
                  <span className={`chip ${STATE[a.state].tone}`}>{STATE[a.state].label}</span>
                </td>
                <td className="tiny muted conn-detail">{a.detail}</td>
                <td>{a.state === 'connected' || a.grant ? <span className="chip subtle">{a.access === 'full' ? 'full access' : 'scoped · Extension'}</span> : null}</td>
                <td className="conn-actions">
                  {a.autoConnect && a.state === 'available' ? (
                    <button className="btn primary small conn-connect" disabled={agentAction.isPending} onClick={() => act('connect', a)}>
                      {tr('Connect', '连接')}
                    </button>
                  ) : null}
                  {a.autoConnect && (a.state === 'mismatch' || a.state === 'partial') ? (
                    <button className="btn small conn-connect" disabled={agentAction.isPending} onClick={() => act('connect', a)}>
                      {tr('Repair', '修复')}
                    </button>
                  ) : null}
                  {!a.autoConnect && a.state !== 'not_installed' ? (
                    <button className="btn small" disabled={agentAction.isPending} onClick={() => act('copy', a)}>
                      {tr('Copy MCP JSON', '复制 MCP JSON')}
                    </button>
                  ) : null}
                  {a.state === 'connected' || a.state === 'mismatch' || a.state === 'partial' ? (
                    <button className="btn ghost small conn-disconnect" disabled={agentAction.isPending} onClick={() => act('disconnect', a)}>
                      {tr('Disconnect', '断开')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="card-foot wrap">
          <button className="btn ghost small" onClick={() => setShowExt((v) => !v)} aria-expanded={showExt}>
            {showExt ? '▾' : '▸'} {tr('Grant details', '授权细节')}
          </button>
          <span className="chip warn">Extension</span>
          <span className="tiny muted">{tr('The original has only full access; expiry, read counts, revoke and renew are Navalia extensions.', '原版只有 full access；有效期、读取次数、撤销与续期是 Navalia 扩展。')}</span>
        </div>
        {showExt ? (
          <table className="conn-table conn-grants">
            <thead>
              <tr>
                <th>Agent</th>
                <th>{tr('State', '状态')}</th>
                <th>{tr('Created', '创建')}</th>
                <th>{tr('Expires', '到期')}</th>
                <th>{tr('Reads', '读取')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(conns.data?.agents ?? []).every((a) => !a.grant) ? (
                <tr>
                  <td colSpan={6} className="tiny muted">
                    {tr('No active grants (revoked ones are not shown).', '没有有效授权（已撤销的不显示）。')}
                  </td>
                </tr>
              ) : null}
              {(conns.data?.agents ?? [])
                .filter((a) => a.grant)
                .map((a) => {
                  const g = a.grant!
                  return (
                    <tr key={g.id}>
                      <td>{a.name}</td>
                      <td>{g.state}</td>
                      <td>{formatDateTime(g.createdAt)}</td>
                      <td>{g.expiresAt ? formatDateTime(g.expiresAt) : tr('Never', '不过期')}</td>
                      <td>
                        {g.reads}
                        {g.maxReads ? ` / ${g.maxReads}` : ''}
                      </td>
                      <td className="conn-actions">
                        <button className="btn ghost small" onClick={() => grantAction.mutate({ action: 'renew', grantId: g.id, ttlSeconds: 30 * 24 * 3600 })}>
                          {tr('Renew 30 days · Ext', '续期 30 天 · Ext')}
                        </button>
                        <button className="btn ghost small" onClick={() => grantAction.mutate({ action: 'revoke', grantId: g.id })}>
                          {tr('Revoke · Ext', '撤销 · Ext')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="card conn-logcard">
        <div className="card-head">
          <h3>Access log</h3>
          <div className="conn-actions">
            <label className="tiny conn-check">
              <input type="checkbox" checked={includeFailures} onChange={(e) => setIncludeFailures(e.target.checked)} />
              {tr('Show denied/failed', '显示拒绝/失败')} <span className="chip warn">Extension</span>
            </label>
            <button className="btn ghost small conn-clear" onClick={() => setConfirmClear(true)} disabled={!log.data?.length}>
              {tr('Clear log', '清空记录')}
            </button>
          </div>
        </div>
        <p className="conn-meaning">
          Counts successful context reads, including empty results. Response characters include formatting and guidance; they do not measure time saved.
          {getLocale() === 'zh' ? <span className="muted"> 统计成功的上下文读取（含空结果）。返回字符含格式与说明，不代表节省的时间。</span> : null}
        </p>
        <div className="conn-totals">
          <span>
            <strong>{okRows.length}</strong> {tr('reads', '次读取')}
          </span>
          <span>
            <strong>{formatNumber(chars)}</strong> {tr('response chars', '返回字符')}
          </span>
          <span className="conn-typing" title={tr('Response chars ÷ 300 chars/min; only a conversion of read volume, not time saved', '返回字符 ÷ 300 字/分钟；只是读取量的换算，不是节省的时间')}>
            {typingTimeCopy(chars)}
          </span>
          <span className="tiny muted">{tr('Last 30 days', '最近 30 天')}</span>
        </div>
        <AccessChart daily={daily.data ?? []} />
        {capCounts.length > 0 ? (
          <div className="conn-caps">
            <button className={`chip ${capFilter === '' ? 'ok' : 'subtle'}`} onClick={() => setCapFilter('')}>
              {tr('All', '全部')} {allRows.length}
            </button>
            {capCounts.map(([cap, n]) => (
              <button key={cap} className={`chip mono ${capFilter === cap ? 'ok' : 'subtle'}`} onClick={() => setCapFilter(capFilter === cap ? '' : cap)}>
                {cap} {n}
              </button>
            ))}
          </div>
        ) : null}
        {log.isError ? <div className="banner bad compact">{message(log.error)}</div> : null}
        <AccessLogList rows={shownRows} />
      </section>

      {confirmClear ? (
        <Modal
          title={tr('Clear Access log', '清空 Access log')}
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmClear(false)}>
                {tr('Cancel', '取消')}
              </button>
              <button
                className="btn primary conn-clear-confirm"
                disabled={clear.isPending}
                onClick={() => clear.mutate(undefined, { onSuccess: () => setConfirmClear(false) })}
              >
                {tr('Clear', '清空')}
              </button>
            </>
          }
        >
          <p>{tr('Deletes all read records. Connected Agents are not affected and can keep reading.', '删除全部读取记录。已连接的 Agent 不受影响，仍可继续读取。')}</p>
          {clear.isError ? <div className="banner bad compact">{message(clear.error)}</div> : null}
        </Modal>
      ) : null}
    </div>
  )
}
