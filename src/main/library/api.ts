// Typed renderer API fragment for the S1 library feature (S1-08 Library, S1-09 daily brief).
// Types + constants only: no node imports, so the renderer typecheck can include it.
import type { LensResult } from '../../shared/types'

/**
 * Column a Library entry lands in. Classification uses only fields the Runtime itself emits:
 * - Point `file_name` prefix `person-` / `project-` (same rule as personal-model
 *   `model/entity_source.py::_ENTITY_PREFIXES`);
 * - relation Line `source_entity_kind` / `target_entity_kind` (closed `EntityKind` set in
 *   personal-model `store/relation_edges.py`).
 * Anything else (org / event / artifact / an unknown kind string) is `unclassified` — never guessed.
 */
export type LibraryColumn = 'person' | 'project' | 'unclassified'

export interface LibraryPointRef {
  id: string
  content: string
  receipt: string
  file_name: string
  occurred_at: string | null
}

export interface LibraryRelationRef {
  /** Line id when the Runtime gave one. */
  id: string | null
  predicate: string
  label: string | null
  /** The other endpoint (canonical identity string). */
  other: string
  otherKind: string | null
  /** Verbatim quote the Runtime stored for the relation, if any. */
  quote: string | null
  /** Evidence receipt (`source_evidence.receipt`) when present. */
  receipt: string | null
  direction: 'out' | 'in'
}

export interface LibraryEntity {
  /** Stable key: `${column}:${normalized name}`. */
  key: string
  name: string
  column: LibraryColumn
  /** The raw kind the Runtime reported (`person`, `org`, `event`, …) or null when none. */
  rawKind: string | null
  /** Where the classification came from. */
  source: 'point_file' | 'relation_kind' | 'both'
  points: LibraryPointRef[]
  relations: LibraryRelationRef[]
  /** Latest occurred_at / valid_from / created_at seen across the entity's evidence. */
  lastSeen: string | null
  /** Best reference to open in EvidenceDrawer (a Point receipt, else a relation receipt), or null. */
  evidenceRef: string | null
}

/** Where a Library skill row came from (S1 provenance badge). `user_edited` is shown as an extra flag. */
/** `extracted` = drafted by an external agent and pasted back (S2-07 `provenance.extraction`), never 来自观察. */
export type LibrarySkillOrigin = 'observed' | 'imported' | 'shared' | 'extracted'

export interface LibrarySkill {
  /**
   * Workflow id usable as `go('playbook', { workflowId })`. Observed ids are `rt-<stem>`
   * (DEVIATIONS D25), imported `imp-…`, shared `shr-…`.
   */
  id: string
  title: string
  /** Workflow goal, or the Runtime description / playbook text when the goal is empty. */
  summary: string
  origin: LibrarySkillOrigin
  /** True when the current version is a manual edit in Lens (手动编辑). */
  edited: boolean
  /** Runtime memory path when the Workflow came from the Runtime, else null. */
  path: string | null
  updated: string | null
  /** First evidence ref (entry id / receipt), usable in EvidenceDrawer; null if none. */
  evidenceRef: string | null
  evidenceCount: number
  /** Distinct ISO-week dates the evidence carries (same rule as the Playbook headline). */
  evidenceDates: Array<string | null>
  /** Parallel to `evidenceDates`: the evidence ref's own origin (`imported` = carried in, may not resolve here). */
  evidenceOrigins: Array<'local' | 'imported'>
  /**
   * Another row in this list with the same normalized content (an imported / shared copy that
   * equals an observed Workflow). Shown as a hint only, never removed (keeps N equal to Playbook).
   */
  sameContentAs: string | null
}

export interface LibrarySectionError {
  code: string
  message: string
}

/** Root / Faces read verbatim from the Runtime model graph (S2-04 画像). */
export interface LibraryPortraitItem {
  id: string | null
  signature: string
  observations: number | null
  confidence: number | null
  receipts: number
}

export interface LibraryPortrait {
  root: LibraryPortraitItem | null
  /**
   * Top 3 Faces in the Runtime's own order: personal-model `model/human.py::_schema_sort_key`
   * (observations desc, confidence desc, id asc). No Lens score.
   */
  topFaces: LibraryPortraitItem[]
  /** `model.stats` as the Runtime reported it; null when a field is absent. */
  counts: {
    points: number | null
    faces: number | null
    volumes: number | null
    relationLines: number | null
    receipts: number | null
  }
}

export interface LibrarySkillCounts {
  observed: number
  imported: number
  shared: number
  /** External-agent extractions (S2-07). */
  extracted: number
  /** Rows whose current version is a manual edit (counted on top of their origin). */
  edited: number
  /** behavior_patterns skills dropped because the Workflow catalog already holds them. */
  dedupedPatterns: number
}

export interface LibraryOverview {
  generatedAt: string | null
  buildStatus: string | null
  people: LibraryEntity[]
  projects: LibraryEntity[]
  unclassified: LibraryEntity[]
  /** Null when the model graph could not be read (see graphError). */
  portrait: LibraryPortrait | null
  /** Runtime `/model/graph` failure: people / projects / 画像 show this, skills still render. */
  graphError: LibrarySectionError | null
  skills: LibrarySkill[]
  skillCounts: LibrarySkillCounts
  /** behavior_patterns failure is reported here instead of failing the whole overview. */
  skillsError: LibrarySectionError | null
  /** Lens Workflow store / catalog failure (skills fall back to behavior_patterns only). */
  workflowError: LibrarySectionError | null
  counts: { people: number; projects: number; unclassified: number; skills: number }
}

/** Parsed `entity_graph` MCP result (read-only). */
export type LibraryEntityGraph =
  | {
      resolved: string
      layer: string | null
      asOf: string | null
      edges: Array<{
        src: string
        dst: string
        predicate: string
        label: string | null
        observations: number | null
        valid_from: string | null
        valid_to: string | null
        status: string | null
      }>
      neighbors: string[]
      chainToUser: string | null
    }
  | { resolved: null; layer: string | null; note: string }

export interface ExportBriefResult {
  /** Null when the user cancelled the save dialog. */
  path: string | null
  bytes: number
}

export const LIBRARY_CHANNELS = {
  overview: 'lens:library:overview',
  entity: 'lens:library:entity',
  exportBrief: 'lens:library:export-brief'
} as const

export interface LibraryApi {
  library: {
    overview(): Promise<LensResult<LibraryOverview>>
    entity(name: string): Promise<LensResult<LibraryEntityGraph>>
    exportBrief(markdown: string, date: string): Promise<LensResult<ExportBriefResult>>
  }
}
