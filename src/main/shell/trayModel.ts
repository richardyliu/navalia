// OG-04: pure tray menu model + template icon bitmap. No electron imports (unit-testable).
import { tr } from '../../shared/i18n'

export type TrayAction = 'open' | 'quickbox' | 'capture-pause' | 'capture-resume' | 'quit' | 'proactive_open_log' | 'proactive_pause_all'

export type TrayMenuItem =
  | { kind: 'action'; id: TrayAction; label: string; enabled: boolean; accelerator?: string }
  | { kind: 'info'; label: string }
  | { kind: 'separator' }

export interface TrayCaptureState {
  /** null = capture service status unavailable. */
  started: boolean | null
  paused: boolean
  /** ISO end of a timed pause, if any. */
  until: string | null
}

export interface TrayMenuInput {
  capture: TrayCaptureState
  /** Registered global shortcut (shown as a hint next to Quick Box), or null. */
  shortcut: string | null
  /** C17: proactive 「提醒」 items (empty unless the user turned them on). */
  extra?: TrayMenuItem[]
}

export function captureLine(c: TrayCaptureState): string {
  if (c.paused) {
    if (!c.until) return tr('Capture: paused', '采集：已暂停')
    const until = c.until.slice(11, 16) || c.until
    return tr(`Capture: paused (until ${until})`, `采集：已暂停（至 ${until}）`)
  }
  if (c.started === null) return tr('Capture: status unknown', '采集：状态未知')
  return c.started ? tr('Capture: running', '采集：运行中') : tr('Capture: off', '采集：未启用')
}

/**
 * The menu is rebuilt from live state every time the tray is clicked, so labels never go stale.
 * Pause / resume reuse the Capture Plane's own pause API (`capture.pause('now')` / `resume()`).
 */
export function buildTrayMenuModel(input: TrayMenuInput): TrayMenuItem[] {
  const { capture } = input
  return [
    { kind: 'action', id: 'open', label: tr('Open Navalia', '打开 Navalia'), enabled: true },
    {
      kind: 'action',
      id: 'quickbox',
      label: 'Quick Box',
      enabled: true,
      ...(input.shortcut ? { accelerator: input.shortcut } : {})
    },
    { kind: 'separator' },
    { kind: 'info', label: captureLine(capture) },
    capture.paused
      ? { kind: 'action', id: 'capture-resume', label: tr('Resume capture', '恢复采集'), enabled: true }
      : { kind: 'action', id: 'capture-pause', label: tr('Pause capture', '暂停采集'), enabled: capture.started !== null },
    { kind: 'separator' },
    ...(input.extra && input.extra.length > 0 ? [...input.extra, { kind: 'separator' as const }] : []),
    { kind: 'action', id: 'quit', label: tr('Quit Navalia', '退出 Navalia'), enabled: true }
  ]
}

/**
 * Template-image glyph for the menu bar: the app's ◐ brand mark (ring + filled left half),
 * drawn procedurally so no binary asset or new dependency is needed. Returns raw 32-bit pixels
 * (size × size × 4). Colour channels are 0 (black); only alpha carries the shape, so the byte
 * order (RGBA vs BGRA) is irrelevant and macOS tints it for light/dark menu bars.
 */
export function renderTrayGlyph(size: number): Buffer {
  if (!Number.isInteger(size) || size < 8 || size > 256) throw new Error('glyph size out of range')
  const buf = Buffer.alloc(size * size * 4)
  const c = size / 2
  const outer = size * 0.44
  const inner = outer - Math.max(1, size * 0.09)
  const SS = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - c
          const py = y + (sy + 0.5) / SS - c
          const d = Math.hypot(px, py)
          if (d <= outer && (d >= inner || px <= 0)) hits++
        }
      }
      buf[(y * size + x) * 4 + 3] = Math.round((hits / (SS * SS)) * 255)
    }
  }
  return buf
}
