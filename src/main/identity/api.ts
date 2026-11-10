/**
 * Renderer-facing API fragment for the Identity Plane (merged into src/shared/api.ts via `extends`).
 * Everything here is public data: no private key, ciphertext, token, or token hash ever appears.
 */
import type { LensResult } from '../../shared/types'
import type { SignedCard } from './card-schema'
import type { GrantView, IssuedGrant, NewGrantInput } from './grants-schema'
import type { SwipeQr } from './swipe-schema'
import type { OwnerAliasDecision, OwnerAliasList, OwnerAliasListStatus } from '../runtime/owner-aliases'

export type VerifyFailure = 'parse' | 'schema' | 'fingerprint' | 'signature'

/** Which local key signed a card: the current one, one retired by "Reset identity", or neither. */
export type IssuerStatus = 'current' | 'previous' | 'foreign'

export interface PublicIdentityView {
  alg: 'Ed25519'
  /** Raw 32-byte public key, base64url. */
  publicKey: string
  /** Lowercase hex SHA-256 of the raw public key. */
  fingerprint: string
  createdAt: string
  keyBackend: string
}

export interface RetiredIdentityView {
  fingerprint: string
  createdAt: string
  retiredAt: string
}

export interface IdentityStatus {
  storeRoot: string
  encryptionAvailable: boolean
  /** Null until the user creates a card (local "claim", DEVIATIONS D3). */
  identity: PublicIdentityView | null
  previous: RetiredIdentityView[]
}

export interface ResetOutcome {
  /** False when the user chose Cancel in the native dialog. */
  reset: boolean
  status: IdentityStatus
}

export interface IssuedCard {
  signed: SignedCard
  issuer: IssuerStatus
  /** Absolute path of the written `.navaliacard`, when known. */
  file: string | null
}

export type CardVerifyView =
  | { valid: true; card: SignedCard; issuer: IssuerStatus }
  | { valid: false; reason: VerifyFailure; detail: string }

/** Second check only: the real confirmation is a native dialog shown by main. */
export const RESET_CONFIRM = 'RESET_IDENTITY' as const

export interface SwipeApi {
  swipe: {
    /** QR for the latest card: payload `{v:1, card_id, fp}` + SVG. Null when no card exists. */
    qr(): Promise<LensResult<SwipeQr | null>>
    /** Save dialog lives in main; returns the chosen path or null if cancelled. */
    exportFile(kind: 'card' | 'qr'): Promise<LensResult<{ saved: string | null }>>
    exportPng(rect: { x: number; y: number; width: number; height: number }): Promise<LensResult<{ saved: string | null }>>
    /** Open dialog in main, then offline verification of someone else's `.navaliacard`. */
    importFile(): Promise<LensResult<(CardVerifyView & { file: string }) | null>>
  }
}

export interface IdentityApi {
  identity: {
    status(): Promise<LensResult<IdentityStatus>>
    init(): Promise<LensResult<IdentityStatus>>
    reset(confirm: typeof RESET_CONFIRM): Promise<LensResult<ResetOutcome>>
  }
  card: {
    create(): Promise<LensResult<IssuedCard>>
    latest(): Promise<LensResult<IssuedCard | null>>
    verify(text: string): Promise<LensResult<CardVerifyView>>
  }
  /**
   * Runtime 2026-11-05.3 owner-alias review (REST `/owner-aliases*`, proxied by main). Only the user
   * decides: confirm / reject require the alias to be listed by the Runtime and not already in the target
   * state, then open a main-owned native dialog; Cancel → `decided: false`.
   */
  ownerAliases: {
    list(status?: OwnerAliasListStatus): Promise<LensResult<OwnerAliasList>>
    confirm(alias: string): Promise<LensResult<OwnerAliasDecision>>
    reject(alias: string): Promise<LensResult<OwnerAliasDecision>>
  }
}

export const IDENTITY_CHANNELS = {
  status: 'lens:identity:status',
  init: 'lens:identity:init',
  reset: 'lens:identity:reset',
  cardCreate: 'lens:card:create',
  cardLatest: 'lens:card:latest',
  cardVerify: 'lens:card:verify',
  ownerAliasesList: 'lens:owner-aliases:list',
  ownerAliasesConfirm: 'lens:owner-aliases:confirm',
  ownerAliasesReject: 'lens:owner-aliases:reject'
} as const

export type { SignedCard, GrantView, IssuedGrant, NewGrantInput, OwnerAliasDecision, OwnerAliasList, OwnerAliasListStatus }
