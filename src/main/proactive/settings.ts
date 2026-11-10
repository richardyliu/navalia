// S1-R4-05 `<LensStore>/proactive-settings.json` (0600, atomic write, zod strict). Same fail-closed rule
// as shell/settings.ts: a missing file means defaults (all off); a corrupt or invalid file means
// defaults (all off) plus an error the Settings page shows. Nothing turns on by accident.
//
// S1-FULL C17: version 2 adds briefDays, dailyCap, minItems (context gate), detail, tray and the
// proactive shortcut. A valid version-1 file is migrated on read: its existing values are kept and
// every new field takes its default (all OFF), so an upgrade never turns anything on.
import path from 'node:path'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { validateAccelerator } from '../shell/accelerator'
import { readFileIfExists, writeFileSecure } from '../store/paths'
import {
  DAILY_CAP_MAX,
  DEFAULT_MIN_ITEMS,
  DEFAULT_PROACTIVE_ACCELERATOR,
  GATED_TRIGGERS,
  MIN_ITEMS_MAX,
  PROACTIVE_DAILY_CAP,
  PROACTIVE_TRIGGERS,
  type GatedTrigger,
  type ProactiveSettings,
  type ProactiveSettingsPatch,
  type ProactiveTrigger
} from './api'

export const PROACTIVE_SETTINGS_FILENAME = 'proactive-settings.json'

export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (00:00–23:59)')

const triggerShape = Object.fromEntries(PROACTIVE_TRIGGERS.map((t) => [t, z.boolean()])) as Record<ProactiveTrigger, z.ZodBoolean>
const V1_TRIGGERS = ['owner_aliases', 'capture_degraded', 'runtime', 'daily_brief', 'carried_todos'] as const
const v1TriggerShape = Object.fromEntries(V1_TRIGGERS.map((t) => [t, z.boolean()])) as Record<(typeof V1_TRIGGERS)[number], z.ZodBoolean>

const MinItem = z.number().int().min(1).max(MIN_ITEMS_MAX)
const minItemsShape = Object.fromEntries(GATED_TRIGGERS.map((t) => [t, MinItem])) as Record<GatedTrigger, typeof MinItem>

const AcceleratorSchema = z.string().superRefine((value, ctx) => {
  const r = validateAccelerator(value)
  if (!r.ok) ctx.addIssue({ code: 'custom', message: r.reason })
})

export const ProactiveSettingsSchema = z.strictObject({
  version: z.literal(2),
  enabled: z.boolean(),
  triggers: z.strictObject(triggerShape),
  quietHours: z.strictObject({ start: HHMM, end: HHMM }),
  briefTime: HHMM,
  briefDays: z.enum(['all', 'weekdays']),
  dailyCap: z.number().int().min(1).max(DAILY_CAP_MAX),
  minItems: z.strictObject(minItemsShape),
  detail: z.boolean(),
  tray: z.boolean(),
  shortcut: z.strictObject({ enabled: z.boolean(), accelerator: AcceleratorSchema })
})

/** The S1-R4-05 file format, accepted only to migrate it. */
const ProactiveSettingsV1Schema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  triggers: z.strictObject(v1TriggerShape),
  quietHours: z.strictObject({ start: HHMM, end: HHMM }),
  briefTime: HHMM
})

export const ProactiveSettingsPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  triggers: z.strictObject(triggerShape).partial().optional(),
  quietHours: z.strictObject({ start: HHMM, end: HHMM }).optional(),
  briefTime: HHMM.optional(),
  briefDays: z.enum(['all', 'weekdays']).optional(),
  dailyCap: z.number().int().min(1).max(DAILY_CAP_MAX).optional(),
  minItems: z.strictObject(minItemsShape).partial().optional(),
  detail: z.boolean().optional(),
  tray: z.boolean().optional(),
  shortcut: z.strictObject({ enabled: z.boolean().optional(), accelerator: AcceleratorSchema.optional() }).optional()
})

