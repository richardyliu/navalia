// S1-FULL C17 Settings 「本机提醒 · 进阶」: menu bar entry, own global shortcut, weekday-only brief,
// daily cap, context-sufficiency thresholds, detail text, and the local decision log (fired /
// suppressed + reason). Everything defaults to off; the master switch above turns all of it off.
import { useEffect, useState } from 'react'
import {
  DAILY_CAP_MAX,
  GATED_TRIGGERS,
  MIN_ITEMS_MAX,
  TRIGGER_CODE,
  TRIGGER_LABEL,
  type GatedTrigger,
  type ProactiveSettingsPatch,
  type ProactiveView
} from '../../../../main/proactive/api'
import { tr } from '../../lib/i18n'
import { decisionLine, parseThreshold, shortcutText } from './proactiveExtrasView'

export function ProactiveExtras() {
  const [view, setView] = useState<ProactiveView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [acc, setAcc] = useState('')
  const [mins, setMins] = useState<Record<GatedTrigger, string> | null>(null)
  const [cap, setCap] = useState('')

  function accept(v: ProactiveView): void {
    setView(v)
    setAcc(v.settings.shortcut.accelerator)
    setCap(String(v.settings.dailyCap))
    setMins(Object.fromEntries(GATED_TRIGGERS.map((t) => [t, String(v.settings.minItems[t])])) as Record<GatedTrigger, string>)
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
  if (!s || !view || !mins) return error ? <div className="banner bad compact">{error}</div> : null
  const sc = shortcutText(view.shortcut)
  const capN = parseThreshold(cap, DAILY_CAP_MAX)
  const minPatch: Partial<Record<GatedTrigger, number>> = {}
  let minsValid = true
  for (const t of GATED_TRIGGERS) {
    const n = parseThreshold(mins[t], MIN_ITEMS_MAX)
    if (n === null) minsValid = false
    else minPatch[t] = n
  }

  return (
    <section className="card" data-testid="proactive-extras">
      <div className="card-head">
        <h3>{tr('Proactive · Advanced', '本机提醒 · 进阶')}</h3>
        <span className="chip subtle">{s.enabled ? tr('Master switch on', '总开关已开') : tr('Master switch off: nothing below takes effect', '总开关关闭：以下都不生效')}</span>
      </div>
      <p className="muted small">
        {tr(
          'All notifications are computed on this Mac (no network, no LLM). Not enough content means no notification: each kind has an "at least N evidenced items" threshold; below it Navalia stays silent and records that in the decision log below.',
          '所有提醒都在本机计算（不联网、不调 LLM）。内容不够就不提醒：每类提醒都有「至少几条带证据的条目」门槛，低于门槛保持沉默，并记在下面的决定记录里。'
        )}
      </p>
      {error ? <div className="banner bad compact">{error}</div> : null}
      <dl className="kv">
        <div>
          <dt>
            <label>
              <input type="checkbox" checked={s.tray} disabled={busy} onChange={(e) => void save({ tray: e.target.checked })} />{' '}
              {tr('Proactive entry in the menu bar', '菜单栏「提醒」入口')}
            </label>
          </dt>
          <dd className="tiny muted">
            {tr(
              'Needs the menu bar icon to be on. Shows only how many were sent today, plus "Turn off all proactive notifications".',
              '需要菜单栏图标已开启。只显示今天已发几条，以及「关闭全部提醒」。'
            )}
          </dd>
        </div>
        <div>
          <dt>
            <label>
              <input
                type="checkbox"
                checked={s.shortcut.enabled}
                disabled={busy}
                onChange={(e) => void save({ shortcut: { enabled: e.target.checked } })}
              />{' '}
              {tr('Global shortcut', '全局快捷键')}
            </label>
          </dt>
          <dd>
            <input className="mono small" size={28} value={acc} onChange={(e) => setAcc(e.target.value)} />{' '}
            <button className="btn ghost small" disabled={busy || acc === s.shortcut.accelerator} onClick={() => void save({ shortcut: { accelerator: acc } })}>
              {tr('Save shortcut', '保存快捷键')}
            </button>
            <div className={`tiny ${sc.tone === 'warn' ? '' : 'muted'}`}>
              <span className={`chip ${sc.tone}`}>{view.shortcut.state}</span> {sc.text}
            </div>
          </dd>
        </div>
        <div>
          <dt>
            <label>
              <input type="checkbox" checked={s.briefDays === 'weekdays'} disabled={busy} onChange={(e) => void save({ briefDays: e.target.checked ? 'weekdays' : 'all' })} />{' '}
              {tr('Brief notifications on weekdays only', '简报类提醒只在工作日')}
            </label>
          </dt>
          <dd className="tiny muted">{tr('T1 / T2 / T10 are only sent Monday to Friday.', 'T1 / T2 / T10 只在周一到周五发。')}</dd>
        </div>
        <div>
          <dt>
            <label>
              <input type="checkbox" checked={s.detail} disabled={busy} onChange={(e) => void save({ detail: e.target.checked })} />{' '}
              {tr('Include a short detail in notifications', '通知里附带简短说明')}
            </label>
          </dt>
          <dd className="tiny muted">
            {tr(
              'Off by default: title and count only. When on, meeting / friend moment notifications may include a title of up to 30 characters (it may appear on the lock screen and in screen sharing).',
              '默认关闭：只有标题和数量。打开后，会议 / 朋友时刻提醒可以附带最多 30 个字的标题（可能出现在锁屏和屏幕共享里）。'
            )}
          </dd>
        </div>
        <div>
          <dt>{tr('Daily maximum', '每天最多')}</dt>
          <dd>
            <input className="mono small" size={3} value={cap} onChange={(e) => setCap(e.target.value)} />{' '}
            {tr(`per day (1–${DAILY_CAP_MAX})`, `条（1–${DAILY_CAP_MAX}）`)}
          </dd>
        </div>
        {GATED_TRIGGERS.map((t) => (
          <div key={t}>
            <dt>
              {TRIGGER_CODE[t]} {tr('threshold', '门槛')} ≥ <input className="mono small" size={3} value={mins[t]} onChange={(e) => setMins({ ...mins, [t]: e.target.value })} />
            </dt>
            <dd className="tiny muted">{TRIGGER_LABEL[t]}</dd>
          </div>
        ))}
      </dl>
      <div className="card-foot wrap">
        <button
          className="btn ghost small"
          disabled={busy || capN === null || !minsValid}
          onClick={() => void save({ dailyCap: capN ?? undefined, minItems: minPatch })}
        >
          {tr('Save limit and thresholds', '保存上限与门槛')}
        </button>
        {capN === null || !minsValid ? <span className="tiny muted">{tr(`Enter a whole number from 1 to ${MIN_ITEMS_MAX}`, `请填 1 到 ${MIN_ITEMS_MAX} 的整数`)}</span> : null}
      </div>
      <details>
        <summary className="small">
          {tr(
            'Decision log (sent / not sent and why; category, count and source ids only, no content)',
            '决定记录（发送 / 没发送及原因；只有类别、数量和来源编号，不含内容）'
          )}
        </summary>
        {view.decisions.length === 0 ? (
          <p className="tiny muted">{tr('No records yet. Nothing is evaluated or recorded while the master switch is off.', '还没有记录。总开关关闭时不评估，也不记录。')}</p>
        ) : (
          <ul className="tiny mono" data-testid="proactive-decisions">
            {view.decisions.map((d, i) => (
              <li key={`${d.time}-${i}`}>{decisionLine(d)}</li>
            ))}
          </ul>
        )}
        <button className="btn ghost small" disabled={busy || view.decisions.length === 0} onClick={() => void call(() => window.lens.proactive.clearDecisions())}>
          {tr('Clear decision log', '清空决定记录')}
        </button>
      </details>
    </section>
  )
}
