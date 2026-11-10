// S1-FULL C18 — shared moments (共同经历), Lens side. Types + constants only (renderer-safe).
//
// A moment is never inferred: the user proposes it to one friend from the local Peers list, the
// friend accepts it on their own Lens, and only then is it a 共同经历. Both texts are Ed25519-signed
// by the participants (proposer: `persome-moment-v1\n` + JCS; accepter: `persome-moment-accept-v1\n`
// + JCS over the moment's sha256). The cloud is a courier; every client verifies offline.
import { tr } from '../../shared/i18n'
import type { CloudResult } from './api'

export const MOMENTS_CHANNELS = {
  /** Offline: verified moments from `<LensStore>/moments/` (works while cloud is OFF). */
  local: 'lens:moments:local',
  /** GET /v1/moments → verify → store accepted ones locally. */
  sync: 'lens:moments:sync',
  proposePreview: 'lens:moments:propose-preview',
  propose: 'lens:moments:propose',
  acceptPreview: 'lens:moments:accept-preview',
  accept: 'lens:moments:accept',
  discardPreview: 'lens:moments:discard-preview',
  decline: 'lens:moments:decline',
  /** DELETE on the server (disappears for both) + local removal. */
  remove: 'lens:moments:delete',
  /** Local-only removal (e.g. the server no longer has it). */
  forgetLocal: 'lens:moments:forget-local',
  /** The user's own reflective note, stored locally only. */
  setNote: 'lens:moments:set-note'
} as const

export const MOMENT_LIMITS = {
  maxTitleChars: 200,
  maxNoteChars: 4000,
  maxPlaceChars: 200,
  /** The user's local reflective note (never uploaded by this feature). */
  maxMyNoteChars: 4000,
  /** Creation only (verification accepts any start ≤ end). */
  maxRangeDays: 366,
  /** Moments read from one server response. */
  maxServerRows: 500
} as const

export const MOMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type MomentVisibility = 'private' | 'letters'

export const VISIBILITY_LABEL = {
  get private() {
    return tr('Just the two of us (not in weekly letters)', '仅我们两人（不写进周信）')
  },
  get letters() {
    return tr('Can appear in weekly letters (either of us may mention it)', '可以写进周信（双方都可以在每周信里提到）')
  }
} satisfies Record<MomentVisibility, string>

/**
 * 「帮助表达 prompt（不替用户说话）」: fixed questions shown next to a text box the user writes in.
 * Lens never writes text about a moment (no LLM, no template filling).
 */
const MOMENT_PROMPT_TEXT: ReadonlyArray<() => string> = [
  () => tr('What detail do you remember most from that day?', '那天最记得的一个细节是？'),
  () => tr('One thing you want to say to them?', '想对 TA 说的一句话？'),
  () => tr('Did anything change in how you think since that day?', '那天之后，有什么想法变了吗？'),
  () => tr('If you did it again, what would you want to do together?', '如果再来一次，想一起做什么？')
]
// Array with getter elements: indexing, .map and .includes all read the current locale.
export const MOMENT_PROMPTS: readonly string[] = Object.defineProperties(
  [] as string[],
  Object.fromEntries(MOMENT_PROMPT_TEXT.map((get, i) => [i, { get, enumerable: true }]))
)

export function deleteNote(): string {
  return tr(
    'Once deleted, this shared moment is removed from the cloud and neither of you can see it (the copy saved on their Mac is marked "deleted in cloud" at the next sync).',
    '删除后，这条共同经历会从云端删除，你和对方都看不到了（对方本机已保存的副本会在下次同步时标为「云端已删除」）。'
  )
}

export interface MomentParty {
  public_key: string
  fingerprint: string
}

/** Exactly what the proposer signs (everything except `signature`). */
export interface MomentUnsigned {
  version: 1
  kind: 'persome-moment'
  moment_id: string
  title: string
  note: string
  occurred_on: { start: string; end: string }
  place: string | null
  participants: [string, string]
  visibility: MomentVisibility
  proposer: MomentParty
  created_at: string
}

export interface AcceptanceUnsigned {
  version: 1
  kind: 'persome-moment-accept'
  moment_id: string
  moment_sha256: string
  accepter: MomentParty
  accepted_at: string
}

