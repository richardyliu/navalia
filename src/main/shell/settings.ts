// OG-04 shell prefs: `<LensStore>/shell-settings.json` (0600, atomic write via the Lens Store helper).
// Shell-owned file; Lens Store `settings.json` is identity-owned and is not touched.
// Every toggle defaults to OFF: no menu bar icon, no global hotkey, no hidden residency.
import path from 'node:path'
import { z } from 'zod'
import { readFileIfExists, writeFileSecure } from '../store/paths'
import { validateAccelerator } from './accelerator'
import { DEFAULT_ACCELERATOR, type ShellSettings, type ShellSettingsPatch } from './api'
import { tr } from '../../shared/i18n'

export const SHELL_SETTINGS_FILENAME = 'shell-settings.json'

const AcceleratorSchema = z.string().superRefine((value, ctx) => {
  const r = validateAccelerator(value)
  if (!r.ok) ctx.addIssue({ code: 'custom', message: r.reason })
})

export const ShellSettingsSchema = z.strictObject({
  version: z.literal(1),
  trayEnabled: z.boolean(),
  shortcutEnabled: z.boolean(),
  shortcutAccelerator: AcceleratorSchema,
  keepResidentOnClose: z.boolean()
})

export const ShellSettingsPatchSchema = z.strictObject({
  trayEnabled: z.boolean().optional(),
  shortcutEnabled: z.boolean().optional(),
  shortcutAccelerator: AcceleratorSchema.optional(),
  keepResidentOnClose: z.boolean().optional()
})

export const DEFAULT_SHELL_SETTINGS: Readonly<ShellSettings> = Object.freeze({
  version: 1,
  trayEnabled: false,
  shortcutEnabled: false,
  shortcutAccelerator: DEFAULT_ACCELERATOR,
  keepResidentOnClose: false
})

export function shellSettingsFile(storeRoot: string): string {
  return path.join(storeRoot, SHELL_SETTINGS_FILENAME)
}

export interface ShellSettingsRead {
  settings: ShellSettings
  /** Non-null when the file existed but was unreadable/invalid: defaults (all off) are used. */
  error: string | null
}

/** Missing file → defaults. Corrupt/invalid file → defaults + error (fail closed: nothing turns on). */
export function readShellSettings(file: string): ShellSettingsRead {
  let raw: Buffer | null
  try {
    raw = readFileIfExists(file)
  } catch (error) {
    return { settings: { ...DEFAULT_SHELL_SETTINGS }, error: tr(`Cannot read ${SHELL_SETTINGS_FILENAME}: ${(error as Error).message}`, `无法读取 ${SHELL_SETTINGS_FILENAME}：${(error as Error).message}`) }
  }
  if (raw === null) return { settings: { ...DEFAULT_SHELL_SETTINGS }, error: null }
  try {
    const parsed = ShellSettingsSchema.parse({ ...DEFAULT_SHELL_SETTINGS, ...JSON.parse(raw.toString('utf8')) })
    return { settings: parsed, error: null }
  } catch {
    return { settings: { ...DEFAULT_SHELL_SETTINGS }, error: tr(`${SHELL_SETTINGS_FILENAME} is invalid; using defaults (all off)`, `${SHELL_SETTINGS_FILENAME} 无效，已使用默认值（全部关闭）`) }
  }
}

/** Apply a validated patch. Accelerators are stored normalized. Throws ZodError on invalid input. */
export function applyShellPatch(current: ShellSettings, rawPatch: unknown): ShellSettings {
  const patch: ShellSettingsPatch = ShellSettingsPatchSchema.parse(rawPatch ?? {})
  const next: ShellSettings = { ...current, ...patch }
  if (patch.shortcutAccelerator !== undefined) {
    const r = validateAccelerator(patch.shortcutAccelerator)
    if (r.ok) next.shortcutAccelerator = r.accelerator
  }
  return ShellSettingsSchema.parse(next)
}

export function writeShellSettings(file: string, settings: ShellSettings): ShellSettings {
  const parsed = ShellSettingsSchema.parse(settings)
  writeFileSecure(file, `${JSON.stringify(parsed, null, 2)}\n`)
  return parsed
}
