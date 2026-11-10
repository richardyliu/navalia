import type { IssuerStatus, SignedCard } from '../../../../main/identity/api'
import { formatDateTime } from '../../lib/format'
import { groupFingerprint } from './layout'
import { MiniMap } from './MiniMap'
import { tr } from '../../lib/i18n'

const LEVEL_LABEL = { volume: 'Volume', face: 'Face' } as const

export function PersonalCard({
  signed,
  issuer,
  flipped,
  onFlip
}: {
  signed: SignedCard
  issuer: IssuerStatus
  flipped: boolean
  onFlip: () => void
}) {
  const { content, issuer: key } = signed.card
  const { front, back } = content

  return (
    <div className="pcard-wrap">
      <div className={`pcard ${flipped ? 'flipped' : ''}`}>
        <div className="pcard-inner">
          <section className="pcard-face pcard-front" aria-hidden={flipped}>
            <header className="pcard-top">
              <div>
                <div className="eyebrow">Personal Card</div>
                <strong className="pcard-name">{front.display_name ?? 'Personal Card'}</strong>
              </div>
              <div className="pcard-badges">
                {front.degraded ? <span className="chip warn">{tr('Model degraded', '模型降级')} · {front.model_status}</span> : null}
                {issuer !== 'current' ? <span className="chip bad">{issuer === 'previous' ? tr('Signed with old key', '旧密钥签名') : tr('Not this Mac\'s key', '非本机密钥')}</span> : null}
              </div>
            </header>
            {front.summary ? (
              <p className="pcard-summary">{front.summary}</p>
            ) : (
              <p className="pcard-summary empty">{tr('The model has no Root (identity summary) yet. Once the Runtime builds a Root, regenerate the card.', '模型还没有 Root（身份摘要）。Runtime 构建出 Root 后，重新生成卡片。')}</p>
            )}
            {front.highlights.length > 0 ? (
              <ul className="pcard-highlights">
                {front.highlights.map((h, i) => (
                  <li key={i}>
                    <span className="chip subtle">{LEVEL_LABEL[h.level]}</span>
                    <span className="pcard-hl-text">{h.signature}</span>
                    <span className="tiny muted">{h.observations} obs</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <footer className="pcard-asof">
              <span>as of {formatDateTime(front.as_of)}</span>
              <span className="tiny muted">{back.stats.points} points</span>
            </footer>
          </section>

          <section className="pcard-face pcard-back" aria-hidden={!flipped}>
            <header className="pcard-top">
              <div>
                <div className="eyebrow">Mini Map</div>
                <strong className="pcard-name">Root · Volume · Face</strong>
              </div>
              {front.degraded ? <span className="chip warn">{tr('Model degraded', '模型降级')} · {front.model_status}</span> : null}
            </header>
            <MiniMap map={back.mini_map} />
            <div className="pcard-stats">
              <span>{back.stats.points} points</span>
              <span>{back.stats.relation_lines} relations</span>
              <span>{back.stats.faces} faces</span>
              <span>{back.stats.volumes} volumes</span>
              <span>{back.stats.roots} root</span>
            </div>
          </section>
        </div>
      </div>

      {/* Outside the flipping element so it is visible on both sides. */}
      <div className="pcard-fp" title={tr('Ed25519 public key fingerprint (SHA-256). Whoever receives the card should check this string.', 'Ed25519 公钥指纹（SHA-256）。收到卡片的人应核对这一串。')}>
        <span className="tiny muted">{tr('Ed25519 fingerprint', 'Ed25519 指纹')}</span>
        <code>{groupFingerprint(key.fingerprint)}</code>
      </div>

      <button className="btn ghost small pcard-flip" onClick={onFlip} aria-label={tr('Flip', '翻面')}>
        ⇋ {flipped ? tr('Show front', '看正面') : tr('Flip to Mini Map', '翻面看 Mini Map')}
      </button>
    </div>
  )
}
