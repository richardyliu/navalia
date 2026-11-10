// OG-04: global shortcut accelerator validation. Pure: no node / electron imports (renderer-safe).
// Validation is stricter than Electron's parser on purpose: we require a real (non-Shift) modifier
// so a global hotkey can never swallow plain typing, and we refuse well-known system / editing
// shortcuts. Passing validation does NOT mean registration will succeed (another app may own it);
// the controller reports that failure honestly.
import { ACCELERATOR_MAX_LENGTH } from './api'
import { tr } from '../../shared/i18n'

const MODIFIERS: Record<string, string> = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super'
}

const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Super', 'Shift']

const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  plus: 'Plus'
}

const PUNCTUATION = new Set(['-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`'])

/** Canonical combos we refuse (system / universal editing shortcuts). Compared after normalization. */
const RESERVED = new Set(
  [
    'Command+Space', // Spotlight
    'Control+Space', // input source switch
    'CommandOrControl+Space',
    'Command+Tab',
    'Alt+Tab',
    'Control+Tab',
    'CommandOrControl+Tab',
    ...['Q', 'W', 'C', 'V', 'X', 'Z', 'A', 'S', 'H', 'M', 'Tab'].flatMap((k) => [
      `CommandOrControl+${k}`,
      `Command+${k}`,
      `Control+${k}`
    ]),
    'CommandOrControl+Shift+Z',
    'Command+Shift+Z',
    'Control+Shift+Z',
    'Command+Shift+3',
    'Command+Shift+4',
    'Command+Shift+5',
    'CommandOrControl+Shift+3',
    'CommandOrControl+Shift+4',
    'CommandOrControl+Shift+5'
  ]
)

export type AcceleratorCheck = { ok: true; accelerator: string } | { ok: false; reason: string }

function normalizeKey(raw: string): string | null {
  const lower = raw.toLowerCase()
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return lower
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (f) return `F${f[1]}`
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower]
  if (PUNCTUATION.has(raw)) return raw
  return null
}

/** Validate and normalize an accelerator string such as `CommandOrControl+Shift+Space`. */
export function validateAccelerator(input: unknown): AcceleratorCheck {
  if (typeof input !== 'string') return { ok: false, reason: tr('Shortcut must be a string', '快捷键必须是字符串') }
  const text = input.trim()
  if (!text) return { ok: false, reason: tr('Shortcut cannot be empty', '快捷键不能为空') }
  if (text.length > ACCELERATOR_MAX_LENGTH) return { ok: false, reason: tr(`Shortcut too long (max ${ACCELERATOR_MAX_LENGTH} characters)`, `快捷键过长（最多 ${ACCELERATOR_MAX_LENGTH} 字符）`) }
  if (/\s/.test(text)) return { ok: false, reason: tr('Shortcut cannot contain spaces (write the space key as Space)', '快捷键不能包含空格（空格键请写 Space）') }
  const parts = text.split('+')
  if (parts.some((p) => p === '')) return { ok: false, reason: tr('Bad format: join keys with +, and write the plus key as Plus', '格式错误：用 + 连接，加号键请写 Plus') }
  const mods = new Set<string>()
  let key: string | null = null
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()]
    if (mod) {
      if (key !== null) return { ok: false, reason: tr('Modifiers must come before the key', '修饰键必须写在按键前面') }
      if (mods.has(mod)) return { ok: false, reason: tr(`Duplicate modifier: ${mod}`, `修饰键重复：${mod}`) }
      mods.add(mod)
      continue
    }
    if (key !== null) return { ok: false, reason: tr('Only one non-modifier key is allowed', '只能有一个非修饰键') }
    const k = normalizeKey(part)
    if (!k) return { ok: false, reason: tr(`Unsupported key: ${part}`, `不支持的按键：${part}`) }
    key = k
  }
  if (key === null) return { ok: false, reason: tr('Missing a key (e.g. Space, K)', '缺少按键（例如 Space、K）') }
  if (mods.has('CommandOrControl') && (mods.has('Command') || mods.has('Control'))) {
    return { ok: false, reason: tr('CommandOrControl cannot be combined with Command / Control', 'CommandOrControl 不能与 Command / Control 同时使用') }
  }
  const strong = [...mods].filter((m) => m !== 'Shift')
  if (strong.length === 0) return { ok: false, reason: tr('Needs at least one Command / Control / Alt modifier (Shift alone is not enough)', '至少需要一个 Command / Control / Alt 修饰键（不能只用 Shift）') }
  const accelerator = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+')
  if (RESERVED.has(accelerator)) return { ok: false, reason: tr(`${accelerator} is a system or common editing shortcut; pick another`, `${accelerator} 是系统或常用编辑快捷键，请换一个`) }
  return { ok: true, accelerator }
}
