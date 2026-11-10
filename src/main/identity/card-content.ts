import { z } from 'zod'
import type { ModelGraphResponse } from '../../shared/types'
import { scrubText, type Redactor } from './redact'
import { CardContentSchema, MAX_HIGHLIGHTS, MAX_LABEL_CHARS, MAX_MAP_FACES, MAX_MAP_VOLUMES, type CardContent } from './card-schema'

export { CardContentSchema, MAX_HIGHLIGHTS, MAX_LABEL_CHARS, MAX_MAP_FACES, MAX_MAP_VOLUMES, type CardContent }

export interface BuildCardContentOptions {
  displayName?: string | null
  redact?: Redactor
}

/**
 * `/model/share-card`: the runtime's server-side scrubbed projection (routes.py `_share_card_projection`).
 * Lenient on extra fields so a newer runtime does not break card creation.
 */
const ShareItemSchema = z.object({
  signature: z.string(),
  observations: z.number(),
  confidence: z.number()
})
export const ShareCardSchema = z.object({
  generated_at: z.string(),
  model: z.object({
    root: ShareItemSchema.nullable(),
    faces: z.array(ShareItemSchema),
    volumes: z.array(ShareItemSchema),
    stats: z.object({
      points: z.number(),
      evolution_lines: z.number(),
      relation_lines: z.number(),
      faces: z.number(),
      volumes: z.number(),
      roots: z.number()
    })
  })
})
type ShareItem = z.infer<typeof ShareItemSchema>

export interface CardSources {
  /** Required. All card text comes from here (then through the Lens scrubber as well). */
  share: unknown
  /** Optional. Used only for structure (members / parent_id) and build status, never for text. */
  graph: ModelGraphResponse | null
}

interface Structure {
  id: string | null
  parentId: string | null
  members: string[]
}

type Weighted = { observations?: unknown; confidence?: unknown }

function clamp01(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.min(1, Math.max(0, n))
}

function count(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0
  return Math.max(0, n)
}

function label(raw: unknown, redact: Redactor): string | null {
  if (typeof raw !== 'string') return null
  const text = redact(raw).replace(/\s+/g, ' ').trim()
  if (!text) return null
  // Truncate by code point so a surrogate pair is never split (canonical JSON rejects lone surrogates).
  const chars = Array.from(text)
  return chars.length > MAX_LABEL_CHARS ? `${chars.slice(0, MAX_LABEL_CHARS - 1).join('')}…` : text
}

function structureOf(item: unknown): Structure {
  const o = (item ?? {}) as { id?: unknown; parent_id?: unknown; members?: unknown }
  return {
    id: typeof o.id === 'string' && o.id ? o.id : null,
    parentId: typeof o.parent_id === 'string' && o.parent_id ? o.parent_id : null,
    members: Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string') : []
  }
}

/**
 * The runtime builds share-card from the same cached graph and keeps item order, dropping only
 * items whose scrubbed signature is empty. Structure is attached only when the two lists line up
 * exactly (same length, same observations/confidence at every index); otherwise none is attached.
 */
function align(share: ShareItem[], graph: unknown[] | undefined): Array<Structure | null> {
  if (!graph || graph.length !== share.length) return share.map(() => null)
  const same = share.every((s, i) => {
    const g = (graph[i] ?? {}) as Weighted
    return count(g.observations) === count(s.observations) && clamp01(g.confidence) === clamp01(s.confidence)
  })
  return same ? graph.map(structureOf) : share.map(() => null)
}

function byWeight(a: Weighted, b: Weighted): number {
  return count(b.observations) - count(a.observations) || clamp01(b.confidence) - clamp01(a.confidence)
}

/** Normalize to UTC ISO-8601 with millisecond precision; throws if neither input is a date. */
function toIso(...candidates: Array<string | null | undefined>): string {
  for (const value of candidates) {
    if (!value) continue
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return new Date(ms).toISOString()
  }
  throw new Error('model snapshot has no valid generated_at')
}

/**
 * Pure projection of `/model/share-card` (+ optional `/model/graph` structure) into Card content.
 * Exports only summaries, counts and structure: no points, quotes, receipts, ids or paths.
 */
