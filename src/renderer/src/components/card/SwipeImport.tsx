import { useState } from 'react'
import { matchQr, type QrMatch } from '../../../../main/identity/swipe-schema'
import { formatDateTime } from '../../lib/format'
import { groupFingerprint } from './layout'
import { useImport } from './useSwipe'
import { tr } from '../../lib/i18n'

const MAX_BYTES = 2_000_000

const REASON: Record<string, string> = {
  get parse() {
    return tr('Not a valid JSON card file', '不是合法的 JSON 卡片文件')
  },
  get schema() {
    return tr('Does not match the .navaliacard format (or has unsigned fields added)', '格式不符合 .navaliacard（或被加了未签名字段）')
  },
  get fingerprint() {
    return tr('Public key fingerprint does not match the key in the card', '公钥指纹与卡内公钥不一致')
  },
  get signature() {
    return tr('Signature does not match: the content was changed', '签名不匹配：内容被改过')
  }
}

const MATCH: Record<QrMatch, { label: string; tone: string }> = {
  match: {
    get label() {
      return tr('QR code matches this card (same key, same card)', '二维码与这张卡一致（同一把密钥、同一张卡）')
    },
    tone: 'ok'
  },
  same_key_other_card: {
    get label() {
      return tr('Same key, but not the card in the QR code', '同一把密钥，但不是二维码里的那张卡')
    },
    tone: 'warn'
  },
  different_key: {
    get label() {
      return tr('Fingerprint mismatch: not the person/key in the QR code', '指纹不一致：不是二维码对应的那个人/密钥')
    },
    tone: 'bad'
  },
  invalid_qr: {
    get label() {
      return tr('Invalid QR code content', '二维码内容不合法')
    },
    tone: 'bad'
  }
}

export function SwipeImport() {
  const imp = useImport()
  const [qrText, setQrText] = useState('')
  const [over, setOver] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const r = imp.data

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    // The window-level guard (main.tsx) also prevents navigation; this element handles the file.
    e.preventDefault()
    setOver(false)
    setLocalError(null)
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (file.size > MAX_BYTES) return setLocalError(tr('File is too large to be a card', '文件太大，不像是一张卡片'))
    imp.mutate({ text: await file.text(), name: file.name })
  }

  const match = r && r.valid && qrText.trim() ? matchQr(r.card, qrText) : null

  return (
    <section className="card swipe-import">
      <div className="card-head">
        <h3>{tr("Verify someone else's card", '验证别人的卡片')}</h3>
        <span className="tiny muted">{tr('Offline: verified using only the card file, no network.', '离线：只用卡片文件本身验证，不联网。')}</span>
      </div>
      <div
        className={`swipe-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <span>{tr('Drop a .navaliacard here', '把 .navaliacard 拖到这里')}</span>
        <button className="btn ghost small swipe-open" onClick={() => imp.mutate(null)} disabled={imp.isPending}>
          {tr('or choose a file…', '或选择文件…')}
        </button>
      </div>
      {localError ? <div className="banner bad compact">{localError}</div> : null}
      {imp.isError ? <div className="banner bad compact">{imp.error instanceof Error ? imp.error.message : String(imp.error)}</div> : null}
      {r ? (
        <div className="swipe-result">
          <div className="swipe-result-head">
            <span className={`chip ${r.valid ? 'ok' : 'bad'}`}>{r.valid ? tr('Signature valid', '签名有效') : tr('Invalid', '无效')}</span>
            <span className="tiny muted mono ellipsis">{r.file}</span>
          </div>
          {r.valid ? (
            <>
              <dl className="pcard-dl">
                <dt>{tr('Fingerprint', '指纹')}</dt>
                <dd className="mono pcard-fp-full">{groupFingerprint(r.card.card.issuer.fingerprint)}</dd>
                <dt>{tr('Card ID', '卡片 ID')}</dt>
                <dd className="mono">{r.card.card.card_id}</dd>
                <dt>{tr('Name', '名字')}</dt>
                <dd>{r.card.card.content.front.display_name ?? '—'}</dd>
                <dt>{tr('Summary', '摘要')}</dt>
                <dd>{r.card.card.content.front.summary ?? tr('(no Root summary)', '（没有 Root 摘要）')}</dd>
                <dt>as of</dt>
                <dd>{formatDateTime(r.card.card.content.front.as_of)}</dd>
                <dt>{tr('Relation to this Mac', '本机关系')}</dt>
                <dd>{r.issuer === 'current' ? tr('Your own current key', '这是你自己的当前密钥') : r.issuer === 'previous' ? tr('Your own old key', '你自己的旧密钥') : tr("Someone else's key", '别人的密钥')}</dd>
              </dl>
              <p className="tiny muted">{tr('A signature only proves the content is unchanged and matches the key in the card. To confirm who it is, check the fingerprint with them or scan their QR code.', '签名只证明内容没被改、和卡内公钥一致；要确认是谁，请和对方核对指纹或扫他的二维码。')}</p>
              <label className="swipe-qr-input">
                <span className="tiny muted">{tr('Their QR code content (paste after scanning)', '对方二维码的内容（扫码后粘贴）')}</span>
                <textarea rows={2} value={qrText} onChange={(e) => setQrText(e.target.value)} placeholder='{"v":1,"card_id":"card_…","fp":"…"}' />
              </label>
              {match ? <span className={`chip ${MATCH[match].tone} swipe-match`}>{MATCH[match].label}</span> : null}
            </>
          ) : (
            <p className="swipe-invalid">
              {REASON[r.reason] ?? r.reason}
              <span className="tiny muted"> · {r.detail}</span>
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}
