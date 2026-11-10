// S1-FULL C8 (cloud friend cards) + C10 (subscriptions / weekly letter by email) — channel names
// and renderer-safe types. No node imports: the renderer and preload import this file. Merged into
// `CloudApi` (api.ts) as the `subs` and `cloudCards` namespaces, so they reach `window.lens.*`
// through the existing cloud preload fragment.
//
// The renderer never sends a signature, an envelope or card text to be uploaded: main builds and
// signs the letter envelope from {title, markdown, week} parked under a previewId, and uploads the
// latest locally signed card it previewed.
import { tr } from '../../shared/i18n'
import type { CloudResult } from './api'

export const SUBS_CHANNELS = {
  letterDraft: 'lens:subs:letter-draft',
  letterPreview: 'lens:subs:letter-preview',
  letterDiscard: 'lens:subs:letter-discard',
  letterPublish: 'lens:subs:letter-publish',
  letters: 'lens:subs:letters',
  deliveries: 'lens:subs:deliveries',
  subscribers: 'lens:subs:subscribers',
  removeSubscriber: 'lens:subs:remove-subscriber',
  subscribeLink: 'lens:subs:subscribe-link',
  friendLetters: 'lens:subs:friend-letters',
  cachedLetters: 'lens:subs:cached-letters'
} as const

export const CLOUD_CARDS_CHANNELS = {
  status: 'lens:cloud-cards:status',
  publishPreview: 'lens:cloud-cards:publish-preview',
  publish: 'lens:cloud-cards:publish',
  unpublish: 'lens:cloud-cards:unpublish',
  fetchFriend: 'lens:cloud-cards:fetch-friend'
} as const

export const LETTER_LIMITS = {
  maxTitleChars: 200,
  maxMarkdownChars: 30_000,
  /** Server request bodies are ≤ 64 KiB; keep a margin for the JSON wrapper. */
  maxBodyBytes: 60 * 1024,
  /** Server returns ≤ 12 letters per friend. */
  maxFriendLetters: 12,
  /** Verified letters kept in the local cache per friend. */
  maxCachedPerFriend: 52
} as const

export const WEEK_RE = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/
export const FINGERPRINT_RE = /^[0-9a-f]{64}$/
/** Server ids (letter / subscriber) as they appear in a URL path segment. */
export const SERVER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

// ── C10 letters ─────────────────────────────────────────────────────────────

export interface SubsLetterDraft {
  title: string
  markdown: string
  /** ISO week `YYYY-Www` of the last day of the 7-day window. */
  week: string
  range: { start: string; end: string }
  timezone: string
  counts: { inWindow: number; recentTotal: number; undated: number }
  /** Honest notes, e.g. the Runtime could not be read. */
  warnings: string[]
  /**
   * S1-FULL C11: shared moments listed in 「这周和朋友的共同经历」 (accepted, both signatures verified
   * offline, visibility `letters`, in the window). `line` is the exact (redacted) line in `markdown`;
   * `noteLine` is the user's own local note as a redacted line, inserted only if they tick it.
   */
  moments?: SubsLetterMoment[]
}

export interface SubsLetterMoment {
  momentId: string
  title: string
  start: string
  end: string
  friend: string
  /** Null when the line could not be located after redaction (then the note cannot be toggled). */
  line: string | null
  noteLine: string | null
}

/** The unsigned envelope exactly as main will sign it (all fields except `signature`). */
export interface LetterEnvelopeUnsigned {
  version: 1
  kind: 'persome-letter'
  issue_id: string
  week: string
  title: string
  markdown: string
  created_at: string
  signer: { public_key: string; fingerprint: string }
}

export interface LetterPreview {
  previewId: string
  envelope: LetterEnvelopeUnsigned
  /** Exactly the bytes that will be signed (UTF-8): `persome-letter-v1\n` + canonical JSON. */
  signingText: string
  /** Size of the POST body that will be sent (with the signature added). */
  bodyBytes: number
  expiresAt: string
}

export interface LetterPublished {
  letterId: string
  issueId: string
  recipients: number
  /** The signed envelope text that was sent (canonical JSON incl. `signature`). */
  envelopeText: string
}

export interface LetterCounts {
  queued: number
  sent: number
  failed: number
  suppressed: number
}

export interface PublishedLetter {
  letterId: string
  issueId: string
  week: string
  title: string
  createdAt: string
  counts: LetterCounts
}

export interface LetterDelivery {
  subscriberId: string
  emailMasked: string
  status: string
  attempts: number
  updatedAt: string | null
  errorCode: string | null
}

export interface Subscriber {
  subscriberId: string
  emailMasked: string
  status: 'pending' | 'confirmed'
  createdAt: string
  confirmedAt: string | null
}

