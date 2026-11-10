import { z } from 'zod'
import { readFileIfExists, type StorePaths } from './paths'

export const SettingsSchema = z
  .object({
    version: z.literal(1),
    /** Optional label printed on the Card front. Null means "no name" (no account exists). */
    displayName: z.string().trim().min(1).max(80).nullable()
  })
  .strict()

export type LensSettings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: LensSettings = { version: 1, displayName: null }

export function readSettings(paths: StorePaths): LensSettings {
  const raw = readFileIfExists(paths.settingsFile)
  if (!raw) return { ...DEFAULT_SETTINGS }
  return SettingsSchema.parse(JSON.parse(raw.toString('utf8')))
}
