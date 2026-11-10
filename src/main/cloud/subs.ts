// S1-FULL C10 — Subscriptions (Lens side): weekly letter by email, subscribers, friends' letters.
// Main only; network only via client.ts (this file never calls the network directly).
//
// - Draft: the deterministic peers/letter.ts template (no LLM) over the LOCAL Runtime's
//   recent_activity, re-addressed to subscribers (broadcastLetter). The user edits title/markdown.
// - Preview: main builds the unsigned envelope from {title, markdown, week} and parks it under a
//   previewId; the renderer sees exactly the bytes that will be signed. The renderer never sends a
//   signature or envelope text.
// - Publish: native confirm in main → KeyManager.sign → self-verify → POST exactly that envelope.
// - Friends' letters: GET by fingerprint → offline verify each (signature + signer == requested
//   fingerprint) → forged ones dropped and reported → verified ones cached in
//   `<LensStore>/cloud-letters/<fp>/<issue_id>.json` (0600, dirs 0700), re-verified on every read.
import { randomUUID } from 'node:crypto'
import { redactForCloud } from './context'
import { tr } from '../../shared/i18n'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { MemorySearchHit } from '../../shared/types'
import { buildLetter, letterWindow, addDays, experienceLine, experienceNoteLine, peerName, type LetterExperience } from '../peers/letter'
import { createMomentsStore, letterMoments } from './moments-store'
import { ensureSecureDir, readFileIfExists, writeFileSecure } from '../store/paths'
import { canonicalize } from '../identity/canonical'
import { CloudError } from './errors'
import { identityFingerprint, type CloudConfirm } from './service'
import { UUID_RE, isoWeek, letterSigningText, signLetter, verifyLetterText, type LetterEnvelope } from './letter-sign'
import {
  FINGERPRINT_RE,
  LETTER_LIMITS,
  noTrackingNote,
  SERVER_ID_RE,
  WEEK_RE,
  type CachedLettersResult,
  type DroppedLetter,
  type FriendLetter,
  type FriendLettersResult,
  type LetterDelivery,
  type LetterEnvelopeUnsigned,
  type LetterPreview,
  type LetterPublished,
  type PublishedLetter,
  type SubscribeLink,
  type Subscriber,
  type SubsLetterDraft,
  type SubsLetterMoment
} from './subs-api'
import { confirmOrCancel, createPreviewStore, mapStatus, requireReady, type CloudHandle } from './subs-common'

export interface SubsDeps {
  storeRoot: string
  cloud: CloudHandle
  /** KeyManager.getPublicIdentity (`public_key`; the fingerprint is recomputed from it). */
  getPublicIdentity: () => { public_key: string } | null
  /** KeyManager.sign. The private key never leaves keys.ts. */
  sign: (message: Buffer) => Buffer
  /** Local Runtime MCP (stdio). Absent / failing ⇒ the draft says so; nothing is invented. */
  ossTool?: (name: string, args: Record<string, unknown>) => Promise<string>
  /** Runtime secrets scrubbed verbatim from the draft (production: knownRuntimeSecrets). */
  knownSecrets?: () => readonly string[]
  nativeConfirm?: CloudConfirm
  now?: () => Date
  randomHex?: (bytes: number) => string
  randomUuid?: () => string
}

export interface SubsService {
  letterDraft(args: { timezone: string }): Promise<SubsLetterDraft>
  letterPreview(args: { title: string; markdown: string; week: string }): LetterPreview
  letterDiscard(previewId: string): boolean
  letterPublish(previewId: string, sender: unknown): Promise<LetterPublished>
  letters(): Promise<PublishedLetter[]>
  deliveries(letterId: string): Promise<LetterDelivery[]>
  subscribers(): Promise<Subscriber[]>
  removeSubscriber(subscriberId: string, sender: unknown): Promise<boolean>
  subscribeLink(): SubscribeLink
  friendLetters(fingerprint: string): Promise<FriendLettersResult>
  cachedLetters(fingerprint: string): CachedLettersResult
}