export type MomentRejectReason =
  | 'parse'
  | 'schema'
  /** public_key does not hash to the claimed fingerprint. */
  | 'fingerprint'
  | 'signature'
  /** I am not one of the two participants (or proposer / accepter not a participant). */
  | 'not_participant'
  /** Acceptance names a different moment id or sha256. */
  | 'mismatch'
  /** Accepter is the proposer. */
  | 'self_accept'
  /** Local file name ≠ moment_id. */
  | 'file_name'

export interface MomentView {
  momentId: string
  title: string
  /** The proposer's signed note (visible to both participants and the server). */
  note: string
  start: string
  end: string
  place: string | null
  visibility: MomentVisibility
  createdAt: string
  proposerFingerprint: string
  /** The other participant (never me). */
  friendFingerprint: string
  /** Display name from the friend's verified card in Peers; null when unknown / unnamed. */
  friendName: string | null
  /** The friend is in the local Peers list. */
  friendKnown: boolean
  iAmProposer: boolean
}

export interface LocalMoment extends MomentView {
  acceptedAt: string
  /** Both signatures verified offline on this read. Always true for listed moments. */
  verified: true
  myNote: string | null
  myNoteUpdatedAt: string | null
}

export interface RejectedLocalMoment {
  file: string
  reason: MomentRejectReason | 'unreadable'
}

export interface LocalMomentsResult {
  moments: LocalMoment[]
  /** Files that failed verification (ignored, not shown, not deleted). */
  rejected: RejectedLocalMoment[]
}

export type IncomingBlock = 'unknown_signer'

export interface IncomingMoment extends MomentView {
  /** False when the proposer is not in Peers (「签名者不在朋友列表」). */
  canAccept: boolean
  blocked: IncomingBlock | null
}

export interface OutgoingMoment extends MomentView {
  status: 'pending' | 'declined'
}

export interface DroppedMoment {
  index: number
  momentId: string | null
  reason: MomentRejectReason
}

export interface MomentsSyncResult {
  /** Pending, proposed to me, proposer signature verified. */
  incoming: IncomingMoment[]
  /** Pending / declined moments I proposed (verified). */
  outgoing: OutgoingMoment[]
  /** Declined moments proposed to me. */
  declinedByMe: MomentView[]
  /** Accepted + both signatures verified, written to the local store. */
  accepted: LocalMoment[]
  /** Rows that failed offline verification (not shown, not stored). */
  dropped: DroppedMoment[]
  /** Locally stored moments the server no longer lists (probably deleted by the other side). */
  remoteMissing: string[]
}

export interface MomentProposeArgs {
  friendFingerprint: string
  title: string
  start: string
  end: string
  place: string | null
  note: string
  visibility: MomentVisibility
}

export interface MomentProposePreview {
  previewId: string
  /** The exact object that will be signed (all fields except `signature`). */
  moment: MomentUnsigned
  /** UTF-8 that will be signed: `persome-moment-v1\n` + canonical JSON. */
  signingText: string
  friendName: string | null
  expiresAt: string
}

export interface MomentProposed {
  momentId: string
  status: 'pending'
  /** The signed moment text that was sent. */
  momentText: string
}

export interface MomentAcceptPreview {
  previewId: string
  moment: MomentView
  acceptance: AcceptanceUnsigned
  signingText: string
  expiresAt: string
}

export interface MomentsApiFragment {
  moments: {
    local(): Promise<CloudResult<LocalMomentsResult>>
    sync(): Promise<CloudResult<MomentsSyncResult>>
    proposePreview(args: MomentProposeArgs): Promise<CloudResult<MomentProposePreview>>
    propose(previewId: string): Promise<CloudResult<MomentProposed>>
    acceptPreview(momentId: string): Promise<CloudResult<MomentAcceptPreview>>
    accept(previewId: string): Promise<CloudResult<LocalMoment>>
    discardPreview(previewId: string): Promise<CloudResult<boolean>>
    decline(momentId: string): Promise<CloudResult<{ status: 'declined' }>>
    remove(momentId: string): Promise<CloudResult<{ remote: boolean; local: boolean }>>
    forgetLocal(momentId: string): Promise<CloudResult<{ local: boolean }>>
    setNote(momentId: string, text: string): Promise<CloudResult<LocalMoment>>
  }
}
