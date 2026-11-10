// S1-FULL C17: the proactive layer's own global shortcut (default OFF). Electron's globalShortcut is
// injected as a minimal registry so this file is unit-testable with a fake.
//
// - Registered only while the master switch AND the shortcut switch are on; unregistered right away
//   when either turns off, when the accelerator changes, and on quit.
// - Conflict check before registering: the accelerator must pass shell/accelerator.ts validation
//   (no system / editing shortcuts, needs a real modifier), must differ from the Quick Box shortcut
//   (`reserved()`), and must not already be registered by this app. A refusal by the OS / another
//   app (register() === false) is reported, never swallowed.
// - Pressing it only opens / focuses a Lens page (onPress); it writes nothing.
import { tr } from '../../shared/i18n'
import { validateAccelerator } from '../shell/accelerator'
import type { ProactiveSettings, ProactiveShortcutStatus } from './api'

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered?(accelerator: string): boolean
}

export interface ProactiveShortcutDeps {
  registry: ShortcutRegistry
  /** Accelerators other Lens surfaces hold (the Quick Box shortcut when it is on). */
  reserved?(): string[]
  onPress(): void
}

export function createProactiveShortcut(deps: ProactiveShortcutDeps) {
  let held: string | null = null
  let status: ProactiveShortcutStatus = { state: 'off', accelerator: '', message: null }

  function release(): void {
    if (held !== null) {
      try {
        deps.registry.unregister(held)
      } catch {
        // already gone
      }
    }
    held = null
  }

  function apply(settings: ProactiveSettings, settingsValid = true): ProactiveShortcutStatus {
    const want = settingsValid && settings.enabled && settings.shortcut.enabled
    const raw = settings.shortcut.accelerator
    if (!want) {
      release()
      status = { state: 'off', accelerator: raw, message: null }
      return status
    }
    const check = validateAccelerator(raw)
    if (!check.ok) {
      release()
      status = { state: 'failed', accelerator: raw, message: check.reason }
      return status
    }
    const acc = check.accelerator
    if (held === acc) return status
    release()
    const reserved = (deps.reserved?.() ?? []).map((r) => {
      const v = validateAccelerator(r)
      return v.ok ? v.accelerator : r
    })
    if (reserved.includes(acc)) {
      status = { state: 'failed', accelerator: acc, message: tr(`${acc} is already the Quick Box shortcut. Choose another one`, `${acc} 已被 Quick Box 快捷键使用，请换一个`) }
      return status
    }
    if (deps.registry.isRegistered?.(acc)) {
      status = { state: 'failed', accelerator: acc, message: tr(`${acc} is already used by another shortcut in this app`, `${acc} 已被本应用的其他快捷键占用`) }
      return status
    }
    let ok = false
    try {
      ok = deps.registry.register(acc, () => deps.onPress())
    } catch {
      ok = false
    }
    if (!ok) {
      status = { state: 'failed', accelerator: acc, message: tr(`Could not register ${acc}: it may be taken by the system or another app`, `${acc} 注册失败：可能被系统或其他应用占用`) }
      return status
    }
    held = acc
    status = { state: 'registered', accelerator: acc, message: null }
    return status
  }

  return {
    apply,
    status: (): ProactiveShortcutStatus => status,
    held: (): string | null => held,
    dispose(): void {
      release()
      status = { state: 'off', accelerator: status.accelerator, message: null }
    }
  }
}
