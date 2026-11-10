import fs from 'node:fs'
import { CARD_FORMAT, newCardId, signCard } from '../../src/main/identity/card'
import { buildCardContent } from '../../src/main/identity/card-content'
import { createKeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { sources } from './fixtures'
import { createTestBox, tempRoot } from './helpers'

export function createIssuedCard() {
  const root = tempRoot('issued')
  const keys = createKeyManager(storePaths(root), createTestBox())
  const id = keys.ensureIdentity()
  const signed = signCard(
    {
      format: CARD_FORMAT,
      version: 1,
      card_id: newCardId(),
      issued_at: new Date().toISOString(),
      issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint },
      content: buildCardContent(sources())
    },
    keys
  )
  return { signed, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}
