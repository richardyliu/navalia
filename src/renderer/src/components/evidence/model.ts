/**
 * EvidenceDrawer view-model (S1-01). Pure: no React, no window, testable under vitest/node.
 *
 * Honesty rules (MOD-07):
 * - An item Runtime marks unresolvable (`resolvable === false`) or `status === 'missing'` is an
 *   *unresolved receipt*. It is never shown or counted as a direct source.
 * - A reason is only shown when Runtime returned one (`metadata.reason` / `item.reason`).
 *   Lens never invents a reason; known Runtime reason codes get a Chinese gloss, unknown codes are
 *   shown verbatim.
 * - Drops: Runtime only records a per-window integer (`memory_deltas.dropped`, surfaced by
 *   `persome delta-report`). Lens shows the integer and says there is no per-item reason.
 */
import type { EvidenceItem, EvidenceResponse } from '../../../../shared/types'
import { tr } from '../../lib/i18n'

export function unresolvedMarker(): string {
  return tr('Evidence unresolved', '证据未解析')
}

/**
 * Lens-side fallback for an unresolved receipt (MOD-07 / OG-03). Always labelled as Lens's, never as
 * Runtime data. Runtime 0.3.2 (personal-model b7a28ff) has no read-only surface that reads
 * `model_candidate_evidence` or a Point's candidate lineage:
 * - REST `GET /model/evidence` / MCP `resolve_evidence`: no resolver branch for this receipt kind;
 * - MCP `read_receipt` / `related_events`: only read the `entries` table → `entry not found`
 *   (and on a hit they bump retrieval counters, so they are not side-effect free);
 * - REST `GET /model/node`: returns the Point's own text and receipt, not its sources.
 * Lens must not read `index.db`, so the honest fallback is `none`, with what was checked.
 * Re-verified by docs/test-evidence/_scripts/mod07_08_recheck.py (see MOD-07/ 2026-11-05 evidence).
 */
export interface EvidenceFallback {
  source: 'lens_fallback'
  outcome: 'none'
  text: string
  checked: readonly string[]
}

export function fallbackChecked(): readonly string[] {
  return [
    tr('GET /model/evidence (MCP resolve_evidence)', 'GET /model/evidence（MCP resolve_evidence）'),
    'MCP read_receipt',
    'MCP related_events',
    'GET /model/node'
  ]
}

export const NO_FALLBACK: EvidenceFallback = {
  source: 'lens_fallback',
  outcome: 'none',
  get text() {
    return tr(
      'Navalia fallback: none. Before schema 2026-11-05.3, Runtime had no read-only surface that could read the original text/window of this kind of receipt (read_receipt / related_events only query the entries table; /model/node returns only the Point itself); from 2026-11-05.3 /model/evidence resolves it. Navalia does not read index.db, so it does not fill in the link.',
      'Navalia 回退：无。schema 2026-11-05.3 之前的 Runtime 没有任何只读接口能读出这类回执的原文/窗口（read_receipt / related_events 只查 entries 表；/model/node 只返回 Point 本身）；2026-11-05.3 起由 /model/evidence 解析。Navalia 不读 index.db，所以不补链。'
    )
  },
  get checked() {
    return fallbackChecked()
  }
}

/**
 * S1-R5-03: Runtime's MCP `remember` (personal-model mcp/memory_write.py) force-tags every entry
 * `source:agent-run`. Such a memory has no upstream capture lineage: the entry itself is the record.
 * Lens shows that as 来源=本条记忆 instead of an empty "无" — it is still NOT counted as a direct source.
 */
export const REMEMBER_PROVENANCE_TAG = 'source:agent-run'

export interface SelfSource {
  label: string
  detail: string
  /** The Runtime tag that justified it (always `source:agent-run`). */
  tag: typeof REMEMBER_PROVENANCE_TAG
}

export const REMEMBER_SELF_SOURCE: SelfSource = {
  get label() {
    return tr('Source = this memory', '来源=本条记忆')
  },
  get detail() {
    return tr(
      'This memory was written directly via remember (Runtime tag source:agent-run). The memory itself is the record; there is no earlier screen capture or session source. "Nearby context" below is only captures close in time, not sources.',
      '这条是通过 remember 直接写入的记忆（Runtime 标记 source:agent-run），记忆本身就是记录，没有更早的屏幕采集或会话来源。下方“邻近上下文”只是时间上相邻的采集，不是来源。'
    )
  },
  tag: REMEMBER_PROVENANCE_TAG
}

