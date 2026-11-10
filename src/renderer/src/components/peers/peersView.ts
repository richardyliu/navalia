// Pure view-model for the Peers page (vitest has no DOM; Peers.tsx stays thin).
import type {
  PeerEvent,
  PeerImportResult,
  PeerRejectReason,
  PeerSummary,
  PeerVerification,
  PeerTopic,
  SubscriptionFileReport,
  SubscriptionOutcome,
  SubscriptionRefreshReport,
  SubscriptionSkipReason,
  SubscriptionStatus
} from '../../../../main/peers/api'
import { SUBSCRIPTION_STATUS, UNVERIFIED } from '../../../../main/peers/api'
import { tr } from '../../lib/i18n'

export function shortFingerprint(fp: string): string {
  return fp.length > 16 ? `${fp.slice(0, 8)}…${fp.slice(-4)}` : fp
}

export function peerTitle(p: Pick<PeerSummary, 'displayName' | 'fingerprint'>): string {
  return p.displayName?.trim() || tr(`Unnamed (${p.fingerprint.slice(0, 8)})`, `未署名（${p.fingerprint.slice(0, 8)}）`)
}

export const VERIFICATION_LABEL: Record<PeerVerification, { text: string; tone: 'ok' | 'warn'; note: string }> = {
  valid: {
    get text() {
      return tr('Signature valid', '签名有效')
    },
    tone: 'ok',
    get note() {
      return tr(
        'The card content matches its signature and has not changed since import. A signature only proves integrity and key continuity, not who they are (no accounts; see DEVIATIONS D3).',
        '卡片内容与签名一致，自导入后未被改动。签名只证明完整性和密钥连续性，不证明对方是谁（无账号，见 DEVIATIONS D3）。'
      )
    }
  },
  old_key: {
    get text() {
      return tr('Possibly an old key (Unverified)', `可能是旧密钥（${UNVERIFIED}）`)
    },
    tone: 'warn',
    get note() {
      return tr(
        'The signature is valid, but another card with the same name is newer and uses a different key. They may have reset their identity, or it may just be the same name; no account links the two keys.',
        '签名有效，但另一张同名卡片更新、且用的是另一把密钥。可能是对方重置了身份，也可能只是重名；没有账号可以把两把密钥连起来。'
      )
    }
  }
}

export const REJECT_LABEL: Record<PeerRejectReason, string> = {
  get tampered() {
    return tr('Rejected: the card was modified (signature or fingerprint mismatch) and was not added.', '已拒绝：卡片被改动过（签名或指纹不匹配），没有加入列表。')
  },
  get invalid() {
    return tr('Rejected: this is not a valid .navaliacard.', '已拒绝：这不是一张有效的 .navaliacard。')
  },
  get self() {
    return tr('Rejected: this card is signed with your own key.', '已拒绝：这是用你自己的密钥签名的卡片。')
  },
  get too_large() {
    return tr('Rejected: the file is too large to be a card.', '已拒绝：文件太大，不像是一张卡片。')
  }
}

export function importNotice(r: PeerImportResult | null): { tone: 'ok' | 'warn' | 'bad'; text: string } | null {
  if (!r) return null
  if (!r.ok) return { tone: 'bad', text: REJECT_LABEL[r.reason] }
  const name = peerTitle(r.peer)
  switch (r.outcome) {
    case 'added':
      return { tone: 'ok', text: tr(`Added: ${name} (signature valid)`, `已加入：${name}（签名有效）`) }
    case 'updated':
      return { tone: 'ok', text: tr(`Updated: ${name}'s card was replaced with a newer version; the old one is kept in history`, `已更新：${name} 的卡片换成了更新的版本，旧版本保留在历史里`) }
    case 'unchanged':
      return { tone: 'warn', text: tr(`This card from ${name} was already imported; no changes`, `${name} 的这张卡片已经导入过，没有变化`) }
    case 'older_version':
      return { tone: 'warn', text: tr(`This is an older card from ${name}: saved to history; the newer version is still shown`, `这是 ${name} 的一张旧版卡片：已存入历史，当前显示的仍是更新的版本`) }
  }
}

export const TOPIC_SOURCE_LABEL: Record<PeerTopic['source'], string> = {
  get summary() {
    return tr('Summary', '概述')
  },
  get highlight() {
    return tr('Highlight', '重点')
  },
  get map() {
    return tr('Mini Map', '小地图')
  }
}

