/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * - Numbers: ECMAScript Number-to-String (RFC 8785 §3.2.2.3); NaN/Infinity rejected.
 * - Strings: RFC 8785 §3.2.2.2 escaping; lone surrogates rejected (I-JSON, RFC 7493).
 * - Object keys: sorted by UTF-16 code units (§3.2.3), no whitespace anywhere.
 * - Only JSON data is accepted: undefined, functions, symbols, bigint, and non-plain
 *   objects (Date, Map, class instances) throw instead of being silently coerced.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

const SHORT_ESCAPES: Record<number, string> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\'
}

export function canonicalizeString(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    const short = SHORT_ESCAPES[unit]
    if (short !== undefined) {
      out += short
    } else if (unit < 0x20) {
      out += `\\u${unit.toString(16).padStart(4, '0')}`
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError(`lone high surrogate at index ${i}`)
      }
      out += value[i] + value[i + 1]
      i++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalJsonError(`lone low surrogate at index ${i}`)
    } else {
      out += value[i]
    }
  }
  return `${out}"`
}

export function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number: ${value}`)
  // ECMAScript Number::toString is exactly the RFC 8785 serialization; -0 becomes "0".
  return Object.is(value, -0) ? '0' : String(value)
}

/** UTF-16 code unit comparison, as required by RFC 8785 §3.2.3. */
function compareUtf16(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i)
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return canonicalizeNumber(value)
    case 'string':
      return canonicalizeString(value)
    case 'object':
      break
    default:
      throw new CanonicalJsonError(`unsupported JSON value of type ${typeof value}`)
  }

  const obj = value as object
  if (stack.has(obj)) throw new CanonicalJsonError('cyclic structure')
  stack.add(obj)
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = []
      for (let i = 0; i < obj.length; i++) parts.push(serialize(obj[i], stack))
      return `[${parts.join(',')}]`
    }
    if (!isPlainObject(obj)) throw new CanonicalJsonError('only plain objects can be canonicalized')
    const keys = Object.keys(obj).sort(compareUtf16)
    const parts: string[] = []
    for (const key of keys) {
      parts.push(`${canonicalizeString(key)}:${serialize(obj[key], stack)}`)
    }
    return `{${parts.join(',')}}`
  } finally {
    stack.delete(obj)
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value, new Set())
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8')
}
