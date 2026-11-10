// Pure aggregation for the S1-08 Library page. No I/O: inputs are the Runtime `/model/graph`
// snapshot and the `behavior_patterns` MCP payload; output is the three-column view model.
import { tr } from '../../shared/i18n'
import type { BehaviorPatterns, ModelGraphResponse, Point } from '../../shared/types'
import type { WorkflowCatalog } from '../workflows/api'
import type {
  LibraryColumn,
  LibraryEntity,
  LibraryEntityGraph,
  LibraryOverview,
  LibraryPortrait,
  LibraryPortraitItem,
  LibraryRelationRef,
  LibrarySectionError
} from './api'
import { aggregateSkills } from './skills'

/** personal-model `model/entity_source.py::_ENTITY_PREFIXES` (Runtime's own file-name convention). */
const FILE_PREFIXES: Array<[string, string]> = [
  ['person-', 'person'],
  ['org-', 'org'],
  ['project-', 'project']
]

/** Same fold as personal-model `evomem/identity.py::norm` (NFKC + whitespace fold + casefold). */
export function normName(name: string): string {
  return (name ?? '').normalize('NFKC').trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase()
}

/**
 * Port of personal-model `evomem/person_graph.py::_slug` — how the Runtime names `person-<slug>.md`
 * files. Used to match a relation endpoint (canonical identity) to its entity file.
 */
export function slugName(name: string): string {
  const out: string[] = []
  for (const ch of (name ?? '').normalize('NFKC').trim()) {
    if (/[\p{L}\p{N}]/u.test(ch)) out.push(ch.toLowerCase())
    else if (out.length && out[out.length - 1] !== '-') out.push('-')
  }
  const slug = out.join('').replace(/^-+|-+$/g, '')
  return slug || 'unknown'
}

export function columnForKind(kind: string | null | undefined): LibraryColumn {
  if (kind === 'person') return 'person'
  if (kind === 'project') return 'project'
  return 'unclassified'
}

/** `person-mira.md` → { name: 'mira', kind: 'person' }; non-entity files → null. */
export function entityFromFileName(fileName: string): { name: string; kind: string } | null {
  const stem = String(fileName ?? '').replace(/\.md$/, '')
  for (const [prefix, kind] of FILE_PREFIXES) {
    if (stem.startsWith(prefix)) {
      const name = stem.slice(prefix.length).trim()
      return name ? { name, kind } : null
    }
  }
  return null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  return tb > ta ? b : a
}

interface Draft {
  entity: LibraryEntity
  kinds: Set<string>
}

function tagSet(tags: Point['tags']): Set<string> {
  if (Array.isArray(tags)) return new Set(tags.map(String))
  return new Set(String(tags ?? '').split(/\s+/).filter(Boolean))
}

function pointTime(p: Point): string | null {
  return p.occurred_at ?? p.valid_from ?? p.created_at ?? null
}

export interface EntityAggregate {
  generatedAt: string | null
  buildStatus: string | null
  people: LibraryEntity[]
  projects: LibraryEntity[]
  unclassified: LibraryEntity[]
  portrait: LibraryPortrait
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function portraitItem(raw: unknown): LibraryPortraitItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const signature = str(r.signature)
  if (!signature) return null
  return {
    id: str(r.id),
    signature,
    observations: num(r.observations),
    confidence: num(r.confidence),
    receipts: Array.isArray(r.source_receipts) ? r.source_receipts.length : 0
  }
}

/**
 * Port of personal-model `model/human.py::_schema_sort_key`: observations desc, confidence desc,
 * id asc — the order the Runtime itself uses when it renders Faces into HUMAN.md.
 */
export function compareFaces(a: LibraryPortraitItem, b: LibraryPortraitItem): number {
  return (b.observations ?? 0) - (a.observations ?? 0) || (b.confidence ?? 0) - (a.confidence ?? 0) || (a.id ?? '').localeCompare(b.id ?? '')
}

/** S2-04 画像: Root + top 3 Faces verbatim from the graph, counts from `model.stats`. */
export function portraitFromGraph(graph: ModelGraphResponse | null | undefined): LibraryPortrait {
  const model = graph?.model
  const faces = (Array.isArray(model?.faces) ? model.faces : []).map(portraitItem).filter((f): f is LibraryPortraitItem => f !== null)
  // Stable sort: equal keys keep the Runtime's own list order.
  const topFaces = faces
    .map((f, i) => ({ f, i }))
    .sort((a, b) => compareFaces(a.f, b.f) || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.f)
  const stats = (model?.stats ?? {}) as unknown as Record<string, unknown>
  return {
    root: portraitItem(model?.root),
    topFaces,
    counts: {
      points: num(stats.points),
      faces: num(stats.faces),
      volumes: num(stats.volumes),
      relationLines: num(stats.relation_lines),
      receipts: num(stats.receipts)
    }
  }
}

