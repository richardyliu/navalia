import { z } from 'zod'

/**
 * Convert the JSON Schema subset the OSS runtime emits (pydantic: type, properties, required,
 * anyOf-with-null, items, enum, min/max, min/maxLength, maxItems, default) into zod, so the
 * Broker validates arguments before anything reaches the runtime. Unknown properties are
 * rejected at the top level (no smuggled arguments). Unsupported constructs fall back to
 * z.unknown() for that property only.
 */
type Json = Record<string, unknown>

function convert(s: Json): z.ZodTypeAny {
  if (Array.isArray(s.anyOf)) {
    const parts = (s.anyOf as Json[]).map(convert)
    return parts.length === 1 ? parts[0] : z.union(parts as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  if (Array.isArray(s.enum)) {
    const lits = (s.enum as Array<string | number | boolean | null>).map((v) => z.literal(v))
    if (lits.length === 0) return z.never()
    return lits.length === 1 ? lits[0] : z.union(lits as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  switch (s.type) {
    case 'string': {
      let t = z.string()
      if (typeof s.minLength === 'number') t = t.min(s.minLength)
      if (typeof s.maxLength === 'number') t = t.max(s.maxLength)
      return t
    }
    case 'integer':
    case 'number': {
      let t = s.type === 'integer' ? z.number().int() : z.number()
      if (typeof s.minimum === 'number') t = t.min(s.minimum)
      if (typeof s.maximum === 'number') t = t.max(s.maximum)
      return t
    }
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array': {
      let t = z.array(s.items ? convert(s.items as Json) : z.unknown())
      if (typeof s.maxItems === 'number') t = t.max(s.maxItems)
      return t
    }
    case 'object':
      return objectSchema(s, false)
    default:
      return z.unknown()
  }
}

function objectSchema(s: Json, strict: boolean): z.ZodTypeAny {
  const props = (s.properties ?? {}) as Record<string, Json>
  const required = new Set((s.required as string[] | undefined) ?? [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [k, v] of Object.entries(props)) shape[k] = required.has(k) ? convert(v) : convert(v).optional()
  const o = z.object(shape)
  return strict ? o.strict() : o.passthrough()
}

export function argsSchema(inputSchema: Json): z.ZodTypeAny {
  return objectSchema(inputSchema, true)
}
