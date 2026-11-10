// OG-01 Home dashboard: pure view-model helpers. No I/O, no clock reads (now/timezone injected),
// no LLM, no network. Every number shown on Home comes from one of these functions applied to data
// an existing IPC call returned; when the source has nothing, the result says so (never a default).
import type { AccessLogDay, AgentState, ConnectionsOverview } from '../../../../main/broker/api'
import type { HetSummary } from '../../../../main/het/api'
import { localDateIn, placeTimestamp, previousDate, type Brief, type NextStepItem } from '../../../../main/library/brief'
import type { PeerList } from '../../../../main/peers/api'
import type { WorkflowCatalog } from '../../../../main/workflows/api'
import type { ProvenanceKind } from '../../../../main/workflows/schema'
import type { MemorySearchHit, ModelSnapshot, Point, RecentActivityResponse } from '../../../../shared/types'
import { tr } from '../../lib/i18n'

/** recent_activity limit used by Today / Home (IPC max is 100). */
export const RECENT_LIMIT = 100

// ── HET ────────────────────────────────────────────────────────────────────

export type HetCardView =
  | {
      kind: 'unmeasured'
      /** Why nothing is counted yet (Chinese, shown verbatim). */
      reason: string
      pending: number
      failed: number
      unsettled: number
    }
  | {
      kind: 'measured'
      /** Today's counted minutes in tenths; null when today has no counted task (still 未测量 for today). */
      todayTenths: number | null
      todayTasks: number
      windowTenths: number
      windowTasks: number
      windowDays: number
      pending: number
      failed: number
    }

/**
 * HET is "measured" only when at least one task was assessed and counted in the window.
 * Otherwise the card says 未测量: a 0 here would read as "0 minutes of AI work", which nobody measured.
 */
export function hetCardView(summary: HetSummary, today: string): HetCardView {
  const windowTasks = summary.days.reduce((n, d) => n + d.tasks, 0)
  if (windowTasks === 0) {
    let reason: string
    if (summary.state === 'notStarted') reason = tr('No assessed Agent work detected yet', '还没有检测到已完成评估的 Agent 工作')
    else if (summary.state === 'calculating') reason = tr('Calculating', '正在计算')
    else if (summary.pending > 0) reason = tr(`${summary.pending} tasks awaiting assessment`, `${summary.pending} 个任务等待评估`)
    else if (summary.failed > 0) reason = tr(`${summary.failed} task assessments failed`, `${summary.failed} 个任务评估失败`)
    else if (summary.unsettled > 0) reason = tr(`${summary.unsettled} sessions not finished yet`, `${summary.unsettled} 个会话尚未结束`)
    else reason = tr('No counted tasks in this period', '这段时间没有计入的任务')
    return { kind: 'unmeasured', reason, pending: summary.pending, failed: summary.failed, unsettled: summary.unsettled }
  }
  const day = summary.days.find((d) => d.date === today)
  return {
    kind: 'measured',
    todayTenths: day && day.tasks > 0 ? day.minutes_tenths : null,
    todayTasks: day?.tasks ?? 0,
    windowTenths: summary.total_minutes_tenths,
    windowTasks,
    windowDays: summary.days.length,
    pending: summary.pending,
    failed: summary.failed
  }
}

// ── Today / Actions ────────────────────────────────────────────────────────

/** Actions = the explicitly unfinished items the Today brief found (never habits, never a score). */
export function actionItems(brief: Brief): NextStepItem[] {
  return brief.nextSteps.filter((n) => n.kind === 'todo')
}

// ── Memories ───────────────────────────────────────────────────────────────

function pointTime(p: Point): string | null {
  return p.occurred_at ?? p.created_at ?? p.valid_from ?? null
}

/** Latest Points (is_latest only), newest first by occurred_at → created_at → valid_from. Undated last. */
export function recentPoints(model: ModelSnapshot, limit = 5): Array<{ point: Point; at: string | null }> {
  return model.points
    .filter((p) => p.is_latest !== false)
    .map((point) => ({ point, at: pointTime(point), ms: Date.parse(pointTime(point) ?? '') }))
    .sort((a, b) => {
      const am = Number.isNaN(a.ms) ? -Infinity : a.ms
      const bm = Number.isNaN(b.ms) ? -Infinity : b.ms
      if (am !== bm) return bm - am
      return a.point.id < b.point.id ? -1 : a.point.id > b.point.id ? 1 : 0
    })
    .slice(0, limit)
    .map(({ point, at }) => ({ point, at }))
}