function hasRememberTag(metadata: Record<string, unknown>): boolean {
  const tags = metadata.tags
  return Array.isArray(tags) && tags.some((t) => t === REMEMBER_PROVENANCE_TAG)
}

/** Lens wording when Runtime returned a Point with `sources=[]` and no reason. */
export function pointNoSourcesReason(): string {
  return tr(
    'Runtime returned empty sources for this Point (sources=[]) and gave no reason',
    'Runtime 为这条 Point 返回了空的 sources（sources=[]），没有给出原因'
  )
}

export function mod07PointKnownIssue(): string {
  return tr(
    'Navalia note: upstream issue MOD-07. Before schema 2026-11-05.3, Runtime did not keep the link to model_candidate_evidence receipts when a candidate was promoted to a Point, so every promoted Point has sources=[]. That does not mean it has no evidence. From 2026-11-05.3 Runtime lists candidate_evidence sources; if it is still empty, Runtime really recorded no source.',
    'Navalia 注：上游问题 MOD-07 —— schema 2026-11-05.3 之前的 Runtime 在 candidate 晋升为 Point 时没有保存它与 model_candidate_evidence 回执的关联，晋升出来的 Point 一律 sources=[]，这不代表它没有证据。2026-11-05.3 起 Runtime 会列出 candidate_evidence 来源；若仍为空，Runtime 确实没有记录来源。'
  )
}

/**
 * Reason codes `resolve_evidence` actually emits (personal-model src/persome/evidence.py,
 * `resolve_evidence`): `empty_reference` and `source_not_found_or_retained`. Nothing else.
 */
export const RUNTIME_MISSING_REASONS: Readonly<Record<string, string>> = {
  get source_not_found_or_retained() {
    return tr(
      'Runtime could not find what this receipt points to, or the original content is past retention',
      'Runtime 没有找到这条回执指向的对象，或原始内容已过保留期'
    )
  },
  get empty_reference() {
    return tr('Empty reference', '引用为空')
  }
}

export interface UnresolvedReceipt {
  reference: string
  label: string
  kind: string | null
  status: string
  /** Raw Runtime reason code, or null when Runtime gave none. */
  reasonCode: string | null
  /** Chinese text for the reason; null when Runtime gave none. */
  reasonText: string
  receiptPreserved: boolean | null
  /** Receipt type from `⟨id:path⟩`, e.g. `model_candidate_evidence`. */
  receiptPath: string | null
  /** Lens-side note for a known upstream issue; kept apart from the Runtime reason. */
  knownIssue: string | null
  /** Lens fallback attempt, labelled as Lens's; null when not applicable. */
  fallback: EvidenceFallback | null
  marker: string
}

export interface DroppedNotice {
  count: number
  text: string
}

export interface EvidenceView {
  /** Set when the requested reference itself did not resolve. */
  rootUnresolved: UnresolvedReceipt | null
  sources: EvidenceItem[]
  unresolvedSources: UnresolvedReceipt[]
  context: EvidenceItem[]
  history: EvidenceItem[]
  /** Number of resolved direct sources (unresolved receipts excluded). */
  sourceCount: number
  /** A Point that Runtime returned with zero direct sources. */
  pointWithoutSources: boolean
  /**
   * S1-R5-03: a `remember` memory (tag `source:agent-run`) with no sources — the entry is its own record.
   * Null otherwise. Never counted in `sourceCount`.
   */
  selfSource: SelfSource | null
  /**
   * Explicit "证据未解析" entry for a Point with zero resolved sources (sources=[] or every source
   * unresolved), so a Point never renders as silently source-less.
   */
  pointUnresolved: UnresolvedReceipt | null
  dropped: DroppedNotice | null
  /**
   * MOD-12 (fixed in Runtime schema 2026-11-05.3): with `as_of`, Points and relation edges come back with
   * their status AT T and `metadata.status_now` beside it. Null when the Runtime sent no `status_now`.
   */
  asOfStatus: AsOfStatus | null
}