const EVENT_LABEL: Record<PeerEvent['kind'], string> = {
  get imported() {
    return tr('Imported the card on this Mac', '在本机导入了卡片')
  },
  get updated() {
    return tr('Imported a newer card', '导入了更新的卡片')
  },
  get reimported_same() {
    return tr('Imported the same card again', '重复导入了同一张卡片')
  },
  get older_version() {
    return tr('Imported an older card (saved to history)', '导入了一张旧版卡片（存入历史）')
  }
}

export interface ActivityRow {
  at: string
  text: string
}

/** Activity = local events only. The card's issued_at is what the card itself says, labelled as such. */
export function activityRows(events: PeerEvent[]): ActivityRow[] {
  return events.map((e) => ({ at: e.at, text: tr(`${EVENT_LABEL[e.kind]} (card issued ${formatLocal(e.cardIssuedAt)})`, `${EVENT_LABEL[e.kind]}（卡片签发于 ${formatLocal(e.cardIssuedAt)}）`) }))
}

export function formatLocal(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const SUBSCRIPTION = SUBSCRIPTION_STATUS

// ── S2-09 subscription folder ────────────────────────────────────────────────

export const SUB_OUTCOME_LABEL: Record<SubscriptionOutcome, { text: string; tone: 'ok' | 'warn' | 'bad' | 'subtle' }> = {
  added: {
    get text() {
      return tr('New', '新增')
    },
    tone: 'ok'
  },
  updated: {
    get text() {
      return tr('Updated', '已更新')
    },
    tone: 'ok'
  },
  unchanged: {
    get text() {
      return tr('No change', '无变化')
    },
    tone: 'subtle'
  },
  older_version: {
    get text() {
      return tr('Older version (saved to history)', '旧版本（存入历史）')
    },
    tone: 'warn'
  },
  duplicate: {
    get text() {
      return tr('Duplicate, skipped', '重复跳过')
    },
    tone: 'subtle'
  },
  rejected: {
    get text() {
      return tr('Rejected', '已拒绝')
    },
    tone: 'bad'
  },
  skipped: {
    get text() {
      return tr('Not read', '未读取')
    },
    tone: 'warn'
  }
}

export const SUB_SKIP_LABEL: Record<SubscriptionSkipReason, string> = {
  get symlink() {
    return tr('Symbolic link, not followed', '是符号链接，不跟随')
  },
  get not_regular() {
    return tr('Not a regular file', '不是普通文件')
  },
  get too_large() {
    return tr('File too large', '文件太大')
  },
  get count_cap() {
    return tr('Over the per-refresh file count limit; handled on the next refresh', '超过单次刷新的文件数上限，下次刷新再处理')
  },
  get byte_cap() {
    return tr('Over the per-refresh total size limit; handled on the next refresh', '超过单次刷新的总大小上限，下次刷新再处理')
  },
  get not_downloaded() {
    return tr('iCloud file not downloaded to this Mac yet (open the folder in Finder to download it, then refresh)', 'iCloud 文件还没下载到本机（在访达里打开该文件夹让它下载后再刷新）')
  },
  get unreadable() {
    return tr('Cannot read', '无法读取')
  },
  get unknown_signer() {
    return tr('Signer is not in your Peers list; not imported (import their card first, then refresh)', '签名者不在朋友列表，未导入（先导入对方的卡片，再刷新）')
  }
}

const KIND_LABEL: Record<SubscriptionFileReport['kind'], string> = {
  get card() {
    return tr('Card', '卡片')
  },
  get skill() {
    return tr('Skill', '技能')
  }
}

export interface SubRow {
  key: string
  name: string
  kind: string
  label: string
  tone: 'ok' | 'warn' | 'bad' | 'subtle'
  note: string | null
}

/** One row per file; the reason text is in the UI language, the verifier detail is kept verbatim. */
export function subscriptionRows(r: SubscriptionRefreshReport): SubRow[] {
  return r.files.map((f, i) => {
    const o = SUB_OUTCOME_LABEL[f.outcome]
    let note: string | null = f.detail
    if (f.outcome === 'skipped' && f.reason && f.reason in SUB_SKIP_LABEL) note = SUB_SKIP_LABEL[f.reason as SubscriptionSkipReason] + (f.detail ? tr(`: ${f.detail}`, `：${f.detail}`) : '')
    else if (f.outcome === 'rejected' && f.kind === 'card' && f.reason && f.reason in REJECT_LABEL) note = `${REJECT_LABEL[f.reason as PeerRejectReason]}${f.detail ? tr(` (${f.detail})`, `（${f.detail}）`) : ''}`
    else if (f.outcome === 'duplicate' && f.reason === 'skill') note = tr(`This skill is already on this Mac (${f.detail ?? ''})`, `这个技能已经在本机（${f.detail ?? ''}）`)
    return { key: `${i}:${f.name}`, name: f.name, kind: KIND_LABEL[f.kind], label: o.text, tone: o.tone, note }
  })
}

export function subscriptionSummary(r: SubscriptionRefreshReport, countsOnly = false): string {
  const parts = (Object.keys(SUB_OUTCOME_LABEL) as SubscriptionOutcome[]).filter((k) => r.counts[k] > 0).map((k) => `${SUB_OUTCOME_LABEL[k].text} ${r.counts[k]}`)
  if (countsOnly) return parts.length ? parts.join(' · ') : tr('No new files', '没有新文件')
  const head = r.files.length ? parts.join(' · ') : tr('No .navaliacard / .navaliaskill files in the folder', '文件夹里没有 .navaliacard / .navaliaskill 文件')
  return r.ignored ? tr(`${head} (${r.ignored} other file(s) not read)`, `${head}（另有 ${r.ignored} 个其它文件未读取）`) : head
}

export function subscriptionState(s: SubscriptionStatus | null | undefined): { text: string; tone: 'ok' | 'warn' | 'subtle' } {
  if (!s || !s.folder) return { text: tr('Not enabled', '未启用'), tone: 'subtle' }
  if (!s.enabled) return { text: tr('Stopped', '已停用'), tone: 'subtle' }
  if (s.folderProblem) return { text: tr('Folder unavailable', '文件夹不可用'), tone: 'warn' }
  if (s.autoScan?.enabled) return { text: tr(`Enabled (scans every ${s.autoScan.intervalMinutes} min)`, `已启用（每 ${s.autoScan.intervalMinutes} 分钟扫描）`), tone: 'ok' }
  return { text: tr('Enabled (manual refresh)', '已启用（手动刷新）'), tone: 'ok' }
}

// ── S1-R4-06 opt-in periodic scan (X2) ──────────────────────────────────────

export function autoScanHint(): string {
  return tr(
    'Off by default. When on, every N minutes Navalia runs exactly the same scan as Refresh: top level of this folder only, offline signature checks, dedup by content hash, no subfolders, no network. It stops when you stop the subscription or quit Navalia.',
    '默认关闭。开启后 Navalia 每隔 N 分钟自动做一次和「刷新」完全相同的扫描：只看这个文件夹第一层，离线验签，按内容 hash 去重，不递归、不联网。停用订阅或退出 Navalia 时停止。'
  )
}

/** Clamp a typed interval into the allowed range; non-numbers fall back to the current value. */
export function clampInterval(raw: string | number, s: Pick<SubscriptionStatus['autoScan'], 'minMinutes' | 'maxMinutes' | 'intervalMinutes'>): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return s.intervalMinutes
  return Math.min(s.maxMinutes, Math.max(s.minMinutes, Math.round(n)))
}

