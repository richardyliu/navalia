// S1-R4-05 proactive service: settings file + state/log store + engine + scheduler + the permission
// flow. Electron-free; main.ts injects the real Notification, timers and data sources.
//
// Permission: the first time the master switch is turned on, one test notification is shown and
// the outcome is recorded (shown / not_shown / unsupported). Anything but `shown` means nothing is
// ever sent, and Lens does not ask again by itself; only the user's 「重新测试」 does.
//
// S1-FULL C17 additions:
// - Master switch off ⇒ immediately: timer cleared, proactive shortcut unregistered, tray items
//   gone, pending events and their in-memory labels dropped. Events published while off are ignored.
// - Event bus (events.ts): a publish queues a hashed pending item and evaluates T8 / T9 right away
//   (same gates: threshold, quiet hours, daily cap, dedupe, cooldown).
// - Ticks are serialized (scheduled tick, event tick and manual tick never overlap on state).
import {
  BODY,
  EVENT_TRIGGERS,
  NOTIFICATION_TITLE,
  TRIGGER_ROUTE,
  type EventTrigger,
  type NotificationPermissionState,
  type ProactiveRoute,
  type ProactiveTrayAction,
  type ProactiveView
} from './api'
import { createProactiveEngine, hashId, inQuietHours, sentTodayCount, type EngineDeps, type TickOptions, type TickResult } from './engine'
import { EVENT_TRIGGER, evidencedItemIds, type ProactiveEvent, type ProactiveEventBus } from './events'
import { createProactiveScheduler, type Timers } from './scheduler'
import { applyProactivePatch, proactiveSettingsFile, readProactiveSettings, writeProactiveSettings } from './settings'
import { createProactiveShortcut, type ShortcutRegistry } from './shortcut'
import { createFileStore, type ProactiveStore } from './store'
import { proactiveTrayItems } from './trayItems'

export interface ProactiveServiceDeps extends Omit<EngineDeps, 'readSettings' | 'store' | 'eventLabels'> {
  storeRoot: string
  /** Defaults to the 0600 file store under storeRoot. */
  store?: ProactiveStore
  timers: Timers
  /** Electron globalShortcut (or a fake). Absent ⇒ the shortcut setting reports 'failed'. */
  shortcuts?: ShortcutRegistry
  /** Accelerators other Lens surfaces hold (the Quick Box shortcut). */
  reservedAccelerators?(): string[]
  /** Event bus other planes publish to. */
  bus?: ProactiveEventBus
  /** Called after any change that alters the tray items (shell rebuilds its menu lazily anyway). */
  onTrayChanged?(): void
  log?(message: string): void
}

const NO_SHORTCUTS: ShortcutRegistry = { register: () => false, unregister: () => undefined }

