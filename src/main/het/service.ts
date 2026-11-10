import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { activeAnchorVersion } from './anchors'
import type { HetActivity, HetAssessorBudget, HetAssessorInfo, HetAssessorStatus, HetCountFilter, HetFilteredTasks, HetPeriod, HetWeekCounts, HetSummary, HetTaskDto, HetTickStatus, HetUpdateStatus, WeeklyReviewResult } from './api'
import { disabledTransport, type AssessorTransport } from './assessor'
import { FAKE_ASSESSOR_ENV, fixtureTransport, readAssessorFixture } from './fixtureTransport'
import { HET_SENT_FIELDS_MINIMAL, HET_SENT_FIELDS_SUMMARIES } from './api'
import { callsOnDay, correctTask, hetActivity, hetPeriod, hetSummary, hetTasks, localDay, openHetDb, retryFailed, revertCorrection } from './ledger'
import {
  DEFAULT_HET_SETTINGS,
  readHetSettings,
  setAssessorEnabled as persistAssessorEnabled,
  setSendSummariesToAssessor as persistSendSummaries
} from './settings'
import { createTranscriptSource, hetRootsFromEnv, HetAbortError, type TranscriptSource } from './sources'
import { tick } from './tick'
import type { HetCorrection } from './types'
import { buildWeeklyReview } from './weekly'
import { hetFilteredTasks, hetWeekCounts } from './weekCounts'

/**
 * Main-process HET service: owns het.db, runs the tick on startup and every
 * `intervalMs`, never overlaps ticks, and stops cleanly on quit. Transport defaults to
 * `disabledTransport` (no LLM call is possible from this module unless main injects one).
 *
 * S1-02 invariant: minutes can only be produced when ALL of
 *   (1) het-settings.json `assessorEnabled === true` (user switch, default false),
 *   (2) main injected a real `transport` (not `disabledTransport`), and
 *   (3) the injected `budget` probe returns `{ available: true }` (no probe ⇒ unavailable),
 * hold — or, in unpackaged builds only, the E2E fixture assessor is active. Otherwise the
 * tick is gated: no transport call, tasks stay `needs_assessment` with the gate reason.
 *
 * X3 (R4-1): main injects the Runtime `[agent_funding]` transport (agentFundingTransport.ts)
 * and a budget probe built on `readBudget()`. The user switch still defaults to off, so a
 * fresh install makes no model call. In unpackaged builds the E2E fixture (env
 * LENS_HET_FAKE_ASSESSOR + allowFakeAssessor) takes precedence over the injected transport.
 */

/** Result of the budget probe main injects next to a real transport. */
export interface HetBudgetState {
  available: boolean
  /** Short machine reason when unavailable, e.g. 'exhausted', 'not_configured'. */
  reason?: string
}

export type HetGate = { state: HetAssessorStatus['state']; gate: string | null; reason: string | null }

/** Pure decision rule for whether the assessor may run. Tested directly (tests/het/assessorGate.test.ts). */
export function assessorGate(i: {
  fixture: boolean
  enabled: boolean
  transportPresent: boolean
  budget: HetBudgetState | null
}): HetGate {
  if (i.fixture) return { state: 'fixture', gate: null, reason: null }
  if (!i.enabled) return { state: 'disabled', gate: 'assessor_disabled', reason: 'assessor_disabled' }
  if (!i.transportPresent) return { state: 'no_transport', gate: 'no_transport', reason: 'no_transport' }
  if (!i.budget || !i.budget.available) {
    const why = (i.budget?.reason ?? 'no_budget_probe').replace(/[^a-z0-9_]/gi, '_').slice(0, 40) || 'unknown'
    return { state: 'budget_unavailable', gate: `budget_unavailable:${why}`, reason: why }
  }
  return { state: 'ready', gate: null, reason: null }
}

