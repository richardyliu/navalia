// 订阅 (Subscriptions) page view-model (S1-FULL C8 / C10): pure functions, tested by vitest (no DOM).
import type { CloudErrorCode, CloudStatus } from '../../../main/cloud/api'
import { tr } from '../../../shared/i18n'
import {
  LETTER_LIMITS,
  WEEK_RE,
  type CloudCardStatus,
  type DroppedLetter,
  type FriendCardFetched,
  type LetterCounts,
  type LetterRejectReason
} from '../../../main/cloud/subs-api'

export { noTrackingNote, cardAudienceNote } from '../../../main/cloud/subs-api'

export function serverVisibleNote(): string {
  return tr(
    'The server is not end-to-end encrypted: weekly letter text, subscriber emails and published cards are visible to the operator on the server.',
    '服务器不是端到端加密：周信正文、订阅者邮箱和发布的卡片在服务器上对运营方可见。'
  )
}
export function verifyNote(): string {
  return tr(
    "Friends' weekly letters and cards are verified offline on this Mac: anything with a bad signature, or signed by someone other than the fingerprint you asked for, is discarded.",
    '朋友的周信和卡片都在本机离线验签：签名不对、或签名者不是你要找的那个指纹，一律丢弃。'
  )
}

export type SubsGate = { state: 'loading' } | { state: 'off' | 'signed_out' | 'ready'; text: string }

/** Cloud OFF / signed out point to the Chat page, where the cloud setup panel lives. */
export function subsGate(status: CloudStatus | null | undefined): SubsGate {
  if (!status) return { state: 'loading' }
  if (!status.enabled || !status.baseUrl) return { state: 'off', text: tr(
        'Cloud is off (local mode stays offline). Turn it on below or in Cloud chat. Drafts and cached weekly letters from friends are still viewable on this Mac.',
        '云端未开启（本地模式不联网）。可以在下面开启，或到「云端对话」页设置。草稿和已缓存的朋友周信仍可在本机查看。'
      ) }
  if (!status.signedIn) return { state: 'signed_out', text: tr(`Cloud is on (${status.baseUrl}), but you are not signed in yet.`, `已开启云端（${status.baseUrl}），但还没有登录。`) }
  return { state: 'ready', text: tr(`Signed in to ${status.baseUrl}`, `已登录 ${status.baseUrl}`) }
}

/** Accept a pasted fingerprint with spaces / colons / uppercase; null unless it is 64 hex. */
export function parseFingerprint(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/[\s:_-]/g, '')
  return /^[0-9a-f]{64}$/.test(s) ? s : null
}

export function shortFp(fp: string): string {
  return fp.length > 16 ? `${fp.slice(0, 8)}…${fp.slice(-8)}` : fp
}

const DELIVERY_LABEL: Record<string, string> = {
  get queued() {
    return tr('Queued', '排队中')
  },
  get sent() {
    return tr('Sent', '已发送')
  },
  get failed() {
    return tr('Failed', '失败')
  },
  get suppressed() {
    return tr('Not sent (unsubscribed or blocked)', '未发送（已退订或被拦截）')
  }
}

export function deliveryStatusLabel(status: string): string {
  return DELIVERY_LABEL[status] ?? status
}

export function subscriberStatusLabel(status: 'pending' | 'confirmed'): string {
  return status === 'confirmed' ? tr('Confirmed', '已确认') : tr('Waiting for email confirmation', '等待邮件确认')
}

export function countsText(c: LetterCounts): string {
  const total = c.queued + c.sent + c.failed + c.suppressed
  if (total === 0) return tr('No recipients', '没有收件人')
  const parts = [tr(`${c.sent} sent`, `已发送 ${c.sent}`)]
  if (c.queued) parts.push(tr(`${c.queued} queued`, `排队 ${c.queued}`))
  if (c.failed) parts.push(tr(`${c.failed} failed`, `失败 ${c.failed}`))
  if (c.suppressed) parts.push(tr(`${c.suppressed} not sent`, `未发送 ${c.suppressed}`))
  return tr(`${parts.join(' · ')} (${total} total)`, `${parts.join(' · ')}（共 ${total}）`)
}

const REJECT_LABEL: Record<LetterRejectReason, string> = {
  get parse() {
    return tr('Not valid JSON', '不是合法的 JSON')
  },
  get schema() {
    return tr('Wrong format', '格式不对')
  },
  get fingerprint() {
    return tr('Public key does not match the fingerprint', '公钥和指纹对不上')
  },
  get wrong_signer() {
    return tr('Signer is not this friend', '签名者不是这位朋友')
  },
  get signature() {
    return tr('Signature check failed', '签名验证失败')
  }
}

