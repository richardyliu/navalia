import { groupFingerprint } from './layout'
import { tr } from '../../lib/i18n'

/**
 * Local card creation (ID-02, DEVIATIONS D3): no account and no cloud (OG-D1). It creates a
 * local Ed25519-signed card. No fake login UI.
 */
export function LocalClaim({
  fingerprint,
  pending,
  disabled,
  onCreate
}: {
  fingerprint: string | null
  pending: boolean
  disabled: boolean
  onCreate: () => void
}) {
  return (
    <section className="card pcard-empty" data-deviation="D3">
      <div className="eyebrow">
        Local <span className="chip warn pcard-deviation">DEVIATION · D3</span>
      </div>
      <h3>Create your Personal Card</h3>
      <p>
        {tr(
          'Create your card on this Mac: Navalia generates an Ed25519 key (the private key is encrypted with the system safeStorage and stays in the local main process), reads the cleaned identity summary from the Runtime (',
          '在本机创建你的卡片：生成一把 Ed25519 密钥（私钥由系统 safeStorage 加密，只留在本机主进程）， 从 Runtime 读取已清洗的身份摘要（'
        )}
        <code>/model/share-card</code>
        {tr(') and signs it.', '）后签名。')}
      </p>
      <p className="tiny muted pcard-deviation-note">
        {tr(
          'No account is needed: the card is created and signed on this Mac (DEVIATIONS D3). The optional self-hosted Cloud has nothing to do with creating a card.',
          '不需要账号：卡片在本机创建并签名（DEVIATIONS D3）。可选的自建云端与创建卡片无关。'
        )}
      </p>
      <button className="btn primary pcard-create" onClick={onCreate} disabled={pending || disabled}>
        {pending ? tr('Creating…', '创建中…') : tr('Create card', '创建卡片')}
      </button>
      {fingerprint ? (
        <p className="tiny muted">
          {tr('Existing key: ', '已有密钥：')}<code>{groupFingerprint(fingerprint).slice(0, 19)}…</code>
        </p>
      ) : null}
    </section>
  )
}
