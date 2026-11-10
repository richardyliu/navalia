import { createHash } from 'node:crypto'
import { overlapMs, unionWindows } from './timeline'
import type { AgentEvent, AgentId, AgentSignal, AttendedWindow, HetTask } from './types'

/**
 * Segmenter: transcript events (+ optional attended windows) → `HetTask` candidates.
 *
 * Pure and clock-injected: output depends only on (input, now, options). Events with
 * `ts > now` are treated as not yet observed, so replaying a corpus at an earlier `now`
 * yields exactly what a tick at that time would have seen.
 *
 * Algorithm:
 *  1. Group events by (agent, sessionId), sort by ts.
 *  2. Split each session wherever consecutive events are > `idleGapMs` apart.
 *  3. Merge segments of the same (agent, project) whose gap is ≤ `mergeGapMs`
 *     (overlapping parallel sessions in one project become one task).
 *     Segments with unknown project never merge across sessions.
 *  4. status = settled iff `now - end ≥ settleAfterMs`.
 *  5. attendedMs = overlap of [start, end] with the union of attended windows
 *     (null when no timeline supplied). It is evidence, not a boundary.
 *
 * Invariant enforced: mergeGapMs ≤ idleGapMs ≤ settleAfterMs. With it, a settled task
 * cannot grow from events at ts ≤ now that arrive in order (a late-flushed old event
 * can still reopen it; the ledger upsert must handle that by id).
 */

export interface SegmenterOptions {
  idleGapMs: number
  mergeGapMs: number
  settleAfterMs: number
  /** Drop segments with fewer events (noise: a lone title/system line). */
  minEvents: number
  /** Drop segments without at least one human prompt or assistant turn. */
  requireTurn: boolean
  maxFilesPerTask: number
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  idleGapMs: 30 * 60_000,
  mergeGapMs: 10 * 60_000,
  settleAfterMs: 30 * 60_000,
  minEvents: 2,
  requireTurn: true,
  maxFilesPerTask: 50
}

export interface SegmenterInput {
  events: AgentEvent[]
  attended?: AttendedWindow[]
  sessionTitles?: Record<string, string>
}

interface Segment {
  agent: AgentId
  sessionId: string
  project: string | null
  events: AgentEvent[]
  start: number
  end: number
}

export function validateOptions(o: SegmenterOptions): void {
  if (!(o.mergeGapMs >= 0 && o.mergeGapMs <= o.idleGapMs && o.idleGapMs <= o.settleAfterMs)) {
    throw new Error('segmenter options must satisfy 0 ≤ mergeGapMs ≤ idleGapMs ≤ settleAfterMs')
  }
}

function dominantProject(evs: AgentEvent[]): string | null {
  const counts = new Map<string, number>()
  for (const e of evs) if (e.project) counts.set(e.project, (counts.get(e.project) ?? 0) + 1)
  let best: string | null = null
  let bestN = 0
  for (const [p, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && p < best)) {
      best = p
      bestN = n
    }
  }
  return best
}

export function taskId(agent: AgentId, sessionId: string, start: number): string {
  return 'het_' + createHash('sha256').update(`${agent}\u0000${sessionId}\u0000${start}`).digest('hex').slice(0, 20)
}

/** Same as `segment`, also returning each task's member events (sorted by ts). */
export function segmentDetailed(
  input: SegmenterInput,
  now: number,
  options: Partial<SegmenterOptions> = {}
): Array<{ task: HetTask; events: AgentEvent[] }> {
  const o: SegmenterOptions = { ...DEFAULT_SEGMENTER_OPTIONS, ...options }
  validateOptions(o)

  // 1. group by session
  const bySession = new Map<string, AgentEvent[]>()
  for (const e of input.events) {
    if (!Number.isFinite(e.ts) || e.ts > now) continue
    const k = `${e.agent}\u0000${e.sessionId}`
    let arr = bySession.get(k)
    if (!arr) bySession.set(k, (arr = []))
    arr.push(e)
  }

  // 2. idle-gap split
  const segments: Segment[] = []
  for (const evs of bySession.values()) {
    evs.sort((a, b) => a.ts - b.ts || a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line)
    let cur: AgentEvent[] = []
    const flush = (): void => {
      if (!cur.length) return
      segments.push({
        agent: cur[0].agent,
        sessionId: cur[0].sessionId,
        project: dominantProject(cur),
        events: cur,
        start: cur[0].ts,
        end: cur[cur.length - 1].ts
      })
      cur = []
    }
    for (const e of evs) {
      if (cur.length && e.ts - cur[cur.length - 1].ts > o.idleGapMs) flush()
      cur.push(e)
    }
    flush()
  }

  const kept = segments.filter((s) => {
    if (s.events.length < o.minEvents) return false
    if (o.requireTurn && !s.events.some((e) => (e.role === 'user' && !e.sidechain) || e.role === 'assistant')) {
      return false
    }
    return true
  })

  // 3. same-project merge
  kept.sort((a, b) => a.start - b.start || a.sessionId.localeCompare(b.sessionId))
  const groups: Segment[][] = []
  const open = new Map<string, { group: Segment[]; end: number }>()
  for (const s of kept) {
    const key = s.project === null ? `${s.agent}\u0000#${s.sessionId}` : `${s.agent}\u0000${s.project}`
    const g = open.get(key)
    if (g && s.start - g.end <= o.mergeGapMs) {
      g.group.push(s)
      g.end = Math.max(g.end, s.end)
    } else {
      const group = [s]
      groups.push(group)
      open.set(key, { group, end: s.end })
    }
  }

  // 4–5. materialise
  const union = input.attended ? unionWindows(input.attended) : null
  const tasks = groups.map((group): { task: HetTask; events: AgentEvent[] } => {
    const first = group[0]
    const evs = group
      .flatMap((s) => s.events)
      .sort((a, b) => a.ts - b.ts || a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line)
    const start = Math.min(...group.map((s) => s.start))
    const end = Math.max(...group.map((s) => s.end))
    const sessionIds = [...new Set(group.map((s) => s.sessionId))]
    const written = new Set<string>()
    const read = new Set<string>()
    const signals = new Set<AgentSignal>()
    let toolCalls = 0
    for (const e of evs) {
      for (const f of e.filesWritten) written.add(f)
      for (const f of e.filesRead) if (!written.has(f)) read.add(f)
      for (const s of e.signals) signals.add(s)
      toolCalls += e.toolNames.length
    }
    for (const f of written) read.delete(f)
    const title = sessionIds.map((id) => input.sessionTitles?.[id]).find((t) => !!t) ?? null
    const task: HetTask = {
      id: taskId(first.agent, first.sessionId, first.start),
      agent: first.agent,
      project: first.project,
      title,
      start,
      end,
      kind: 'unassessed',
      status: now - end >= o.settleAfterMs ? 'settled' : 'unsettled',
      sessionIds,
      stats: {
        events: evs.length,
        userTurns: evs.filter((e) => e.role === 'user' && !e.sidechain).length,
        assistantTurns: evs.filter((e) => e.role === 'assistant').length,
        toolCalls,
        filesWritten: written.size,
        filesRead: read.size,
        sidechainEvents: evs.filter((e) => e.sidechain).length
      },
      filesWritten: [...written].sort().slice(0, o.maxFilesPerTask),
      signals: [...signals].sort(),
      attendedMs: union ? overlapMs(union, start, end) : null
    }
    return { task, events: evs }
  })
  return tasks.sort((a, b) => a.task.start - b.task.start || a.task.id.localeCompare(b.task.id))
}
