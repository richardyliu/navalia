// 订阅者: masked emails + status, remove (native confirm in main), copy my subscribe link.
import { useCallback, useEffect, useState } from 'react'
import type { Subscriber } from '../../../../main/cloud/subs-api'
import { tr } from '../../lib/i18n'
import { formatTime, noTrackingNote, subscriberStatusLabel, subsErrorText } from '../../pages/subscriptionsView'

export function SubscribersSection({ ready, enabled }: { ready: boolean; enabled: boolean }) {
  const [list, setList] = useState<Subscriber[]>([])
  const [link, setLink] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!ready) return setList([])
    const r = await window.lens.subs.subscribers()
    if (r.ok) setList(r.data)
    else setMsg(subsErrorText(r.error))
  }, [ready])

  useEffect(() => {
    void refresh()
    if (!enabled) return setLink(null)
    void window.lens.subs.subscribeLink().then((r) => setLink(r.ok ? r.data.url : null))
  }, [refresh, enabled])

  async function remove(id: string): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.lens.subs.removeSubscriber(id)
      if (!r.ok) setMsg(subsErrorText(r.error))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card subs-section" data-testid="subs-subscribers">
      <h2>{tr('Subscribers', '订阅者')}</h2>
      <p className="tiny muted">
        {tr(
          `${noTrackingNote()}. Subscribing requires the person to confirm in an email (double opt-in).`,
          `${noTrackingNote()}。订阅需要对方在邮件里点确认（双重确认）。`
        )}
      </p>
      {link ? (
        <div className="subs-row">
          <span className="mono tiny subs-ellipsis">{link}</span>
          <button className="btn small" onClick={() => void window.lens.app.copy(link).then(() => setMsg(tr('Subscribe link copied', '订阅链接已复制')))}>
            {tr('Copy subscribe link', '复制订阅链接')}
          </button>
        </div>
      ) : null}
      {ready && list.length === 0 ? <p className="tiny muted">{tr('No subscribers yet.', '还没有订阅者。')}</p> : null}
      {list.length ? (
        <table className="subs-table">
          <thead>
            <tr>
              <th>{tr('Email', '邮箱')}</th>
              <th>{tr('Status', '状态')}</th>
              <th>{tr('Subscribed', '订阅时间')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.subscriberId}>
                <td className="mono">{s.emailMasked}</td>
                <td>{subscriberStatusLabel(s.status)}</td>
                <td>{formatTime(s.confirmedAt ?? s.createdAt)}</td>
                <td>
                  <button className="btn small ghost" disabled={busy} onClick={() => void remove(s.subscriberId)}>
                    {tr('Remove…', '移除…')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {msg ? <p className="tiny">{msg}</p> : null}
    </section>
  )
}
