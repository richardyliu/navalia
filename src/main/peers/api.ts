// Typed renderer API fragment for S1-11 Peers + weekly letter. Owned by the peers feature agent.
// Types + constants only: no node imports, so the renderer typecheck can include it.
import type { LensResult } from '../../shared/types'
import { tr } from '../../shared/i18n'
import type { SignedCard } from '../identity/card-schema'

export const PEERS_CHANNELS = {
  list: 'lens:peers:list',
  get: 'lens:peers:get',
  importFile: 'lens:peers:import-file',
  importText: 'lens:peers:import-text',
  remove: 'lens:peers:remove',
  suggestions: 'lens:peers:suggestions',
  // S1-R3-05 共同话题 / 共同经历.
  sharedMoments: 'lens:peers:shared-moments',
  letterDraft: 'lens:peers:letter-draft',
  exportLetter: 'lens:peers:export-letter',
  // S2-09 local subscription folder (DECISIONS X2).
  subStatus: 'lens:peers:sub-status',
  subChoose: 'lens:peers:sub-choose',
  subEnable: 'lens:peers:sub-enable',
  subDisable: 'lens:peers:sub-disable',
  subRefresh: 'lens:peers:sub-refresh',
  subAutoScan: 'lens:peers:sub-auto-scan'
} as const

/** Label every inferred line carries. */
export const UNVERIFIED = '未核实'

/**
 * Stored peers always verify (tampered cards are rejected, never listed).
 * - `valid`: signature verifies with the key the card carries.
 * - `old_key`: signature verifies, but another peer with the same display name has a newer card
 *   signed by a different key (friend probably reset their identity). Heuristic: no account
 *   links the two keys, so this is labelled 未核实 in the UI.
 */
export type PeerVerification = 'valid' | 'old_key'

/** Why an import was refused. Nothing is written in any of these cases. */
export type PeerRejectReason =
  /** Fingerprint or Ed25519 signature check failed: the content was changed after signing. */
  | 'tampered'
  /** Not JSON / not a `.navaliacard` (schema mismatch). */
  | 'invalid'
  /** Signed by this Lens Store's own current or retired key. */
  | 'self'
  | 'too_large'

export type PeerEventKind = 'imported' | 'updated' | 'reimported_same' | 'older_version'

/** Local events only: what happened in this app, never what the friend did. */
export interface PeerEvent {
  at: string
  kind: PeerEventKind
  cardId: string
  cardIssuedAt: string
}

export interface PeerTopic {
  source: 'summary' | 'highlight' | 'map'
  text: string
}

export interface PeerSummary {
  fingerprint: string
  displayName: string | null
  /** Root summary on the card front, verbatim. */
  headline: string | null
  /** "What the card says they work on": summary + highlights + Mini Map labels, verbatim, deduped. */
  topics: PeerTopic[]
  verification: PeerVerification
  /** Fingerprint of the same-name peer whose newer card makes this one `old_key`. */
  supersededBy: string | null
  cardId: string
  cardIssuedAt: string
  cardAsOf: string
  cardDegraded: boolean
  importedAt: string
  updatedAt: string
  versions: number
}

export interface PeerDetail extends PeerSummary {
  card: SignedCard
  history: Array<{ cardId: string; issuedAt: string; importedAt: string }>
  events: PeerEvent[]
}

export interface PeerList {
  peers: PeerSummary[]
  /** Stored files that no longer verify (edited on disk). Not listed; reported so nothing is hidden silently. */
  unreadable: number
}

export type PeerImportResult =
  | { ok: true; outcome: 'added' | 'updated' | 'unchanged' | 'older_version'; peer: PeerDetail }
  | { ok: false; reason: PeerRejectReason; detail: string }

export interface PeerSuggestion {
  /** Words / phrases present in both the friend's card line and the user's own line. */
  shared: string[]
  peerQuote: string
  peerSource: PeerTopic['source']
  userQuote: string
  userSource: 'root' | 'volume' | 'face' | 'point'
  /** Receipt / id of the user's line, when it has one. */
  userRef: string | null
  label: typeof UNVERIFIED
}

export interface PeerSuggestions {
  suggestions: PeerSuggestion[]
  /** Why the list is empty or partial (e.g. Runtime unreachable). Null when the model was read. */
  modelError: string | null
}

// ── S1-R3-05 shared moments (共同话题 / 共同经历) ─────────────────────────────

/**
 * Keyword overlap kinds (D31, demoted in S1-FULL C18): `topic` = overlap with the user's model (or an
 * undated memory entry); `experience` = a dated memory entry. These are NOT shared experiences —
 * real 共同经历 are signed by both people (cloud/moments*.ts). Labels say so.
 */
