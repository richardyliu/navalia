// S1-R3-05 共同话题 / 共同经历: pure grouping. No I/O, no LLM, no clock.
//
// Inputs are only (a) the friend's verified card topics, (b) the user's own model lines (read-only
// Runtime graph) and (c) the user's own memory entries that the Runtime's local `search` returned for
// each card topic. Two match kinds:
//   - literal: fixed-rule term overlap (topics.ts sharedTerms: ≥1 Latin word or ≥2 CJK bigrams);
//   - semantic: the Runtime's own search ranking for the topic text, behind a relevance gate
//     (S1-R4-09, see searchGate below). We never claim the two people did the same thing: every
//     entry is labelled 未核实.
import { createHash } from 'node:crypto'
import type { MemorySearchHit } from '../../shared/types'
import { scrubText } from '../identity/redact'
import { stripSecrets } from '../import/redact'
import { MIN_SEARCH_SCORE, UNVERIFIED, type PeerTopic, type SharedMomentEntry, type SharedMomentGroup, type SharedMoments } from './api'
import { placeTimestamp, quoteLine } from './letter'
import { clip, extractTerms, sharedTerms, type UserLine } from './topics'

/** Card topics sent to `search` per refresh (bounded: one local call each). */
export const MAX_SEARCH_TOPICS = 6
/** `top_k` per search. */
export const SEARCH_TOP_K = 3
/**
 * S1-R4-09 relevance gate for Runtime `search` hits.
 *
 * What the Runtime actually returns (personal-model-og src/persome/mcp/server.py `_search`, read
 * 2026-11-05): per result `id, path, timestamp, age_days, content, rank, confidence, conflicted,
 * occurred_at[, related_faces]`. There is NO `score` field. `rank` is not a relevance score: on the
 * BM25 path it is the raw FTS5 bm25() value (negative, lower = better, unbounded, query-dependent)
 * and on the hybrid / associative paths (the production default) dense-only hits carry `rank=0.0`
 * (store/fts.py EntryHit(..., rank=0.0)); the list order comes from RRF + recency, not from `rank`.
 * `confidence` is the entry's extraction confidence, not query relevance. So Lens ignores `rank` and
 * `confidence` for gating.
 *
 * Rule: if a hit carries a finite numeric `score` (only a future / other Runtime would), it must be
 * ≥ MIN_SEARCH_SCORE (assumed normalised 0..1, higher = more relevant). Otherwise the hit must share
 * literal terms with the card topic (topics.ts sharedTerms: ≥1 Latin word or ≥2 CJK bigrams).
 * Hits that fail are dropped (not shown, not citable) and counted in `droppedBelowGate`.
 */
export { MIN_SEARCH_SCORE }

export type SearchGate = { pass: true; via: 'score' | 'overlap'; score: number | null } | { pass: false; score: number | null }

export function searchGate(hit: Pick<MemorySearchHit, 'score'>, shared: readonly string[]): SearchGate {
  const raw = (hit as { score?: unknown }).score
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw >= MIN_SEARCH_SCORE ? { pass: true, via: 'score', score: raw } : { pass: false, score: raw }
  }
  return shared.length ? { pass: true, via: 'overlap', score: null } : { pass: false, score: null }
}

const MAX_LITERAL_PER_TOPIC = 2
const MAX_MEMORY_PER_TOPIC = 2
const MAX_GROUPS = 8

export interface TopicSearch {
  topicIndex: number
  hits: MemorySearchHit[] | null
  error: string | null
}

export interface SharedMomentsInput {
  fingerprint?: string
  topics: PeerTopic[]
  lines: UserLine[]
  searches: TopicSearch[]
  modelError?: string | null
}

/**
 * S1-R3-SEC M3: everything shown to the user as "shareable with this friend" (UI and letter) is
 * redacted first: secrets (import/redact.ts stripSecrets) then email / phone / paths / urls
 * (identity/redact.ts scrubText, the Card scrubber). Applied to the full text BEFORE clipping.
 */
export function peerSafe(text: unknown): string {
  return scrubText(stripSecrets(String(text ?? '')).text)
}

function entryId(topic: string, e: Pick<SharedMomentEntry, 'kind' | 'evidenceRef' | 'userSnippet'>): string {
  return createHash('sha256')
    .update(JSON.stringify([topic, e.kind, e.evidenceRef, e.userSnippet]))
    .digest('hex')
    .slice(0, 16)
}