export function defaultProactiveSettings(): ProactiveSettings {
  return {
    version: 2,
    enabled: false,
    triggers: Object.fromEntries(PROACTIVE_TRIGGERS.map((t) => [t, false])) as Record<ProactiveTrigger, boolean>,
    quietHours: { start: '22:00', end: '09:00' },
    briefTime: '09:00',
    briefDays: 'weekdays',
    dailyCap: PROACTIVE_DAILY_CAP,
    minItems: { ...DEFAULT_MIN_ITEMS },
    detail: false,
    tray: false,
    shortcut: { enabled: false, accelerator: DEFAULT_PROACTIVE_ACCELERATOR }
  }
}

/** v1 → v2: keep what the user set; every new field takes its default. v1 fired T1/T2 on every day. */
export function migrateV1(v1: z.infer<typeof ProactiveSettingsV1Schema>): ProactiveSettings {
  const d = defaultProactiveSettings()
  return {
    ...d,
    enabled: v1.enabled,
    triggers: { ...d.triggers, ...v1.triggers },
    quietHours: v1.quietHours,
    briefTime: v1.briefTime,
    briefDays: 'all'
  }
}

export function proactiveSettingsFile(storeRoot: string): string {
  return path.join(storeRoot, PROACTIVE_SETTINGS_FILENAME)
}

export interface ProactiveSettingsRead {
  settings: ProactiveSettings
  /** Non-null when the file existed but was unreadable / invalid: defaults (all off) are used. */
  error: string | null
}

export function readProactiveSettings(file: string): ProactiveSettingsRead {
  let raw: Buffer | null
  try {
    raw = readFileIfExists(file)
  } catch {
    return { settings: defaultProactiveSettings(), error: tr(`Cannot read ${PROACTIVE_SETTINGS_FILENAME}; all notifications are off`, `无法读取 ${PROACTIVE_SETTINGS_FILENAME}，通知全部关闭`) }
  }
  if (raw === null) return { settings: defaultProactiveSettings(), error: null }
  try {
    // No merge with defaults: a file with a missing or extra key is invalid (fail closed).
    const json = JSON.parse(raw.toString('utf8')) as { version?: unknown }
    if (json && json.version === 1) return { settings: migrateV1(ProactiveSettingsV1Schema.parse(json)), error: null }
    return { settings: ProactiveSettingsSchema.parse(json), error: null }
  } catch {
    return { settings: defaultProactiveSettings(), error: tr(`${PROACTIVE_SETTINGS_FILENAME} is invalid; all notifications are off (saving settings once rewrites the file)`, `${PROACTIVE_SETTINGS_FILENAME} 无效，通知全部关闭（保存一次设置会重写该文件）`) }
  }
}

/** Validated patch → next settings. Throws ZodError on invalid input (nothing is written). */
export function applyProactivePatch(current: ProactiveSettings, rawPatch: unknown): ProactiveSettings {
  const patch: ProactiveSettingsPatch = ProactiveSettingsPatchSchema.parse(rawPatch ?? {})
  let accelerator = patch.shortcut?.accelerator ?? current.shortcut.accelerator
  const norm = validateAccelerator(accelerator)
  if (norm.ok) accelerator = norm.accelerator
  return ProactiveSettingsSchema.parse({
    ...current,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    triggers: { ...current.triggers, ...(patch.triggers ?? {}) },
    quietHours: patch.quietHours ?? current.quietHours,
    briefTime: patch.briefTime ?? current.briefTime,
    briefDays: patch.briefDays ?? current.briefDays,
    dailyCap: patch.dailyCap ?? current.dailyCap,
    minItems: { ...current.minItems, ...(patch.minItems ?? {}) },
    detail: patch.detail ?? current.detail,
    tray: patch.tray ?? current.tray,
    shortcut: { enabled: patch.shortcut?.enabled ?? current.shortcut.enabled, accelerator }
  })
}

export function writeProactiveSettings(file: string, settings: ProactiveSettings): ProactiveSettings {
  const parsed = ProactiveSettingsSchema.parse(settings)
  writeFileSecure(file, `${JSON.stringify(parsed, null, 2)}\n`)
  return parsed
}
