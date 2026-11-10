import { activeAnchorVersion } from './anchors'
import { assessOne, type AssessorTransport } from './assessor'
import {
  applyVerdict,
  assessQueue,
  callsOnDay,
  getMeta,
  inTx,
  localDay,
  markGated,
  markNeedsAssessment,
  recordCall,
  setMeta,
  taskForAssessor,
  upsertTask,
  type UpsertOutcome
} from './ledger'
import type { SqlDb } from './schema'
import { segmentDetailed, type SegmenterInput, type SegmenterOptions } from './segmenter'
import type { HetSettings } from './settings'

/**
 * tick(now): segment → upsert by stable id (reopen on growth) → assess within caps → promote.
 *
 * Caps (hard): per tick `perTickCap` transport invocations; per local day `perDayCap`
 * invocations that reached a model. Never retries within a tick. quota / offline / error /
 * budget_unavailable stop the assess phase and block it for `backoffMs`. `invalid` counts
 * a task attempt and moves on. Idempotent: a tick at `now <= last_tick_ms` runs no
 * assessment, and the upsert phase is a no-op on unchanged input.
 */

export interface TickDeps {
  db: SqlDb
  transport: AssessorTransport
  settings: HetSettings
  input: SegmenterInput
  segmenter?: Partial<SegmenterOptions>
  dayOf?: (ms: number) => string
  /** Checked before each assessor call; an abort ends the assess phase (no partial writes). */
  signal?: AbortSignal
  /**
   * S1-02: when set, the assessor is not allowed to run this tick. No transport call is made,
   * no agent_calls row is written; waiting tasks get `last_error = gate` (e.g.
   * 'assessor_disabled', 'no_transport', 'budget_unavailable:<why>') so the UI can say why.
   */
  gate?: string | null
}

export interface TickReport {
  now: number
  upserts: Record<UpsertOutcome, number>
  assess: {
    ran: boolean
    skipped?: 'replayed_tick' | 'blocked' | 'day_cap' | 'tick_cap_zero' | 'no_anchor' | 'gated'
    gate?: string
    calls: number
    outcomes: Record<string, number>
    stoppedOn?: string
  }
}

const STOP_OUTCOMES = new Set(['quota', 'offline', 'error', 'budget_unavailable'])

export async function tick(deps: TickDeps, now: number): Promise<TickReport> {
  const { db, settings } = deps
  const dayOf = deps.dayOf ?? localDay
  const report: TickReport = {
    now,
    upserts: { inserted: 0, settled: 0, updated: 0, reopened: 0, unchanged: 0 },
    assess: { ran: false, calls: 0, outcomes: {} }
  }

  // 1–2. segment + upsert (one transaction)
  const detailed = segmentDetailed(deps.input, now, deps.segmenter)
  inTx(db, () => {
    for (const { task, events } of detailed) {
      const o = upsertTask(db, task, events, {
        now,
        persistSummaries: settings.persistSummaries,
        evidencePerTask: settings.evidencePerTask
      })
      report.upserts[o]++
    }
  })

  // 3. assess within caps
  const lastTick = Number(getMeta(db, 'last_tick_ms') ?? '-Infinity')
  if (now <= lastTick) {
    report.assess.skipped = 'replayed_tick'
    return report
  }
  inTx(db, () => setMeta(db, 'last_tick_ms', String(now)))

  if (deps.gate) {
    const gate = deps.gate
    inTx(db, () => markGated(db, gate, now))
    report.assess.skipped = 'gated'
    report.assess.gate = gate
    return report
  }

  const blockedUntil = Number(getMeta(db, 'assessor_blocked_until') ?? '0')
  if (now < blockedUntil) {
    report.assess.skipped = 'blocked'
    return report
  }
  const anchorVersion = activeAnchorVersion(db)
  if (anchorVersion === null) {
    report.assess.skipped = 'no_anchor'
    return report
  }
  const day = dayOf(now)
  const dayLeft = settings.perDayCap - callsOnDay(db, day)
  const budget = Math.min(settings.perTickCap, dayLeft)
  if (settings.perTickCap === 0) {
    report.assess.skipped = 'tick_cap_zero'
    return report
  }
  if (dayLeft <= 0) {
    report.assess.skipped = 'day_cap'
    return report
  }

  report.assess.ran = true
  const queue = assessQueue(db, now, settings.backoffMs, budget)
  for (const id of queue) {
    if (report.assess.calls >= budget) break
    if (deps.signal?.aborted) {
      report.assess.stoppedOn = 'aborted'
      break
    }
    const { task, evidence } = taskForAssessor(db, id)
    const res = await assessOne(task, evidence, deps.transport, settings.maxInputChars, settings.sendSummariesToAssessor)
    report.assess.calls++
    report.assess.outcomes[res.outcome] = (report.assess.outcomes[res.outcome] ?? 0) + 1
    inTx(db, () => {
      recordCall(db, {
        taskId: id,
        now,
        day,
        tickMs: now,
        transport: deps.transport.name,
        outcome: res.outcome,
        inputChars: res.inputChars,
        outputChars: res.outputChars,
        client: res.client ?? null,
        model: res.model ?? null,
        anchorVersion: res.outcome === 'ok' && res.verdict ? anchorVersion : null
      })
      if (res.outcome === 'ok' && res.verdict) {
        const prov = res.client != null || res.model != null ? { client: res.client ?? null, model: res.model ?? null } : {}
        applyVerdict(db, id, res.verdict, anchorVersion, now, prov)
      }
      else {
        const countAttempt = res.outcome === 'invalid' || res.outcome === 'error'
        markNeedsAssessment(db, id, res.outcome, res.reason, countAttempt, settings.maxAttempts, now)
        if (STOP_OUTCOMES.has(res.outcome)) setMeta(db, 'assessor_blocked_until', String(now + settings.backoffMs))
      }
    })
    if (STOP_OUTCOMES.has(res.outcome)) {
      report.assess.stoppedOn = res.outcome
      break
    }
  }
  return report
}
