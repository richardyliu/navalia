// S1-R4-05 proactive state + log files in the Lens Store, both 0600 (writeFileSecure).
//
// - proactive-log.json: what was sent: {trigger, time, source_ids}. No text, ever: source ids are
//   fixed category codes or 16-hex sha256 prefixes (see engine.ts `hashId`).
// - proactive-state.json: last-seen values for edge triggers, dedupe keys, cooldown times and the
//   notification permission record. A corrupt file is replaced by an empty state (baselines reset).
// - proactive-decisions.json (S1-FULL C17): every decision for an enabled trigger, fired or
//   suppressed, with its reason and the gate's count / threshold. Same no-text rule as the log.
//   Consecutive identical decisions are folded (repeat + last_time) so a 15-min tick cannot flood it.
import path from 'node:path'
import { z } from 'zod'
import { readFileIfExists, writeFileSecure } from '../store/paths'
import { CAPTURE_ISSUES, DECISION_REASONS, EVENT_TRIGGERS, PROACTIVE_TRIGGERS, type ProactiveDecision, type ProactiveLogEntry } from './api'

export const PROACTIVE_LOG_FILENAME = 'proactive-log.json'
export const PROACTIVE_STATE_FILENAME = 'proactive-state.json'
export const PROACTIVE_DECISIONS_FILENAME = 'proactive-decisions.json'
export const LOG_MAX_ENTRIES = 500
export const DECISIONS_MAX_ENTRIES = 500
const DEDUPE_TTL_MS = 60 * 86_400_000

/** A source id is a category code, optionally `:` + a date / ISO instant / 16-hex hash. */
export const SOURCE_ID_RE = /^[a-z_]{1,32}(:[0-9a-f]{16}|:\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?)?$/

const LogEntrySchema = z.strictObject({
  trigger: z.enum([...PROACTIVE_TRIGGERS, 'test']),
  time: z.string().max(40),
  source_ids: z.array(z.string().regex(SOURCE_ID_RE)).max(200)
})
const LogSchema = z.strictObject({ version: z.literal(1), entries: z.array(LogEntrySchema).max(LOG_MAX_ENTRIES) })

const DecisionSchema = z.strictObject({
  time: z.string().max(40),
  last_time: z.string().max(40),
  repeat: z.number().int().min(1),
  trigger: z.enum([...PROACTIVE_TRIGGERS, 'all']),
  outcome: z.enum(['fired', 'suppressed']),
  reason: z.enum(DECISION_REASONS).nullable(),
  count: z.number().int().min(0).nullable(),
  threshold: z.number().int().min(0).nullable(),
  source_ids: z.array(z.string().regex(SOURCE_ID_RE)).max(200)
})
const DecisionsSchema = z.strictObject({ version: z.literal(1), entries: z.array(DecisionSchema).max(DECISIONS_MAX_ENTRIES) })

/** An event-trigger item waiting to be evaluated / sent. Ids are hashes; the label never persists. */
const PendingEventSchema = z.strictObject({
  trigger: z.enum(EVENT_TRIGGERS),
  /** hashId of the publisher's id. */
  id: z.string().regex(SOURCE_ID_RE),
  /** Hashes of the evidenced items (distinct). */
  items: z.array(z.string().regex(SOURCE_ID_RE)).max(200),
  at: z.number()
})

const StateSchema = z.strictObject({
  version: z.literal(1),
  permission: z.strictObject({
    state: z.enum(['not_asked', 'shown', 'not_shown', 'unsupported', 'denied']),
    at: z.string().max(40).nullable()
  }),
  ownerAliases: z.strictObject({ lastSeen: z.number().int().min(0).nullable() }),
  capture: z.strictObject({
    badSince: z.number().nullable(),
    issues: z.array(z.enum(CAPTURE_ISSUES as [string, ...string[]])),
    notified: z.boolean(),
    lastRejected: z.number().int().min(0).nullable()
  }),
  runtime: z.strictObject({ downSince: z.number().nullable(), notified: z.boolean(), revision: z.string().max(200).nullable() }),
  /** dedupe key → epoch ms sent. */
  sent: z.record(z.string().max(80), z.number()),
  /** trigger → epoch ms of its last notification. */
  lastSent: z.record(z.string().max(32), z.number()),
  lastTick: z.number().nullable(),
  /** C17 event triggers. Missing in S1-R4-05 state files ⇒ []. */
  pendingEvents: z.array(PendingEventSchema).max(200).default([])
})
export type ProactiveState = z.infer<typeof StateSchema>

