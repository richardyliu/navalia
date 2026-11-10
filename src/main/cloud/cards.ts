// S1-FULL C8 — cloud friend cards (Lens side). Main only; network only via client.ts.
//
// Publish: the latest local card signed by the CURRENT identity is previewed (human-readable fields +
// the exact `.navaliacard` text) and parked under a previewId; `publish(previewId)` asks a main-owned
// native confirm and PUTs exactly that text. Unpublish: native confirm, then DELETE.
// Fetch a friend: GET by fingerprint → Lens's own offline card verifier → the signer must equal the
// requested fingerprint and must not be us → the existing Peers store import path (fingerprint
// dedupe, ≤ 20 versions, re-verified on every read). The server is only a courier (D31 unchanged).
import { tr } from '../../shared/i18n'
import { z } from 'zod'
import { latestCard, verifyCardText, type SignedCard } from '../identity/card'
import { createPeerStore, MAX_CARD_BYTES, type PeerStore } from '../peers/store'
import { storePaths } from '../store/paths'
import { CloudError } from './errors'
import { identityFingerprint, type CloudConfirm } from './service'
import { cardAudienceNote, FINGERPRINT_RE, type CardPublished, type CardPublishPreview, type CloudCardStatus, type FriendCardFetched } from './subs-api'
import { confirmOrCancel, createPreviewStore, mapStatus, requireReady, type CloudHandle } from './subs-common'

export interface CloudCardsDeps {
  storeRoot: string
  cloud: CloudHandle
  /** KeyManager.getPublicIdentity (only `public_key` is used; the fingerprint is recomputed). */
  getPublicIdentity: () => { public_key: string } | null
  /** Main-owned native confirm; absent ⇒ publish / unpublish refused. */
  nativeConfirm?: CloudConfirm
  /** Default: the Lens Store Peers list (`<storeRoot>/peers`), same files the Peers page uses. */
  peers?: Pick<PeerStore, 'importText'>
  now?: () => Date
  randomHex?: (bytes: number) => string
}

export interface CloudCardsService {
  status(): Promise<CloudCardStatus>
  publishPreview(): CardPublishPreview
  publish(previewId: string, sender: unknown): Promise<CardPublished>
  unpublish(sender: unknown): Promise<boolean>
  fetchFriend(fingerprint: string): Promise<FriendCardFetched>
}

const PREVIEW_TTL_MS = 15 * 60_000
const Iso = z.string().min(1).max(64).refine((s) => Number.isFinite(Date.parse(s)))
const PutSchema = z.object({
  fingerprint: z.string().regex(FINGERPRINT_RE),
  version: z.number().int().nonnegative(),
  published_at: Iso,
  unchanged: z.boolean()
})
const GetSchema = z.object({
  card: z.string().min(1).max(MAX_CARD_BYTES),
  version: z.number().int().nonnegative(),
  published_at: Iso
})

/** Same bytes `writeCardFile` writes, so the uploaded text equals the local `.navaliacard` file. */
export function cardText(signed: SignedCard): string {
  return `${JSON.stringify(signed, null, 2)}\n`
}