export const LETTER_CACHE_DIR = 'cloud-letters'
const PREVIEW_TTL_MS = 15 * 60_000
/** Errors after which the same signed envelope may be retried (the server dedupes by issue_id). */
const RETRYABLE = new Set(['network', 'timeout', 'server', 'rate_limited'])
const BROADCAST_NAME = '各位朋友'

const Iso = z.string().min(1).max(64).refine((s) => Number.isFinite(Date.parse(s)))
const ServerId = z.string().regex(SERVER_ID_RE)
const Count = z.number().int().nonnegative()
const PostSchema = z.object({ letter_id: ServerId, issue_id: z.string().regex(UUID_RE), recipients: Count })
const LettersSchema = z
  .array(
    z.object({
      letter_id: ServerId,
      issue_id: z.string().max(64),
      week: z.string().max(16),
      title: z.string().max(1000),
      created_at: Iso,
      counts: z.object({ queued: Count, sent: Count, failed: Count, suppressed: Count })
    })
  )
  .max(1000)
const DeliveriesSchema = z
  .array(
    z.object({
      subscriber_id: ServerId,
      email_masked: z.string().max(320),
      status: z.string().max(32),
      attempts: Count,
      updated_at: Iso.nullable().optional(),
      error_code: z.string().max(64).nullable().optional()
    })
  )
  .max(10_000)
const SubscribersSchema = z
  .array(
    z.object({
      subscriber_id: ServerId,
      email_masked: z.string().max(320),
      status: z.enum(['pending', 'confirmed']),
      created_at: Iso,
      confirmed_at: Iso.nullable().optional()
    })
  )
  .max(10_000)
const ByFingerprintSchema = z.array(z.object({ letter: z.string().min(1).max(200_000), published_at: Iso.nullable().optional() })).max(100)
const CacheFileSchema = z.strictObject({ version: z.literal(1), fetched_at: Iso, published_at: Iso.nullable(), letter: z.string().min(1).max(200_000) })

/** recent_activity → `{entries}` (bare array tolerated); malformed entries are skipped. */
export function parseRecent(text: string): MemorySearchHit[] {
  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.entries
  if (!Array.isArray(list)) throw new Error('not a list')
  return list.filter((e): e is MemorySearchHit => !!e && typeof e === 'object' && typeof (e as MemorySearchHit).id === 'string' && typeof (e as MemorySearchHit).content === 'string')
}

/**
 * Re-address the per-friend template to subscribers: drop the H1 (the title is separate), the
 * friend-card section and the friend-card footer lines; fix the "never sent" disclaimer.
 * Deterministic and line-based.
 */
export function broadcastLetter(markdown: string): string {
  const out: string[] = []
  let skipping = false
  const lines = markdown.split('\n')
  for (const [i, line] of lines.entries()) {
    if (i === 0 && line.startsWith('# ')) continue
    if (i === 1 && line === '' && out.length === 0) continue
    if (line.startsWith('## ')) skipping = line === '## 和你的卡片有关的'
    if (skipping) continue
    if (line.startsWith('- 来源 search') || line.startsWith('- 对方卡片：')) continue
    out.push(line.replace('不会发送到任何地方。', '只有你确认发布后才会签名发给订阅者。'))
  }
  return out.join('\n')
}

function friendView(env: LetterEnvelope, publishedAt: string | null): FriendLetter {
  return {
    issueId: env.issue_id,
    week: env.week,
    title: env.title,
    markdown: env.markdown,
    createdAt: env.created_at,
    publishedAt,
    signerFingerprint: env.signer.fingerprint
  }
}

