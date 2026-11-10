/**
 * Card wire format (zod only, no Node imports) so the renderer can share these types.
 */
import { z } from 'zod'

export const MAX_LABEL_CHARS = 280
/** Schema bound in UTF-16 units: labels are cut by code point, so astral chars may use 2 units each. */
export const MAX_LABEL_UNITS = MAX_LABEL_CHARS * 2
export const MAX_HIGHLIGHTS = 5
export const MAX_MAP_VOLUMES = 12
export const MAX_MAP_FACES = 48

const Unit = z.number().min(0).max(1)
const Count = z.number().int().min(0)
const Iso = z.string().datetime({ offset: true })

const SummaryItem = z
  .object({
    level: z.enum(['volume', 'face']),
    signature: z.string().min(1).max(MAX_LABEL_UNITS),
    observations: Count,
    confidence: Unit
  })
  .strict()

const MapNode = z
  .object({
    /** Card-local key (r0, v3, f12). Runtime ids are identifiers and are not exported. */
    key: z.string().regex(/^[rvf]\d{1,3}$/),
    level: z.enum(['root', 'volume', 'face']),
    label: z.string().min(1).max(MAX_LABEL_UNITS),
    observations: Count,
    confidence: Unit,
    /** Number of runtime members (points for a face, faces for a volume, volumes for the root). */
    member_count: Count
  })
  .strict()

const MapEdge = z
  .object({
    from: z.string().regex(/^[rvf]\d{1,3}$/),
    to: z.string().regex(/^[rvf]\d{1,3}$/)
  })
  .strict()

export const ModelStatsSchema = z
  .object({
    points: Count,
    evolution_lines: Count,
    relation_lines: Count,
    faces: Count,
    volumes: Count,
    roots: Count
  })
  .strict()

export const CardContentSchema = z
  .object({
    front: z
      .object({
        display_name: z.string().min(1).max(80).nullable(),
        /** Root signature: the identity summary. Null when the model has no Root yet. */
        summary: z.string().min(1).max(MAX_LABEL_UNITS).nullable(),
        summary_confidence: Unit.nullable(),
        summary_observations: Count.nullable(),
        highlights: z.array(SummaryItem).max(MAX_HIGHLIGHTS),
        /** When the runtime produced the model snapshot ("as of"). */
        as_of: Iso,
        model_status: z.string().min(1).max(32),
        /** True when the build reported degraded stages or the index is unhealthy. */
        degraded: z.boolean()
      })
      .strict(),
    back: z
      .object({
        mini_map: z
          .object({
            nodes: z.array(MapNode).max(1 + MAX_MAP_VOLUMES + MAX_MAP_FACES),
            edges: z.array(MapEdge).max(4096)
          })
          .strict(),
        stats: ModelStatsSchema
      })
      .strict()
  })
  .strict()

export type CardContent = z.infer<typeof CardContentSchema>

export const CARD_FORMAT = 'navalia.card'
export const CARD_FILE_EXT = '.navaliacard'
/** Previous name (Grapple). Still accepted on read so older cards verify and import. */
export const PREV_CARD_FORMAT = 'grapple.card'
export const PREV_CARD_FILE_EXT = '.grapplecard'
/** Pre-rename (Persome Lens) names. Still accepted on read so older cards verify and import. */
export const LEGACY_CARD_FORMAT = 'persome-lens.card'
export const LEGACY_CARD_FILE_EXT = '.persomecard'

const B64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * The signed payload. Self-contained: it carries its own public key, so a verifier
 * needs only the file. This proves integrity and key continuity, not who the holder
 * is (no account, see DEVIATIONS D3).
 */
export const CardSchema = z
  .object({
    format: z.union([z.literal(CARD_FORMAT), z.literal(PREV_CARD_FORMAT), z.literal(LEGACY_CARD_FORMAT)]),
    version: z.literal(1),
    card_id: z.string().regex(/^card_[0-9a-f]{32}$/),
    issued_at: z.string().datetime({ offset: true }),
    issuer: z
      .object({
        alg: z.literal('Ed25519'),
        public_key: B64Url32,
        fingerprint: Hex64
      })
      .strict(),
    content: CardContentSchema
  })
  .strict()

export const SignedCardSchema = z
  .object({
    card: CardSchema,
    signature: z
      .object({
        alg: z.literal('Ed25519'),
        key_fingerprint: Hex64,
        /** base64url Ed25519 signature over RFC 8785 canonical JSON of `card`. */
        value: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
      })
      .strict()
  })
  .strict()

export type Card = z.infer<typeof CardSchema>
export type SignedCard = z.infer<typeof SignedCardSchema>

