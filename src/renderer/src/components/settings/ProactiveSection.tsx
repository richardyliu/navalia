// S1-R4-05 Settings 「本机通知」 (X9, opt-in). Every switch defaults to off. Notifications carry counts
// and categories only; clicking one only opens a Lens page. No network, no LLM.
import { useEffect, useState } from 'react'
import {
  PROACTIVE_TRIGGERS,
  TRIGGER_CODE,
  TRIGGER_LABEL,
  type ProactiveSettingsPatch,
  type ProactiveView
} from '../../../../main/proactive/api'
import { tr } from '../../lib/i18n'
import { PERMISSION_TEXT, permissionTone, proactiveStatusLine } from './proactiveView'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function ProactiveSection() {
  const [view, setView] = useState<ProactiveView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [quiet, setQuiet] = useState({ start: '', end: '' })
  const [briefTime, setBriefTime] = useState('')

  function accept(v: ProactiveView): void {
    setView(v)
    setQuiet(v.settings.quietHours)
    setBriefTime(v.settings.briefTime)
  }

  async function call(fn: () => ReturnType<typeof window.lens.proactive.get>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (r.ok) accept(r.data)
      else setError(r.error.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void call(() => window.lens.proactive.get())
  }, [])

  const save = (patch: ProactiveSettingsPatch): Promise<void> => call(() => window.lens.proactive.set(patch))
  const s = view?.settings
  const timesValid = HHMM.test(quiet.start) && HHMM.test(quiet.end) && HHMM.test(briefTime)
  const timesDirty = s ? quiet.start !== s.quietHours.start || quiet.end !== s.quietHours.end || briefTime !== s.briefTime : false

  return (
    <section className="card" data-testid="proactive-settings">
      <div className="card-head">
        <h3>{tr('Local notifications', '本机通知')}</h3>
        <span className="chip subtle">{view ? proactiveStatusLine(view) : tr('Loading…', '读取中…')}</span>
      </div>
      <p className="muted small">
        {tr(
          `All off by default. Notifications only carry counts and categories (e.g. "2 names that might be yours to confirm"), never memory text, names, window titles, URLs or WeChat content; clicking one only opens the matching Navalia page and writes nothing. At most ${view?.dailyCap ?? 3} per day, none during quiet hours, no network.`,
          `默认全部关闭。通知只写数量和类别（例如「有 2 个可能是你的名字待确认」），不含记忆正文、人名、窗口标题、网址或微信内容；点通知只会打开 Navalia 的对应页面，不会写入任何东西。每天最多 ${view?.dailyCap ?? 3} 条，安静时段不发，不联网。`
        )}
      </p>
      {view?.settingsError ? <div className="banner warn compact">{view.settingsError}</div> : null}
      {error ? <div className="banner bad compact">{error}</div> : null}
      {s && view ? (
        <>
          <dl className="kv">
            <div>
              <dt>
                <label>
                  <input
                    type="checkbox"
                    data-testid="proactive-enabled"
                    checked={s.enabled}
                    disabled={busy}
                    onChange={(e) => void save({ enabled: e.target.checked })}
                  />{' '}
                  {tr('Master switch', '总开关')}
                </label>
              </dt>
              <dd>
                <span className={`chip ${permissionTone(view.permission.state)}`}>
                  {tr(`Permission to notify: ${view.permission.state}`, `通知权限：${view.permission.state}`)}
                </span>
                <p className="tiny muted">{PERMISSION_TEXT[view.permission.state]}</p>
                {view.permission.state !== 'not_asked' ? (
                  <div className="card-foot wrap">
                    <button className="btn ghost small" disabled={busy} onClick={() => void call(() => window.lens.proactive.test())}>
                      {tr('Test again', '重新测试')}
                    </button>
                    {view.permission.state === 'shown' ? (
                      <button className="btn ghost small" disabled={busy} onClick={() => void call(() => window.lens.proactive.reportDenied())}>
                        {tr("I didn't see a notification", '我没看到通知')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </dd>
            </div>
            {PROACTIVE_TRIGGERS.map((t) => (
              <div key={t}>
                <dt>
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`proactive-${t}`}
                      checked={s.triggers[t]}
                      disabled={busy}
                      onChange={(e) => void save({ triggers: { [t]: e.target.checked } })}
                    />{' '}
                    {TRIGGER_CODE[t]}
                  </label>
                </dt>
                <dd className="small">{TRIGGER_LABEL[t]}</dd>
              </div>
            ))}
            <div>
              <dt>{tr('Quiet hours', '安静时段')}</dt>
              <dd>
                <input className="mono small" size={5} value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} /> –{' '}
                <input className="mono small" size={5} value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} />
                <span className="tiny muted">
                  {tr(' Local time, may cross midnight; same start and end means no quiet hours', ' 本地时间，可跨午夜；开始与结束相同表示不设安静时段')}
                </span>
              </dd>
            </div>
            <div>
              <dt>{tr('Brief time (T1 / T2)', '简报时间（T1 / T2）')}</dt>
              <dd>
                <input className="mono small" size={5} value={briefTime} onChange={(e) => setBriefTime(e.target.value)} />
                <span className="tiny muted">{tr(' Brief / to-do notifications are only sent after this time', ' 到这个时间之后才会发简报 / 待办提醒')}</span>
              </dd>
            </div>
          </dl>
          <div className="card-foot wrap">
            <button
              className="btn ghost small"
              disabled={busy || !timesDirty || !timesValid}
              onClick={() => void save({ quietHours: quiet, briefTime })}
            >
              {tr('Save times', '保存时间')}
            </button>
            {!timesValid ? <span className="tiny muted">{tr('Time format is HH:MM', '时间格式为 HH:MM')}</span> : null}
          </div>
          <details>
            <summary className="small">{tr('Recently sent (category, time and source ids only, no content)', '最近发送记录（只有类别、时间和来源编号，不含内容）')}</summary>
            {view.log.length === 0 ? (
              <p className="tiny muted">{tr('No notifications sent yet.', '还没有发送过通知。')}</p>
            ) : (
              <ul className="tiny mono">
                {view.log.map((e, i) => (
                  <li key={`${e.time}-${i}`}>
                    {e.time} · {e.trigger === 'test' ? tr('Test', '测试') : TRIGGER_CODE[e.trigger]} ·{' '}
                    {tr(`${e.source_ids.length} sources`, `${e.source_ids.length} 个来源`)}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      ) : null}
    </section>
  )
}
