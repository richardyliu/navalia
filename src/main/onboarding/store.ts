// S2-01 first-run record: `<LensStore>/onboarding.json` (0600). Owned by the onboard-ask agent.
// The record holds only an outcome, a step id and ISO timestamps — no paths, no user data, no secrets.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readFileIfExists, storePaths, writeFileSecure } from '../store/paths'
import { ONBOARDING_STEPS, type OnboardingFinishInput, type OnboardingStatus } from './api'

export const ONBOARDING_FILENAME = 'onboarding.json'

const RecordSchema = z.strictObject({
  version: z.literal(1),
  outcome: z.enum(['completed', 'skipped', 'legacy', 'reopened']),
  lastStep: z.enum(ONBOARDING_STEPS).nullable(),
  completedAt: z.string().nullable(),
  skippedAt: z.string().nullable(),
  updatedAt: z.string()
})
export type OnboardingRecord = z.infer<typeof RecordSchema>

export function onboardingFile(storeRoot: string): string {
  return path.join(storeRoot, ONBOARDING_FILENAME)
}

function nonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => !name.startsWith('.'))
  } catch {
    return false
  }
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Lens Store entries that only exist after the user did something (they are never created at
 * boot): identity init, Card / settings / grants / capture exclusions, workflows, peers.
 * `audit.db`, `het.db`, `het-settings.json` and the empty `identity/` + `cards/` dirs are created
 * or touched by the app itself, so they do NOT count. Returns store-relative names only.
 */
export function priorDataSignals(storeRoot: string): string[] {
  const p = storePaths(storeRoot)
  const signals: string[] = []
  if (exists(p.identityFile)) signals.push('identity/identity.json')
  if (exists(p.settingsFile)) signals.push('settings.json')
  if (exists(p.grantsFile)) signals.push('grants.json')
  if (exists(path.join(storeRoot, 'capture-settings.json'))) signals.push('capture-settings.json')
  if (nonEmptyDir(p.cardsDir)) signals.push('cards/')
  if (nonEmptyDir(path.join(storeRoot, 'workflows'))) signals.push('workflows/')
  if (nonEmptyDir(path.join(storeRoot, 'peers'))) signals.push('peers/')
  return signals
}

function write(storeRoot: string, record: OnboardingRecord): void {
  writeFileSecure(onboardingFile(storeRoot), `${JSON.stringify(RecordSchema.parse(record), null, 2)}\n`)
}

function toStatus(record: OnboardingRecord): OnboardingStatus {
  const base = { completedAt: record.completedAt, skippedAt: record.skippedAt, lastStep: record.lastStep }
  if (record.outcome === 'reopened') return { show: true, reason: 'reopened', ...base }
  return { show: false, reason: record.outcome, ...base }
}

type ReadResult = { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'ok'; record: OnboardingRecord }

function readRecord(storeRoot: string): ReadResult {
  let raw: Buffer | null
  try {
    raw = readFileIfExists(onboardingFile(storeRoot))
  } catch {
    return { kind: 'corrupt' }
  }
  if (!raw) return { kind: 'absent' }
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(raw.toString('utf8')))
    return parsed.success ? { kind: 'ok', record: parsed.data } : { kind: 'corrupt' }
  } catch {
    return { kind: 'corrupt' }
  }
}

/** First-run decision. Never throws for a bad record; may write a `legacy` record (best-effort). */
export function onboardingStatus(storeRoot: string, now: () => Date = () => new Date()): OnboardingStatus {
  const r = readRecord(storeRoot)
  if (r.kind === 'ok') return toStatus(r.record)
  if (r.kind === 'corrupt') return { show: false, reason: 'corrupt', completedAt: null, skippedAt: null, lastStep: null }
  if (priorDataSignals(storeRoot).length === 0) {
    return { show: true, reason: 'first_run', completedAt: null, skippedAt: null, lastStep: null }
  }
  const legacy: OnboardingRecord = {
    version: 1,
    outcome: 'legacy',
    lastStep: null,
    completedAt: null,
    skippedAt: null,
    updatedAt: now().toISOString()
  }
  try {
    write(storeRoot, legacy)
  } catch {
    // Read-only / missing store: still an existing user; just don't persist the decision.
  }
  return toStatus(legacy)
}

export function finishOnboarding(
  storeRoot: string,
  input: OnboardingFinishInput,
  now: () => Date = () => new Date()
): OnboardingStatus {
  const at = now().toISOString()
  const record: OnboardingRecord = {
    version: 1,
    outcome: input.outcome,
    lastStep: input.lastStep,
    completedAt: input.outcome === 'completed' ? at : null,
    skippedAt: input.outcome === 'skipped' ? at : null,
    updatedAt: at
  }
  write(storeRoot, record)
  return toStatus(record)
}

/** "重新打开引导": the next status() shows the overlay; previous timestamps are kept for reference. */
export function resetOnboarding(storeRoot: string, now: () => Date = () => new Date()): OnboardingStatus {
  const prev = readRecord(storeRoot)
  const kept = prev.kind === 'ok' ? prev.record : null
  const record: OnboardingRecord = {
    version: 1,
    outcome: 'reopened',
    lastStep: null,
    completedAt: kept?.completedAt ?? null,
    skippedAt: kept?.skippedAt ?? null,
    updatedAt: now().toISOString()
  }
  write(storeRoot, record)
  return toStatus(record)
}
