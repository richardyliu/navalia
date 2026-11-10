import { scrubText, type Redactor } from '../identity/redact'

/** Recursively scrub every string (values and keys) in a JSON-like value. */
export function deepScrub(value: unknown, redact: Redactor = scrubText, depth = 0): unknown {
  if (depth > 40) return '[truncated]'
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, redact, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[redact(k)] = deepScrub(v, redact, depth + 1)
    return out
  }
  return value
}

/** Opaque handle: urlsafe-base64 / id charset only (no '/', '@', ':', '.', spaces → no path, email or URL). */
export const OPAQUE_VALUE_RE = /^[A-Za-z0-9_-]{1,1024}$/

/**
 * deepScrub, except values under `opaqueKeys` that match `opaqueRe` pass verbatim. Keys are scrubbed
 * too. Anything else under those keys (e.g. a value with '@' or '/') is scrubbed as usual.
 */
export function scrubKeepingOpaque(value: unknown, opaqueKeys: ReadonlySet<string>, opaqueRe: RegExp = OPAQUE_VALUE_RE, depth = 0): unknown {
  if (depth > 40) return '[truncated]'
  if (Array.isArray(value)) return value.map((v) => scrubKeepingOpaque(v, opaqueKeys, opaqueRe, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const opaque = opaqueKeys.has(k) && typeof v === 'string' && opaqueRe.test(v)
      out[deepScrub(k) as string] = opaque ? v : scrubKeepingOpaque(v, opaqueKeys, opaqueRe, depth + 1)
    }
    return out
  }
  return deepScrub(value)
}