export function emptyState(): ProactiveState {
  return {
    version: 1,
    permission: { state: 'not_asked', at: null },
    ownerAliases: { lastSeen: null },
    capture: { badSince: null, issues: [], notified: false, lastRejected: null },
    runtime: { downSince: null, notified: false, revision: null },
    sent: {},
    lastSent: {},
    lastTick: null,
    pendingEvents: []
  }
}

export interface ProactiveStore {
  readState(): ProactiveState
  writeState(state: ProactiveState): void
  readLog(): ProactiveLogEntry[]
  appendLog(entry: ProactiveLogEntry): void
  readDecisions(): ProactiveDecision[]
  appendDecisions(entries: ProactiveDecision[]): void
  clearDecisions(): void
}

const sameDecision = (a: ProactiveDecision, b: ProactiveDecision): boolean =>
  a.trigger === b.trigger &&
  a.outcome === b.outcome &&
  a.reason === b.reason &&
  a.count === b.count &&
  a.threshold === b.threshold &&
  a.source_ids.join('\n') === b.source_ids.join('\n')

/** Append with folding: an entry identical to the latest entry of the same trigger bumps it. */
export function foldDecisions(existing: ProactiveDecision[], incoming: ProactiveDecision[]): ProactiveDecision[] {
  const out = existing.map((e) => ({ ...e }))
  for (const raw of incoming) {
    const d = DecisionSchema.parse(raw)
    let lastIdx = -1
    for (let i = out.length - 1; i >= 0; i--) if (out[i].trigger === d.trigger) { lastIdx = i; break }
    if (lastIdx >= 0 && sameDecision(out[lastIdx], d)) {
      out[lastIdx] = { ...out[lastIdx], repeat: out[lastIdx].repeat + 1, last_time: d.last_time }
    } else out.push(d)
  }
  return out.slice(-DECISIONS_MAX_ENTRIES)
}

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = readFileIfExists(file)
    if (raw === null) return null
    return schema.parse(JSON.parse(raw.toString('utf8')))
  } catch {
    return null
  }
}

export function createFileStore(storeRoot: string, now: () => number = Date.now): ProactiveStore {
  const stateFile = path.join(storeRoot, PROACTIVE_STATE_FILENAME)
  const logFile = path.join(storeRoot, PROACTIVE_LOG_FILENAME)
  const decisionsFile = path.join(storeRoot, PROACTIVE_DECISIONS_FILENAME)
  const readDecisions = (): ProactiveDecision[] => readJson(decisionsFile, DecisionsSchema)?.entries ?? []
  return {
    readDecisions,
    appendDecisions: (entries) => {
      if (entries.length === 0) return
      writeFileSecure(decisionsFile, `${JSON.stringify({ version: 1, entries: foldDecisions(readDecisions(), entries) }, null, 2)}\n`)
    },
    clearDecisions: () => writeFileSecure(decisionsFile, `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`),
    readState: () => readJson(stateFile, StateSchema) ?? emptyState(),
    writeState: (state) => {
      const cutoff = now() - DEDUPE_TTL_MS
      const sent = Object.fromEntries(Object.entries(state.sent).filter(([, t]) => t >= cutoff))
      writeFileSecure(stateFile, `${JSON.stringify(StateSchema.parse({ ...state, sent }), null, 2)}\n`)
    },
    readLog: () => readJson(logFile, LogSchema)?.entries ?? [],
    appendLog: (entry) => {
      const entries = [...(readJson(logFile, LogSchema)?.entries ?? []), LogEntrySchema.parse(entry)].slice(-LOG_MAX_ENTRIES)
      writeFileSecure(logFile, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    }
  }
}

/** In-memory store for tests. */
export function createMemoryStore(): ProactiveStore & { log: ProactiveLogEntry[]; state: ProactiveState; decisions: ProactiveDecision[] } {
  const box = { state: emptyState(), log: [] as ProactiveLogEntry[], decisions: [] as ProactiveDecision[] }
  return {
    get decisions() {
      return box.decisions
    },
    readDecisions: () => [...box.decisions],
    appendDecisions: (entries) => void (box.decisions = foldDecisions(box.decisions, entries)),
    clearDecisions: () => void (box.decisions = []),
    get state() {
      return box.state
    },
    get log() {
      return box.log
    },
    readState: () => structuredClone(box.state),
    writeState: (s) => void (box.state = StateSchema.parse(structuredClone(s))),
    readLog: () => [...box.log],
    appendLog: (e) => void box.log.push(LogEntrySchema.parse(e))
  }
}
