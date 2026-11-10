// S1-R4-05 proactive engine: one tick = read sources for the enabled triggers → candidates → gates
// (quiet hours, daily cap, dedupe, cooldown) → notifier. Clock, notifier, sources and store are all
// injected, so this file never touches Electron, the network or the real Lens Store by itself.
//
// Order: T3 owner_aliases, T4 capture_degraded, T5 runtime, T8 meeting_ready, T9 friend_moment,
// T1 daily_brief, T2 carried_todos, T10 weekly_counts.
// A disabled trigger's source is not read at all. A source that throws or returns null is silent.
//
// S1-FULL C17:
// - Context-sufficiency gate: gated triggers (GATED_TRIGGERS) fire only when ≥ settings.minItems
//   distinct evidenced items back them; below that they stay silent (`below_threshold`).
// - Decision log: every evaluation of an enabled trigger is recorded as fired / suppressed + reason
//   (store.appendDecisions). Nothing is recorded while the master switch is off.
// - Event triggers read `state.pendingEvents` (filled by service.ts from the event bus).
// - dailyCap / briefDays / detail come from settings.
import { createHash } from 'node:crypto'
import { addDays, dayIn } from '../het/tz'
import {
  BODY,
  CAPTURE_DEGRADED_MIN_MS,
  CAPTURE_ISSUES,
  DETAIL_MAX_CHARS,
  EVENT_TTL_MS,
  NOTIFICATION_TITLE,
  PROACTIVE_TRIGGERS,
  RUNTIME_DOWN_MIN_MS,
  TRIGGER_COOLDOWN,
  TRIGGER_ROUTE,
  type CaptureIssue,
  type DecisionReason,
  type EventTrigger,
  type ProactiveDecision,
  type ProactiveRoute,
  type ProactiveSettings,
  type ProactiveTrigger
} from './api'
import type { ProactiveState, ProactiveStore } from './store'

// --- sources -----------------------------------------------------------------------------------

/** T4 sample. `null` fields mean "unknown", which never counts as bad. */
export interface CaptureSample {
  /** Lens capture plane started (ingest mode). Permissions only matter while it is. */
  captureActive: boolean
  accessibility: boolean | null
  screenRecording: boolean | null
  /** Cumulative ingest `rejected` counter of this app run. */
  ingestRejectedTotal: number | null
  /** Runtime `/health` fields, or null when /health was not reachable. */
  health: { ocr_enabled: boolean | null; ocr: string | null; ocr_worker: string | null; capture_pipeline: string | null } | null
}

export interface RuntimeSample {
  reachable: boolean
  /** Runtime identity marker (`schema:<rev>|build:<build_version>`, or `version:<v>` on older Runtimes); null when unknown. */
  revision: string | null
}

export interface BriefSample {
  /** Stable keys (brief.ts nextStepKey) of today's 下一步 items. */
  nextSteps: string[]
  /** Keys of explicit todos from yesterday's records that are still listed as open. */
  yesterdayTodos: string[]
}

/** T10 sample: last ISO week's owner-only counts (performance/counts.ts), as evidence row ids. */
export interface WeekSample {
  /** Local Monday label (YYYY-MM-DD) of the week the items belong to. */
  weekStart: string
  /** One stable id per evidenced row (task id / event id / commit hash). */
  items: string[]
}

export interface ProactiveSources {
  /** T3: alias keys of pending owner-alias candidates (Runtime GET /owner-aliases?status=pending). */
  ownerAliasesPending(): Promise<string[] | null>
  capture(): Promise<CaptureSample | null>
  runtime(): Promise<RuntimeSample | null>
  brief(now: number, timezone: string): Promise<BriefSample | null>
  /** T10. Optional: absent ⇒ no source (silent). */
  lastWeek?(now: number, timezone: string): Promise<WeekSample | null>
}

export interface Notifier {
  isSupported(): boolean
  /** Resolves 'shown' when the OS reported it shown. `onClick` must only open a Lens page. */
  show(n: { title: string; body: string }, onClick?: () => void): Promise<'shown' | 'failed' | 'timeout'>
}

