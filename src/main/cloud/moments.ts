// S1-FULL C18 — shared moments (共同经历), Lens side. Main only; network only via client.ts.
//
// - No inference: a moment exists only because the user proposed it to one friend from Peers.
// - Propose: main builds the unsigned moment from the user's fields, parks it under a previewId and
//   returns the exact bytes to be signed → native confirm → KeyManager.sign → self-verify → POST
//   exactly that text.
// - Incoming: proposer signature verified offline AND the proposer must be in Peers; otherwise it is
//   listed as 「签名者不在朋友列表」 and cannot be accepted.
// - Accept: acceptance over the sha256 of the exact moment text the user saw → confirm → sign → POST.
// - Accepted moments: both signatures verified offline, stored `<LensStore>/moments/<id>.json`.
// - Delete: confirm (it disappears for both) → DELETE → local removal.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { CloudError } from './errors'
import { identityFingerprint, type CloudConfirm } from './service'
import { confirmOrCancel, createPreviewStore, mapStatus, requireReady, type CloudHandle } from './subs-common'
import {
  deleteNote,
  MOMENT_ID_RE,
  MOMENT_LIMITS,
  VISIBILITY_LABEL,
  type AcceptanceUnsigned,
  type DroppedMoment,
  type LocalMoment,
  type LocalMomentsResult,
  type MomentAcceptPreview,
  type MomentProposeArgs,
  type MomentProposePreview,
  type MomentProposed,
  type MomentsSyncResult,
  type MomentUnsigned,
  type MomentView
} from './moments-api'
import { acceptanceSigningText, isCalendarDate, momentSigningText, signAcceptance, signMoment, verifyAcceptanceText, verifyAcceptedPair, verifyMomentText } from './moments-sign'
import { createMomentsStore, MomentStoreError, momentView, peerNames, type MomentsStore } from './moments-store'

export interface MomentsDeps {
  storeRoot: string
  cloud: CloudHandle
  getPublicIdentity: () => { public_key: string } | null
  sign: (message: Buffer) => Buffer
  nativeConfirm?: CloudConfirm
  now?: () => Date
  randomHex?: (bytes: number) => string
  randomUuid?: () => string
  /** C17 publisher: a moment I proposed was newly accepted by the friend (first seen in sync). No text. */
  onMomentAccepted?: (id: string, items: Array<{ id: string; evidence: string }>) => void
}

export interface MomentsService {
  store: MomentsStore
  local(): LocalMomentsResult
  sync(): Promise<MomentsSyncResult>
  proposePreview(args: MomentProposeArgs): MomentProposePreview
  propose(previewId: string, sender: unknown): Promise<MomentProposed>
  acceptPreview(momentId: string): MomentAcceptPreview
  accept(previewId: string, sender: unknown): Promise<LocalMoment>
  discardPreview(previewId: string): boolean
  decline(momentId: string, sender: unknown): Promise<{ status: 'declined' }>
  remove(momentId: string, sender: unknown): Promise<{ remote: boolean; local: boolean }>
  forgetLocal(momentId: string, sender: unknown): Promise<{ local: boolean }>
  setNote(momentId: string, text: string): LocalMoment
}

const PREVIEW_TTL_MS = 15 * 60_000
const RETRYABLE = new Set(['network', 'timeout', 'server', 'rate_limited'])

const Iso = z.string().min(1).max(64).refine((s) => Number.isFinite(Date.parse(s)))
const RowSchema = z.object({
  moment_id: z.string().max(64),
  status: z.enum(['pending', 'accepted', 'declined']),
  moment: z.string().min(1).max(64 * 1024),
  acceptance: z.string().min(1).max(8 * 1024).nullable().optional(),
  updated_at: Iso.nullable().optional()
})
const ListSchema = z.array(RowSchema).max(MOMENT_LIMITS.maxServerRows)
const PostSchema = z.object({ moment_id: z.string().regex(MOMENT_ID_RE), status: z.literal('pending') })
const AcceptSchema = z.object({ status: z.literal('accepted') })
const DeclineSchema = z.object({ status: z.literal('declined') })

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000)
}

function storeError(e: unknown): never {
  if (e instanceof MomentStoreError) {
    if (e.code === 'no_identity') throw new CloudError('no_identity')
    if (e.code === 'not_found') throw new CloudError('not_found')
    throw new CloudError('signature_invalid')
  }
  throw e
}

