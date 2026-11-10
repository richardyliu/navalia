import type { ModelGraphResponse } from '../../shared/types'
import type { RuntimeClient } from '../runtime/client'
import { ensureStore, type StorePaths } from '../store/paths'
import { readSettings } from '../store/settings'
import { CARD_FORMAT, latestCard, newCardId, signCard, verifyCardText, writeCardFile, type Card } from './card'
import { buildCardContent } from './card-content'
import type { KeyManager } from './keys'
import type { SecretBox } from './secret-box'
import type { CardVerifyView, IdentityStatus, IssuedCard, IssuerStatus, ResetOutcome } from './api'

export interface IdentityDeps {
  paths: StorePaths
  keys: KeyManager
  box: SecretBox
  /** Runtime `/model/share-card` (scrubbed): the only source of card text. Main-process only. */
  getShareCard: () => Promise<unknown>
  /** Runtime `/model/graph`: structure (Mini Map edges) and build status only. Failure is tolerated. */
  getGraph: () => Promise<ModelGraphResponse>
  /**
   * Native confirmation owned by main (security review #9): Electron `dialog.showMessageBox`
   * with Cancel as default. Reset happens only when this resolves true.
   */
  confirmReset: () => Promise<boolean>
  /**
   * Runtime owner-alias review (REST, main-process only). Absent → the IPC channels fail closed.
   * `confirmDecision` is the user gesture: a main-owned native dialog parented to `sender`'s window,
   * Cancel by default. Nothing is posted unless it resolves true.
   */
  ownerAliases?: OwnerAliasDeps
  now?: () => Date
}

export interface OwnerAliasDeps {
  client: () => Pick<RuntimeClient, 'ownerAliases' | 'confirmOwnerAlias' | 'rejectOwnerAlias'>
  confirmDecision: (decision: 'confirm' | 'reject', alias: string, sender: unknown) => Promise<boolean>
}

export interface IdentityService {
  status(): IdentityStatus
  init(): IdentityStatus
  createCard(): Promise<IssuedCard>
  latest(): IssuedCard | null
  verify(text: string): CardVerifyView
  reset(): Promise<ResetOutcome>
  issuerOf(fingerprint: string): IssuerStatus
}

export function createIdentityService(deps: IdentityDeps): IdentityService {
  const now = deps.now ?? (() => new Date())

  function issuerOf(fingerprint: string): IssuerStatus {
    if (deps.keys.getPublicIdentity()?.fingerprint === fingerprint) return 'current'
    if (deps.keys.previousIdentities().some((p) => p.fingerprint === fingerprint)) return 'previous'
    return 'foreign'
  }

  function status(): IdentityStatus {
    const identity = deps.keys.getPublicIdentity()
    return {
      storeRoot: deps.paths.root,
      encryptionAvailable: deps.box.isAvailable(),
      identity: identity
        ? {
            alg: identity.alg,
            publicKey: identity.public_key,
            fingerprint: identity.fingerprint,
            createdAt: identity.created_at,
            keyBackend: identity.key_backend
          }
        : null,
      previous: deps.keys
        .previousIdentities()
        .map((p) => ({ fingerprint: p.fingerprint, createdAt: p.created_at, retiredAt: p.retired_at }))
    }
  }

  return {
    status,

    init() {
      ensureStore(deps.paths)
      deps.keys.ensureIdentity()
      return status()
    },

    async createCard() {
      ensureStore(deps.paths)
      const identity = deps.keys.ensureIdentity()
      const settings = readSettings(deps.paths)
      const share = await deps.getShareCard()
      const graph = await deps.getGraph().catch(() => null)
      const card: Card = {
        format: CARD_FORMAT,
        version: 1,
        card_id: newCardId(),
        issued_at: now().toISOString(),
        issuer: { alg: 'Ed25519', public_key: identity.public_key, fingerprint: identity.fingerprint },
        content: buildCardContent({ share, graph }, { displayName: settings.displayName })
      }
      const signed = signCard(card, deps.keys)
      const file = writeCardFile(deps.paths, signed)
      return { signed, file, issuer: 'current' }
    },

    latest() {
      const signed = latestCard(deps.paths)
      return signed ? { signed, file: null, issuer: issuerOf(signed.card.issuer.fingerprint) } : null
    },

    verify(text) {
      const result = verifyCardText(text)
      if (result.valid) return { valid: true, card: result.card, issuer: issuerOf(result.card.card.issuer.fingerprint) }
      return { valid: false, reason: result.reason, detail: result.detail }
    },

    async reset() {
      if (!(await deps.confirmReset())) return { reset: false, status: status() }
      deps.keys.resetIdentity()
      return { reset: true, status: status() }
    },

    issuerOf
  }
}