export type SharedMomentKind = 'topic' | 'experience'
export const SHARED_KIND_LABEL: Record<SharedMomentKind, string> = {
  get topic() {
    return tr('Topic overlap', '话题重合')
  },
  get experience() {
    return tr('Dated memory overlap', '有日期的记忆重合')
  }
}

/**
 * How the entry was found. `literal`: words / CJK bigrams present in both lines (fixed rule).
 * `semantic`: returned by the Runtime's local `search` for the card topic AND passed the relevance
 * gate on a numeric `score` (S1-R4-09; see shared.ts MIN_SEARCH_SCORE). `both`: a search hit that
 * also overlaps literally. Since S1-R4-09 a search hit with neither a passing score nor a literal
 * overlap is dropped, never shown.
 */
export type SharedMatch = 'literal' | 'semantic' | 'both'

/**
 * S1-R4-09: minimum Runtime search `score` (assumed 0..1, higher = more relevant) for a hit to be
 * shown on its own. The current Runtime returns no `score`; see shared.ts searchGate for the rule
 * that applies then (literal overlap required). Lives here so the renderer can show it.
 */
export const MIN_SEARCH_SCORE = 0.5

export interface SharedMomentEntry {
  /**
   * S1-R3-SEC M3: stable id derived from the (redacted) topic + entry content. The letter cites an
   * entry's snippet only when the user ticked this id in the Peers UI.
   */
  id: string
  kind: SharedMomentKind
  match: SharedMatch
  /** Literal shared terms (empty for semantic-only hits). */
  shared: string[]
  /** The user's own line (one line, clipped), redacted (secrets, email, phone, paths) since S1-R3-SEC. */
  userSnippet: string
  userSource: PeerSuggestion['userSource'] | 'memory'
  userPath: string | null
  /** Raw Runtime timestamp of a memory entry (null for model lines / undated entries). */
  userDate: string | null
  /** Evidence reference for the drawer: point receipt / id, or memory entry id. Null = no receipt. */
  evidenceRef: string | null
  /** 1-based rank in the Runtime `search` result for this topic (null for model lines). */
  rank: number | null
  /**
   * S1-R4-09: why a search hit passed the relevance gate. `score` = Runtime returned a numeric
   * `score` ≥ MIN_SEARCH_SCORE; `overlap` = no usable score, literal term overlap required.
   * Null / absent for model lines (literal by construction).
   */
  gate?: 'score' | 'overlap' | null
  /** The Runtime `score` when one was returned (null otherwise). */
  score?: number | null
  label: typeof UNVERIFIED
}

export interface SharedMomentGroup {
  /** The friend's card topic (redacted like the snippets since S1-R3-SEC). */
  topic: PeerTopic
  entries: SharedMomentEntry[]
}

export interface SharedMoments {
  fingerprint: string
  /** Only topics with at least one entry, in card order. Empty = no matches (empty state). */
  groups: SharedMomentGroup[]
  counts: { topics: number; experiences: number }
  /** Reading the user's model failed (literal overlap missing). */
  modelError: string | null
  /** Runtime `search` failed (semantic matches missing). */
  searchError: string | null
  /** How many card topics were sent to `search`. */
  searchedTopics: number
  /** S1-R4-09: search hits dropped by the relevance gate (not shown, not citable). */
  droppedBelowGate?: number
}

export interface LetterDraft {
  fingerprint: string
  markdown: string
  timezone: string
  /** Inclusive local dates of the 7-day window. */
  range: { start: string; end: string }
  /** `experiences`: signed shared moments (C11) listed in the letter. */
  counts: { inWindow: number; recentTotal: number; undated: number; experiences: number }
  suggestedFileName: string
}

// ── S2-09 local subscription folder ─────────────────────────────────────────

/** Per-file result of one manual refresh. */
export type SubscriptionOutcome =
  | 'added'
  | 'updated'
  | 'unchanged'
  | 'older_version'
  /** sha256 already in the ledger (or seen earlier in the same refresh), or the skill already exists. */
  | 'duplicate'
  | 'rejected'
  | 'skipped'

export type SubscriptionSkipReason =
  | 'symlink'
  | 'not_regular'
  | 'too_large'
  /** More candidate files than one refresh handles; the rest wait for the next refresh. */
  | 'count_cap'
  /** Total bytes budget of one refresh used up. */
  | 'byte_cap'
  /** iCloud placeholder (`.name.icloud`): not downloaded to this Mac yet. */
  | 'not_downloaded'
  | 'unreadable'
  /** `.navaliaskill` signed by a key that is not in the Peers list: not imported, not ledgered (imports after the friend is added). */
  | 'unknown_signer'

export interface SubscriptionFileReport {
  name: string
  kind: 'card' | 'skill'
  /** Null when the file was not read (skipped before reading). */
  sha256: string | null
  outcome: SubscriptionOutcome
  /** Skip reason, card reject reason, or `skill`. Null on success. */
  reason: SubscriptionSkipReason | PeerRejectReason | 'skill' | null
  /** Human detail (verifier message, peer name, workflow id). */
  detail: string | null
}

