import { useState } from 'react'
import type { ImapConfigInput, ImapConfigView, ImapFetchOptions } from '../../../../main/connectors/api'
import { imapNotSupported, IMAP_PROVIDERS, imapFormErrors, providerFor } from '../../pages/connectorsView'
import { tr } from '../../lib/i18n'

/**
 * C19 IMAP settings + fetch. The password field is write-only: main never sends it back; an empty
 * field keeps the stored one.
 */
export function ImapPanel(props: {
  status: ImapConfigView | null
  busy: boolean
  onSave: (v: ImapConfigInput) => Promise<boolean>
  onClear: () => void
  onFetch: (o: ImapFetchOptions) => void
}) {
  const s = props.status
  const [editing, setEditing] = useState(!s?.configured)
  const [form, setForm] = useState<ImapConfigInput>({ host: s?.host ?? '', port: s?.port ?? 993, user: '', password: '', mailbox: s?.mailbox ?? 'INBOX' })
  const [opts, setOpts] = useState<ImapFetchOptions>({ sinceDays: 7, maxMessages: 50 })
  const errs = imapFormErrors(form, !!s?.hasPassword)
  const note = providerFor(form.host)

  const set = <K extends keyof ImapConfigInput>(k: K, v: ImapConfigInput[K]): void => setForm({ ...form, [k]: v })

  return (
    <section className="card conn-imap">
      <h3>{tr('IMAP mailbox (app password, read-only)', 'IMAP 邮箱（应用专用密码，只读）')}</h3>
      {s && !s.encryptionAvailable ? (
        <div className="banner bad compact">
          {tr(
            'System encrypted storage (Keychain) is unavailable: Navalia never saves a mail password in plaintext, so IMAP cannot be used for now.',
            '系统加密存储（钥匙串）不可用：Navalia 不会以明文保存邮箱密码，因此暂时无法使用 IMAP。'
          )}
        </div>
      ) : null}
      {s?.configured && !editing ? (
        <div className="conn-imap-current tiny">
          <span>
            {s.userMasked} · {s.host}:{s.port} ·{' '}
            {tr(`mailbox "${s.mailbox}" · password saved encrypted`, `邮箱「${s.mailbox}」· 密码已加密保存`)}
          </span>
          <button className="btn ghost small" disabled={props.busy} onClick={() => setEditing(true)}>
            {tr('Edit', '修改')}
          </button>
          <button className="btn ghost small" disabled={props.busy} onClick={props.onClear}>
            {tr('Clear credentials', '清除凭据')}
          </button>
        </div>
      ) : (
        <form
          className="conn-imap-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (errs.length) return
            void props.onSave(form).then((ok) => {
              if (ok) {
                setEditing(false)
                setForm({ ...form, password: '' })
              }
            })
          }}
        >
          <label>
            {tr('Server', '服务器')}
            <input className="input" value={form.host} placeholder="imap.gmail.com" onChange={(e) => set('host', e.target.value)} autoComplete="off" />
          </label>
          <label>
            {tr('Port', '端口')}
            <input className="input conn-port" type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
          <label>
            {tr('Account', '账号')}
            <input className="input" value={form.user} placeholder={s?.userMasked ?? 'you@example.com'} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
          </label>
          <label>
            {tr('App password', '应用专用密码')}
            <input
              className="input"
              type="password"
              value={form.password}
              placeholder={s?.hasPassword ? tr('Leave empty = keep the saved password', '留空 = 保留已保存的密码') : tr('Not your mail sign-in password', '不是邮箱登录密码')}
              onChange={(e) => set('password', e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label>
            {tr('Mailbox (folder)', '邮箱（文件夹）')}
            <input className="input" value={form.mailbox} placeholder="INBOX" onChange={(e) => set('mailbox', e.target.value)} />
          </label>
          {errs.length && (form.host || form.user) ? (
            <ul className="tiny conn-errs">
              {errs.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : null}
          <div className="page-actions">
            <button className="btn primary" type="submit" disabled={props.busy || errs.length > 0 || (s ? !s.encryptionAvailable : false)}>
              {tr('Save encrypted', '加密保存')}
            </button>
            {s?.configured ? (
              <button className="btn ghost" type="button" onClick={() => setEditing(false)}>
                {tr('Cancel', '取消')}
              </button>
            ) : null}
          </div>
          {note ? (
            <div className="muted tiny">
              {tr(`${note.name}: account is the ${note.user}.`, `${note.name}：账号填${note.user}。`)} {note.password.join(' ')}
            </div>
          ) : null}
        </form>
      )}

      {s?.configured && !editing ? (
        <div className="conn-imap-fetch tiny">
          {tr('Read the last', '读取最近')}
          <input className="input conn-num" type="number" min={1} max={365} value={opts.sinceDays} onChange={(e) => setOpts({ ...opts, sinceDays: Number(e.target.value) })} />
          {tr('days, up to', '天、最多')}
          <input className="input conn-num" type="number" min={1} max={500} value={opts.maxMessages} onChange={(e) => setOpts({ ...opts, maxMessages: Number(e.target.value) })} />
          {tr('messages', '封')}
          <button
            className="btn primary"
            disabled={props.busy || !(opts.sinceDays >= 1 && opts.sinceDays <= 365 && opts.maxMessages >= 1 && opts.maxMessages <= 500)}
            onClick={() => props.onFetch({ sinceDays: Math.floor(opts.sinceDays), maxMessages: Math.floor(opts.maxMessages) })}
          >
            {props.busy ? tr('Connecting…', '连接中…') : tr('Connect and preview', '连接并预览')}
          </button>
          <span className="muted">
            {tr('Read-only: never marks as read, deletes or moves. Nothing is written before the preview.', '只读：不标记已读、不删除、不移动。预览前不会写入任何内容。')}
          </span>
        </div>
      ) : null}

      <details className="tiny">
        <summary>{tr('What is an app password? How to turn it on for each provider', '什么是应用专用密码？各邮箱怎么开')}</summary>
        <p className="muted">
          {tr(
            'An app password (authorization code) is a separate password your mail provider generates for third-party clients. It only works for mail, can be revoked at any time in your mail settings, and never exposes your main password. Navalia uses it only to sign in to IMAP read-only. This version does not support OAuth sign-in.',
            '应用专用密码（授权码）是邮箱服务商为第三方客户端单独生成的密码，只能用来收发邮件，可以随时在邮箱设置里作废，不会暴露你的主密码。Navalia 只用它以只读方式登录 IMAP。这个版本不支持 OAuth 登录。'
          )}
        </p>
        <ul>
          {IMAP_PROVIDERS.map((p) => (
            <li key={p.name}>
              <strong>{p.name}</strong>
              {tr(`: server ${p.host}, port ${p.port}, account is the ${p.user}.`, `：服务器 ${p.host}，端口 ${p.port}，账号填${p.user}。`)} {p.password.join(' ')}
            </li>
          ))}
          {imapNotSupported().map((n) => (
            <li key={n} className="muted">
              {n}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