export function createSubsService(deps: SubsDeps): SubsService {
  const now = deps.now ?? (() => new Date())
  const uuid = deps.randomUuid ?? (() => randomUUID())
  const previews = createPreviewStore<{ unsigned: LetterEnvelopeUnsigned; busy: boolean }>({ ttlMs: PREVIEW_TTL_MS, max: 8, now, randomHex: deps.randomHex })
  const cacheRoot = path.join(deps.storeRoot, LETTER_CACHE_DIR)

  function identity(): { public_key: string; fingerprint: string } {
    const fp = identityFingerprint(deps.getPublicIdentity)
    const id = fp ? deps.getPublicIdentity() : null
    if (!fp || !id) throw new CloudError('no_identity')
    return { public_key: id.public_key, fingerprint: fp }
  }

  function cacheDir(fp: string): string {
    if (!FINGERPRINT_RE.test(fp)) throw new CloudError('invalid_args')
    return path.join(cacheRoot, fp)
  }

  /** Verified cache entries for `fp`, newest created_at first. */
  function readCache(fp: string): { letters: Array<{ view: FriendLetter; file: string }>; unreadable: number } {
    const dir = cacheDir(fp)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n) && UUID_RE.test(n.slice(0, 36)))
    } catch {
      return { letters: [], unreadable: 0 }
    }
    const letters: Array<{ view: FriendLetter; file: string }> = []
    let unreadable = 0
    for (const n of names) {
      const file = path.join(dir, n)
      try {
        const raw = readFileIfExists(file)
        const parsed = raw ? CacheFileSchema.safeParse(JSON.parse(raw.toString('utf8'))) : null
        const v = parsed?.success ? verifyLetterText(parsed.data.letter, fp) : null
        if (!parsed?.success || !v?.valid || `${v.envelope.issue_id}.json` !== n) {
          unreadable++
          continue
        }
        letters.push({ view: friendView(v.envelope, parsed.data.published_at), file })
      } catch {
        unreadable++
      }
    }
    letters.sort((a, b) => b.view.createdAt.localeCompare(a.view.createdAt) || a.view.issueId.localeCompare(b.view.issueId))
    return { letters, unreadable }
  }

  function writeCache(fp: string, env: LetterEnvelope, text: string, publishedAt: string | null): void {
    ensureSecureDir(cacheRoot)
    const dir = cacheDir(fp)
    ensureSecureDir(dir)
    const body = { version: 1, fetched_at: now().toISOString(), published_at: publishedAt, letter: text }
    writeFileSecure(path.join(dir, `${env.issue_id}.json`), `${JSON.stringify(body, null, 2)}\n`)
  }

  function pruneCache(fp: string): void {
    const { letters } = readCache(fp)
    // Only verified, uuid-named files inside <cacheRoot>/<fp>/ are ever removed.
    for (const old of letters.slice(LETTER_LIMITS.maxCachedPerFriend)) {
      if (path.dirname(old.file) === cacheDir(fp)) fs.rmSync(old.file, { force: true })
    }
  }

  return {
    async letterDraft({ timezone }) {
      const id = identity()
      const at = now()
      let range: { start: string; end: string }
      try {
        range = letterWindow(at, timezone)
      } catch {
        throw new CloudError('invalid_args', { detail: tr('Invalid time zone', '时区无效') })
      }
      const since = addDays(range.start, -1)
      let recent: MemorySearchHit[] | null = null
      let recentError: string | null = null
      if (!deps.ossTool) recentError = '本机 Persome Runtime 不可用'
      else {
        try {
          recent = parseRecent(await deps.ossTool('recent_activity', { since, limit: 200 }))
        } catch {
          // Fixed text only: raw errors can carry local paths and must not end up in an email.
          recentError = '本机 Persome Runtime 不可用'
        }
      }
      // S1-FULL C11: only accepted shared moments, both signatures re-verified offline, visibility
      // `letters`, overlapping the window. `private` / pending / unverified never appear.
      let experiences: Array<LetterExperience & { note: string | null }> = []
      let experiencesError: string | null = null
      try {
        const local = createMomentsStore({ storeRoot: deps.storeRoot, me: () => id.fingerprint, now }).list()
        experiences = letterMoments(local.moments, range).map((m) => ({
          momentId: m.momentId,
          title: m.title,
          start: m.start,
          end: m.end,
          friend: peerName({ displayName: m.friendName, fingerprint: m.friendFingerprint }),
          note: m.myNote
        }))
      } catch {
        experiencesError = '本机共同经历读取失败'
      }
      const draft = buildLetter({
        now: at,
        timezone,
        peer: { fingerprint: id.fingerprint, displayName: BROADCAST_NAME, cardId: '—', cardIssuedAt: '—' },
        recent,
        recentError,
        experiences,
        experiencesError,
        audience: 'broadcast'
      })
      const week = isoWeek(range.end)
      const warnings: string[] = []
      // Phase 2 gate finding: the draft quotes local memory verbatim and is mailed to every subscriber.
      // Same redaction as the cloud chat context (secrets, emails, home / Runtime paths, image data,
      // CN phone / ID numbers). Names and free text are NOT caught: the user still reviews every line.
      let known: readonly string[] = []
      try {
        known = deps.knownSecrets?.() ?? []
      } catch {
        known = []
      }
      const red = redactForCloud(broadcastLetter(draft.markdown), known)
      const markdown = red.dropped ? '（草稿内容看起来像密钥 / 环境变量，已整段省略，请自己写。）\n' : red.text
      if (red.dropped) warnings.push(tr('The whole draft looks like a key or environment variables, so it was left out.', '草稿整段像密钥或环境变量，已省略。'))
      else if (red.redactions > 0) warnings.push(
          tr(
            `Automatically redacted ${red.redactions} item(s) (keys, emails, local paths, images, phone / ID numbers). Names and ordinary text are not redacted.`,
            `已自动脱敏 ${red.redactions} 处（密钥、邮箱、本机路径、图片、手机号 / 身份证号）；人名和普通文字不会被脱敏。`
          )
        )
      if (recentError) warnings.push(tr('Could not read recent activity on this Mac: the "what I worked on this week" section is empty, and nothing was made up.', '读取本机最近活动失败：「这周我在做的事」这一节是空的，没有编造任何内容。'))
      if (draft.counts.inWindow > 0) warnings.push(tr('The draft quotes your local memory word for word, including paths and entry ids. Check every line before publishing and remove anything subscribers should not see.', '草稿逐字引用了你本机记忆的原文、路径和条目 id，发布前请逐行检查并删掉不想让订阅者看到的内容。'))
      if (/<!--/.test(draft.markdown)) warnings.push(tr('The draft has <!-- --> placeholders. Write them yourself or delete them.', '草稿里有 <!-- --> 占位，需要你自己写或删掉。'))
      const moments: SubsLetterMoment[] = red.dropped
        ? []
        : experiences.map((e) => {
            const r = redactForCloud(experienceLine(e, 'broadcast'), known)
            const line = !r.dropped && markdown.split('\n').includes(r.text) ? r.text : null
            const n = e.note ? redactForCloud(experienceNoteLine(e.note), known) : null
            return { momentId: e.momentId, title: e.title, start: e.start, end: e.end, friend: e.friend, line, noteLine: n && !n.dropped ? n.text : null }
          })
      if (moments.length) warnings.push(
          tr(
            `Listed ${moments.length} shared moment(s) signed by both of you and allowed in weekly letters. Your own notes are not attached by default; tick each one below to include it.`,
            `列出了 ${moments.length} 条双方签名确认、允许写进周信的共同经历；你自己写的话默认不附上，需要在下面逐条勾选。`
          )
        )
      return {
        title: `每周信 · ${week}`,
        markdown,
        week,
        range: draft.range,
        timezone,
        counts: { inWindow: draft.counts.inWindow, recentTotal: draft.counts.recentTotal, undated: draft.counts.undated },
        warnings,
        moments
      }
    },

    letterPreview({ title, markdown, week }) {
      const t = title.trim()
      if (!t || t.length > LETTER_LIMITS.maxTitleChars || !markdown.trim() || markdown.length > LETTER_LIMITS.maxMarkdownChars || !WEEK_RE.test(week)) {
        throw new CloudError('invalid_args')
      }
      const id = identity()
      const unsigned: LetterEnvelopeUnsigned = {
        version: 1,
        kind: 'persome-letter',
        issue_id: uuid(),
        week,
        title: t,
        markdown,
        created_at: now().toISOString(),
        signer: { public_key: id.public_key, fingerprint: id.fingerprint }
      }
      let signingText: string
      try {
        signingText = letterSigningText(unsigned)
      } catch {
        throw new CloudError('invalid_args', { detail: tr('The body contains characters that cannot be signed', '正文含有无法签名的字符') })
      }
      const bodyBytes = Buffer.byteLength(JSON.stringify({ letter: canonicalize({ ...unsigned, signature: 'A'.repeat(86) }) }), 'utf8')
      if (bodyBytes > LETTER_LIMITS.maxBodyBytes) throw new CloudError('invalid_args', { detail: tr('The weekly letter is too long (over 60 KiB to send). Please shorten it', '周信太长（发送内容超过 60 KiB），请删减') })
      const { id: previewId, expiresAt } = previews.put({ unsigned, busy: false })
      return { previewId, envelope: unsigned, signingText, bodyBytes, expiresAt }
    },

    letterDiscard: (previewId) => previews.delete(previewId),

    async letterPublish(previewId, sender) {
      const stored = previews.get(previewId)
      if (!stored) throw new CloudError('not_found')
      const base = requireReady(deps.cloud)
      const id = identity()
      if (id.fingerprint !== stored.unsigned.signer.fingerprint || id.public_key !== stored.unsigned.signer.public_key) throw new CloudError('no_identity')
      if (stored.busy) throw new CloudError('busy')
      stored.busy = true
      try {
        const u = stored.unsigned
        await confirmOrCancel(deps.nativeConfirm, sender, {
          message: tr('Publish this issue of the weekly letter?', '发布这一期周信？'),
          detail: tr(
            `"${u.title}" (${u.week}) will be signed with your identity and sent through ${base} to every confirmed subscriber. ${noTrackingNote()}. It cannot be recalled once sent.`,
            `「${u.title}」（${u.week}）会用你的身份签名，经 ${base} 发给所有已确认的订阅者。${noTrackingNote()}。发出后无法撤回。`
          ),
          confirmLabel: tr('Sign and publish', '签名并发布')
        })
        let signed: { envelope: LetterEnvelope; text: string }
        try {
          signed = signLetter(u, deps.sign)
        } catch {
          throw new CloudError('no_identity')
        }
        // Self-check with the same verifier friends use: never send something that would not verify.
        if (!verifyLetterText(signed.text, id.fingerprint).valid) throw new CloudError('no_identity')
        let res: z.infer<typeof PostSchema>
        try {
          res = await deps.cloud.client.requestJson('POST', '/v1/letters', { letter: signed.text }, PostSchema)
        } catch (e) {
          if (!(e instanceof CloudError && RETRYABLE.has(e.code))) previews.delete(previewId)
          mapStatus(e, { 400: 'letter_invalid', 403: 'letter_not_owner', 409: 'duplicate_issue' })
        }
        previews.delete(previewId)
        if (res.issue_id !== u.issue_id) throw new CloudError('bad_response')
        return { letterId: res.letter_id, issueId: res.issue_id, recipients: res.recipients, envelopeText: signed.text }
      } finally {
        stored.busy = false
      }
    },

    async letters() {
      requireReady(deps.cloud)
      const rows = await deps.cloud.client.requestJson('GET', '/v1/letters', undefined, LettersSchema)
      return rows.map((r) => ({ letterId: r.letter_id, issueId: r.issue_id, week: r.week, title: r.title, createdAt: r.created_at, counts: r.counts }))
    },

    async deliveries(letterId) {
      if (!SERVER_ID_RE.test(letterId)) throw new CloudError('invalid_args')
      requireReady(deps.cloud)
      let rows: z.infer<typeof DeliveriesSchema>
      try {
        rows = await deps.cloud.client.requestJson('GET', `/v1/letters/${letterId}/deliveries`, undefined, DeliveriesSchema)
      } catch (e) {
        mapStatus(e, { 404: 'not_found' })
      }
      return rows.map((r) => ({
        subscriberId: r.subscriber_id,
        emailMasked: r.email_masked,
        status: r.status,
        attempts: r.attempts,
        updatedAt: r.updated_at ?? null,
        errorCode: r.error_code ?? null
      }))
    },

    async subscribers() {
      requireReady(deps.cloud)
      const rows = await deps.cloud.client.requestJson('GET', '/v1/subscribers', undefined, SubscribersSchema)
      return rows.map((r) => ({ subscriberId: r.subscriber_id, emailMasked: r.email_masked, status: r.status, createdAt: r.created_at, confirmedAt: r.confirmed_at ?? null }))
    },

    async removeSubscriber(subscriberId, sender) {
      if (!SERVER_ID_RE.test(subscriberId)) throw new CloudError('invalid_args')
      requireReady(deps.cloud)
      await confirmOrCancel(deps.nativeConfirm, sender, {
        message: tr('Remove this subscriber?', '移除这位订阅者？'),
        detail: tr('The server will delete this email address and future weekly letters will not be sent to it. They can still subscribe again later.', '服务器会删除这个邮箱，之后的周信不再发给 TA。TA 以后仍可以重新订阅。'),
        confirmLabel: tr('Remove', '移除')
      })
      try {
        await deps.cloud.client.requestEmpty('DELETE', `/v1/subscribers/${subscriberId}`)
      } catch (e) {
        mapStatus(e, { 404: 'not_found' })
      }
      return true
    },

    subscribeLink() {
      const id = identity()
      const st = deps.cloud.status()
      if (!st.enabled || !st.baseUrl) throw new CloudError('disabled')
      return { url: `${st.baseUrl}/s/${id.fingerprint}`, fingerprint: id.fingerprint }
    },

    async friendLetters(fingerprint) {
      if (!FINGERPRINT_RE.test(fingerprint)) throw new CloudError('invalid_args')
      requireReady(deps.cloud)
      let rows: z.infer<typeof ByFingerprintSchema>
      try {
        rows = await deps.cloud.client.requestJson('GET', `/v1/letters/by/${fingerprint}`, undefined, ByFingerprintSchema)
      } catch (e) {
        mapStatus(e, { 404: 'not_found' })
      }
      const letters: FriendLetter[] = []
      const dropped: DroppedLetter[] = []
      let cached = 0
      for (const [index, row] of rows.slice(0, LETTER_LIMITS.maxFriendLetters).entries()) {
        const v = verifyLetterText(row.letter, fingerprint)
        if (!v.valid) {
          dropped.push({ index, reason: v.reason, issueId: v.issueId })
          continue
        }
        const publishedAt = row.published_at ?? null
        writeCache(fingerprint, v.envelope, row.letter, publishedAt)
        cached++
        letters.push(friendView(v.envelope, publishedAt))
      }
      if (cached) pruneCache(fingerprint)
      letters.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.issueId.localeCompare(b.issueId))
      return { fingerprint, letters, dropped, cached }
    },

    cachedLetters(fingerprint) {
      const { letters, unreadable } = readCache(fingerprint)
      return { fingerprint, letters: letters.map((l) => l.view), unreadable }
    }
  }
}
