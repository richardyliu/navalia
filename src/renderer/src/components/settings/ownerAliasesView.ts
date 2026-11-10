// S1-R3-01: pure view helpers + controller for Settings → 身份别名 (Runtime owner-alias review,
// schema 2026-11-05.3). No React, no IPC import: the controller takes the `window.lens.ownerAliases`
// bridge as an argument so tests can drive it with a mock.
//
// Boundary: the renderer never activates an alias by itself. `confirm` / `reject` go to main, which
// re-reads the Runtime list, shows a main-owned native dialog and posts only on "yes"
// (src/main/identity/ipc.ts decideOwnerAlias). Nothing here calls the Runtime or the network.
import type { LensError, LensResult } from '../../../../shared/types'
import type { OwnerAliasDecision, OwnerAliasList, OwnerAliasRow, OwnerAliasStatus } from '../../../../main/runtime/owner-aliases'
import { tr } from '../../../../shared/i18n'

export interface OwnerAliasBridge {
  list(status?: OwnerAliasStatus | 'all'): Promise<LensResult<OwnerAliasList>>
  confirm(alias: string): Promise<LensResult<OwnerAliasDecision>>
  reject(alias: string): Promise<LensResult<OwnerAliasDecision>>
}

export const OWNER_ALIAS_TABS: ReadonlyArray<{ status: OwnerAliasStatus; readonly label: string }> = [
  {
    status: 'pending',
    get label() {
      return tr('Pending', '待确认')
    }
  },
  {
    status: 'active',
    get label() {
      return tr('Confirmed', '已确认')
    }
  },
  {
    status: 'rejected',
    get label() {
      return tr('Rejected', '已拒绝')
    }
  }
]

export const STATUS_LABEL: Record<OwnerAliasStatus, string> = {
  get pending() {
    return tr('Pending', '待确认')
  },
  get active() {
    return tr('Confirmed (resolves to you)', '已确认（解析为你）')
  },
  get rejected() {
    return tr('Rejected', '已拒绝')
  }
}

/** Shown above every quote: the text is copied from screen / session content, not written by Lens. */
export function untrustedQuoteNote(): string {
  return tr('Original excerpt (unverified, from screen / session content, display only)', '原文摘录（未核实，来自屏幕 / 会话内容，只作展示）')
}

export const QUOTE_MAX = 280

/** Error codes main already maps to fixed texts; anything else gets a generic fixed text here. */
const KNOWN_CODES = new Set<LensError['code']>(['unreachable', 'timeout', 'unauthorized', 'token_unavailable', 'not_found', 'schema', 'server', 'unknown'])
export function genericAliasError(): string {
  return tr('Owner alias request failed', 'owner alias 请求失败')
}

/**
 * Redacted error text. Main already returns fixed messages (no alias, note, token or Runtime body);
 * the renderer additionally drops a thrown IPC error's message (it could carry anything) and caps length.
 */
export function aliasErrorText(error: LensError | unknown): string {
  const e = error as Partial<LensError> | null
  if (e && typeof e.code === 'string' && typeof e.message === 'string' && KNOWN_CODES.has(e.code as LensError['code'])) {
    return e.message.slice(0, 200)
  }
  return genericAliasError()
}

/**
 * Display-safe untrusted text: React escapes markup already; here we also remove control / format /
 * separator characters (bidi overrides, zero-width) so the quote cannot visually spoof the UI,
 * collapse whitespace, and cap the length.
 */
export function safeQuote(raw: string, max = QUOTE_MAX): string {
  const cleaned = raw
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

export interface AliasEvidenceView {
  key: string
  source: string
  session: string
  when: string
  quote: string
}

export interface AliasRowView {
  alias: string
  status: OwnerAliasStatus
  statusLabel: string
  evidenceCount: number
  /** `evidence_count` counts all sightings; the Runtime returns at most the newest 5 quotes. */
  shownNote: string | null
  confidence: string
  lastSeen: string
  evidence: AliasEvidenceView[]
  canConfirm: boolean
  canReject: boolean
}

function day(ts: string | null): string {
  return ts ? ts.slice(0, 16).replace('T', ' ') : tr('Time unknown', '时间未知')
}

export function aliasRows(list: OwnerAliasList | undefined): AliasRowView[] {
  if (!list) return []
  return list.aliases.map((row: OwnerAliasRow) => ({
    alias: safeQuote(row.alias, 160),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status],
    evidenceCount: row.evidence_count,
    shownNote: row.evidence.length < row.evidence_count ? tr(`Showing the latest ${row.evidence.length} of ${row.evidence_count}`, `显示最新 ${row.evidence.length} 条，共 ${row.evidence_count} 条`) : null,
    confidence: Number.isFinite(row.confidence) ? row.confidence.toFixed(2) : '—',
    lastSeen: day(row.last_seen_at),
    evidence: row.evidence.map((ev, i) => ({
      key: `${i}:${ev.session_id}`,
      source: safeQuote(ev.source_kind, 64) || tr('Unknown source', '来源未知'),
      session: safeQuote(ev.session_id, 64) || '—',
      when: day(ev.created_at),
      quote: safeQuote(ev.quote)
    })),
    canConfirm: row.status !== 'active',
    canReject: row.status !== 'rejected'
  }))
}