export interface HetServiceDeps {
  dbFile: string
  settingsFile: string
  /**
   * Real assessor transport (production: agent_funding). Ignored unless the user enabled the
   * assessor AND `budget` reports available.
   */
  transport?: AssessorTransport
  /** X3: display-only metadata for the settings view (client / model / Runtime budget). Must not throw. */
  assessorMeta?: () => { client: string | null; model: string | null; runtimePythonPresent: boolean; budget: HetAssessorBudget | null }
  /** Budget probe paired with `transport`; called once per tick. Missing ⇒ unavailable. Must not throw (a throw ⇒ unavailable). */
  budget?: () => HetBudgetState
  source?: TranscriptSource
  intervalMs?: number
  now?: () => number
  log?: (msg: string) => void
  /** Max time `stop()` waits for an in-flight tick after aborting it (default 2000 ms). */
  stopTimeoutMs?: number
  /** Env for transcript roots (LENS_HET_CLAUDE_ROOT / LENS_HET_CODEX_ROOT); default process.env. */
  env?: NodeJS.ProcessEnv
  /**
   * E2E only. When true AND env LENS_HET_FAKE_ASSESSOR is set, use the fixture transport
   * (no LLM). Main passes `!app.isPackaged`; packaged builds can never enable it.
   */
  allowFakeAssessor?: boolean
}

export interface HetService {
  start(): void
  stop(): Promise<void>
  tickNow(): Promise<void>
  status(): HetTickStatus
  summary(days?: number, timezone?: string): HetSummary
  tasks(limit?: number, includeActivity?: boolean): HetTaskDto[]
  period(start: number, end: number, cursor?: string | null, limit?: number, includeActivity?: boolean, timezone?: string): HetPeriod
  activity(start: number, end: number, timezone?: string): HetActivity
  correct(taskId: string, action: HetCorrection): { minutes_tenths: number | null; changed: boolean }
  /** Undo a correction (D17 reversible). Minutes re-derived from verdict + anchors. */
  revertCorrection(taskId: string): { minutes_tenths: number | null; changed: boolean }
  /** HET-08: re-queue failed tasks, then run one tick (same gate, caps, backoff). */
  retry(): Promise<{ requeued: number }>
  /** Last ledger update outcome; `error` is a short path-free code. */
  update(): HetUpdateStatus
  /** Persist the user switch and schedule a tick. Returns the new assessor status. */
  setAssessorEnabled(enabled: boolean): HetAssessorStatus
  /** X3 settings view. */
  assessorInfo(): HetAssessorInfo
  /** X3: persist `sendSummariesToAssessor`. Callers must confirm before turning it ON (ipc.ts). */
  setSendSummaries(enabled: boolean): boolean
  /** Writes `<base>.md` and `<base>.html`. `targetMd` comes from the main-process save dialog. */
  exportWeekly(weekStartMs: number, targetMd: string | null): WeeklyReviewResult
  /** S1-R3-04: counts for the ISO week containing now (no minutes, no score). */
  weekCounts(timezone?: string): HetWeekCounts
  /** S1-R3-04 click-through list for one count filter. */
  filteredTasks(start: number, end: number, filter: HetCountFilter, cursor?: string | null, limit?: number, timezone?: string): HetFilteredTasks
}

/**
 * Write `<base>.md` + `<base>.html` without clobbering anything (flag `wx`, finding #7).
 * If either exists, tries `<base>-1`, `<base>-2`, … and returns the paths actually written.
 */
