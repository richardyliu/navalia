// B16: Settings → 云端. Server address, login state, account fingerprint, sign out, delete account
// and the cloud on/off switch. Reuses the existing `lens:cloud:*` handlers (no new IPC); deleting
// and enabling are confirmed by a native dialog in main. The token never reaches the renderer.
import { useEffect, useMemo, useState } from 'react'
import type { CloudStatus } from '../../../../main/cloud/api'
import { tr } from '../../lib/i18n'
import {
  CLOUD_FEATURES,
  CLOUD_STATE_LABEL,
  accountFingerprint,
  cloudSettingsState,
  createCloudSettingsController,
  serverLabel,
  type CloudActionResult
} from './cloudSettingsView'
import './settings.css'

export interface CloudSettingsViewProps {
  status: CloudStatus | null
  busy?: boolean
  message?: { ok: boolean; text: string } | null
  url?: string
  onUrl?: (v: string) => void
  onEnable?: () => void
  onDisable?: () => void
  onSignIn?: () => void
  onSignOut?: () => void
  onDelete?: () => void
}

/** Presentational part (static-renderable in tests). */
export function CloudSettingsView({ status, busy = false, message = null, url = '', onUrl, onEnable, onDisable, onSignIn, onSignOut, onDelete }: CloudSettingsViewProps) {
  const state = cloudSettingsState(status)
  const fp = state === 'signed_in' ? accountFingerprint(status?.accountId) : null
  const on = state === 'signed_in' || state === 'signed_out'
  return (
    <section className="card settings-cloud" data-testid="settings-cloud" data-state={state}>
      <div className="card-head">
        <h3>{tr('Cloud', '云端')}</h3>
        <span className={`chip ${state === 'signed_in' ? 'ok' : 'subtle'}`} data-testid="settings-cloud-state">
          {CLOUD_STATE_LABEL[state]}
        </span>
      </div>

      {message ? (
        <div className={`banner ${message.ok ? 'ok' : 'bad'} compact`} role={message.ok ? 'status' : 'alert'} data-testid="settings-cloud-message">
          {message.text}
        </div>
      ) : null}

      <dl className="kv">
        <div>
          <dt>{tr('Server', '服务器')}</dt>
          <dd className="mono small" data-testid="settings-cloud-server">
            {serverLabel(status?.baseUrl)}
          </dd>
        </div>
        <div>
          <dt>{tr('Sign-in', '登录状态')}</dt>
          <dd data-testid="settings-cloud-login">{state === 'signed_in' ? tr('Signed in', '已登录') : state === 'signed_out' ? tr('Not signed in', '未登录') : '—'}</dd>
        </div>
        <div>
          <dt>{tr('Account fingerprint', '账号指纹')}</dt>
          <dd className="mono small" data-testid="settings-cloud-fingerprint">
            {fp ?? '—'}
          </dd>
        </div>
      </dl>

      {state === 'never' || state === 'off' ? (
        <div className="card-foot wrap">
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={tr('https://your-server', 'https://你的服务器')}
            value={url}
            onChange={(e) => onUrl?.(e.target.value)}
            aria-label={tr('Cloud server address', '云端服务器地址')}
          />
          <button className="btn small primary" disabled={busy || !url.trim()} onClick={onEnable} data-testid="settings-cloud-enable">
            {tr('Turn on Cloud…', '开启云端…')}
          </button>
        </div>
      ) : null}

      {on ? (
        <div className="card-foot wrap">
          {state === 'signed_out' ? (
            <button className="btn small primary" disabled={busy} onClick={onSignIn} data-testid="settings-cloud-signin">
              {tr('Sign in with this Mac’s identity', '用本机身份登录')}
            </button>
          ) : (
            <button className="btn small ghost" disabled={busy} onClick={onSignOut} data-testid="settings-cloud-signout">
              {tr('Sign out', '退出登录')}
            </button>
          )}
          <button className="btn small ghost" disabled={busy} onClick={onDisable} data-testid="settings-cloud-disable">
            {tr('Turn off Cloud', '关闭云端')}
          </button>
          {state === 'signed_in' ? (
            <button className="btn small danger" disabled={busy} onClick={onDelete} data-testid="settings-cloud-delete">
              {tr('Delete cloud account…', '删除云账号…')}
            </button>
          ) : null}
        </div>
      ) : null}

      <h4>{tr('Features that use Cloud', '使用云端的功能')}</h4>
      <ul className="settings-cloud-features small" data-testid="settings-cloud-features">
        {CLOUD_FEATURES.map((f) => (
          <li key={f.id}>
            <strong>{f.label}</strong> <span className="muted">— {f.note}</span>{' '}
            <span className={`chip ${on ? 'ok' : 'subtle'}`}>{on ? tr('Available (online only when you use it)', '可用（主动使用时才联网）') : tr('Off', '关闭')}</span>
          </li>
        ))}
      </ul>
      <p className="tiny muted" style={{ marginBottom: 0 }}>
        {tr(
          'Cloud is off by default; while it is off, Navalia does not go online. Features have no separate switches: data is sent only when you act on the matching page. Deleting the cloud account only deletes data on the server; data on this Mac is not affected.',
          '云端默认关闭；关闭时 Navalia 不会联网。各功能没有单独开关：只有你在对应页面主动操作时才会发送数据。删除云账号只删服务器上的数据，本机数据不受影响。'
        )}
      </p>
    </section>
  )
}

/** Mounted once from Settings.tsx. */
export function CloudSettingsSection() {
  const ctl = useMemo(() => createCloudSettingsController(window.lens.cloud), [])
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void ctl.load().then((r) => {
      if (r.status) {
        setStatus(r.status)
        setUrl(r.status.baseUrl ?? '')
      } else setMessage({ ok: false, text: r.message })
    })
  }, [ctl])

  async function act(fn: () => Promise<CloudActionResult>): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const r = await fn()
      if (r.status) setStatus(r.status)
      setMessage(r.message ? { ok: r.ok, text: r.message } : null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <CloudSettingsView
      status={status}
      busy={busy}
      message={message}
      url={url}
      onUrl={setUrl}
      onEnable={() => void act(() => ctl.enable(url))}
      onDisable={() => void act(() => ctl.disable(status?.baseUrl ?? null))}
      onSignIn={() => void act(() => ctl.signIn())}
      onSignOut={() => void act(() => ctl.signOut())}
      onDelete={() => void act(() => ctl.deleteAccount())}
    />
  )
}