/** One line about the periodic scan (null when off and never run). */
export function autoScanLine(s: SubscriptionStatus | null | undefined): string | null {
  const a = s?.autoScan
  if (!a) return null
  const parts: string[] = []
  if (a.enabled) {
    parts.push(
      a.nextAt
        ? tr(`Next auto scan ${formatLocal(a.nextAt)}`, `下次自动扫描 ${formatLocal(a.nextAt)}`)
        : s.enabled
          ? tr('Periodic scan is on', '定期扫描已开启')
          : tr('Subscription stopped; periodic scan paused', '订阅已停用，定期扫描暂停')
    )
  }
  const last = a.lastRun
  if (last) {
    const at = formatLocal(last.at)
    if (last.ok) {
      const summary = last.counts
        ? subscriptionSummary({ folder: '', scannedAt: last.at, files: [], counts: last.counts, ignored: 0 }, true)
        : tr('done', '完成')
      parts.push(tr(`Last auto scan ${at}: ${summary}`, `上次自动扫描 ${at}：${summary}`))
    } else {
      parts.push(tr(`Last auto scan ${at} failed: ${last.error ?? 'unknown error'}`, `上次自动扫描 ${at} 失败：${last.error ?? '未知错误'}`))
    }
  }
  return parts.length ? parts.join(' · ') : null
}