/** Raw alias (exactly what the Runtime listed) for posting; the displayed one may be cleaned. */
export function rawAliasAt(list: OwnerAliasList | undefined, index: number): string | null {
  return list?.aliases[index]?.alias ?? null
}

export function emptyText(status: OwnerAliasStatus): string {
  if (status === 'pending')
    return tr(
      'No pending aliases. When Persome spots a name or account on screen that might be you, it lands here first and only takes effect after you confirm it.',
      '没有待确认的别名。Persome 在屏幕上发现“可能是你”的名字或账号时，会先放在这里，等你确认后才生效。'
    )
  if (status === 'active') return tr('No confirmed aliases yet.', '还没有确认过的别名。')
  return tr('No rejected aliases.', '没有被拒绝的别名。')
}

export interface DecisionOutcome {
  tone: 'ok' | 'warn' | 'bad'
  message: string
  /** Fresh list for the current tab (null if the re-list itself failed). */
  list: OwnerAliasList | null
  listError: string | null
}

export function decisionMessage(kind: 'confirm' | 'reject', r: LensResult<OwnerAliasDecision>): { tone: DecisionOutcome['tone']; message: string } {
  if (!r.ok) return { tone: 'bad', message: aliasErrorText(r.error) }
  if (!r.data.decided) return { tone: 'warn', message: tr('Cancelled. Nothing was changed.', '已取消，未做任何更改。') }
  const alias = safeQuote(r.data.alias, 160)
  return kind === 'confirm'
    ? {
        tone: 'ok',
        message: tr(
          `Confirmed "${alias}" is you. Status: ${r.data.status ? STATUS_LABEL[r.data.status] : 'unknown'}.`,
          `已确认“${alias}”是你，状态：${r.data.status ? STATUS_LABEL[r.data.status] : '未知'}。`
        )
      }
    : {
        tone: 'ok',
        message: tr(
          `Rejected "${alias}". Status: ${r.data.status ? STATUS_LABEL[r.data.status] : 'unknown'}.`,
          `已拒绝“${alias}”，状态：${r.data.status ? STATUS_LABEL[r.data.status] : '未知'}。`
        )
      }
}

/**
 * One decision, then re-list the current tab. The bridge's confirm / reject trigger main's native
 * dialog; this function never posts anything else and never decides on the user's behalf.
 */
export async function decideAndRelist(bridge: OwnerAliasBridge, kind: 'confirm' | 'reject', alias: string, tab: OwnerAliasStatus): Promise<DecisionOutcome> {
  let result: LensResult<OwnerAliasDecision>
  try {
    result = kind === 'confirm' ? await bridge.confirm(alias) : await bridge.reject(alias)
  } catch (error) {
    result = { ok: false, error: { code: 'unknown', message: aliasErrorText(error) } }
  }
  const { tone, message } = decisionMessage(kind, result)
  let list: OwnerAliasList | null = null
  let listError: string | null = null
  try {
    const r = await bridge.list(tab)
    if (r.ok) list = r.data
    else listError = aliasErrorText(r.error)
  } catch (error) {
    listError = aliasErrorText(error)
  }
  return { tone, message, list, listError }
}

/** List a tab; throws an Error carrying only the redacted text (for react-query). */
export async function listAliases(bridge: OwnerAliasBridge, tab: OwnerAliasStatus): Promise<OwnerAliasList> {
  let r: LensResult<OwnerAliasList>
  try {
    r = await bridge.list(tab)
  } catch (error) {
    throw new Error(aliasErrorText(error))
  }
  if (!r.ok) throw new Error(aliasErrorText(r.error))
  return r.data
}
