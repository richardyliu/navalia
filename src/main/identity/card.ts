import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, verify as cryptoVerify } from 'node:crypto'
import { readFileIfExists, writeFileSecure, type StorePaths } from '../store/paths'
import { canonicalBytes } from './canonical'
import type { VerifyFailure } from './api'
import { CARD_FILE_EXT, CARD_FORMAT, LEGACY_CARD_FILE_EXT, PREV_CARD_FILE_EXT, CardSchema, SignedCardSchema, type Card, type SignedCard } from './card-schema'
import { fingerprintOf, publicKeyFromRaw, type KeyManager } from './keys'

export { CARD_FILE_EXT, CARD_FORMAT, CardSchema, SignedCardSchema, type Card, type SignedCard, type VerifyFailure }
export type VerifyResult = { valid: true; card: SignedCard } | { valid: false; reason: VerifyFailure; detail: string }

export function newCardId(): string {
  return `card_${randomBytes(16).toString('hex')}`
}

export function signCard(card: Card, keys: KeyManager): SignedCard {
  const parsed = CardSchema.parse(card)
  const identity = keys.getPublicIdentity()
  if (!identity) throw new Error('no identity keypair')
  if (parsed.issuer.public_key !== identity.public_key || parsed.issuer.fingerprint !== identity.fingerprint) {
    throw new Error('card issuer does not match the local identity')
  }
  const signature = keys.sign(canonicalBytes(parsed))
  return SignedCardSchema.parse({
    card: parsed,
    signature: { alg: 'Ed25519', key_fingerprint: identity.fingerprint, value: signature.toString('base64url') }
  })
}

/**
 * Offline verification using only the card itself.
 * The signature is checked over the canonical form of the card exactly as parsed from
 * the file (not over a re-serialized schema output), so what is displayed is what is verified.
 */
export function verifySignedCard(input: unknown): VerifyResult {
  const parsed = SignedCardSchema.safeParse(input)
  if (!parsed.success) {
    return { valid: false, reason: 'schema', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  }
  const { card, signature } = parsed.data
  const rawPub = Buffer.from(card.issuer.public_key, 'base64url')
  const fingerprint = fingerprintOf(rawPub)
  if (fingerprint !== card.issuer.fingerprint || fingerprint !== signature.key_fingerprint) {
    return { valid: false, reason: 'fingerprint', detail: 'public key fingerprint does not match' }
  }
  const rawCard = (input as { card: unknown }).card
  let ok = false
  try {
    ok = cryptoVerify(null, canonicalBytes(rawCard), publicKeyFromRaw(rawPub), Buffer.from(signature.value, 'base64url'))
  } catch (error) {
    return { valid: false, reason: 'signature', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!ok) return { valid: false, reason: 'signature', detail: 'Ed25519 signature does not verify' }
  return { valid: true, card: parsed.data }
}

export function verifyCardText(text: string): VerifyResult {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    return { valid: false, reason: 'parse', detail: error instanceof Error ? error.message : String(error) }
  }
  return verifySignedCard(input)
}

export function cardFilePath(paths: StorePaths, cardId: string): string {
  if (!/^card_[0-9a-f]{32}$/.test(cardId)) throw new Error('invalid card id')
  return path.join(paths.cardsDir, `${cardId}${CARD_FILE_EXT}`)
}

export function writeCardFile(paths: StorePaths, signed: SignedCard): string {
  const file = cardFilePath(paths, signed.card.card_id)
  writeFileSecure(file, `${JSON.stringify(signed, null, 2)}\n`)
  return file
}

export function readCardFile(file: string): VerifyResult {
  const raw = readFileIfExists(file)
  if (!raw) return { valid: false, reason: 'parse', detail: 'card file not found' }
  return verifyCardText(raw.toString('utf8'))
}

/** Most recently issued card in the store that still verifies, or null. */
export function latestCard(paths: StorePaths): SignedCard | null {
  let names: string[]
  try {
    names = fs.readdirSync(paths.cardsDir).filter((n) => n.endsWith(CARD_FILE_EXT) || n.endsWith(PREV_CARD_FILE_EXT) || n.endsWith(LEGACY_CARD_FILE_EXT))
  } catch {
    return null
  }
  let best: SignedCard | null = null
  for (const name of names) {
    const result = readCardFile(path.join(paths.cardsDir, name))
    if (!result.valid) continue
    if (!best || Date.parse(result.card.card.issued_at) > Date.parse(best.card.issued_at)) best = result.card
  }
  return best
}
