import { useState } from 'react'
import { Modal } from '../Modal'
import { tr } from '../../lib/i18n'

export function ResetIdentityDialog({
  fingerprint,
  pending,
  error,
  onConfirm,
  onClose
}: {
  fingerprint: string | null
  pending: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  const [understood, setUnderstood] = useState(false)
  return (
    <Modal
      title={tr('Reset identity', '重置身份')}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={pending}>
            {tr('Cancel', '取消')}
          </button>
          <button className="btn danger pcard-reset-confirm" onClick={onConfirm} disabled={!understood || pending}>
            {pending ? tr('Resetting…', '重置中…') : tr('Generate new key', '生成新密钥')}
          </button>
        </>
      }
    >
      <p>{tr('This generates a new Ed25519 key and deletes the current private key. After that:', '会生成一把新的 Ed25519 密钥，并删除当前私钥。之后：')}</p>
      <ul className="pcard-reset-list">
        <li>{tr('Cards you already sent still verify, but show as “Signed with old key”.', '已经发出去的卡片仍能验证签名，但会显示为“旧密钥签名”。')}</li>
        <li>{tr('The old fingerprint others saved will no longer match your new card; they need to check the fingerprint again.', '别人保存的旧指纹将不再对应你的新卡片，需要重新核对指纹。')}</li>
        <li>{tr('This cannot be undone.', '这一步不能撤销。')}</li>
      </ul>
      {fingerprint ? (
        <p className="tiny muted">
          {tr('Current fingerprint: ', '当前指纹：')}<code>{fingerprint.slice(0, 16)}…</code>
        </p>
      ) : null}
      <label className="pcard-reset-check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        {tr('I understand old cards will show as signed with an old key', '我明白旧卡片会显示为旧密钥签名')}
      </label>
      <p className="tiny muted">{tr('After you click “Generate new key”, the system shows one more confirmation dialog; the reset only happens when you click “Reset identity” there.', '点“生成新密钥”后，系统还会弹出一次确认框；在那里点“重置身份”才会真的执行。')}</p>
      {error ? <div className="banner bad compact">{error}</div> : null}
    </Modal>
  )
}
