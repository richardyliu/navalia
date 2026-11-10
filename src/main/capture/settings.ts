import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readFileIfExists, writeFileSecure } from '../store/paths'

/**
 * Capture settings owned by Lens (not Runtime config): per-app exclusion
 * (bundle id + app name lists) and pause. Stored in the Lens Store as
 * capture-settings.json, written atomically with 0600.
 */

export const CAPTURE_SETTINGS_FILENAME = 'capture-settings.json'

export function captureSettingsFile(storeRoot: string): string {
  return path.join(storeRoot, CAPTURE_SETTINGS_FILENAME)
}

const Iso = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO timestamp expected')
const Entry = z.string().trim().min(1).max(256)

export const PauseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('indefinite'), since: Iso }).strict(),
  z.object({ mode: z.literal('until'), since: Iso, until: Iso }).strict()
])

export const CaptureSettingsSchema = z
  .object({
    version: z.literal(1),
    excluded: z
      .object({
        bundleIds: z.array(Entry).max(500),
        appNames: z.array(Entry).max(500)
      })
      .strict(),
    pause: PauseSchema
  })
  .strict()

export type CaptureSettings = z.infer<typeof CaptureSettingsSchema>
export type PauseSetting = z.infer<typeof PauseSchema>
export type ExclusionKind = 'bundleId' | 'appName'

export function defaultCaptureSettings(): CaptureSettings {
  return { version: 1, excluded: { bundleIds: [], appNames: [] }, pause: { mode: 'none' } }
}

/** Next local midnight strictly after `ms` (DST-safe: built from calendar fields). */
export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
}

export interface PauseState {
  paused: boolean
  mode: PauseSetting['mode']
  since: string | null
  /** ISO time the pause ends by itself, null if indefinite / not paused. */
  until: string | null
}

const norm = (v: string): string => v.trim().toLowerCase()

export class CaptureSettingsStore {
  private settings: CaptureSettings
  private readonly listeners = new Set<() => void>()
  /** Set when the file on disk was unreadable and defaults were used. */
  readonly loadError: string | null

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now
  ) {
    const loaded = CaptureSettingsStore.read(file)
    this.settings = loaded.settings
    this.loadError = loaded.error
  }

  private static read(file: string): { settings: CaptureSettings; error: string | null } {
    const raw = readFileIfExists(file)
    if (!raw) return { settings: defaultCaptureSettings(), error: null }
    try {
      return { settings: CaptureSettingsSchema.parse(JSON.parse(raw.toString('utf8'))), error: null }
    } catch (error) {
      // Keep the unreadable file for inspection instead of overwriting it silently.
      const aside = `${file}.invalid-${Date.now()}`
      try {
        fs.renameSync(file, aside)
      } catch {
        // best effort
      }
      return { settings: defaultCaptureSettings(), error: `capture settings unreadable, moved to ${aside}: ${(error as Error).message}` }
    }
  }

  get(): CaptureSettings {
    return structuredClone(this.settings)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private commit(next: CaptureSettings): void {
    const valid = CaptureSettingsSchema.parse(next)
    writeFileSecure(this.file, JSON.stringify(valid, null, 2) + '\n')
    this.settings = valid
    for (const l of this.listeners) {
      try {
        l()
      } catch {
        // listeners never block persistence
      }
    }
  }

  // Exclusion -------------------------------------------------------------

  isExcluded(bundleId: string, appName: string): boolean {
    const b = norm(bundleId)
    const a = norm(appName)
    return (
      (b !== '' && this.settings.excluded.bundleIds.some((x) => norm(x) === b)) ||
      (a !== '' && this.settings.excluded.appNames.some((x) => norm(x) === a))
    )
  }

  addExclusion(kind: ExclusionKind, value: string): CaptureSettings {
    const v = Entry.parse(value)
    const next = this.get()
    const list = kind === 'bundleId' ? next.excluded.bundleIds : next.excluded.appNames
    if (!list.some((x) => norm(x) === norm(v))) list.push(v)
    this.commit(next)
    return this.get()
  }

  removeExclusion(kind: ExclusionKind, value: string): CaptureSettings {
    const next = this.get()
    const key = kind === 'bundleId' ? 'bundleIds' : 'appNames'
    next.excluded[key] = next.excluded[key].filter((x) => norm(x) !== norm(value))
    this.commit(next)
    return this.get()
  }

  // Pause -----------------------------------------------------------------

  pauseState(): PauseState {
    const p = this.settings.pause
    if (p.mode === 'none') return { paused: false, mode: 'none', since: null, until: null }
    if (p.mode === 'until' && Date.parse(p.until) <= this.now()) {
      return { paused: false, mode: 'none', since: null, until: null }
    }
    return { paused: true, mode: p.mode, since: p.since, until: p.mode === 'until' ? p.until : null }
  }

  pauseNow(): PauseState {
    const next = this.get()
    next.pause = { mode: 'indefinite', since: new Date(this.now()).toISOString() }
    this.commit(next)
    return this.pauseState()
  }

  pauseUntilNextMidnight(): PauseState {
    const now = this.now()
    const next = this.get()
    next.pause = {
      mode: 'until',
      since: new Date(now).toISOString(),
      until: new Date(nextLocalMidnight(now)).toISOString()
    }
    this.commit(next)
    return this.pauseState()
  }

  resume(): PauseState {
    const next = this.get()
    next.pause = { mode: 'none' }
    this.commit(next)
    return this.pauseState()
  }

  /** Persist an expired timed pause as resumed; returns true if it changed. */
  expireIfDue(): boolean {
    const p = this.settings.pause
    if (p.mode === 'until' && Date.parse(p.until) <= this.now()) {
      this.resume()
      return true
    }
    return false
  }
}