export interface SubscriptionRefreshReport {
  folder: string
  scannedAt: string
  files: SubscriptionFileReport[]
  counts: Record<SubscriptionOutcome, number>
  /** Entries in the folder that are neither `.navaliacard` nor `.navaliaskill` (not read). */
  ignored: number
}

export interface SubscriptionStatus {
  enabled: boolean
  folder: string | null
  /** Problem with the configured folder right now (missing, not a directory…). Null when fine or unset. */
  folderProblem: string | null
  ledgerSize: number
  lastRefreshAt: string | null
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
  /** S1-R4-06 (X2): opt-in periodic scan of the same folder. Default off. */
  autoScan: SubscriptionAutoScan
}

export interface SubscriptionAutoScan {
  enabled: boolean
  intervalMinutes: number
  minMinutes: number
  maxMinutes: number
  /** Filled by the main-process scheduler (not persisted): last automatic scan in this app session. */
  lastRun?: SubscriptionAutoScanRun | null
  /** Next planned automatic scan (ISO), null when no timer is armed. */
  nextAt?: string | null
}

export interface SubscriptionAutoScanRun {
  at: string
  ok: boolean
  counts: Record<SubscriptionOutcome, number> | null
  /** Redacted error (folder missing, busy with a manual refresh…). */
  error: string | null
}

export interface PeersApi {
  peers: {
    list(): Promise<LensResult<PeerList>>
    get(fingerprint: string): Promise<LensResult<PeerDetail | null>>
    /** Open dialog in main; null when cancelled. */
    importFile(): Promise<LensResult<PeerImportResult | null>>
    importText(text: string): Promise<LensResult<PeerImportResult>>
    remove(fingerprint: string): Promise<LensResult<{ removed: boolean }>>
    suggestions(fingerprint: string): Promise<LensResult<PeerSuggestions>>
    /** S1-R3-05 keyword overlap (literal + local Runtime search; no LLM). 未核实; never cited in letters (C18). */
    sharedMoments(fingerprint: string, timezone?: string): Promise<LensResult<SharedMoments>>
    /** C11: the letter lists only signed shared moments with this friend (visibility `letters`, in the window). */
    letterDraft(fingerprint: string, timezone: string): Promise<LensResult<LetterDraft>>
    /** Save dialog in main; never sent anywhere. */
    exportLetter(fingerprint: string, markdown: string): Promise<LensResult<{ path: string | null; bytes: number }>>
    /** S2-09: subscription folder config + ledger size. */
    subStatus(): Promise<LensResult<SubscriptionStatus>>
    /** Directory dialog in main; validates and enables. Null when cancelled. */
    subChoose(): Promise<LensResult<SubscriptionStatus | null>>
    /** Re-enable the previously chosen folder (re-validated). */
    subEnable(): Promise<LensResult<SubscriptionStatus>>
    /** 停用: stop using the folder (path and ledger kept). */
    subDisable(): Promise<LensResult<SubscriptionStatus>>
    /** Manual scan. Refused while disabled. */
    subRefresh(): Promise<LensResult<SubscriptionRefreshReport>>
    /** S1-R4-06: turn the periodic scan on / off and set its interval (minutes, ≥ minMinutes). */
    subSetAutoScan(enabled: boolean, intervalMinutes: number): Promise<LensResult<SubscriptionStatus>>
  }
}

/** Subscription (S1 "subscribe to a friend") = local folder only; manual refresh + opt-in periodic scan: DECISIONS X2 / S2-09 / S1-R4-06. */
export const SUBSCRIPTION_STATUS = {
  state: 'local_folder',
  get reason(): string {
    return tr(
      'Local first: folder subscription (DECISIONS X2, the default). Pick a local or iCloud Drive folder as your subscription folder. Peers drop .navaliacard / .navaliaskill files into it, you press Refresh, and Navalia verifies the signatures offline and imports them. Periodic scan is off by default; turn it on below (it scans only the top level of this folder, not subfolders). Folder subscription never goes online. Email subscription to weekly letters is a separate, optional Cloud feature, off by default; see the Subscriptions page.',
      '本地优先：文件夹订阅（DECISIONS X2，默认方式）。可以选一个本地或 iCloud Drive 文件夹作为「订阅文件夹」：朋友把 .navaliacard / .navaliaskill 放进去，你手动点「刷新」，Navalia 离线验签后导入。定期扫描默认关闭，需要你在下面开启（只扫这个文件夹第一层，不递归）；文件夹订阅任何情况下都不联网。邮件订阅周信是另一个可选的云端功能，默认关闭，见「订阅」页。'
    )
  }
} as const