export function buildCardContent(sources: CardSources, options: BuildCardContentOptions = {}): CardContent {
  const redact = options.redact ?? scrubText
  const share = ShareCardSchema.parse(sources.share)
  const graph = sources.graph
  const asOf = toIso(share.generated_at, graph?.model?.generated_at, graph?.generated_at)

  type Item = { share: ShareItem; label: string; structure: Structure | null }
  function items(list: ShareItem[], graphList: unknown[] | undefined): Item[] {
    const structures = align(list, graphList)
    const out: Item[] = []
    list.forEach((s, i) => {
      const text = label(s.signature, redact)
      if (text) out.push({ share: s, label: text, structure: structures[i] })
    })
    return out.sort((a, b) => byWeight(a.share, b.share))
  }

  const rootShare = share.model.root
  const rootLabel = rootShare ? label(rootShare.signature, redact) : null
  const rootStructure =
    rootShare && rootLabel ? (align([rootShare], graph?.model?.root ? [graph.model.root] : undefined)[0] ?? null) : null
  const volumes = items(share.model.volumes, graph?.model?.volumes)
  const faces = items(share.model.faces, graph?.model?.faces)

  const highlights = [
    ...volumes.map((item) => ({ level: 'volume' as const, item })),
    ...faces.map((item) => ({ level: 'face' as const, item }))
  ]
    .sort((a, b) => byWeight(a.item.share, b.item.share))
    .slice(0, MAX_HIGHLIGHTS)
    .map(({ level, item }) => ({
      level,
      signature: item.label,
      observations: count(item.share.observations),
      confidence: clamp01(item.share.confidence)
    }))

  const nodes: CardContent['back']['mini_map']['nodes'] = []
  const keyByRuntimeId = new Map<string, string>()
  const placed: Array<{ key: string; structure: Structure | null }> = []

  function addNode(key: string, level: 'root' | 'volume' | 'face', item: Item): void {
    nodes.push({
      key,
      level,
      label: item.label,
      observations: count(item.share.observations),
      confidence: clamp01(item.share.confidence),
      member_count: item.structure ? item.structure.members.length : 0
    })
    if (item.structure?.id) keyByRuntimeId.set(item.structure.id, key)
    placed.push({ key, structure: item.structure })
  }

  if (rootShare && rootLabel) addNode('r0', 'root', { share: rootShare, label: rootLabel, structure: rootStructure })
  volumes.slice(0, MAX_MAP_VOLUMES).forEach((item, i) => addNode(`v${i}`, 'volume', item))
  faces.slice(0, MAX_MAP_FACES).forEach((item, i) => addNode(`f${i}`, 'face', item))

  // Edges only from structure the runtime actually reports (members / parent_id); none are invented.
  const edgeSet = new Set<string>()
  const edges: CardContent['back']['mini_map']['edges'] = []
  function addEdge(from: string | undefined, to: string | undefined): void {
    if (!from || !to || from === to) return
    const id = `${from}>${to}`
    if (edgeSet.has(id)) return
    edgeSet.add(id)
    edges.push({ from, to })
  }
  for (const { key, structure } of placed) {
    if (!structure) continue
    for (const member of structure.members) addEdge(key, keyByRuntimeId.get(member))
    if (structure.parentId) addEdge(keyByRuntimeId.get(structure.parentId), key)
  }

  const stats = share.model.stats
  const build = graph?.model?.build
  const degraded =
    (Array.isArray(build?.degraded_stages) && build.degraded_stages.length > 0) || Boolean(graph?.index_health)

  return CardContentSchema.parse({
    front: {
      display_name: options.displayName ?? null,
      summary: rootLabel,
      summary_confidence: rootShare && rootLabel ? clamp01(rootShare.confidence) : null,
      summary_observations: rootShare && rootLabel ? count(rootShare.observations) : null,
      highlights,
      as_of: asOf,
      model_status: (typeof build?.status === 'string' && build.status.slice(0, 32)) || 'unknown',
      degraded
    },
    back: {
      mini_map: { nodes, edges },
      stats: {
        points: count(stats.points),
        evolution_lines: count(stats.evolution_lines),
        relation_lines: count(stats.relation_lines),
        faces: count(stats.faces),
        volumes: count(stats.volumes),
        roots: count(stats.roots)
      }
    }
  })
}