export function rejectReasonLabel(reason: LetterRejectReason): string {
  return REJECT_LABEL[reason] ?? reason
}

/** One line per dropped letter, always starting with 「签名无效，已丢弃」 (en: "Invalid signature, discarded"). */
export function droppedLines(dropped: DroppedLetter[]): string[] {
  return dropped.map((d) =>
    tr(
      `Invalid signature, discarded: letter ${d.index + 1}${d.issueId ? ` (${d.issueId.slice(0, 8)})` : ''} · ${rejectReasonLabel(d.reason)}`,
      `签名无效，已丢弃：第 ${d.index + 1} 封${d.issueId ? `（${d.issueId.slice(0, 8)}）` : ''} · ${rejectReasonLabel(d.reason)}`
    )
  )
}

/** Count of `<!-- … -->` placeholders the user still has to fill or delete. */
export function placeholderCount(markdown: string): number {
  return (markdown.match(/<!--[\s\S]*?-->/g) ?? []).length
}

/** Null when the draft can be previewed; otherwise why not (mirrors the IPC limits). */
export function draftProblem(d: { title: string; markdown: string; week: string }): string | null {
  if (!d.title.trim()) return tr('Title cannot be empty', '标题不能为空')
  if (d.title.trim().length > LETTER_LIMITS.maxTitleChars) return tr(`Title can be at most ${LETTER_LIMITS.maxTitleChars} characters`, `标题最多 ${LETTER_LIMITS.maxTitleChars} 字`)
  if (!d.markdown.trim()) return tr('Body cannot be empty', '正文不能为空')
  if (d.markdown.length > LETTER_LIMITS.maxMarkdownChars) return tr(`Body can be at most ${LETTER_LIMITS.maxMarkdownChars} characters`, `正文最多 ${LETTER_LIMITS.maxMarkdownChars} 字`)
  if (!WEEK_RE.test(d.week)) return tr('Issue must be in YYYY-Www format (for example 2026-W45)', '期号格式应为 YYYY-Www（例如 2026-W45）')
  return null
}

const FETCH_OUTCOME = {
  get added() {
    return tr('Signature verified, added to Peers', '验签通过，已加入朋友列表')
  },
  get updated() {
    return tr('Signature verified, updated to the new version', '验签通过，已更新到新版本')
  },
  get unchanged() {
    return tr('Signature verified, same as the local version', '验签通过，和本地已有的版本相同')
  },
  get older_version() {
    return tr('Signature verified; the cloud version is older than the local one and was added to history', '验签通过，云端版本比本地旧，已记入历史')
  }
} satisfies Record<FriendCardFetched['outcome'], string>

export function cardFetchText(r: FriendCardFetched): string {
  const who = r.displayName ?? shortFp(r.fingerprint)
  return tr(
    `${who}: ${FETCH_OUTCOME[r.outcome]} (${r.versions} local version(s); cloud version ${r.cloudVersion})`,
    `${who}：${FETCH_OUTCOME[r.outcome]}（本地共 ${r.versions} 个版本；云端第 ${r.cloudVersion} 版）`
  )
}

export function cloudCardStatusText(s: CloudCardStatus | null): string {
  if (!s) return ''
  if (!s.published) return tr('Not published to the cloud yet', '还没有发布到云端')
  if (!s.verified)
    return tr(
      `The cloud has version ${s.version}, but verification on this Mac failed (the server's content cannot be trusted)`,
      `云端有第 ${s.version} 版，但本机验签失败（服务器返回的内容不可信）`
    )
  return s.matchesLatest
    ? tr(`Published (version ${s.version}, matches your latest local card)`, `已发布（第 ${s.version} 版，与本地最新卡片一致）`)
    : tr(`Published (version ${s.version}, not your latest local card; you can publish again)`, `已发布（第 ${s.version} 版，不是本地最新卡片，可以重新发布）`)
}

const HINT: Partial<Record<CloudErrorCode, string>> = {
  get disabled() {
    return tr('Turn on Cloud first.', '先开启云端。')
  },
  get unauthorized() {
    return tr('Please sign in to Cloud again.', '请重新登录云端。')
  },
  get no_card() {
    return tr('Generate one on the Personal Card page.', '到「个人卡片」页生成一张。')
  },
  get no_identity() {
    return tr('Create an identity on the Personal Card page.', '到「个人卡片」页创建身份。')
  },
  get duplicate_issue() {
    return tr('To send again, preview again (a new issue number is generated).', '如需再发，请重新预览（会生成新的期号）。')
  }
}

export function subsErrorText(e: { code: string; message: string }): string {
  const hint = HINT[e.code as CloudErrorCode]
  return hint ? tr(`${e.message}. ${hint}`, `${e.message}。${hint}`) : e.message
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