export function writeExportPair(targetMd: string, markdown: string, html: string): { mdPath: string; htmlPath: string } {
  const base = targetMd.replace(/\.(md|markdown)$/i, '')
  for (let n = 0; n < 100; n++) {
    const stem = n === 0 ? base : `${base}-${n}`
    const mdPath = `${stem}.md`
    const htmlPath = `${stem}.html`
    if (existsSync(mdPath) || existsSync(htmlPath)) continue
    try {
      writeFileSync(mdPath, markdown, { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    try {
      writeFileSync(htmlPath, html, { mode: 0o600, flag: 'wx' })
    } catch (e) {
      unlinkSync(mdPath) // keep the pair together; we created mdPath just now
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    return { mdPath, htmlPath }
  }
  throw new Error('could not find a free export file name')
}

/** Short, path-free code for a failed ledger update (exposed via REST/UI; raw message stays in the main log). */
export function updateErrorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{2,32}$/i.test(code)) return `update_failed:${code}`
  const name = e instanceof Error ? e.name : ''
  return /^[A-Za-z]{2,32}$/.test(name) && name !== 'Error' ? `update_failed:${name}` : 'update_failed'
}

export function createHetService(deps: HetServiceDeps): HetService {
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  const log0 = deps.log ?? (() => undefined)
  const fakePath = env[FAKE_ASSESSOR_ENV]?.trim()
  let transport: AssessorTransport = deps.transport ?? disabledTransport
  let fixture = false
  if (fakePath) {
    if (deps.allowFakeAssessor === true) {
      transport = fixtureTransport(readAssessorFixture(fakePath))
      fixture = true
      log0('[het] fake assessor fixture enabled (unpackaged build, no LLM)')
    } else log0(`[het] ${FAKE_ASSESSOR_ENV} ignored: fake assessor not allowed in this build`)
  }
  const realTransport = !fixture && deps.transport !== undefined && deps.transport !== disabledTransport
  const source = deps.source ?? createTranscriptSource(hetRootsFromEnv(env))
  const stopTimeoutMs = deps.stopTimeoutMs ?? 2000
  const abort = new AbortController()
  const intervalMs = deps.intervalMs ?? 5 * 60_000
  const log = deps.log ?? (() => undefined)
  let db: DatabaseSync | null = openHetDb(deps.dbFile, now())
  let timer: NodeJS.Timeout | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false
  let lastTickAt: number | null = null
  let lastError: string | null = null
  let lastErrorCode: string | null = null
  let consecutiveFailures = 0
  let lastBudget: HetBudgetState | null = null

  const probeBudget = (): HetBudgetState => {
    if (!deps.budget) return { available: false, reason: 'no_budget_probe' }
    try {
      const b = deps.budget()
      return { available: b.available === true, reason: b.reason }
    } catch {
      return { available: false, reason: 'probe_error' }
    }
  }
  const enabledNow = (): boolean => {
    try {
      return readHetSettings(deps.settingsFile).assessorEnabled
    } catch {
      return false
    }
  }
  const assessorStatus = (): HetAssessorStatus => {
    const enabled = enabledNow()
    const g = assessorGate({ fixture, enabled, transportPresent: realTransport, budget: realTransport && enabled ? lastBudget ?? { available: false, reason: 'not_probed' } : null })
    return { enabled, transport_present: realTransport || fixture, state: g.state, reason: g.reason }
  }

  const updateStatus = (): HetUpdateStatus => ({
    failed: lastErrorCode !== null,
    error: lastErrorCode,
    last_tick_at: lastTickAt === null ? null : new Date(lastTickAt).toISOString(),
    consecutive_failures: consecutiveFailures
  })

  const need = (): DatabaseSync => {
    if (!db) throw new Error('HET ledger is closed')
    return db
  }

  async function runTick(): Promise<void> {
    if (stopped || !db) return
    try {
      const input = await source.refresh(abort.signal)
      if (stopped || !db) return
      const settings = readHetSettings(deps.settingsFile)
      const budget = !fixture && realTransport && settings.assessorEnabled ? probeBudget() : null
      lastBudget = budget
      const { gate } = assessorGate({ fixture, enabled: settings.assessorEnabled, transportPresent: realTransport, budget })
      const r = await tick({ db, transport, settings, input, signal: abort.signal, gate }, now())
      lastTickAt = r.now
      lastError = null
      lastErrorCode = null
      consecutiveFailures = 0
      log(`[het] tick ${JSON.stringify({ upserts: r.upserts, calls: r.assess.calls, skipped: r.assess.skipped ?? null, gate: r.assess.gate ?? null })}`)
    } catch (e) {
      if (e instanceof HetAbortError || stopped) {
        log('[het] tick aborted by stop()')
        return
      }
      lastError = e instanceof Error ? e.message : String(e)
      lastErrorCode = updateErrorCode(e)
      consecutiveFailures++
      log(`[het] tick failed: ${lastError}`)
    }
  }

  function tickNow(): Promise<void> {
    if (!inFlight) inFlight = runTick().finally(() => (inFlight = null))
    return inFlight
  }

  return {
    start() {
      if (timer || stopped) return
      void tickNow()
      timer = setInterval(() => void tickNow(), intervalMs)
      timer.unref?.()
    },
    /**
     * Bounded shutdown (finding R3): abort the in-flight tick (it stops at the next file
     * boundary / before the next assessor call), wait at most `stopTimeoutMs`, then close.
     * A tick still running after the deadline finds the ledger closed and exits via catch.
     */
    async stop() {
      if (stopped && !db) return
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      abort.abort()
      if (inFlight) {
        let to: NodeJS.Timeout | undefined
        const timedOut = await Promise.race([
          inFlight.then(() => false),
          new Promise<boolean>((r) => (to = setTimeout(() => r(true), stopTimeoutMs)))
        ])
        clearTimeout(to)
        if (timedOut) log(`[het] stop: in-flight tick did not finish within ${stopTimeoutMs} ms; closing anyway`)
      }
      try {
        db?.close()
      } catch {
        // already closed
      }
      db = null
    },
    tickNow,
    status: () => ({
      lastTickAt: lastTickAt === null ? null : new Date(lastTickAt).toISOString(),
      running: inFlight !== null,
      lastError,
      transport: transport.name,
      assessor: assessorStatus()
    }),
    summary: (days, timezone) => {
      const s = hetSummary(need(), { now: now(), days, timezone })
      const update = updateStatus()
      if (!update.failed) return { ...s, update }
      return { ...s, update, ledger_state: s.state, state: 'updateFailed' }
    },
    update: () => updateStatus(),
    tasks: (limit, includeActivity) => hetTasks(need(), { limit, includeActivity }),
    period: (start, end, cursor, limit, includeActivity, timezone) =>
      hetPeriod(need(), { start, end, cursor, limit, includeActivity, timezone }),
    activity: (start, end, timezone) => hetActivity(need(), { start, end, timezone }),
    weekCounts: (timezone) => hetWeekCounts(need(), { now: now(), timezone }),
    filteredTasks: (start, end, filter, cursor, limit, timezone) =>
      hetFilteredTasks(need(), { start, end, filter, cursor, limit, timezone }),
    correct: (taskId, action) => {
      const r = correctTask(need(), taskId, action, now())
      return { minutes_tenths: r.minutesTenths, changed: r.changed }
    },
    revertCorrection: (taskId) => {
      const r = revertCorrection(need(), taskId, now())
      return { minutes_tenths: r.minutesTenths, changed: r.changed }
    },
    async retry() {
      const requeued = retryFailed(need(), now())
      if (!stopped) await tickNow()
      return { requeued }
    },
    assessorInfo() {
      const st = assessorStatus()
      let settings = { ...DEFAULT_HET_SETTINGS }
      let metaV: ReturnType<NonNullable<HetServiceDeps['assessorMeta']>> = { client: null, model: null, runtimePythonPresent: false, budget: null }
      try {
        if (deps.assessorMeta) metaV = deps.assessorMeta()
      } catch {
        // display only
      }
      try {
        settings = readHetSettings(deps.settingsFile)
      } catch {
        // keep defaults
      }
      const d = need()
      const send = settings.sendSummariesToAssessor
      return {
        ...st,
        transport: transport.name,
        runtime_python_present: metaV.runtimePythonPresent,
        client: metaV.client,
        model: metaV.model,
        budget: metaV.budget,
        send_summaries: send,
        anchor_version: activeAnchorVersion(d),
        per_tick_cap: settings.perTickCap,
        per_day_cap: settings.perDayCap,
        calls_today: callsOnDay(d, localDay(now())),
        sent_fields: send ? [...HET_SENT_FIELDS_MINIMAL, ...HET_SENT_FIELDS_SUMMARIES] : [...HET_SENT_FIELDS_MINIMAL]
      }
    },
    setSendSummaries(enabled) {
      return persistSendSummaries(deps.settingsFile, enabled).sendSummariesToAssessor
    },
    setAssessorEnabled(enabled) {
      persistAssessorEnabled(deps.settingsFile, enabled)
      lastBudget = null
      if (!stopped) void tickNow()
      return assessorStatus()
    },
    exportWeekly(weekStartMs, targetMd) {
      const review = buildWeeklyReview(need(), weekStartMs, now(), assessorStatus())
      if (!targetMd) return { markdownPath: null, htmlPath: null, total_minutes_tenths: review.totalTenths, rows: review.counted.length }
      const { mdPath, htmlPath } = writeExportPair(targetMd, review.markdown, review.html)
      return { markdownPath: mdPath, htmlPath, total_minutes_tenths: review.totalTenths, rows: review.counted.length }
    }
  }
}