export interface SubscribeLink {
  url: string
  fingerprint: string
}

/** A friend's letter that verified offline (signature + signer == requested fingerprint). */
export interface FriendLetter {
  issueId: string
  week: string
  title: string
  markdown: string
  createdAt: string
  publishedAt: string | null
  signerFingerprint: string
}

export type LetterRejectReason = 'parse' | 'schema' | 'fingerprint' | 'wrong_signer' | 'signature'

export interface DroppedLetter {
  /** Position in the server response. */
  index: number
  reason: LetterRejectReason
  /** Only when the envelope parsed far enough to have one. */
  issueId: string | null
}

export interface FriendLettersResult {
  fingerprint: string
  letters: FriendLetter[]
  dropped: DroppedLetter[]
  /** Verified letters written to the local cache in this fetch. */
  cached: number
}

export interface CachedLettersResult {
  fingerprint: string
  letters: FriendLetter[]
  /** Cache files that no longer verify (ignored, not shown). */
  unreadable: number
}

// ── C8 cloud cards ──────────────────────────────────────────────────────────

export interface CloudCardStatus {
  published: boolean
  version: number | null
  publishedAt: string | null
  /** card_id of the published card (only when it verified offline). */
  cardId: string | null
  /** Offline verification of what the server returned (false also when not published). */
  verified: boolean
  /** True when the published card is the same as the latest local card. */
  matchesLatest: boolean
}

export interface CardPublishPreview {
  previewId: string
  fingerprint: string
  cardId: string
  issuedAt: string
  displayName: string | null
  summary: string | null
  highlights: string[]
  asOf: string
  stats: { points: number; faces: number; volumes: number }
  /** Exactly the `.navaliacard` text that will be uploaded. */
  cardText: string
  bytes: number
  audienceNote: string
  expiresAt: string
}

export interface CardPublished {
  fingerprint: string
  version: number
  publishedAt: string
  unchanged: boolean
}

export interface FriendCardFetched {
  outcome: 'added' | 'updated' | 'unchanged' | 'older_version'
  fingerprint: string
  displayName: string | null
  versions: number
  cloudVersion: number
  publishedAt: string
}

export function cardAudienceNote(): string {
  return tr('Public to anyone with your fingerprint: anyone who knows it can fetch this card from the cloud.', '公开给持有你指纹的人：任何知道你指纹的人都能从云端取到这张卡片。')
}
export function noTrackingNote(): string {
  return tr('No open/read tracking; every email has an unsubscribe link', '不追踪打开/阅读；每封邮件都有退订链接')
}

export interface SubsApiFragment {
  subs: {
    /** Deterministic draft (peers/letter.ts template; no LLM), from the local Runtime only. */
    letterDraft(args: { timezone: string }): Promise<CloudResult<SubsLetterDraft>>
    /** Main builds the unsigned envelope and parks it; nothing is signed or sent yet. */
    letterPreview(args: { title: string; markdown: string; week: string }): Promise<CloudResult<LetterPreview>>
    letterDiscard(previewId: string): Promise<CloudResult<boolean>>
    /** Native confirm in main, then sign + `POST /v1/letters` of exactly the previewed envelope. */
    letterPublish(previewId: string): Promise<CloudResult<LetterPublished>>
    letters(): Promise<CloudResult<PublishedLetter[]>>
    deliveries(letterId: string): Promise<CloudResult<LetterDelivery[]>>
    subscribers(): Promise<CloudResult<Subscriber[]>>
    /** Native confirm in main. */
    removeSubscriber(subscriberId: string): Promise<CloudResult<boolean>>
    subscribeLink(): Promise<CloudResult<SubscribeLink>>
    /** Fetch + offline verify + cache; forged letters are dropped and reported. */
    friendLetters(fingerprint: string): Promise<CloudResult<FriendLettersResult>>
    /** Local cache only (re-verified on read); no network. */
    cachedLetters(fingerprint: string): Promise<CloudResult<CachedLettersResult>>
  }
  cloudCards: {
    status(): Promise<CloudResult<CloudCardStatus>>
    publishPreview(): Promise<CloudResult<CardPublishPreview>>
    /** Native confirm in main, then `PUT /v1/cards` of exactly the previewed card text. */
    publish(previewId: string): Promise<CloudResult<CardPublished>>
    /** Native confirm in main, then `DELETE /v1/cards`. */
    unpublish(): Promise<CloudResult<boolean>>
    /** GET → offline verify → signer must equal `fingerprint`, not self → Peers store import. */
    fetchFriend(fingerprint: string): Promise<CloudResult<FriendCardFetched>>
  }
}