export interface LibraryInput {
  /** Null when the model graph failed (graphError says why). */
  graph: ModelGraphResponse | null
  graphError?: LibrarySectionError | null
  /** Lens Workflow catalog; null when it failed (workflowError) or was not read. */
  catalog: WorkflowCatalog | null
  workflowError?: LibrarySectionError | null
  patterns: BehaviorPatterns | null
  skillsError?: LibrarySectionError | null
}

/** Every section is independent: a failure in one never empties another. */
export function aggregateLibrary(input: LibraryInput): LibraryOverview {
  const entities = input.graph ? aggregateEntities(input.graph) : null
  const { skills, skillCounts } = aggregateSkills(input.catalog, input.patterns)
  const people = entities?.people ?? []
  const projects = entities?.projects ?? []
  const unclassified = entities?.unclassified ?? []
  return {
    generatedAt: entities?.generatedAt ?? null,
    buildStatus: entities?.buildStatus ?? null,
    people,
    projects,
    unclassified,
    portrait: entities?.portrait ?? null,
    graphError: input.graphError ?? (entities ? null : { code: 'unknown', message: tr('Could not read the model', '没有读到模型') }),
    skills,
    skillCounts,
    skillsError: input.skillsError ?? null,
    workflowError: input.workflowError ?? null,
    counts: { people: people.length, projects: projects.length, unclassified: unclassified.length, skills: skills.length }
  }
}

