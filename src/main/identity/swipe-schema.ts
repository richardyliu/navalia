/**
 * Swipe QR payload: identifies a card and its key, carries no card content.
 * Pure (zod only) so the renderer can parse and compare offline.
 */
import { z } from 'zod'
import type { SignedCard } from './card-schema'

export const QrPayloadSchema = z
  .object({
    v: z.literal(1),
    card_id: z.string().regex(/^card_[0-9a-f]{32}$/),
    fp: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict()
export type QrPayload = z.infer<typeof QrPayloadSchema>

/** Fixed key order so the same card always yields the same QR. */
export function qrPayloadText(card: SignedCard): string {
  return JSON.stringify({ v: 1, card_id: card.card.card_id, fp: card.card.issuer.fingerprint })
}

export function parseQrPayload(text: string): QrPayload | null {
  try {
    const r = QrPayloadSchema.safeParse(JSON.parse(text.trim()))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export type QrMatch = 'match' | 'same_key_other_card' | 'different_key' | 'invalid_qr'

/** Compare a verified card with a scanned QR payload: the key fingerprint is what matters. */
export function matchQr(card: SignedCard, qrText: string): QrMatch {
  const qr = parseQrPayload(qrText)
  if (!qr) return 'invalid_qr'
  if (qr.fp !== card.card.issuer.fingerprint) return 'different_key'
  return qr.card_id === card.card.card_id ? 'match' : 'same_key_other_card'
}

export interface SwipeQr {
  payload: string
  svg: string
  version: number
  ecc: string
}