// ── Heatmap ────────────────────────────────────────────────────────────────

export interface HeatmapView {
  /** Oldest first; each row has 24 hourly counts in `timezone`. */
  rows: Array<{ date: string; hours: number[]; total: number }>
  max: number
  /** Entries placed in the grid. */
  placed: number
  /** Entries in the window with a date but no time (cannot pick an hour). */
  dateOnly: number
  /** Entries older than the window. */
  outside: number
  /** Entries whose timestamp is missing or unparseable. */
  undated: number
  /** Entries read (≤ RECENT_LIMIT): the grid is a sample of the latest records, not all capture. */
  sampled: number
  /** True when the Runtime returned as many entries as were asked for (older ones may exist). */
  truncated: boolean
}

/** Day × hour grid of recent_activity timestamps (Runtime records), in `timezone`. */
export function heatmapView(recent: RecentActivityResponse, now: number, timezone: string, days = 7): HeatmapView {
  const dates: string[] = []
  let d = localDateIn(now, timezone)
  for (let i = 0; i < days; i++) {
    dates.unshift(d)
    d = previousDate(d)
  }
  const rows = dates.map((date) => ({ date, hours: new Array<number>(24).fill(0), total: 0 }))
  const index = new Map(dates.map((date, i) => [date, i]))
  let placed = 0
  let dateOnly = 0
  let outside = 0
  let undated = 0
  for (const e of recent.entries) {
    const at = placeTimestamp(e.timestamp, timezone)
    if (!at) {
      undated++
      continue
    }
    const i = index.get(at.date)
    if (i === undefined) {
      outside++
      continue
    }
    if (!at.time) {
      dateOnly++
      continue
    }
    const hour = Number(at.time.slice(0, 2))
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      dateOnly++
      continue
    }
    rows[i].hours[hour]++
    rows[i].total++
    placed++
  }
  const max = rows.reduce((m, r) => Math.max(m, ...r.hours), 0)
  return {
    rows,
    max,
    placed,
    dateOnly,
    outside,
    undated,
    sampled: recent.entries.length,
    truncated: recent.entries.length >= RECENT_LIMIT
  }
}

/** 0 → empty, else 1..4 by share of the max (shown as a legend, no hidden scale). */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0
  const r = count / max
  if (r > 0.75) return 4
  if (r > 0.5) return 3
  if (r > 0.25) return 2
  return 1
}

// ── Recent ─────────────────────────────────────────────────────────────────

export function recentItems(recent: RecentActivityResponse, timezone: string, limit = 5): Array<{ entry: MemorySearchHit; date: string | null; time: string | null }> {
  return recent.entries
    .map((entry) => ({ entry, at: placeTimestamp(entry.timestamp, timezone) }))
    .sort((a, b) => (b.at?.sort ?? '').localeCompare(a.at?.sort ?? ''))
    .slice(0, limit)
    .map(({ entry, at }) => ({ entry, date: at?.date ?? null, time: at?.time ?? null }))
}

// ── Agents / Connections ───────────────────────────────────────────────────

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  get connected() {
    return tr('Connected', '已连接')
  },
  get available() {
    return tr('Installed · not connected', '已安装 · 未连接')
  },
  get not_installed() {
    return tr('Not installed', '未安装')
  },
  get mismatch() {
    return tr('Config mismatch', '配置不一致')
  },
  get partial() {
    return tr('Partly configured', '部分配置')
  }
}

export function agentStateTone(state: AgentState): 'ok' | 'warn' | 'bad' | 'subtle' {
  if (state === 'connected') return 'ok'
  if (state === 'mismatch' || state === 'partial') return 'warn'
  return 'subtle'
}

export interface ConnectionsSummary {
  brokerRunning: boolean
  brokerUrl: string
  brokerError: string | null
  total: number
  counts: Record<AgentState, number>
  /** Agents that need attention (mismatch / partial). */
  attention: string[]
  connected: string[]
}

