// S2-03 view-model helpers for the 「问」page (pure; tested without a DOM). Owned by onboard-ask.
import { toolMeta } from '../../../../main/broker/catalog'
import type { Scope } from '../../../../main/identity/grants-schema'
import type { AskPrompt } from './prompts'

/** Lens-extension scopes a scoped grant needs for this card (full access needs none). */
export function requiredScopes(card: AskPrompt): Scope[] {
  const out: Scope[] = []
  for (const tool of card.tools) {
    const meta = toolMeta(tool)
    // Each OSS read tool maps to exactly one scope in the catalog; take the first.
    const scope = meta?.scopes[0]
    if (scope && !out.includes(scope)) out.push(scope)
  }
  return out
}