export function aggregateEntities(graph: ModelGraphResponse): EntityAggregate {
  const model = graph?.model
  const points = Array.isArray(model?.points) ? model.points : []
  const lines = Array.isArray(model?.lines) ? model.lines : []
  const pointIds = new Set(points.map((p) => p.id))
  const drafts = new Map<string, Draft>()
  const displayFromPoint = new Set<string>()

  function draftFor(name: string, kind: string | null, source: 'point_file' | 'relation_kind'): Draft {
    // Merge across sources by (column, Runtime slug): a file stem is already a slug, and a relation
    // endpoint's canonical name slugs to the same file (`Mira Chen` → `person-mira-chen.md`).
    // Unclassified entries also key by raw kind so an `org` and an `event` with one name stay apart.
    const n = slugName(name)
    const column = columnForKind(kind)
    const key = column === 'unclassified' ? `unclassified:${kind ?? '?'}:${n}` : `${column}:${n}`
    let draft = drafts.get(key)
    if (!draft) {
      draft = {
        entity: {
          key,
          name,
          column,
          rawKind: kind,
          source,
          points: [],
          relations: [],
          lastSeen: null,
          evidenceRef: null
        },
        kinds: new Set(kind ? [kind] : [])
      }
      drafts.set(key, draft)
    } else if (draft.entity.source !== source) {
      draft.entity.source = 'both'
      // Prefer the relation's canonical spelling over the lower-case file stem, unless an identity
      // Point already supplied the display name.
      if (source === 'relation_kind' && !displayFromPoint.has(key)) draft.entity.name = name
    }
    return draft
  }

  for (const point of points) {
    if (point.is_latest === false) continue
    const typed = entityFromFileName(point.file_name)
    if (!typed) continue
    const draft = draftFor(typed.name, typed.kind, 'point_file')
    draft.entity.points.push({
      id: point.id,
      content: point.content,
      receipt: point.receipt,
      file_name: point.file_name,
      occurred_at: pointTime(point)
    })
    draft.entity.lastSeen = laterOf(draft.entity.lastSeen, pointTime(point))
    // Runtime marks the identity Point of an entity file with the `entity` (raw) or
    // `person-entity` (roster-derived) tag; its body is the display name (entity_source.py).
    const tags = tagSet(point.tags)
    const display = point.content?.trim()
    if (display && !display.includes('\n') && display.length <= 80 && (tags.has('entity') || tags.has('person-entity'))) {
      if (tags.has('entity') || !displayFromPoint.has(draft.entity.key)) {
        draft.entity.name = display
        displayFromPoint.add(draft.entity.key)
      }
    }
  }

  for (const line of lines) {
    if (!line || line.kind !== 'relation') continue
    const raw = line as Record<string, unknown>
    const source = str(raw.source)
    const target = str(raw.target)
    if (!source || !target) continue // e.g. legacy src/dst point-id lines: nothing to classify
    const sourceKind = str(raw.source_entity_kind)
    const targetKind = str(raw.target_entity_kind)
    const evidence = raw.source_evidence as { receipt?: unknown } | null | undefined
    const receipt = str(evidence?.receipt)
    const base = {
      id: str(raw.id),
      predicate: str(raw.predicate) ?? '',
      label: str(raw.label),
      quote: str(raw.quote),
      receipt
    }
    const when = str(raw.valid_from) ?? str(raw.created_at)
    const ends: Array<[string, string | null, string, string | null, 'out' | 'in']> = [
      [source, sourceKind, target, targetKind, 'out'],
      [target, targetKind, source, sourceKind, 'in']
    ]
    for (const [name, kind, other, otherKind, direction] of ends) {
      if (kind === 'self' || normName(name) === 'self') continue
      if (!kind && pointIds.has(name)) continue // endpoint is a Point id, not an identity
      const draft = draftFor(name, kind, 'relation_kind')
      const ref: LibraryRelationRef = { ...base, other, otherKind, direction }
      draft.entity.relations.push(ref)
      draft.entity.lastSeen = laterOf(draft.entity.lastSeen, when)
    }
  }

  const people: LibraryEntity[] = []
  const projects: LibraryEntity[] = []
  const unclassified: LibraryEntity[] = []
  for (const { entity } of drafts.values()) {
    entity.points.sort((a, b) => (Date.parse(b.occurred_at ?? '') || 0) - (Date.parse(a.occurred_at ?? '') || 0))
    entity.evidenceRef =
      entity.points.find((p) => p.receipt)?.receipt ??
      entity.points[0]?.id ??
      entity.relations.find((r) => r.receipt)?.receipt ??
      null
    if (entity.column === 'person') people.push(entity)
    else if (entity.column === 'project') projects.push(entity)
    else unclassified.push(entity)
  }
  const order = (a: LibraryEntity, b: LibraryEntity): number => {
    const diff = (Date.parse(b.lastSeen ?? '') || 0) - (Date.parse(a.lastSeen ?? '') || 0)
    return diff !== 0 ? diff : a.name.localeCompare(b.name)
  }
  people.sort(order)
  projects.sort(order)
  unclassified.sort(order)

  return {
    generatedAt: str(graph?.generated_at) ?? str(model?.generated_at),
    buildStatus: str(model?.build?.status),
    people,
    projects,
    unclassified,
    portrait: portraitFromGraph(graph)
  }
}

/** Header line in the spirit of the S1 welcome screen; counts come straight from the overview. */
export function libraryHeadline(counts: LibraryOverview['counts']): string {
  return tr(`Organized ${counts.projects} projects and ${counts.people} people`, `已整理 ${counts.projects} 个项目、${counts.people} 个人`)
}

/** Parse the raw `entity_graph` MCP text. Throws on non-JSON so the IPC surfaces a schema error. */
export function parseEntityGraph(text: string): LibraryEntityGraph {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(tr('entity_graph did not return valid JSON', 'entity_graph 返回的不是合法 JSON'))
  }
  const layer = str(raw.layer)
  const resolved = str(raw.resolved)
  if (!resolved) {
    return { resolved: null, layer, note: str(raw.note) ?? tr('This identity could not be resolved; Runtime did not guess.', '没有解析到这个身份；Runtime 没有猜测。') }
  }
  const edges = Array.isArray(raw.edges) ? (raw.edges as Array<Record<string, unknown>>) : []
  return {
    resolved,
    layer,
    asOf: str(raw.as_of),
    edges: edges.map((e) => ({
      src: String(e.src ?? ''),
      dst: String(e.dst ?? ''),
      predicate: String(e.predicate ?? ''),
      label: str(e.label),
      observations: typeof e.observations === 'number' ? e.observations : null,
      valid_from: str(e.valid_from),
      valid_to: str(e.valid_to),
      status: str(e.status)
    })),
    neighbors: Array.isArray(raw.neighbors) ? (raw.neighbors as unknown[]).map(String) : [],
    chainToUser: str(raw.chain_to_user)
  }
}