// --- time ---------------------------------------------------------------------------------------

const hmFmt = new Map<string, Intl.DateTimeFormat>()
/** Minutes since local midnight in `tz`. */
export function localMinutes(ms: number, tz: string): number {
  let f = hmFmt.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    hmFmt.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return Number(p.hour) * 60 + Number(p.minute)
}

export const hhmm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

/** Quiet hours [start, end) local; start > end crosses midnight; start === end means none. */
export function inQuietHours(ms: number, tz: string, q: { start: string; end: string }): boolean {
  const t = localMinutes(ms, tz)
  const s = hhmm(q.start)
  const e = hhmm(q.end)
  if (s === e) return false
  return s < e ? t >= s && t < e : t >= s || t < e
}

/** 0 = Sunday … 6 = Saturday, for the local date label. */
export function weekdayOf(label: string): number {
  const [y, m, d] = label.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Local Monday label of the ISO week containing `label`. */
export function mondayOf(label: string): string {
  return addDays(label, -((weekdayOf(label) + 6) % 7))
}

// --- ids ----------------------------------------------------------------------------------------

/** 16-hex sha256 prefix: lets the log say "which rows" without storing a name or text. */
export const hashId = (prefix: string, value: string): string => `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`

export function dedupeKey(trigger: ProactiveTrigger, sourceIds: string[]): string {
  return `${trigger}:${createHash('sha256').update([...sourceIds].sort().join('\n')).digest('hex').slice(0, 32)}`
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** Detail label: one line, control characters removed, cut to DETAIL_MAX_CHARS. Only used when settings.detail. */
export function detailLabel(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const one = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!one) return null
  return one.length > DETAIL_MAX_CHARS ? `${one.slice(0, DETAIL_MAX_CHARS - 1)}…` : one
}

// --- evaluators ---------------------------------------------------------------------------------

export interface Candidate {
  trigger: ProactiveTrigger
  sourceIds: string[]
  body: string
  /** Gate inputs, for the decision log. */
  count?: number
  threshold?: number
  /** Bypasses the per-trigger cooldown (only T4's single "recovered" message). */
  ignoreCooldown?: boolean
  /** State change applied only if the notification is actually sent (or found already sent). */
  commit(state: ProactiveState): void
}

export interface Silence {
  reason: DecisionReason
  count?: number
  threshold?: number
  sourceIds?: string[]
}

interface Evaluation {
  candidates: Candidate[]
  silent: Silence[]
}

const quiet = (s: Silence): Evaluation => ({ candidates: [], silent: [s] })
const fire = (...c: Candidate[]): Evaluation => ({ candidates: c, silent: [] })

interface Ctx {
  now: number
  tz: string
  settings: ProactiveSettings
  state: ProactiveState
  sources: ProactiveSources
  brief: () => Promise<BriefSample | null>
  /** In-memory labels for pending events (never persisted), keyed by hashed event id. */
  labels: ReadonlyMap<string, string>
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

/** T3: pending count rises above the last-seen count (no previous observation = 0). */
async function evalOwnerAliases(c: Ctx): Promise<Evaluation> {
  const keys = await safe(() => c.sources.ownerAliasesPending())
  if (!keys) return quiet({ reason: 'no_source' })
  const unique = [...new Set(keys)]
  const n = unique.length
  const last = c.state.ownerAliases.lastSeen ?? 0
  // Falling counts lower the baseline right away, so the next rise fires again.
  if (n < last) c.state.ownerAliases.lastSeen = n
  if (n <= last) {
    if (c.state.ownerAliases.lastSeen === null) c.state.ownerAliases.lastSeen = n
    return quiet({ reason: 'no_change', count: n })
  }
  return fire({
    trigger: 'owner_aliases',
    sourceIds: unique.map((k) => hashId('alias', k)).sort(),
    body: BODY.ownerAliases(n),
    count: n,
    commit: (s) => void (s.ownerAliases.lastSeen = n)
  })
}

const BAD_HEALTH = /degraded|error|fail|unavailable|stopped|down|crash|missing|denied/i

export function captureIssues(sample: CaptureSample, lastRejected: number | null): CaptureIssue[] {
  const out = new Set<CaptureIssue>()
  if (sample.captureActive && sample.screenRecording === false) out.add('perm_screen_recording')
  if (sample.captureActive && sample.accessibility === false) out.add('perm_accessibility')
  if (sample.ingestRejectedTotal !== null && lastRejected !== null && sample.ingestRejectedTotal > lastRejected) out.add('ingest_rejected')
  const h = sample.health
  if (h) {
    if (h.ocr_enabled === true && h.ocr && BAD_HEALTH.test(h.ocr)) out.add('ocr')
    if (h.ocr_enabled === true && h.ocr_worker && BAD_HEALTH.test(h.ocr_worker)) out.add('ocr_worker')
    if (h.capture_pipeline && BAD_HEALTH.test(h.capture_pipeline)) out.add('capture_pipeline')
  }
  return CAPTURE_ISSUES.filter((i) => out.has(i))
}

/** T4: bad continuously ≥10 min → once per incident; then one "recovered" message. */
async function evalCapture(c: Ctx): Promise<Evaluation> {
  const sample = await safe(() => c.sources.capture())
  if (!sample) return quiet({ reason: 'no_source' })
  const st = c.state.capture
  const issues = captureIssues(sample, st.lastRejected)
  if (sample.ingestRejectedTotal !== null) st.lastRejected = sample.ingestRejectedTotal
  if (issues.length > 0) {
    if (st.badSince === null) st.badSince = c.now
    st.issues = [...new Set([...st.issues, ...issues])].filter((i): i is CaptureIssue => (CAPTURE_ISSUES as string[]).includes(i))
    if (st.notified) return quiet({ reason: 'no_change', count: issues.length })
    if (c.now - st.badSince < CAPTURE_DEGRADED_MIN_MS) return quiet({ reason: 'not_due', count: issues.length })
    const since = st.badSince
    return fire({
      trigger: 'capture_degraded',
      sourceIds: [`since:${iso(since)}`, ...issues].sort(),
      body: BODY.captureDegraded(issues),
      count: issues.length,
      commit: (s) => void (s.capture.notified = true)
    })
  }
  // Good now.
  if (!st.notified) {
    st.badSince = null
    st.issues = []
    return quiet({ reason: 'no_change', count: 0 })
  }
  const since = st.badSince ?? c.now
  return fire({
    trigger: 'capture_degraded',
    sourceIds: ['recovered', `since:${iso(since)}`].sort(),
    body: BODY.captureRecovered(),
    ignoreCooldown: true,
    commit: (s) => {
      s.capture.badSince = null
      s.capture.issues = []
      s.capture.notified = false
    }
  })
}

/** T5: unreachable ≥5 min (once per incident), or revision changed since the last one seen. */
async function evalRuntime(c: Ctx): Promise<Evaluation> {
  const sample = await safe(() => c.sources.runtime())
  if (!sample) return quiet({ reason: 'no_source' })
  const st = c.state.runtime
  if (!sample.reachable) {
    if (st.downSince === null) st.downSince = c.now
    if (st.notified) return quiet({ reason: 'no_change' })
    if (c.now - st.downSince < RUNTIME_DOWN_MIN_MS) return quiet({ reason: 'not_due' })
    const since = st.downSince
    return fire({ trigger: 'runtime', sourceIds: ['down', `since:${iso(since)}`].sort(), body: BODY.runtimeDown(), commit: (s) => void (s.runtime.notified = true) })
  }
  st.downSince = null
  st.notified = false
  if (!sample.revision) return quiet({ reason: 'no_change' })
  // Only a hash of the revision is kept (state and log), never the string itself.
  const rev = hashId('revision', sample.revision)
  if (st.revision === null) {
    st.revision = rev // first observation is the baseline, not an upgrade
    return quiet({ reason: 'no_change' })
  }
  if (st.revision === rev) return quiet({ reason: 'no_change' })
  return fire({ trigger: 'runtime', sourceIds: [rev], body: BODY.runtimeUpgraded(), commit: (s) => void (s.runtime.revision = rev) })
}

/** Shared time gate for T1 / T2 / T10: briefTime reached and (weekdays only) Monday–Friday. */
function dailyGate(c: Ctx): Silence | null {
  if (c.settings.briefDays === 'weekdays') {
    const wd = weekdayOf(dayIn(c.now, c.tz))
    if (wd === 0 || wd === 6) return { reason: 'not_today' }
  }
  if (localMinutes(c.now, c.tz) < hhmm(c.settings.briefTime)) return { reason: 'not_due' }
  return null
}

/** T1: at/after briefTime on a local day, if today's brief has ≥ minItems 下一步. */
async function evalDailyBrief(c: Ctx): Promise<Evaluation> {
  const gate = dailyGate(c)
  if (gate) return quiet(gate)
  const b = await c.brief()
  if (!b) return quiet({ reason: 'no_source' })
  const keys = [...new Set(b.nextSteps)]
  const min = c.settings.minItems.daily_brief
  if (keys.length < min) return quiet({ reason: 'below_threshold', count: keys.length, threshold: min })
  const today = dayIn(c.now, c.tz)
  return fire({
    trigger: 'daily_brief',
    sourceIds: [`date:${today}`, ...keys.map((k) => hashId('step', k)).sort()],
    body: BODY.dailyBrief(keys.length),
    count: keys.length,
    threshold: min,
    commit: () => undefined
  })
}

/** T2: yesterday's explicit todos still open; once per local day, from briefTime. */
async function evalCarriedTodos(c: Ctx): Promise<Evaluation> {
  const gate = dailyGate(c)
  if (gate) return quiet(gate)
  const b = await c.brief()
  if (!b) return quiet({ reason: 'no_source' })
  const keys = [...new Set(b.yesterdayTodos)]
  const min = c.settings.minItems.carried_todos
  if (keys.length < min) return quiet({ reason: 'below_threshold', count: keys.length, threshold: min })
  const today = dayIn(c.now, c.tz)
  return fire({
    trigger: 'carried_todos',
    sourceIds: [`date:${today}`, ...keys.map((k) => hashId('todo', k)).sort()],
    body: BODY.carriedTodos(keys.length),
    count: keys.length,
    threshold: min,
    commit: () => undefined
  })
}

/** T10: last ISO week's evidenced 「表现」 rows; at most once per week (dedupe on the week label). */
async function evalWeeklyCounts(c: Ctx): Promise<Evaluation> {
  const gate = dailyGate(c)
  if (gate) return quiet(gate)
  const lastWeek = c.sources.lastWeek
  if (!lastWeek) return quiet({ reason: 'no_source' })
  const w = await safe(() => lastWeek(c.now, c.tz))
  if (!w) return quiet({ reason: 'no_source' })
  // Only accept the week that actually precedes today's week (a source bug cannot re-announce old weeks).
  const expected = addDays(mondayOf(dayIn(c.now, c.tz)), -7)
  if (w.weekStart !== expected) return quiet({ reason: 'no_source' })
  const items = [...new Set(w.items)]
  const min = c.settings.minItems.weekly_counts
  if (items.length < min) return quiet({ reason: 'below_threshold', count: items.length, threshold: min, sourceIds: [`week:${w.weekStart}`] })
  return fire({
    trigger: 'weekly_counts',
    sourceIds: [`week:${w.weekStart}`],
    body: BODY.weeklyCounts(items.length),
    count: items.length,
    threshold: min,
    commit: () => undefined
  })
}

const EVENT_BODY: Record<EventTrigger, (n: number) => string> = {
  meeting_ready: BODY.meetingReady,
  friend_moment: BODY.friendMoment
}

/** T8 / T9: one candidate per pending event that passes the gate; others are dropped and logged. */
function evalEvents(trigger: EventTrigger) {
  return async (c: Ctx): Promise<Evaluation> => {
    const mine = c.state.pendingEvents.filter((e) => e.trigger === trigger)
    if (mine.length === 0) return quiet({ reason: 'no_event' })
    const out: Evaluation = { candidates: [], silent: [] }
    const min = c.settings.minItems[trigger]
    const drop = (id: string): void => void (c.state.pendingEvents = c.state.pendingEvents.filter((e) => !(e.trigger === trigger && e.id === id)))
    for (const ev of mine) {
      const n = new Set(ev.items).size
      if (c.now - ev.at > EVENT_TTL_MS) {
        drop(ev.id)
        out.silent.push({ reason: 'expired', count: n, threshold: min, sourceIds: [ev.id] })
        continue
      }
      if (n < min) {
        drop(ev.id)
        out.silent.push({ reason: 'below_threshold', count: n, threshold: min, sourceIds: [ev.id] })
        continue
      }
      const label = c.settings.detail ? detailLabel(c.labels.get(ev.id)) : null
      out.candidates.push({
        trigger,
        sourceIds: [ev.id],
        body: label ? `${EVENT_BODY[trigger](n)} · ${label}` : EVENT_BODY[trigger](n),
        count: n,
        threshold: min,
        commit: (s) => void (s.pendingEvents = s.pendingEvents.filter((e) => !(e.trigger === trigger && e.id === ev.id)))
      })
    }
    return out
  }
}

const EVALUATORS: Record<ProactiveTrigger, (c: Ctx) => Promise<Evaluation>> = {
  owner_aliases: evalOwnerAliases,
  capture_degraded: evalCapture,
  runtime: evalRuntime,
  meeting_ready: evalEvents('meeting_ready'),
  friend_moment: evalEvents('friend_moment'),
  daily_brief: evalDailyBrief,
  carried_todos: evalCarriedTodos,
  weekly_counts: evalWeeklyCounts
}

// --- tick ---------------------------------------------------------------------------------------

export type SkipReason = 'settings_error' | 'off' | 'permission' | 'no_window'
export type SuppressReason = 'quiet_hours' | 'daily_cap' | 'dedupe' | 'cooldown' | 'notify_failed'

export interface TickResult {
  skipped: SkipReason | null
  sent: Array<{ trigger: ProactiveTrigger; body: string; sourceIds: string[] }>
  suppressed: Array<{ trigger: ProactiveTrigger; reason: SuppressReason }>
  /** Everything recorded in the decision log by this tick (fired, suppressed, silent). */
  decisions: ProactiveDecision[]
}

export interface EngineDeps {
  now(): number
  timezone(): string
  readSettings(): { settings: ProactiveSettings; error: string | null }
  store: ProactiveStore
  sources: ProactiveSources
  notifier: Notifier
  /** Opens / focuses a Lens page. The only thing a click may do. */
  openPage(route: ProactiveRoute): void
  /** A main window exists (visible or kept resident). No window ⇒ nothing fires. */
  hasWindow(): boolean
  /** In-memory detail labels of pending events (service.ts); never written to disk. */
  eventLabels?(): ReadonlyMap<string, string>
}

export function sentTodayCount(entries: Array<{ trigger: string; time: string }>, now: number, tz: string): number {
  const today = dayIn(now, tz)
  return entries.filter((e) => e.trigger !== 'test' && Number.isFinite(Date.parse(e.time)) && dayIn(Date.parse(e.time), tz) === today).length
}

function onCooldown(trigger: ProactiveTrigger, state: ProactiveState, now: number, tz: string): boolean {
  const last = state.lastSent[trigger]
  if (last === undefined) return false
  const cd = TRIGGER_COOLDOWN[trigger]
  return cd === 'daily' ? dayIn(last, tz) === dayIn(now, tz) : now - last < cd
}

export interface TickOptions {
  /** Evaluate only these triggers (event publish → immediate evaluation of T8/T9). */
  only?: readonly ProactiveTrigger[]
}

export function createProactiveEngine(deps: EngineDeps) {
  return {
    async tick(opts: TickOptions = {}): Promise<TickResult> {
      const result: TickResult = { skipped: null, sent: [], suppressed: [], decisions: [] }
      const { settings, error } = deps.readSettings()
      if (error) return { ...result, skipped: 'settings_error' }
      // Master switch off (or nothing selected): nothing is read, evaluated or recorded.
      if (!settings.enabled || !PROACTIVE_TRIGGERS.some((t) => settings.triggers[t])) return { ...result, skipped: 'off' }
      const now = deps.now()
      const stamp = iso(now)
      const decide = (d: Omit<ProactiveDecision, 'time' | 'last_time' | 'repeat'>): void =>
        void result.decisions.push({ time: stamp, last_time: stamp, repeat: 1, ...d, source_ids: [...d.source_ids].sort() })

      const state = deps.store.readState()
      if (state.permission.state !== 'shown' || !deps.hasWindow()) {
        const reason = state.permission.state !== 'shown' ? 'permission' : 'no_window'
        decide({ trigger: 'all', outcome: 'suppressed', reason, count: null, threshold: null, source_ids: [] })
        deps.store.appendDecisions(result.decisions)
        return { ...result, skipped: reason }
      }

      const tz = deps.timezone()
      state.lastTick = now
      let briefMemo: Promise<BriefSample | null> | null = null
      const ctx: Ctx = {
        now,
        tz,
        settings,
        state,
        sources: deps.sources,
        brief: () => (briefMemo ??= safe(() => deps.sources.brief(now, tz))),
        labels: deps.eventLabels?.() ?? new Map()
      }
      const candidates: Candidate[] = []
      for (const t of PROACTIVE_TRIGGERS) {
        if (!settings.triggers[t]) continue
        if (opts.only && !opts.only.includes(t)) continue
        const ev = await EVALUATORS[t](ctx)
        for (const s of ev.silent) {
          decide({ trigger: t, outcome: 'suppressed', reason: s.reason, count: s.count ?? null, threshold: s.threshold ?? null, source_ids: s.sourceIds ?? [] })
        }
        candidates.push(...ev.candidates)
      }

      const quietNow = inQuietHours(now, tz, settings.quietHours)
      let today = sentTodayCount(deps.store.readLog(), now, tz)
      for (const cand of candidates) {
        const base = { trigger: cand.trigger, count: cand.count ?? null, threshold: cand.threshold ?? null, source_ids: cand.sourceIds }
        const suppress = (reason: SuppressReason): void => {
          result.suppressed.push({ trigger: cand.trigger, reason })
          decide({ ...base, outcome: 'suppressed', reason })
        }
        const key = dedupeKey(cand.trigger, cand.sourceIds)
        if (state.sent[key] !== undefined) {
          cand.commit(state) // already told the user about exactly these rows
          suppress('dedupe')
          continue
        }
        if (quietNow) {
          suppress('quiet_hours')
          continue
        }
        if (today >= settings.dailyCap) {
          suppress('daily_cap')
          continue
        }
        if (!cand.ignoreCooldown && onCooldown(cand.trigger, state, now, tz)) {
          suppress('cooldown')
          continue
        }
        const route = TRIGGER_ROUTE[cand.trigger]
        const shown = await deps.notifier.show({ title: NOTIFICATION_TITLE, body: cand.body }, () => deps.openPage(route)).catch(() => 'failed' as const)
        if (shown === 'failed') {
          suppress('notify_failed')
          continue
        }
        cand.commit(state)
        state.sent[key] = now
        state.lastSent[cand.trigger] = now
        today += 1
        deps.store.appendLog({ trigger: cand.trigger, time: stamp, source_ids: cand.sourceIds })
        result.sent.push({ trigger: cand.trigger, body: cand.body, sourceIds: cand.sourceIds })
        decide({ ...base, outcome: 'fired', reason: null })
      }
      deps.store.writeState(state)
      deps.store.appendDecisions(result.decisions)
      return result
    }
  }
}