export function connectionsSummary(overview: ConnectionsOverview): ConnectionsSummary {
  const counts: Record<AgentState, number> = { connected: 0, available: 0, not_installed: 0, mismatch: 0, partial: 0 }
  for (const a of overview.agents) counts[a.state]++
  return {
    brokerRunning: overview.broker.running,
    brokerUrl: overview.broker.url,
    brokerError: overview.broker.error,
    total: overview.agents.length,
    counts,
    attention: overview.agents.filter((a) => a.state === 'mismatch' || a.state === 'partial').map((a) => a.name),
    connected: overview.agents.filter((a) => a.state === 'connected').map((a) => a.name)
  }
}

// ── Agent reads (Access log) ───────────────────────────────────────────────

export interface AccessSummary {
  /** Successful context reads in the window (Access log counts reads, not time saved). */
  reads: number
  responseChars: number
  days: number
  activeDays: number
  /** Reads on or after `since` (e.g. the last 7 local days). */
  recentReads: number
  byClient: Array<{ client: string; reads: number; responseChars: number }>
  lastDay: string | null
}

export function accessSummary(rows: AccessLogDay[], days: number, since: string): AccessSummary {
  const byClient = new Map<string, { reads: number; responseChars: number }>()
  const activeDays = new Set<string>()
  let reads = 0
  let responseChars = 0
  let recentReads = 0
  let lastDay: string | null = null
  for (const r of rows) {
    reads += r.reads
    responseChars += r.responseChars
    if (r.reads > 0) activeDays.add(r.day)
    if (r.day >= since) recentReads += r.reads
    if (r.reads > 0 && (lastDay === null || r.day > lastDay)) lastDay = r.day
    const c = byClient.get(r.client) ?? { reads: 0, responseChars: 0 }
    c.reads += r.reads
    c.responseChars += r.responseChars
    byClient.set(r.client, c)
  }
  return {
    reads,
    responseChars,
    days,
    activeDays: activeDays.size,
    recentReads,
    byClient: [...byClient.entries()]
      .map(([client, v]) => ({ client, ...v }))
      .sort((a, b) => b.reads - a.reads || a.client.localeCompare(b.client)),
    lastDay
  }
}

// ── Skills ─────────────────────────────────────────────────────────────────

export interface SkillsSummary {
  workflows: number
  byKind: Record<ProvenanceKind, number>
  /** behavior_patterns playbooks (Runtime skills); null when patterns were not read. */
  playbooks: number | null
  /** Catalog source problems worth surfacing (runtime skill files / behavior_patterns). */
  sourceIssues: string[]
}

export function skillsSummary(catalog: WorkflowCatalog, playbooks: number | null): SkillsSummary {
  const byKind: Record<ProvenanceKind, number> = { observed: 0, imported: 0, user_edited: 0, shared: 0 }
  for (const w of catalog.workflows) byKind[w.provenance.kind]++
  const sourceIssues: string[] = []
  const { runtimeFiles, behaviorPatterns } = catalog.sources
  if (runtimeFiles !== 'ok' && runtimeFiles !== 'missing') sourceIssues.push(tr(`Runtime skill files: ${runtimeFiles}`, `Runtime 技能文件：${runtimeFiles}`))
  if (behaviorPatterns !== 'ok' && behaviorPatterns !== 'skipped') sourceIssues.push(tr(`behavior_patterns: ${behaviorPatterns}`, `behavior_patterns：${behaviorPatterns}`))
  return { workflows: catalog.workflows.length, byKind, playbooks, sourceIssues }
}

// ── Peers ──────────────────────────────────────────────────────────────────

export interface PeersSummary {
  count: number
  /** Peers whose card is superseded by a newer same-name key (labelled 未核实). */
  oldKey: number
  unreadable: number
  latest: { name: string; importedAt: string } | null
}

export function peersSummary(list: PeerList): PeersSummary {
  let latest: PeersSummary['latest'] = null
  for (const p of list.peers) {
    const at = p.updatedAt || p.importedAt
    if (!latest || at > latest.importedAt) latest = { name: p.displayName ?? p.fingerprint.slice(0, 12), importedAt: at }
  }
  return {
    count: list.peers.length,
    oldKey: list.peers.filter((p) => p.verification === 'old_key').length,
    unreadable: list.unreadable,
    latest
  }
}
