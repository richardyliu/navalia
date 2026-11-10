// S1-R3-SEC L6: secrets known at runtime that must be scrubbed verbatim before any text is written
// to memory (ask save-answer, lens:mcp:remember). Never leaves main.
import { runtimeSecretValues } from '../backup/service'
import { REDACTED } from '../import/redact'
import { readLocalToken } from '../runtime/token'

/** The Runtime local token plus every `*_TOKEN / *_KEY / *_SECRET / *PASSW*` value in `<root>/env`. */
export function knownRuntimeSecrets(root: string): string[] {
  const out = new Set<string>(runtimeSecretValues(root))
  try {
    out.add(readLocalToken(root))
  } catch {
    /* no token: nothing to add */
  }
  return [...out]
}

/** Verbatim replacement of known secret values (longest first, ≥ 8 chars). Returns the count replaced. */
export function scrubKnownSecrets(text: string, secrets: readonly unknown[]): { text: string; count: number } {
  let body = text
  let count = 0
  const list = [...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8))].sort((a, b) => b.length - a.length)
  for (const s of list) {
    if (!body.includes(s)) continue
    const parts = body.split(s)
    count += parts.length - 1
    body = parts.join(REDACTED)
  }
  return { text: body, count }
}