export function createMomentsService(deps: MomentsDeps): MomentsService {
  const now = deps.now ?? (() => new Date())
  const uuid = deps.randomUuid ?? (() => randomUUID())
  const store = createMomentsStore({ storeRoot: deps.storeRoot, me: () => identityFingerprint(deps.getPublicIdentity), now })
  const proposals = createPreviewStore<{ unsigned: MomentUnsigned; busy: boolean }>({ ttlMs: PREVIEW_TTL_MS, max: 8, now, randomHex: deps.randomHex })
  const accepts = createPreviewStore<{ unsigned: AcceptanceUnsigned; momentText: string; busy: boolean }>({ ttlMs: PREVIEW_TTL_MS, max: 8, now, randomHex: deps.randomHex })
  /** Verified pending moments proposed to me, from the last sync (accept needs the exact text). */
  const incomingTexts = new Map<string, string>()

  function identity(): { public_key: string; fingerprint: string } {
    const fp = identityFingerprint(deps.getPublicIdentity)
    const id = fp ? deps.getPublicIdentity() : null
    if (!fp || !id) throw new CloudError('no_identity')
    return { public_key: id.public_key, fingerprint: fp }
  }

  function checkId(momentId: string): void {
    if (!MOMENT_ID_RE.test(momentId)) throw new CloudError('invalid_args')
  }

  return {
    store,

    local: () => store.list(),

    async sync() {
      requireReady(deps.cloud)
      const me = identity().fingerprint
      const rows = await deps.cloud.client.requestJson('GET', '/v1/moments', undefined, ListSchema)
      const names = peerNames(deps.storeRoot)
      const result: MomentsSyncResult = { incoming: [], outgoing: [], declinedByMe: [], accepted: [], dropped: [], remoteMissing: [] }
      const seen = new Set<string>()
      incomingTexts.clear()
      for (const [index, row] of rows.entries()) {
        const drop = (reason: DroppedMoment['reason'], momentId: string | null): void => void result.dropped.push({ index, momentId, reason })
        const v = verifyMomentText(row.moment, me)
        if (!v.valid) {
          drop(v.reason, v.momentId)
          continue
        }
        const m = v.moment
        if (m.moment_id !== row.moment_id) {
          drop('mismatch', m.moment_id)
          continue
        }
        seen.add(m.moment_id)
        const view = momentView(m, me, names)
        if (row.status === 'accepted') {
          if (!row.acceptance) {
            drop('schema', m.moment_id)
            continue
          }
          const a = verifyAcceptanceText(row.acceptance, v)
          if (!a.valid) {
            drop(a.reason, m.moment_id)
            continue
          }
          try {
            const isNew = !store.ids().includes(m.moment_id)
            result.accepted.push(store.save(row.moment, row.acceptance))
            if (isNew && view.iAmProposer) {
              try {
                deps.onMomentAccepted?.(m.moment_id, [{ id: m.moment_id, evidence: `moment:${view.start}` }])
              } catch {
                // a proactive publisher must never break sync
              }
            }
          } catch {
            drop('signature', m.moment_id)
          }
        } else if (view.iAmProposer) {
          result.outgoing.push({ ...view, status: row.status })
        } else if (row.status === 'pending') {
          // Accepting requires the proposer to be a friend whose card I verified (same key ⇔ same fingerprint).
          const known = names.has(m.proposer.fingerprint)
          incomingTexts.set(m.moment_id, row.moment)
          result.incoming.push({ ...view, canAccept: known, blocked: known ? null : 'unknown_signer' })
        } else {
          result.declinedByMe.push(view)
        }
      }
      result.remoteMissing = store.ids().filter((id) => !seen.has(id))
      const byDate = (a: MomentView, b: MomentView): number => b.start.localeCompare(a.start) || a.momentId.localeCompare(b.momentId)
      result.incoming.sort(byDate)
      result.outgoing.sort(byDate)
      result.accepted.sort(byDate)
      return result
    },

    proposePreview(args) {
      const me = identity()
      const title = args.title.trim()
      const place = args.place?.trim() ? args.place.trim() : null
      if (!title || title.length > MOMENT_LIMITS.maxTitleChars || /[\r\n\u2028\u2029]/.test(title)) throw new CloudError('invalid_args', { detail: tr('Title must be 1–200 characters on one line', '标题需要 1–200 字、单行') })
      if (args.note.length > MOMENT_LIMITS.maxNoteChars) throw new CloudError('invalid_args', { detail: tr('Note can be at most 4000 characters', '附言最多 4000 字') })
      if (place && (place.length > MOMENT_LIMITS.maxPlaceChars || /[\r\n]/.test(place))) throw new CloudError('invalid_args', { detail: tr('Place can be at most 200 characters on one line', '地点最多 200 字、单行') })
      if (!isCalendarDate(args.start) || !isCalendarDate(args.end) || args.start > args.end) throw new CloudError('invalid_args', { detail: tr('Invalid dates (start cannot be after end)', '日期无效（开始不能晚于结束）') })
      if (daysBetween(args.start, args.end) > MOMENT_LIMITS.maxRangeDays) throw new CloudError('invalid_args', { detail: tr('The date range can be at most one year', '日期范围最长一年') })
      if (args.friendFingerprint === me.fingerprint) throw new CloudError('invalid_args', { detail: tr('You cannot create a shared moment with yourself', '不能和自己创建共同经历') })
      const names = peerNames(deps.storeRoot)
      if (!names.has(args.friendFingerprint)) throw new CloudError('not_friend')
      const participants = [me.fingerprint, args.friendFingerprint].sort() as [string, string]
      const unsigned: MomentUnsigned = {
        version: 1,
        kind: 'persome-moment',
        moment_id: uuid(),
        title,
        note: args.note,
        occurred_on: { start: args.start, end: args.end },
        place,
        participants,
        visibility: args.visibility,
        proposer: { public_key: me.public_key, fingerprint: me.fingerprint },
        created_at: now().toISOString()
      }
      let signingText: string
      try {
        signingText = momentSigningText(unsigned)
      } catch {
        throw new CloudError('invalid_args', { detail: tr('The content contains characters that cannot be signed', '内容含有无法签名的字符') })
      }
      const { id, expiresAt } = proposals.put({ unsigned, busy: false })
      return { previewId: id, moment: unsigned, signingText, friendName: names.get(args.friendFingerprint) ?? null, expiresAt }
    },

    async propose(previewId, sender) {
      const stored = proposals.get(previewId)
      if (!stored) throw new CloudError('not_found')
      const base = requireReady(deps.cloud)
      const me = identity()
      const u = stored.unsigned
      if (me.fingerprint !== u.proposer.fingerprint || me.public_key !== u.proposer.public_key) throw new CloudError('no_identity')
      const friend = u.participants[0] === me.fingerprint ? u.participants[1] : u.participants[0]
      const names = peerNames(deps.storeRoot)
      if (!names.has(friend)) throw new CloudError('not_friend')
      if (stored.busy) throw new CloudError('busy')
      stored.busy = true
      try {
        await confirmOrCancel(deps.nativeConfirm, sender, {
          message: tr('Sign and send this shared moment?', '签名并发出这条共同经历？'),
          detail: tr(
            `"${u.title}" (${u.occurred_on.start}${u.occurred_on.end !== u.occurred_on.start ? ` to ${u.occurred_on.end}` : ''}) will be signed with your identity and sent through ${base} to ${names.get(friend) ?? friend.slice(0, 8)} for them to confirm. ` +
              `Visibility: ${VISIBILITY_LABEL[u.visibility]}. The server operator can see the title, dates, place and note.`,
            `「${u.title}」（${u.occurred_on.start}${u.occurred_on.end !== u.occurred_on.start ? ` 至 ${u.occurred_on.end}` : ''}）会用你的身份签名，经 ${base} 发给 ${names.get(friend) ?? friend.slice(0, 8)}，等 TA 确认。` +
              `可见范围：${VISIBILITY_LABEL[u.visibility]}。服务器运营方能看到标题、日期、地点和附言。`
          ),
          confirmLabel: tr('Sign and send', '签名并发出')
        })
        let signed: { text: string }
        try {
          signed = signMoment(u, deps.sign)
        } catch {
          throw new CloudError('no_identity')
        }
        if (!verifyMomentText(signed.text, me.fingerprint).valid) throw new CloudError('no_identity')
        let res: z.infer<typeof PostSchema>
        try {
          res = await deps.cloud.client.requestJson('POST', '/v1/moments', { moment: signed.text }, PostSchema)
        } catch (e) {
          if (!(e instanceof CloudError && RETRYABLE.has(e.code))) proposals.delete(previewId)
          mapStatus(e, { 400: 'moment_invalid', 403: 'moment_not_owner', 409: 'moment_conflict' })
        }
        proposals.delete(previewId)
        if (res.moment_id !== u.moment_id) throw new CloudError('bad_response')
        return { momentId: res.moment_id, status: 'pending', momentText: signed.text }
      } finally {
        stored.busy = false
      }
    },

    acceptPreview(momentId) {
      checkId(momentId)
      const me = identity()
      const text = incomingTexts.get(momentId)
      if (!text) throw new CloudError('not_found', { detail: tr('Please refresh first', '请先刷新') })
      const v = verifyMomentText(text, me.fingerprint)
      if (!v.valid || v.moment.proposer.fingerprint === me.fingerprint) throw new CloudError('signature_invalid')
      const names = peerNames(deps.storeRoot)
      if (!names.has(v.moment.proposer.fingerprint)) throw new CloudError('unknown_signer')
      const unsigned: AcceptanceUnsigned = {
        version: 1,
        kind: 'persome-moment-accept',
        moment_id: v.moment.moment_id,
        moment_sha256: v.sha256,
        accepter: { public_key: me.public_key, fingerprint: me.fingerprint },
        accepted_at: now().toISOString()
      }
      const { id, expiresAt } = accepts.put({ unsigned, momentText: text, busy: false })
      return { previewId: id, moment: momentView(v.moment, me.fingerprint, names), acceptance: unsigned, signingText: acceptanceSigningText(unsigned), expiresAt }
    },

    async accept(previewId, sender) {
      const stored = accepts.get(previewId)
      if (!stored) throw new CloudError('not_found')
      const base = requireReady(deps.cloud)
      const me = identity()
      const u = stored.unsigned
      if (me.fingerprint !== u.accepter.fingerprint || me.public_key !== u.accepter.public_key) throw new CloudError('no_identity')
      const v = verifyMomentText(stored.momentText, me.fingerprint)
      if (!v.valid || v.sha256 !== u.moment_sha256) throw new CloudError('signature_invalid')
      if (!peerNames(deps.storeRoot).has(v.moment.proposer.fingerprint)) throw new CloudError('unknown_signer')
      if (stored.busy) throw new CloudError('busy')
      stored.busy = true
      try {
        await confirmOrCancel(deps.nativeConfirm, sender, {
          message: tr('Confirm this shared moment?', '确认这条共同经历？'),
          detail: tr(
            `You will sign "${v.moment.title}" with your own identity and send the confirmation through ${base} to them. After that, both of you keep this shared moment on your own Mac. Visibility: ${VISIBILITY_LABEL[v.moment.visibility]}.`,
            `你会用自己的身份签名确认「${v.moment.title}」，经 ${base} 发给对方。确认后双方都会在本机保存这条共同经历。可见范围：${VISIBILITY_LABEL[v.moment.visibility]}。`
          ),
          confirmLabel: tr('Sign and confirm', '签名确认')
        })
        let signed: { text: string }
        try {
          signed = signAcceptance(u, deps.sign)
        } catch {
          throw new CloudError('no_identity')
        }
        if (!verifyAcceptedPair(stored.momentText, signed.text, me.fingerprint).valid) throw new CloudError('no_identity')
        try {
          await deps.cloud.client.requestJson('POST', `/v1/moments/${u.moment_id}/accept`, { acceptance: signed.text }, AcceptSchema)
        } catch (e) {
          if (!(e instanceof CloudError && RETRYABLE.has(e.code))) accepts.delete(previewId)
          mapStatus(e, { 400: 'acceptance_invalid', 403: 'not_participant', 404: 'not_found', 409: 'moment_conflict' })
        }
        accepts.delete(previewId)
        incomingTexts.delete(u.moment_id)
        try {
          return store.save(stored.momentText, signed.text)
        } catch (e) {
          storeError(e)
        }
      } finally {
        stored.busy = false
      }
    },

    discardPreview: (previewId) => proposals.delete(previewId) || accepts.delete(previewId),

    async decline(momentId, sender) {
      checkId(momentId)
      requireReady(deps.cloud)
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Decline this shared moment?', '拒绝这条共同经历？'),
        detail: tr('They will see that you declined. You cannot confirm it afterwards; they would need to propose it again.', '对方会看到你拒绝了。拒绝后不能再确认，需要对方重新发起。'),
        confirmLabel: tr('Decline', '拒绝')
      })
      try {
        await deps.cloud.client.requestJson('POST', `/v1/moments/${momentId}/decline`, {}, DeclineSchema)
      } catch (e) {
        mapStatus(e, { 403: 'not_participant', 404: 'not_found', 409: 'moment_conflict' })
      }
      incomingTexts.delete(momentId)
      return { status: 'declined' }
    },

    async remove(momentId, sender) {
      checkId(momentId)
      requireReady(deps.cloud)
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Delete this shared moment?', '删除这条共同经历？'),
        detail: deleteNote(),
        confirmLabel: tr('Delete (hidden for both of you)', '删除（双方都看不到）')
      })
      let remote = true
      try {
        await deps.cloud.client.requestEmpty('DELETE', `/v1/moments/${momentId}`)
      } catch (e) {
        // Already gone on the server (e.g. the other side deleted it): still remove our copy.
        if (e instanceof CloudError && e.status === 404) remote = false
        else mapStatus(e, { 403: 'not_participant' })
      }
      incomingTexts.delete(momentId)
      return { remote, local: store.remove(momentId) }
    },

    async forgetLocal(momentId, sender) {
      checkId(momentId)
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Delete this shared moment from this Mac?', '从本机删除这条共同经历？'),
        detail: tr('Only the copy saved on this Mac and your own notes are deleted. Nothing goes online, and the cloud and the other person are not affected.', '只删除本机保存的副本和你写的话，不联网，不影响云端或对方。'),
        confirmLabel: tr('Delete from this Mac', '从本机删除')
      })
      return { local: store.remove(momentId) }
    },

    setNote(momentId, text) {
      checkId(momentId)
      try {
        return store.setNote(momentId, text)
      } catch (e) {
        storeError(e)
      }
    }
  }
}
