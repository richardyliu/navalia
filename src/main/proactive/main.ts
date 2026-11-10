// S1-R4-05 production wiring: Electron Notification + real timers + production sources → service.
// Thin on purpose; logic lives in engine.ts / service.ts / scheduler.ts and is unit-tested there.
// Electron `Notification` hands the text to macOS Notification Center; no socket, no push service.
//
// S1-FULL C17: also wires Electron globalShortcut (proactive's own shortcut, default OFF, conflict-
// checked against the Quick Box accelerator), the typed event bus, the menu bar 「提醒」 items (the
// shell tray asks `service.trayItems()`; see wiring request) and the T10 「表现」 source.
import { app, globalShortcut, Notification, type IpcMain } from 'electron'
import { systemTimeZone } from '../het/tz'
import type { QuickOpenPage } from '../shell/api'
import { isQuickOpenPage } from '../shell/api'
import type { ProactiveRoute } from './api'
import type { Notifier, WeekSample } from './engine'
import { createProactiveEventBus, type ProactiveEventBus } from './events'
import { registerProactiveIpc } from './ipc'
import { createProactiveService, type ProactiveService } from './service'
import { createProductionSources, type ProductionSourceDeps } from './sources'

const SHOW_TIMEOUT_MS = 5000

/** Keeps a reference until the notification closes (otherwise it can be GC'd and lose its click). */
function electronNotifier(): Notifier {
  const live = new Set<Notification>()
  return {
    isSupported: () => Notification.isSupported(),
    show: (n, onClick) =>
      new Promise((resolve) => {
        const note = new Notification({ title: n.title, body: n.body, silent: false })
        live.add(note)
        const done = (r: 'shown' | 'failed' | 'timeout'): void => {
          clearTimeout(timer)
          resolve(r)
        }
        const timer = setTimeout(() => done('timeout'), SHOW_TIMEOUT_MS)
        note.once('show', () => done('shown'))
        note.once('failed', () => {
          live.delete(note)
          done('failed')
        })
        note.on('click', () => {
          live.delete(note)
          onClick?.()
        })
        note.once('close', () => live.delete(note))
        note.show()
      })
  }
}

export interface SetupProactiveDeps extends ProductionSourceDeps {
  storeRoot: string
  /** Open / focus a Lens page (shell controller). The only effect of a click. */
  openPage(page: QuickOpenPage): void
  /**
   * C17: open a page that is not (yet) a QuickOpenPage ('meetings', 'performance'). Absent ⇒ those
   * routes fall back to 主页.
   */
  openRoute?(page: ProactiveRoute): void
  /** A main window exists (visible or kept resident). */
  hasWindow(): boolean
  /** C17: shared event bus (created by index.ts and handed to publishers). Absent ⇒ a private one. */
  bus?: ProactiveEventBus
  /** C17: the Quick Box accelerator while that shortcut is on (conflict check). */
  reservedAccelerators?(): string[]
  /** C17: T10 source (performance/proactiveSource.ts). Absent ⇒ T10 stays silent (no_source). */
  lastWeek?(now: number, timezone: string): Promise<WeekSample | null>
  /** C17: called when the tray items may have changed. */
  onTrayChanged?(): void
}

export function setupProactive(ipcMain: IpcMain, deps: SetupProactiveDeps): ProactiveService & { bus: ProactiveEventBus } {
  const bus = deps.bus ?? createProactiveEventBus()
  const open = (route: ProactiveRoute): void => {
    if (deps.openRoute) return deps.openRoute(route)
    deps.openPage(isQuickOpenPage(route) ? route : 'home')
  }
  const sources = createProductionSources(deps)
  if (deps.lastWeek) sources.lastWeek = deps.lastWeek
  const service = createProactiveService({
    storeRoot: deps.storeRoot,
    now: Date.now,
    timezone: systemTimeZone,
    notifier: electronNotifier(),
    sources,
    openPage: open,
    hasWindow: deps.hasWindow,
    timers: { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as NodeJS.Timeout) },
    shortcuts: globalShortcut,
    reservedAccelerators: deps.reservedAccelerators,
    bus,
    onTrayChanged: deps.onTrayChanged,
    log: (m) => console.warn(m)
  })
  registerProactiveIpc(ipcMain, service)
  // Timer + shortcut only if the master switch is already on; both stopped on quit.
  void service.start()
  app.on('will-quit', () => service.stop())
  return Object.assign(service, { bus })
}