export function createProactiveService(deps: ProactiveServiceDeps) {
  const file = proactiveSettingsFile(deps.storeRoot)
  const store = deps.store ?? createFileStore(deps.storeRoot, deps.now)
  const readSettings = () => readProactiveSettings(file)
  /** Hashed event id → label. Memory only; cleared when the master switch goes off. */
  const labels = new Map<string, string>()
  const engine = createProactiveEngine({ ...deps, readSettings, store, eventLabels: () => labels })

  // Serialize every tick: state is read-modify-write.
  let chain: Promise<unknown> = Promise.resolve()
  function serialized(opts?: TickOptions): Promise<TickResult> {
    const next = chain.then(() => engine.tick(opts))
    chain = next.catch(() => undefined)
    return next
  }

  const shouldRun = (): boolean => {
    const { settings, error } = readSettings()
    return !error && settings.enabled && store.readState().permission.state === 'shown'
  }
  const scheduler = createProactiveScheduler({
    tick: () => serialized(),
    shouldRun,
    now: deps.now,
    timers: deps.timers,
    onError: (e) => deps.log?.(`[proactive] tick failed: ${e instanceof Error ? e.name : typeof e}`)
  })

  /** Page of the latest sent notification, else 今天. */
  function latestRoute(): ProactiveRoute {
    const log = store.readLog()
    for (let i = log.length - 1; i >= 0; i--) {
      const t = log[i].trigger
      if (t !== 'test') return TRIGGER_ROUTE[t]
    }
    return 'today'
  }

  const shortcut = createProactiveShortcut({
    registry: deps.shortcuts ?? NO_SHORTCUTS,
    reserved: deps.reservedAccelerators,
    onPress: () => deps.openPage(latestRoute())
  })

  function applySurfaces(): void {
    const { settings, error } = readSettings()
    shortcut.apply(settings, error === null)
    if (error || !settings.enabled) {
      labels.clear()
      const s = store.readState()
      if (s.pendingEvents.length > 0) {
        s.pendingEvents = []
        store.writeState(s)
      }
    }
    deps.onTrayChanged?.()
  }

  function setPermission(stateValue: NotificationPermissionState): void {
    const s = store.readState()
    s.permission = { state: stateValue, at: new Date(deps.now()).toISOString() }
    store.writeState(s)
  }

  async function runTest(): Promise<void> {
    if (!deps.notifier.isSupported()) return setPermission('unsupported')
    const r = await deps.notifier.show({ title: NOTIFICATION_TITLE, body: BODY.test() }).catch(() => 'failed' as const)
    setPermission(r === 'shown' ? 'shown' : 'not_shown')
    store.appendLog({ trigger: 'test', time: new Date(deps.now()).toISOString(), source_ids: [r === 'shown' ? 'shown' : 'not_shown'] })
  }

  function view(): ProactiveView {
    const { settings, error } = readSettings()
    const st = store.readState()
    const log = store.readLog()
    const now = deps.now()
    const tz = deps.timezone()
    const sentToday = sentTodayCount(log, now, tz)
    const quietNow = inQuietHours(now, tz, settings.quietHours)
    return {
      settings,
      settingsError: error,
      permission: st.permission,
      running: scheduler.running(),
      sentToday,
      dailyCap: settings.dailyCap,
      quietNow,
      lastTick: st.lastTick === null ? null : new Date(st.lastTick).toISOString(),
      log: log.slice(-20).reverse(),
      decisions: store.readDecisions().slice(-50).reverse(),
      shortcut: shortcut.status(),
      tray: proactiveTrayItems({ settings, settingsError: error, sentToday, quietNow }),
      pendingEvents: st.pendingEvents.length
    }
  }

  async function update(rawPatch: unknown): Promise<ProactiveView> {
    const { settings: current, error } = readSettings()
    // A corrupt file is replaced only by an explicit save; the patch applies to the all-off defaults.
    const next = applyProactivePatch(current, rawPatch)
    writeProactiveSettings(file, next)
    const turnedOn = next.enabled && (!current.enabled || error !== null)
    if (turnedOn && store.readState().permission.state === 'not_asked') await runTest()
    applySurfaces()
    await scheduler.reconcile()
    return view()
  }

  /** Event from the bus → pending item → immediate evaluation of that trigger only. */
  async function onEvent(event: ProactiveEvent): Promise<TickResult | null> {
    const trigger: EventTrigger = EVENT_TRIGGER[event.type]
    const { settings, error } = readSettings()
    if (error || !settings.enabled || !settings.triggers[trigger]) return null // off: ignored, nothing kept
    const id = hashId(trigger === 'meeting_ready' ? 'meeting' : 'moment', event.id)
    const items = evidencedItemIds(event).map((i) => hashId('item', i)).slice(0, 200)
    const s = store.readState()
    s.pendingEvents = [...s.pendingEvents.filter((e) => !(e.trigger === trigger && e.id === id)), { trigger, id, items, at: deps.now() }].slice(-200)
    store.writeState(s)
    if (event.label) labels.set(id, event.label)
    else labels.delete(id)
    return serialized({ only: [trigger] })
  }

  const unsubscribe = deps.bus?.subscribe((e) => {
    void onEvent(e).catch((err) => deps.log?.(`[proactive] event failed: ${err instanceof Error ? err.name : typeof err}`))
  })

  return {
    view,
    /** Validate + persist. Throws ZodError on invalid input; nothing is written then. */
    update,
    async test(): Promise<ProactiveView> {
      await runTest()
      await scheduler.reconcile()
      return view()
    },
    async reportDenied(): Promise<ProactiveView> {
      setPermission('denied')
      await scheduler.reconcile()
      return view()
    },
    clearDecisions(): ProactiveView {
      store.clearDecisions()
      return view()
    },
    /** Tray menu click (shell wiring). Only opens a page or turns everything off. */
    async trayAction(id: ProactiveTrayAction): Promise<void> {
      if (id === 'proactive_pause_all') await update({ enabled: false })
      else if (id === 'proactive_open_log') deps.openPage('settings')
    },
    trayItems: () => view().tray,
    onEvent,
    /** Call once at startup: starts the timer and the shortcut only if the master switch is on. */
    start: async (): Promise<void> => {
      applySurfaces()
      await scheduler.reconcile()
    },
    stop: (): void => {
      scheduler.stop()
      shortcut.dispose()
      unsubscribe?.()
    },
    /** Direct tick (tests / diagnostics); production ticks come from the scheduler. */
    tick: (opts?: TickOptions): Promise<TickResult> => serialized(opts),
    running: (): boolean => scheduler.running(),
    eventTriggers: EVENT_TRIGGERS
  }
}

export type ProactiveService = ReturnType<typeof createProactiveService>
