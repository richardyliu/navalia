// OG-04 Settings: 菜单栏图标 / 全局快捷键 / 关闭窗口后保持常驻. All default OFF, local only.
import { useEffect, useState } from 'react'
import type { ShellSettingsPatch, ShellState } from '../../../../main/shell/api'
import { validateAccelerator } from '../../../../main/shell/accelerator'
import { tr } from '../../lib/i18n'

export function ShellSettingsSection() {
  const [state, setState] = useState<ShellState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accel, setAccel] = useState('')
  const [busy, setBusy] = useState(false)

  async function load(): Promise<void> {
    const r = await window.lens.shell.get()
    if (r.ok) {
      setState(r.data)
      setAccel(r.data.settings.shortcutAccelerator)
    } else setError(r.error.message)
  }

  useEffect(() => {
    void load()
  }, [])

  async function save(patch: ShellSettingsPatch): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.lens.shell.set(patch)
      if (r.ok) {
        setState(r.data)
        setAccel(r.data.settings.shortcutAccelerator)
      } else setError(r.error.message)
    } finally {
      setBusy(false)
    }
  }

  const s = state?.settings
  const accelCheck = validateAccelerator(accel)
  const accelDirty = s ? accel.trim() !== s.shortcutAccelerator : false

  return (
    <section className="card" data-testid="shell-settings">
      <div className="card-head">
        <h3>{tr('Menu bar & shortcut', '菜单栏与快捷键')}</h3>
        <span className="chip subtle">{tr('All off by default · local only', '默认全部关闭 · 仅本机')}</span>
      </div>
      {state?.settingsError ? <div className="banner warn compact">{state.settingsError}</div> : null}
      {error ? <div className="banner bad compact">{error}</div> : null}
      {s ? (
        <dl className="kv">
          <div>
            <dt>
              <label>
                <input
                  type="checkbox"
                  data-testid="shell-tray"
                  checked={s.trayEnabled}
                  disabled={busy}
                  onChange={(e) => void save({ trayEnabled: e.target.checked })}
                />{' '}
                {tr('Menu bar icon', '菜单栏图标')}
              </label>
            </dt>
            <dd className="small">
              {state.tray.error ? (
                <span className="tone-bad">{state.tray.error}</span>
              ) : state.tray.active ? (
                tr('Shown: Open Navalia / Quick Box / Pause or resume capture / Quit', '已显示：打开 Navalia / Quick Box / 暂停或恢复采集 / 退出')
              ) : (
                <span className="muted">{tr('Off', '关闭')}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>
              <label>
                <input
                  type="checkbox"
                  data-testid="shell-shortcut"
                  checked={s.shortcutEnabled}
                  disabled={busy}
                  onChange={(e) => void save({ shortcutEnabled: e.target.checked })}
                />{' '}
                {tr('Global shortcut (opens Quick Box)', '全局快捷键（唤起 Quick Box）')}
              </label>
            </dt>
            <dd className="small">
              <input
                className="input mono"
                data-testid="shell-accelerator"
                style={{ minWidth: 340 }}
                value={accel}
                maxLength={64}
                onChange={(e) => setAccel(e.target.value)}
              />{' '}
              <button
                className="btn ghost small"
                disabled={busy || !accelDirty || !accelCheck.ok}
                onClick={() => accelCheck.ok && void save({ shortcutAccelerator: accelCheck.accelerator })}
              >
                {tr('Save shortcut', '保存快捷键')}
              </button>
              <div className="tiny">
                {accelDirty && !accelCheck.ok ? <span className="tone-bad">{accelCheck.reason}</span> : null}
                {!accelDirty && state.shortcut.state === 'registered' ? (
                  <span className="tone-ok">{tr(`Registered ${state.shortcut.accelerator}`, `已注册 ${state.shortcut.accelerator}`)}</span>
                ) : null}
                {!accelDirty && state.shortcut.state === 'failed' ? (
                  <span className="tone-bad" data-testid="shell-shortcut-failed">
                    {tr(`${state.shortcut.accelerator}: ${state.shortcut.message}`, `${state.shortcut.accelerator}：${state.shortcut.message}`)}
                  </span>
                ) : null}
                {!accelDirty && state.shortcut.state === 'off' ? <span className="muted">{tr('Not registered', '未注册')}</span> : null}
              </div>
            </dd>
          </div>
          <div>
            <dt>
              <label>
                <input
                  type="checkbox"
                  data-testid="shell-resident"
                  checked={s.keepResidentOnClose}
                  disabled={busy}
                  onChange={(e) => void save({ keepResidentOnClose: e.target.checked })}
                />{' '}
                {tr('Keep running after closing the window', '关闭窗口后保持常驻')}
              </label>
            </dt>
            <dd className={`small ${state.resident.effective ? '' : 'muted'}`}>{state.resident.reason}</dd>
          </div>
        </dl>
      ) : (
        <p className="muted small">{tr('Loading…', '读取中…')}</p>
      )}
      <div className="card-foot wrap">
        <button className="btn ghost small" data-testid="shell-open-quickbox" onClick={() => void window.lens.shell.openQuickBox()}>
          {tr('Open Quick Box', '打开 Quick Box')}
        </button>
        <span className="tiny muted">
          {tr(
            'Quick Box: quick ask (local memory search, no LLM call) / quick note / quick open. Needs no Accessibility or Screen Recording permission. No system notifications.',
            'Quick Box：快速问（本地记忆搜索，不调用 LLM）/ 快速记 / 快速打开。不需要辅助功能或屏幕录制权限。不提供系统通知。'
          )}
        </span>
      </div>
    </section>
  )
}
