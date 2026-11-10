import { useState } from 'react'
import '../components/card/card.css'
import { LocalClaim } from '../components/card/LocalClaim'
import { PersonalCard } from '../components/card/PersonalCard'
import { ResetIdentityDialog } from '../components/card/ResetIdentityDialog'
import { groupFingerprint } from '../components/card/layout'
import { copyText, useCreateCard, useIdentityStatus, useLatestCard, useResetIdentity } from '../components/card/useIdentity'
import { formatDateTime } from '../lib/format'
import { tr } from '../lib/i18n'
import { errorMessage } from '../lib/api'

export function Card() {
  const status = useIdentityStatus()
  const latest = useLatestCard()
  const create = useCreateCard()
  const reset = useResetIdentity()
  const [flipped, setFlipped] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const identity = status.data?.identity ?? null
  const card = latest.data ?? null
  const loading = status.isLoading || latest.isLoading

  async function copyFingerprint(): Promise<void> {
    if (!identity) return
    await copyText(identity.fingerprint)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="page pcard-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Personal Card</div>
          <h2>{tr('Personal Card', '个人卡片')}</h2>
          <p className="muted">{tr('Signed locally with Ed25519; no account needed. Anyone with just the card file can verify it offline.', '本地 Ed25519 签名，不需要账号。别人只拿到卡片文件就能离线验证。')}</p>
        </div>
        {card ? (
          <div className="page-actions">
            <button className="btn ghost pcard-regen" onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? tr('Generating…', '生成中…') : tr('Regenerate from current model', '用当前模型重新生成')}
            </button>
            <button className="btn ghost pcard-reset" onClick={() => setResetOpen(true)}>
              {tr('Reset identity…', '重置身份…')}
            </button>
          </div>
        ) : null}
      </header>

      {status.isError ? <div className="banner bad compact">{errorMessage(status.error)}</div> : null}
      {latest.isError ? <div className="banner bad compact">{errorMessage(latest.error)}</div> : null}
      {status.data && !status.data.encryptionAvailable ? (
        <div className="banner bad compact">{tr('System encryption (safeStorage) is unavailable, so the private key cannot be stored safely and no key will be created.', '系统加密（safeStorage）不可用，无法安全保存私钥，所以不会创建密钥。')}</div>
      ) : null}
      {create.isError ? <div className="banner bad compact">{errorMessage(create.error)}</div> : null}

      {loading ? <p className="muted">{tr('Loading…', '读取中…')}</p> : null}

      {!loading && !card ? (
        <LocalClaim
          fingerprint={identity?.fingerprint ?? null}
          pending={create.isPending}
          disabled={status.data?.encryptionAvailable === false}
          onCreate={() => create.mutate()}
        />
      ) : null}

      {card ? (
        <div className="pcard-layout">
          <div>
            {card.issuer === 'previous' ? (
              <div className="banner warn compact">{tr('This card is signed with an old key (identity was reset). Regenerate it to sign with the current key.', '这张卡由旧密钥签名（身份已重置）。重新生成即可用当前密钥签名。')}</div>
            ) : null}
            <PersonalCard signed={card.signed} issuer={card.issuer} flipped={flipped} onFlip={() => setFlipped((f) => !f)} />
          </div>

          <aside className="card pcard-meta">
            <div className="card-head">
              <h3>{tr('Signature', '签名信息')}</h3>
              <span className={`chip ${card.issuer === 'current' ? 'ok' : 'warn'}`}>
                {card.issuer === 'current' ? tr('Current key', '当前密钥') : card.issuer === 'previous' ? tr('Old key', '旧密钥') : tr('Unknown key', '未知密钥')}
              </span>
            </div>
            <dl className="pcard-dl">
              <dt>{tr('Card ID', '卡片 ID')}</dt>
              <dd className="mono">{card.signed.card.card_id}</dd>
              <dt>{tr('Issued', '签发时间')}</dt>
              <dd>{formatDateTime(card.signed.card.issued_at)}</dd>
              <dt>{tr('Model as of', '模型时间')}</dt>
              <dd>{formatDateTime(card.signed.card.content.front.as_of)}</dd>
              <dt>{tr('Build status', '构建状态')}</dt>
              <dd>{card.signed.card.content.front.model_status}</dd>
              {identity ? (
                <>
                  <dt>{tr('Current key', '当前密钥')}</dt>
                  <dd className="mono pcard-fp-full">{groupFingerprint(identity.fingerprint)}</dd>
                  <dt>{tr('Key created', '密钥创建')}</dt>
                  <dd>{formatDateTime(identity.createdAt)}</dd>
                  <dt>{tr('Private key protection', '私钥保护')}</dt>
                  <dd>{identity.keyBackend === 'electron-safestorage' ? tr('safeStorage (macOS Keychain)', 'safeStorage（macOS 钥匙串）') : identity.keyBackend}</dd>
                </>
              ) : null}
            </dl>
            <div className="card-foot wrap">
              <button className="btn ghost small" onClick={() => void copyFingerprint()} disabled={!identity}>
                {copied ? tr('Copied', '已复制') : tr('Copy fingerprint', '复制指纹')}
              </button>
              <span className="tiny muted">{tr('The card is self-signed: verification proves the content is unchanged, not who holds it. Ask the other person to check the fingerprint.', '卡片自签名：验证证明内容未被改，不证明持有人身份。请让对方核对指纹。')}</span>
            </div>
            {status.data && status.data.previous.length > 0 ? (
              <div className="pcard-prev">
                <div className="tiny muted">{tr('Retired keys', '已退役的密钥')}</div>
                {status.data.previous.map((p) => (
                  <div key={p.fingerprint} className="tiny">
                    <code>{p.fingerprint.slice(0, 16)}…</code> {tr(`retired ${formatDateTime(p.retiredAt)}`, `退役于 ${formatDateTime(p.retiredAt)}`)}
                  </div>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}

      {resetOpen ? (
        <ResetIdentityDialog
          fingerprint={identity?.fingerprint ?? null}
          pending={reset.isPending}
          error={reset.isError ? errorMessage(reset.error) : null}
          onClose={() => setResetOpen(false)}
          onConfirm={() =>
            reset.mutate(undefined, {
              // Main shows the real (native) confirmation; Cancel there leaves everything as is.
              onSuccess: () => setResetOpen(false)
            })
          }
        />
      ) : null}
    </div>
  )
}