export interface AsOfStatus {
  statusAt: string
  statusNow: string | null
  asOf: string | null
  effectiveFrom: string | null
  /** Which clock gave `effectiveFrom` (valid_from / created_at / occurred_at …), as Runtime reports it. */
  basis: string | null
  text: string
}

/** Runtime evidence.py NOT_YET_EFFECTIVE: the object did not exist yet at T; sources/context are emptied on purpose. */
export const NOT_YET_EFFECTIVE = 'not_yet_effective'

export function readAsOfStatus(response: EvidenceResponse): AsOfStatus | null {
  const m = (response.metadata ?? {}) as Record<string, unknown>
  if (typeof m.status_now !== 'string') return null
  const statusAt = response.status
  const statusNow = str(m.status_now)
  const asOf = str(m.as_of)
  const effectiveFrom = str(m.effective_from)
  const basis = str(m.effective_basis)
  const at = asOf ? tr(`As of ${asOf}`, `截至 ${asOf}`) : tr('As of the selected time', '截至所选时间')
  const now = statusNow ?? tr('unknown', '未知')
  const text =
    statusAt === NOT_YET_EFFECTIVE
      ? tr(
          `${at}, this was not yet in effect${effectiveFrom ? ` (effective ${effectiveFrom}${basis ? `, per ${basis}` : ''})` : ''}, so there are no sources or context; status now: ${now}`,
          `${at}这条尚未生效${effectiveFrom ? `（生效时间 ${effectiveFrom}${basis ? `，依据 ${basis}` : ''}）` : ''}，所以没有来源和上下文；现在的状态：${now}`
        )
      : tr(`${at}, status: ${statusAt}; status now: ${now}`, `${at}的状态：${statusAt}；现在的状态：${now}`)
  return { statusAt, statusNow, asOf, effectiveFrom, basis, text }
}

