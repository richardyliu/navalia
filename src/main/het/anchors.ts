import type { SqlDb } from './schema'

/**
 * Anchors: deterministic minutes. The LLM never outputs minutes; it outputs a kind, a
 * size bucket, a complexity level and an adoption level. This module turns those into
 * integer tenths of a minute:
 *
 *   minutes = anchor(kind) × size_units × adoption_weight × complexity_factor
 *   minutes_tenths = round_half_up(minutes × 10)   (integer ⇒ sums are exact)
 *
 * Defaults are DESIGN §5.6; adoption weights DESIGN §5.5. Anchors are versioned in
 * het_anchors: an edit inserts a whole new version; existing rows are immutable (trigger).
 */

export type AnchorKind = 'research' | 'writing' | 'coding' | 'review' | 'ops' | 'meeting'
export const ANCHOR_KINDS: readonly AnchorKind[] = ['research', 'writing', 'coding', 'review', 'ops', 'meeting']

export interface Anchor {
  kind: AnchorKind
  unit: string
  minutes: number
}

export const DEFAULT_ANCHORS: readonly Anchor[] = [
  { kind: 'research', unit: 'per 5 sources/pages', minutes: 20 },
  { kind: 'writing', unit: 'per 500 words', minutes: 30 },
  { kind: 'coding', unit: 'per 200 lines/PR', minutes: 45 },
  { kind: 'review', unit: 'per document/PR', minutes: 20 },
  { kind: 'ops', unit: 'per task', minutes: 10 },
  { kind: 'meeting', unit: 'per minute', minutes: 1 }
]

export type AdoptionLevel = 'confirmed' | 'strong' | 'weak' | 'unknown' | 'rejected'
export const ADOPTION_WEIGHT: Record<AdoptionLevel, number> = {
  confirmed: 1.0,
  strong: 0.85,
  weak: 0.55,
  unknown: 0.3,
  rejected: 0
}

export type SizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl'
/** Size bucket → number of anchor units. */
export const SIZE_UNITS: Record<SizeBucket, number> = { xs: 0.25, s: 0.5, m: 1, l: 2, xl: 4 }

export type Complexity = 'low' | 'medium' | 'high'
export const COMPLEXITY_FACTOR: Record<Complexity, number> = { low: 0.75, medium: 1, high: 1.5 }

export interface MinutesInput {
  anchorMinutes: number
  size: SizeBucket
  complexity: Complexity
  adoption: AdoptionLevel
}

/** Pure, deterministic. Integer tenths of a minute. */
export function minutesTenths(i: MinutesInput): number {
  const raw = i.anchorMinutes * SIZE_UNITS[i.size] * ADOPTION_WEIGHT[i.adoption] * COMPLEXITY_FACTOR[i.complexity] * 10
  // Round half up on a value pre-rounded to 6 decimals to kill binary-float noise
  // (e.g. 0.85 * 45 * 10 = 382.49999999999994).
  return Math.floor(Math.round(raw * 1e6) / 1e6 + 0.5)
}

// ── persistence ─────────────────────────────────────────────────────────────

export function activeAnchorVersion(db: SqlDb): number | null {
  const r = db.prepare("SELECT value FROM het_meta WHERE key = 'active_anchor_version'").get() as
    | { value: string }
    | undefined
  return r ? Number(r.value) : null
}

/** Seed version 1 with defaults if no anchors exist. Idempotent. */
export function ensureDefaultAnchors(db: SqlDb, now: number): number {
  const v = activeAnchorVersion(db)
  if (v !== null) return v
  const ins = db.prepare('INSERT INTO het_anchors (version, kind, unit, minutes, created_ms, author) VALUES (1, ?, ?, ?, ?, ?)')
  for (const a of DEFAULT_ANCHORS) ins.run(a.kind, a.unit, a.minutes, now, 'default')
  db.prepare("INSERT INTO het_meta (key, value) VALUES ('active_anchor_version', '1')").run()
  return 1
}

export function getAnchors(db: SqlDb, version: number): Record<AnchorKind, Anchor> {
  const rows = db.prepare('SELECT kind, unit, minutes FROM het_anchors WHERE version = ?').all(version) as Anchor[]
  const out = {} as Record<AnchorKind, Anchor>
  for (const r of rows) out[r.kind] = { kind: r.kind, unit: r.unit, minutes: r.minutes }
  for (const k of ANCHOR_KINDS) if (!out[k]) throw new Error(`anchor version ${version} missing kind ${k}`)
  return out
}

/**
 * User edit: copies the active version, applies changes, inserts it as version N+1 and
 * makes it active. Old versions are untouched. Existing tasks keep their anchor_version
 * (call `ledger.reanchorAll` to move them explicitly).
 */
export function editAnchors(
  db: SqlDb,
  changes: Partial<Record<AnchorKind, number>>,
  now: number
): number {
  const cur = activeAnchorVersion(db)
  if (cur === null) throw new Error('anchors not initialised')
  for (const [k, m] of Object.entries(changes)) {
    if (!ANCHOR_KINDS.includes(k as AnchorKind)) throw new Error(`unknown anchor kind ${k}`)
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > 10_000) throw new Error(`invalid minutes for ${k}`)
  }
  const base = getAnchors(db, cur)
  const maxRow = db.prepare('SELECT MAX(version) AS v FROM het_anchors').get() as { v: number }
  const next = maxRow.v + 1
  const ins = db.prepare('INSERT INTO het_anchors (version, kind, unit, minutes, created_ms, author) VALUES (?, ?, ?, ?, ?, ?)')
  for (const k of ANCHOR_KINDS) {
    const changed = changes[k] !== undefined
    ins.run(next, k, base[k].unit, changed ? changes[k]! : base[k].minutes, now, changed ? 'user' : 'default')
  }
  db.prepare("UPDATE het_meta SET value = ? WHERE key = 'active_anchor_version'").run(String(next))
  db.prepare("INSERT INTO het_events (task_id, at_ms, kind, actor, payload) VALUES ('*', ?, 'anchors_edited', 'user', ?)").run(
    now,
    JSON.stringify({ from: cur, to: next, changes })
  )
  return next
}
