import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * HET settings, stored as JSON next to het.db (HET-owned file; Lens Store settings are
 * identity-owned). All caps are hard limits enforced by the tick, not hints.
 */
export const HetSettingsSchema = z.strictObject({
  version: z.literal(1),
  /**
   * S1-02: explicit user switch for the assessor. Default false. Minutes can only be produced
   * when this is true AND main injected a real transport AND the budget probe says available
   * (see service.ts `assessorGate`). Turning it on without a transport changes nothing except
   * the reason shown on waiting tasks (`no_transport`).
   */
  assessorEnabled: z.boolean(),
  /** Persist redacted ≤200-char event summaries and session titles in het.db. */
  persistSummaries: z.boolean(),
  /**
   * Security policy P1: send redacted summaries / titles / paths to the assessor transport.
   * Default false → the prompt carries only ids, enums, counts, tool names, signals, file types.
   */
  sendSummariesToAssessor: z.boolean(),
  /** Max assessor transport invocations per tick. */
  perTickCap: z.number().int().min(0).max(50),
  /** Max assessor transport invocations per local day (outcomes that reached a model). */
  perDayCap: z.number().int().min(0).max(1000),
  /** After quota/offline/error, no assessor calls until this much time passes. */
  backoffMs: z.number().int().min(60_000).max(24 * 3600_000),
  /** invalid/error attempts before a task becomes `failed`. */
  maxAttempts: z.number().int().min(1).max(10),
  /** Hard cap on the assessor prompt size. */
  maxInputChars: z.number().int().min(500).max(20_000),
  /** Evidence events kept per task. */
  evidencePerTask: z.number().int().min(1).max(200)
})

export type HetSettings = z.infer<typeof HetSettingsSchema>

export const DEFAULT_HET_SETTINGS: HetSettings = {
  version: 1,
  assessorEnabled: false,
  persistSummaries: true,
  sendSummariesToAssessor: false,
  perTickCap: 5,
  perDayCap: 20,
  backoffMs: 15 * 60_000,
  maxAttempts: 3,
  maxInputChars: 6000,
  evidencePerTask: 40
}

export function readHetSettings(file: string): HetSettings {
  let raw: string
  try {
    const fd = openSync(file, 'r')
    try {
      raw = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return { ...DEFAULT_HET_SETTINGS }
  }
  return HetSettingsSchema.parse({ ...DEFAULT_HET_SETTINGS, ...JSON.parse(raw) })
}

export function writeHetSettings(file: string, s: HetSettings): HetSettings {
  const parsed = HetSettingsSchema.parse(s)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
  return parsed
}

/** Read-modify-write of the single user-facing switch; other keys are preserved. */
export function setAssessorEnabled(file: string, enabled: boolean): HetSettings {
  return writeHetSettings(file, { ...readHetSettings(file), assessorEnabled: enabled })
}

/**
 * X3 / R4-1: user switch for sending redacted summaries / titles / file paths to the
 * assessor. Default false. Main only turns it ON after its own native confirm (ipc.ts).
 */
export function setSendSummariesToAssessor(file: string, enabled: boolean): HetSettings {
  return writeHetSettings(file, { ...readHetSettings(file), sendSummariesToAssessor: enabled })
}