export function mod07KnownIssue(): string {
  return tr(
    'Navalia note: upstream issue MOD-07. Before schema 2026-11-05.3, Runtime resolve_evidence had no branch for model_candidate_evidence receipts, so they always came back missing. From 2026-11-05.3 they resolve; still missing means the record the receipt points to no longer exists or is past retention.',
    'Navalia 注：上游问题 MOD-07 —— schema 2026-11-05.3 之前的 Runtime 的 resolve_evidence 没有解析 model_candidate_evidence 回执的分支，这类回执一律返回 missing；2026-11-05.3 起可以解析，仍为 missing 说明回执指向的记录已不存在或已过保留期。'
  )
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Split `⟨identifier:path⟩` the way Runtime does (last colon). */
export function receiptPath(reference: string): string | null {
  const value = reference.trim()
  if (!value.startsWith('⟨') || !value.endsWith('⟩')) return null
  const inner = value.slice(1, -1)
  const index = inner.lastIndexOf(':')
  if (index <= 0 || index === inner.length - 1) return null
  return inner.slice(index + 1).trim() || null
}

export function isUnresolvedItem(item: EvidenceItem): boolean {
  return item.resolvable === false || item.status === 'missing'
}

export function reasonText(code: string | null): string {
  if (!code) return tr('Runtime gave no reason', 'Runtime 未提供原因')
  return RUNTIME_MISSING_REASONS[code] ?? tr(`Runtime reason: ${code}`, `Runtime 原因：${code}`)
}

function toUnresolved(input: {
  reference: string
  label?: unknown
  kind?: unknown
  status?: unknown
  path?: unknown
  reason?: unknown
  receiptPreserved?: unknown
}): UnresolvedReceipt {
  const path = str(input.path) ?? receiptPath(input.reference)
  const code = str(input.reason)
  return {
    reference: input.reference,
    label: str(input.label) ?? input.reference,
    kind: str(input.kind),
    status: str(input.status) ?? (code ? 'missing' : 'unresolvable'),
    reasonCode: code,
    reasonText: reasonText(code),
    receiptPreserved: typeof input.receiptPreserved === 'boolean' ? input.receiptPreserved : null,
    receiptPath: path,
    knownIssue: path === 'model_candidate_evidence' ? mod07KnownIssue() : null,
    fallback: path === 'model_candidate_evidence' ? NO_FALLBACK : null,
    marker: unresolvedMarker()
  }
}

export function droppedText(count: number): string {
  return tr(`${count} dropped (Runtime gave no per-item reason)`, `已丢弃 ${count} 条（Runtime 未提供逐条原因）`)
}

/**
 * Read a drop count only if Runtime put an integer there. Today `/model/evidence` never does;
 * this is forward-compatible with the MOD-07 upstream patch and with delta-report wiring.
 */
export function readDropped(metadata: Record<string, unknown> | undefined): DroppedNotice | null {
  const raw = metadata?.dropped
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return null
  return { count: raw, text: droppedText(raw) }
}

export function buildEvidenceView(response: EvidenceResponse): EvidenceView {
  const metadata = (response.metadata ?? {}) as Record<string, unknown>
  const rootUnresolved =
    response.status === 'missing'
      ? toUnresolved({
          reference: response.canonical_reference || response.reference,
          label: response.label,
          kind: response.kind,
          status: response.status,
          path: response.path,
          reason: metadata.reason,
          receiptPreserved: metadata.receipt_preserved
        })
      : null

  const sources: EvidenceItem[] = []
  const unresolvedSources: UnresolvedReceipt[] = []
  for (const item of response.sources ?? []) {
    if (isUnresolvedItem(item)) {
      unresolvedSources.push(
        toUnresolved({
          reference: item.reference,
          label: item.label,
          kind: item.kind,
          status: item.status,
          reason: item.reason ?? (item.metadata as Record<string, unknown> | undefined)?.reason,
          receiptPreserved: item.receipt_preserved
        })
      )
    } else {
      sources.push(item)
    }
  }

  const asOfStatus = readAsOfStatus(response)
  // not_yet_effective: Runtime empties sources on purpose (nothing about a future object is evidence at T).
  const selfSource: SelfSource | null =
    rootUnresolved === null &&
    sources.length === 0 &&
    unresolvedSources.length === 0 &&
    response.status !== NOT_YET_EFFECTIVE &&
    hasRememberTag(metadata)
      ? REMEMBER_SELF_SOURCE
      : null
  const pointWithoutSources =
    response.kind === 'point' &&
    rootUnresolved === null &&
    sources.length === 0 &&
    response.status !== NOT_YET_EFFECTIVE &&
    selfSource === null
  const pointUnresolved: UnresolvedReceipt | null = pointWithoutSources
    ? {
        reference: response.canonical_reference || response.reference,
        label: str(response.label) ?? response.reference,
        kind: 'point',
        status: unresolvedSources.length ? 'sources_unresolved' : 'no_sources',
        reasonCode: null,
        reasonText: unresolvedSources.length
          ? tr(
              `None of the ${unresolvedSources.length} sources Runtime returned could be resolved (see per-item reasons below)`,
              `Runtime 返回的 ${unresolvedSources.length} 条来源都无法解析（见下方逐条原因）`
            )
          : pointNoSourcesReason(),
        receiptPreserved: null,
        receiptPath: str(response.path) ?? receiptPath(response.canonical_reference || response.reference),
        knownIssue: unresolvedSources.length ? null : mod07PointKnownIssue(),
        fallback: NO_FALLBACK,
        marker: unresolvedMarker()
      }
    : null

  return {
    rootUnresolved,
    sources,
    unresolvedSources,
    context: response.context ?? [],
    history: response.history ?? [],
    sourceCount: sources.length,
    pointWithoutSources,
    selfSource,
    pointUnresolved,
    dropped: readDropped(metadata),
    asOfStatus
  }
}

/** Shape written by `persome delta-report --json-out <file>` (personal-model cli.py `delta_report`). */
export interface DeltaReportSummary {
  droppedByGates: number
  /** Runtime 2026-11-05.3+ itemized drop reasons (code → count); empty when the Runtime gave none. */
  reasons: Record<string, number>
  rows: number
  sessions: number
  recent: Array<{ sessionId: string; createdAt: string | null; dropped: number; status: string | null }>
}

export function parseDeltaReport(json: unknown): DeltaReportSummary | null {
  if (typeof json !== 'object' || json === null) return null
  const aggregate = (json as { aggregate?: unknown }).aggregate
  if (typeof aggregate !== 'object' || aggregate === null) return null
  const agg = aggregate as Record<string, unknown>
  const dropped = agg.dropped_by_gates
  if (typeof dropped !== 'number' || !Number.isInteger(dropped) || dropped < 0) return null
  const recentRaw = (json as { recent?: unknown }).recent
  const recent = Array.isArray(recentRaw)
    ? recentRaw
        .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
        .map((row) => ({
          sessionId: String(row.session_id ?? ''),
          createdAt: str(row.created_at),
          dropped: typeof row.dropped === 'number' ? row.dropped : 0,
          status: str(row.status) ?? str(row.apply_status)
        }))
    : []
  const reasons: Record<string, number> = {}
  const rawReasons = agg.drop_reasons
  if (typeof rawReasons === 'object' && rawReasons !== null && !Array.isArray(rawReasons)) {
    for (const [k, v] of Object.entries(rawReasons)) {
      if (/^[a-z][a-z0-9_]{0,63}$/.test(k) && typeof v === 'number' && Number.isInteger(v) && v > 0) reasons[k] = v
    }
  }
  return {
    droppedByGates: dropped,
    reasons,
    rows: typeof agg.rows === 'number' ? agg.rows : 0,
    sessions: typeof agg.sessions === 'number' ? agg.sessions : 0,
    recent
  }
}

export function droppedFromDeltaReport(summary: DeltaReportSummary | null): DroppedNotice | null {
  if (!summary || summary.droppedByGates <= 0) return null
  return { count: summary.droppedByGates, text: globalDroppedText(summary.droppedByGates, summary.reasons) }
}

/**
 * delta-report counts are Runtime-wide, never attributable to the evidence item on screen. Runtime
 * 2026-11-05.3+ itemizes drops: the reason codes are shown literally. Rows written before that carry
 * none, so the per-reason totals may sum to less than the total.
 */
export function globalDroppedText(count: number, reasons: Record<string, number> = {}): string {
  const codes = Object.entries(reasons)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
  if (!codes.length)
    return tr(
      `Runtime-wide: gates dropped ${count} in recent memory_delta runs (not specific to this evidence; Runtime gave no per-item reason)`,
      `Runtime 全局：最近的 memory_delta 中门控共丢弃 ${count} 条（不是这条证据专属；Runtime 未提供逐条原因）`
    )
  const covered = Object.values(reasons).reduce((a, b) => a + b, 0)
  const legacy =
    covered < count
      ? tr(`; the other ${count - covered} come from older rows with no recorded reason`, `；其余 ${count - covered} 条来自未记录原因的旧记录`)
      : ''
  return tr(
    `Runtime-wide: gates dropped ${count} in recent memory_delta runs (not specific to this evidence; Runtime reason codes: ${codes.join(' ')}${legacy})`,
    `Runtime 全局：最近的 memory_delta 中门控共丢弃 ${count} 条（不是这条证据专属；Runtime 原因码：${codes.join(' ')}${legacy}）`
  )
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface ReproduceInput {
  reference: string
  asOf?: string
  /** Runtime root (default `~/.persome`). Only the path goes into the command, never the token. */
  root?: string
  port?: number
}

/**
 * Copyable commands that reproduce what the drawer shows. The token is read from `<root>/env`
 * by the user's shell; it is never embedded.
 */
export function reproduceCommands(input: ReproduceInput): { evidence: string; deltaReport: string } {
  const root = input.root?.trim() || '~/.persome'
  const rootArg = root.startsWith('~/') ? `~/${shellQuote(root.slice(2))}` : shellQuote(root)
  const port = input.port && Number.isInteger(input.port) ? input.port : 8742
  const asOf = input.asOf ? ` --data-urlencode ${shellQuote(`as_of=${input.asOf}`)}` : ''
  const evidence =
    // printf is a shell builtin and curl reads the header from stdin (-H @-), so the token never
    // appears in any process argv (`ps`).
    `(set -a; . ${rootArg}/env; printf 'Authorization: Bearer %s\\n' "$PERSOME_LOCAL_API_TOKEN" | curl -sG -H @-` +
    ` --data-urlencode ${shellQuote(`ref=${input.reference}`)}${asOf} http://127.0.0.1:${port}/model/evidence)`
  const deltaReport = `PERSOME_ROOT=${rootArg} persome delta-report --limit 20`
  return { evidence, deltaReport }
}