function hasTimestamp(value: unknown): boolean {
  // Placement only (any zone gives the same yes/no answer).
  return placeTimestamp(value, 'UTC') !== null
}

export function buildSharedMoments(input: SharedMomentsInput): SharedMoments {
  const userTerms = input.lines.map((line) => ({ line, terms: extractTerms(line.text) }))
  const byTopic = new Map<number, TopicSearch>()
  for (const s of input.searches) if (!byTopic.has(s.topicIndex)) byTopic.set(s.topicIndex, s)
  const searchError = input.searches.find((s) => s.error)?.error ?? null

  const seenMemory = new Set<string>()
  let dropped = 0
  const groups: SharedMomentGroup[] = []
  input.topics.forEach((topic, topicIndex) => {
    const pt = extractTerms(topic.text)

    // 1) literal overlap with the user's model lines (ranked like topics.ts suggestOverlap).
    const literal: Array<Omit<SharedMomentEntry, 'id'> & { score: number; weight: number }> = []
    const seenLine = new Set<string>()
    for (const { line, terms } of userTerms) {
      const shared = sharedTerms(topic.text, pt, line.text, terms)
      if (!shared) continue
      const snippet = clip(peerSafe(line.text))
      if (!snippet || seenLine.has(snippet)) continue
      seenLine.add(snippet)
      literal.push({
        kind: 'topic',
        match: 'literal',
        shared,
        userSnippet: snippet,
        userSource: line.source,
        userPath: null,
        userDate: null,
        evidenceRef: line.ref,
        rank: null,
        gate: null,
        label: UNVERIFIED,
        score: shared.reduce((n, s) => n + Math.max(1, s.length - 1), 0),
        weight: line.weight
      })
    }
    literal.sort((a, b) => b.score - a.score || b.weight - a.weight || a.userSnippet.localeCompare(b.userSnippet))

    // 2) the user's memory entries returned by the Runtime search for this topic.
    const memory: Array<Omit<SharedMomentEntry, 'id'>> = []
    const search = byTopic.get(topicIndex)
    ;(search?.hits ?? []).forEach((hit, i) => {
      if (memory.length >= MAX_MEMORY_PER_TOPIC) return
      if (!hit || typeof hit.id !== 'string' || !hit.id || seenMemory.has(hit.id)) return
      const snippet = quoteLine(peerSafe(hit.content))
      if (!snippet) return
      const shared = sharedTerms(topic.text, pt, String(hit.content), extractTerms(String(hit.content))) ?? []
      const gate = searchGate(hit, shared)
      if (!gate.pass) {
        dropped++
        return
      }
      seenMemory.add(hit.id)
      const dated = hasTimestamp(hit.timestamp)
      memory.push({
        kind: dated ? 'experience' : 'topic',
        match: shared.length ? 'both' : 'semantic',
        shared,
        userSnippet: snippet,
        userSource: 'memory',
        userPath: typeof hit.path === 'string' && hit.path ? hit.path : null,
        userDate: dated ? String(hit.timestamp) : null,
        evidenceRef: hit.id,
        rank: i + 1,
        gate: gate.via,
        score: gate.score,
        label: UNVERIFIED
      })
    })

    const safeTopic = { ...topic, text: peerSafe(topic.text) }
    const entries: SharedMomentEntry[] = [
      ...literal.slice(0, MAX_LITERAL_PER_TOPIC).map(({ score: _s, weight: _w, ...e }) => {
        void _s
        void _w
        return { ...e, score: null }
      }),
      ...memory
    ].map((e) => ({ id: entryId(safeTopic.text, e), ...e }))
    // 共同话题 first, then 共同经历 (stable inside each kind).
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'topic' ? -1 : 1))
    if (entries.length && groups.length < MAX_GROUPS) groups.push({ topic: safeTopic, entries })
  })

  const all = groups.flatMap((g) => g.entries)
  return {
    fingerprint: input.fingerprint ?? '',
    groups,
    counts: { topics: all.filter((e) => e.kind === 'topic').length, experiences: all.filter((e) => e.kind === 'experience').length },
    modelError: input.modelError ?? null,
    searchError,
    searchedTopics: input.searches.length,
    droppedBelowGate: dropped
  }
}