export function createCloudCardsService(deps: CloudCardsDeps): CloudCardsService {
  const now = deps.now ?? (() => new Date())
  const peers = deps.peers ?? createPeerStore({ storeRoot: deps.storeRoot, now })
  const previews = createPreviewStore<{ text: string; cardId: string; fingerprint: string }>({ ttlMs: PREVIEW_TTL_MS, max: 4, now, randomHex: deps.randomHex })
  let busy = false

  function myFingerprint(): string {
    const fp = identityFingerprint(deps.getPublicIdentity)
    if (!fp) throw new CloudError('no_identity')
    return fp
  }

  /** Latest local card that verifies AND is signed by the current identity. */
  function latestOwnCard(fp: string): SignedCard {
    const signed = latestCard(storePaths(deps.storeRoot))
    if (!signed || signed.card.issuer.fingerprint !== fp) throw new CloudError('no_card')
    return signed
  }

  return {
    async status() {
      const fp = myFingerprint()
      requireReady(deps.cloud)
      let res: z.infer<typeof GetSchema>
      try {
        res = await deps.cloud.client.requestJson('GET', `/v1/cards/${fp}`, undefined, GetSchema)
      } catch (e) {
        if (e instanceof CloudError && e.status === 404) return { published: false, version: null, publishedAt: null, cardId: null, verified: false, matchesLatest: false }
        throw e
      }
      const v = verifyCardText(res.card)
      const ok = v.valid && v.card.card.issuer.fingerprint === fp
      let latestId: string | null = null
      try {
        latestId = latestOwnCard(fp).card.card_id
      } catch {
        latestId = null
      }
      const cardId = ok ? v.card.card.card_id : null
      return { published: true, version: res.version, publishedAt: res.published_at, cardId, verified: ok, matchesLatest: cardId !== null && cardId === latestId }
    },

    publishPreview() {
      const fp = myFingerprint()
      const signed = latestOwnCard(fp)
      const text = cardText(signed)
      // Defensive: what we upload must verify with our own verifier.
      const v = verifyCardText(text)
      if (!v.valid || v.card.card.issuer.fingerprint !== fp) throw new CloudError('no_card')
      const front = signed.card.content.front
      const stats = signed.card.content.back.stats
      const { id, expiresAt } = previews.put({ text, cardId: signed.card.card_id, fingerprint: fp })
      return {
        previewId: id,
        fingerprint: fp,
        cardId: signed.card.card_id,
        issuedAt: signed.card.issued_at,
        displayName: front.display_name,
        summary: front.summary,
        highlights: front.highlights.map((h) => h.signature),
        asOf: front.as_of,
        stats: { points: stats.points, faces: stats.faces, volumes: stats.volumes },
        cardText: text,
        bytes: Buffer.byteLength(text, 'utf8'),
        audienceNote: cardAudienceNote(),
        expiresAt
      }
    },

    async publish(previewId, sender) {
      const stored = previews.get(previewId)
      if (!stored) throw new CloudError('not_found')
      const base = requireReady(deps.cloud)
      if (myFingerprint() !== stored.fingerprint) throw new CloudError('no_card')
      if (busy) throw new CloudError('busy')
      busy = true
      try {
        await confirmOrCancel(deps.nativeConfirm, sender, {
          message: tr('Publish your Personal Card to the cloud?', '把个人卡片发布到云端？'),
          detail: tr(
            `Card ${stored.cardId} will be uploaded to ${base}. ${cardAudienceNote()} You can withdraw it at any time.`,
            `卡片 ${stored.cardId} 会上传到 ${base}。${cardAudienceNote()}之后可以随时撤回。`
          ),
          confirmLabel: tr('Publish', '发布')
        })
        previews.delete(previewId)
        let res: z.infer<typeof PutSchema>
        try {
          res = await deps.cloud.client.requestJson('PUT', '/v1/cards', { card: stored.text }, PutSchema)
        } catch (e) {
          mapStatus(e, { 400: 'card_invalid', 403: 'card_not_owner' })
        }
        if (res.fingerprint !== stored.fingerprint) throw new CloudError('bad_response')
        return { fingerprint: res.fingerprint, version: res.version, publishedAt: res.published_at, unchanged: res.unchanged }
      } finally {
        busy = false
      }
    },

    async unpublish(sender) {
      myFingerprint()
      const base = requireReady(deps.cloud)
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Withdraw your card from the cloud?', '从云端撤回你的卡片？'),
        detail: tr(
          `The card on ${base} will be deleted and nobody can fetch it by fingerprint anymore. Copies people already fetched are not affected.`,
          `${base} 上的卡片会被删除，别人无法再按指纹取到。已经取到的人手里的副本不受影响。`
        ),
        confirmLabel: tr('Withdraw', '撤回')
      })
      await deps.cloud.client.requestEmpty('DELETE', '/v1/cards')
      return true
    },

    async fetchFriend(fingerprint) {
      if (!FINGERPRINT_RE.test(fingerprint)) throw new CloudError('invalid_args')
      // Self is refused locally, before any request.
      if (identityFingerprint(deps.getPublicIdentity) === fingerprint) throw new CloudError('self_card')
      requireReady(deps.cloud)
      let res: z.infer<typeof GetSchema>
      try {
        res = await deps.cloud.client.requestJson('GET', `/v1/cards/${fingerprint}`, undefined, GetSchema)
      } catch (e) {
        mapStatus(e, { 404: 'not_found' })
      }
      // Offline verification with Lens's own verifier: the server is never trusted.
      const v = verifyCardText(res.card)
      if (!v.valid) throw new CloudError(v.reason === 'signature' || v.reason === 'fingerprint' ? 'signature_invalid' : 'card_invalid')
      if (v.card.card.issuer.fingerprint !== fingerprint) throw new CloudError('wrong_signer')
      const imported = peers.importText(res.card)
      if (!imported.ok) {
        if (imported.reason === 'self') throw new CloudError('self_card')
        if (imported.reason === 'tampered') throw new CloudError('signature_invalid')
        throw new CloudError('card_invalid')
      }
      return {
        outcome: imported.outcome,
        fingerprint: imported.peer.fingerprint,
        displayName: imported.peer.displayName,
        versions: imported.peer.versions,
        cloudVersion: res.version,
        publishedAt: res.published_at
      }
    }
  }
}
