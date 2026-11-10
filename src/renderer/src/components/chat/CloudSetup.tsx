// Minimal cloud opt-in panel, shared by Chat / Subscriptions / Meetings (Settings → 云端 is the full panel:
// components/settings/CloudSettingsSection.tsx). Enabling needs `confirm: true` here AND the native dialog in main; the token never
// reaches the renderer.
// C23: the off-state line is context-neutral by default (this panel is reused outside Chat, where
// 「可以预览将要发送的上下文」 is not true). A page can pass `offText` for its own wording.
import { useState } from 'react'
import type { CloudStatus } from '../../../../main/cloud/api'
import { tr } from '../../lib/i18n'
import { errorText, gateOf, notE2eeNote } from '../../pages/chatView'

/** Shown when cloud is off and the page passes no `offText`. True on every page that reuses the panel. */
/** `abcd1234…wxyz5678` form of a 64-hex fingerprint (account id = identity fingerprint). */
export function fingerprintShort(fp: string): string {
  return /^[0-9a-f]{64}$/.test(fp) ? `${fp.slice(0, 8)}…${fp.slice(-8)}` : fp.slice(0, 24)
}

export function cloudOffNeutral(): string {
  return tr(
    'Cloud is off (off by default): while it is off, Navalia sends nothing to any server. When you need it, enter your server address below and turn it on.',
    '云端未开启（默认关闭）：关闭时 Navalia 不会向服务器发送任何内容。需要时在下面填写你的服务器地址再开启。'
  )
}

export function CloudSetup({
  status,
  onChange,
  offText
}: {
  status: CloudStatus | null
  onChange: (s: CloudStatus) => void
  /** Page-specific line for the off state (e.g. Chat's preview hint). Defaults to cloudOffNeutral(). */
  offText?: string
}) {
  const gate = gateOf(status)
  const [url, setUrl] = useState(status?.baseUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function act(fn: () => Promise<{ ok: true; data: CloudStatus & { remoteRevoked?: boolean } } | { ok: false; error: { code: string; message: string } }>, done?: (d: CloudStatus & { remoteRevoked?: boolean }) => string | null): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      if (r.ok) {
        onChange(r.data)
        setMsg(done ? done(r.data) : null)
      } else setMsg(errorText(r.error))
    } finally {
      setBusy(false)
    }
  }

  if (gate.state === 'loading') return null
  return (
    <section className="card" data-testid="chat-cloud-setup">
      <div className="chat-row">
        <strong>{tr('Cloud', '云端')}</strong>
        <span className="muted small">{gate.state === 'off' ? offText ?? cloudOffNeutral() : gate.text}</span>
      </div>
      {gate.state === 'off' ? (
        <div className="chat-row" style={{ marginTop: 8 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={tr('https://your-server', 'https://你的服务器')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label={tr('Cloud server address', '云端服务器地址')}
          />
          <button
            className="btn small primary"
            disabled={busy || !url.trim()}
            onClick={() => void act(() => window.lens.cloud.configure({ enabled: true, baseUrl: url.trim(), confirm: true }))}
          >
            {tr('Turn on Cloud…', '开启云端…')}
          </button>
        </div>
      ) : null}
      {gate.state === 'signed_out' ? (
        <div className="chat-row" style={{ marginTop: 8 }}>
          <button className="btn small primary" disabled={busy} onClick={() => void act(() => window.lens.cloud.signIn())}>
            {tr('Sign in with this Mac’s identity', '用本机身份登录')}
          </button>
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={() => void act(() => window.lens.cloud.configure({ enabled: false, baseUrl: status?.baseUrl ?? null }))}
          >
            {tr('Turn off Cloud', '关闭云端')}
          </button>
        </div>
      ) : null}
      {gate.state === 'ready' ? (
        <div className="chat-row" style={{ marginTop: 8 }}>
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={() => void act(() => window.lens.cloud.signOut(), (d) =>
                    d.remoteRevoked
                      ? tr('Signed out, and the server session was signed out', '已退出，服务器端会话已注销')
                      : tr('Signed out on this Mac; the server session was not confirmed as signed out (it expires on its own)', '已在本机退出；服务器端会话未确认注销（到期后失效）'))}
          >
            {tr('Sign out', '退出登录')}
          </button>
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={() =>
              void act(
                () => window.lens.cloud.configure({ enabled: false, baseUrl: status?.baseUrl ?? null }),
                (d) =>
                  d.remoteRevoked
                    ? tr('Cloud is off and the server session was signed out', '已关闭云端，服务器端会话已注销')
                    : tr('Cloud is off (the server session was not confirmed as signed out)', '已关闭云端（服务器端会话未确认注销）')
              )
            }
          >
            {tr('Turn off Cloud', '关闭云端')}
          </button>
          {/* Right to deletion (Phase 5 gate): main shows its own native confirm before DELETE /v1/account. */}
          <button
            className="btn small ghost"
            disabled={busy}
            data-testid="cloud-delete-account"
            onClick={() => void act(() => window.lens.cloud.deleteAccount({ confirm: true }), () => tr('Your cloud account and all its data were deleted from the server; data on this Mac is not affected', '云端账号及其全部数据已从服务器删除；本机数据不受影响'))}
          >
            {tr('Delete cloud account…', '删除云端账号…')}
          </button>
        </div>
      ) : null}
      {gate.state === 'ready' && status?.accountId ? (
        <p className="tiny muted" data-testid="cloud-account-fingerprint">
          {tr('Cloud account = this Mac’s identity fingerprint', '云端账号 = 本机身份指纹')} <code className="mono">{fingerprintShort(status.accountId)}</code>
          {tr(' (same as the fingerprint on your Personal Card)', '（与「个人卡片」上的指纹一致）')}
        </p>
      ) : null}
      <p className="tiny muted" style={{ marginBottom: 0 }}>
        {notE2eeNote()}
      </p>
      {msg ? <p className="tiny">{msg}</p> : null}
    </section>
  )
}
