// S1-R4-05 X9 local notifications (docs/design/PROACTIVE.md §2; approved DECISIONS-ROUND3 §1 X9).
// Types + constants only: no node / electron imports, so the renderer typecheck can include it.
//
// Invariants (enforced in engine.ts / service.ts, tested in tests/proactive/):
// - Opt-in: master switch + one switch per trigger, every default OFF.
// - Content-free: a notification carries counts and fixed category words only. Never memory text,
//   names, window titles, URLs or WeChat content. Bodies are built from the fixed templates below.
// - At most PROACTIVE_DAILY_CAP per local day; per-trigger cooldown; dedupe; quiet hours.
// - Click only opens / focuses a Lens page. No notification writes anything.
// - No network, no LLM. Local log `<LensStore>/proactive-log.json` (0600) holds trigger, time and
//   hashed / categorical source ids, never text.
import { tr } from '../../shared/i18n'
import type { LensResult } from '../../shared/types'

/**
 * Evaluation order is fixed: T3, T4, T5, the event triggers T8, T9, then the time triggers T1, T2,
 * T10 (the daily cap is spent in this order).
 * S1-FULL C17 added T8 meeting_ready / T9 friend_moment (event bus, events.ts) and T10 weekly_counts
 * (time-based, from the owner-only 「表现」 counts).
 */
export const PROACTIVE_TRIGGERS = [
  'owner_aliases',
  'capture_degraded',
  'runtime',
  'meeting_ready',
  'friend_moment',
  'daily_brief',
  'carried_todos',
  'weekly_counts'
] as const
export type ProactiveTrigger = (typeof PROACTIVE_TRIGGERS)[number]

/**
 * Triggers with a context-sufficiency gate: they stay silent unless at least `minItems` concrete
 * items (each with its own evidence id) back the notification. Edge triggers (T3–T5) are state
 * changes, not content, so they have no item threshold.
 */
export const GATED_TRIGGERS = ['meeting_ready', 'friend_moment', 'daily_brief', 'carried_todos', 'weekly_counts'] as const
export type GatedTrigger = (typeof GATED_TRIGGERS)[number]
export const EVENT_TRIGGERS = ['meeting_ready', 'friend_moment'] as const
export type EventTrigger = (typeof EVENT_TRIGGERS)[number]

/** Defaults. T1/T2 keep the X9-approved ≥1 rule; the new C17 triggers start stricter. */
export const DEFAULT_MIN_ITEMS: Record<GatedTrigger, number> = {
  meeting_ready: 3,
  friend_moment: 1,
  daily_brief: 1,
  carried_todos: 1,
  weekly_counts: 3
}
export const MIN_ITEMS_MAX = 50
export const DAILY_CAP_MAX = 10
/** An event that could not be sent (quiet hours / cap) is retried on later ticks for this long. */
export const EVENT_TTL_MS = 24 * 3_600_000
/** Proactive's own global shortcut default (different from the Quick Box default). */
export const DEFAULT_PROACTIVE_ACCELERATOR = 'CommandOrControl+Alt+L'
/** Detail text (only when the user enabled `detail`) is cut to this many characters. */
export const DETAIL_MAX_CHARS = 30

/** PROACTIVE.md §2.1 numbering, for UI and logs. */
export const TRIGGER_CODE: Record<ProactiveTrigger, string> = {
  owner_aliases: 'T3',
  capture_degraded: 'T4',
  runtime: 'T5',
  daily_brief: 'T1',
  carried_todos: 'T2',
  meeting_ready: 'T8',
  friend_moment: 'T9',
  weekly_counts: 'T10'
}

export const TRIGGER_LABEL: Record<ProactiveTrigger, string> = {
  get owner_aliases() {
    return tr('New "might be your name" items to confirm', '有新的「可能是你的名字」待确认')
  },
  get capture_degraded() {
    return tr('Screen capture / OCR degraded for ≥10 minutes, and when it recovers', '屏幕采集 / OCR 持续降级（≥10 分钟），以及恢复')
  },
  get runtime() {
    return tr('Runtime unreachable for ≥5 minutes, or Runtime upgraded', 'Runtime 连不上 ≥5 分钟，或 Runtime 升级')
  },
  get daily_brief() {
    return tr('Daily brief ready (at the set time, with enough next steps)', '每日简报就绪（到点，且下一步条数达到门槛）')
  },
  get carried_todos() {
    return tr('Yesterday\'s to-dos still not ticked off', '昨天的待办还没勾掉')
  },
  get meeting_ready() {
    return tr('Meeting transcript ready (enough transcript segments)', '会议转写就绪（转写段数达到门槛）')
  },
  get friend_moment() {
    return tr('Friend moment accepted (enough evidenced items)', '朋友时刻被接受（带证据的条目达到门槛）')
  },
  get weekly_counts() {
    return tr('Last week\'s Performance counts ready (enough evidenced records)', '上周的「表现」计数就绪（带证据的记录达到门槛）')
  }
}

/**
 * Pages a click / the proactive shortcut may open. QuickOpenPage ids (shell/api.ts) plus the pages
 * the shell list does not have yet ('meetings', 'performance'; see the C16-C17 wiring request).
 */
export const PROACTIVE_ROUTES = ['settings', 'capture', 'overview', 'today', 'peers', 'meetings', 'performance'] as const
export type ProactiveRoute = (typeof PROACTIVE_ROUTES)[number]

/** Page each trigger opens on click. */
export const TRIGGER_ROUTE = {
  owner_aliases: 'settings',
  capture_degraded: 'capture',
  runtime: 'overview',
  daily_brief: 'today',
  carried_todos: 'today',
  meeting_ready: 'meetings',
  friend_moment: 'peers',
  weekly_counts: 'performance'
} as const satisfies Record<ProactiveTrigger, ProactiveRoute>

/** Default daily cap (user-configurable 1..DAILY_CAP_MAX since C17). */
export const PROACTIVE_DAILY_CAP = 3
/** One scheduler tick at most every 15 minutes. */
export const PROACTIVE_TICK_MS = 15 * 60_000
export const CAPTURE_DEGRADED_MIN_MS = 10 * 60_000
export const RUNTIME_DOWN_MIN_MS = 5 * 60_000

/** Per-trigger cooldown. `daily` = at most once per local day. */
export const TRIGGER_COOLDOWN: Record<ProactiveTrigger, number | 'daily'> = {
  owner_aliases: 4 * 3_600_000,
  capture_degraded: 30 * 60_000,
  runtime: 3_600_000,
  daily_brief: 'daily',
  carried_todos: 'daily',
  meeting_ready: 10 * 60_000,
  friend_moment: 30 * 60_000,
  weekly_counts: 'daily'
}

export const NOTIFICATION_TITLE = 'Navalia'

/** Fixed T4 categories → fixed words. Nothing from the source is ever copied into a body. */
export const CAPTURE_ISSUE_LABEL = {
  get perm_screen_recording() {
    return tr('Screen Recording permission missing', '缺少屏幕录制权限')
  },
  get perm_accessibility() {
    return tr('Accessibility permission missing', '缺少辅助功能权限')
  },
  get ingest_rejected() {
    return tr('Runtime rejected captured data', 'Runtime 拒收采集数据')
  },
  get ocr() {
    return tr('OCR not ready', 'OCR 未就绪')
  },
  get ocr_worker() {
    return tr('OCR worker error', 'OCR worker 异常')
  },
  get capture_pipeline() {
    return tr('Runtime capture pipeline error', 'Runtime 采集流水线异常')
  }
} as const
export type CaptureIssue = keyof typeof CAPTURE_ISSUE_LABEL
export const CAPTURE_ISSUES = Object.keys(CAPTURE_ISSUE_LABEL) as CaptureIssue[]

/** Body templates: the only inputs are non-negative integers and CaptureIssue codes. */
export const BODY = {
  ownerAliases: (n: number) => tr(`${n} names that might be yours to confirm`, `有 ${n} 个可能是你的名字待确认`),
  captureDegraded: (issues: CaptureIssue[]) =>
    tr(`Screen capture degraded: ${issues.map((i) => CAPTURE_ISSUE_LABEL[i]).join(', ')}`, `屏幕采集已降级：${issues.map((i) => CAPTURE_ISSUE_LABEL[i]).join('、')}`),
  captureRecovered: () => tr('Screen capture is back to normal', '屏幕采集已恢复正常'),
  runtimeDown: () => tr('Persome Runtime has been unreachable for over 5 minutes', 'Persome Runtime 已连不上 5 分钟以上'),
  runtimeUpgraded: () => tr('Runtime was upgraded. Please restart other Agent sessions', 'Runtime 已升级，请重启其他 Agent 会话'),
  dailyBrief: (n: number) => tr(`Today's brief: ${n} next steps`, `今天的简报：${n} 条下一步`),
  carriedTodos: (n: number) => tr(`${n} of yesterday's to-dos still not ticked off`, `有 ${n} 条昨天的待办还没勾掉`),
  meetingReady: (n: number) => tr(`Meeting transcript ready: ${n} segments`, `会议转写已就绪：${n} 段`),
  friendMoment: (n: number) => tr(`Friend moments accepted: ${n}`, `朋友时刻已接受：${n} 条`),
  weeklyCounts: (n: number) => tr(`${n} evidenced records last week. See the Performance page`, `上周有 ${n} 条带证据的记录，可在「表现」页查看`),
  test: () => tr('Notifications are on. This is a test notification with no memory content.', '通知已开启。这是一条测试通知，不含任何记忆内容。')
} as const

export type ProactiveTriggerSwitches = Record<ProactiveTrigger, boolean>

export type BriefDays = 'all' | 'weekdays'

export interface ProactiveSettings {
  /** 2 since S1-FULL C17. A version-1 file is migrated on read (new fields take their OFF defaults). */
  version: 2
  /** Master switch. Off ⇒ no timer, no shortcut, no tray entry, events dropped, nothing evaluated. */
  enabled: boolean
  triggers: ProactiveTriggerSwitches
  /** Local `HH:MM`. start === end means no quiet hours. Crossing midnight is allowed (default 22:00–09:00). */
  quietHours: { start: string; end: string }
  /** T1 / T2 / T10: local `HH:MM` from which the daily notification may fire. */
  briefTime: string
  /** T1 / T2 / T10 on every day, or Monday–Friday only. */
  briefDays: BriefDays
  /** Max notifications per local day (1..DAILY_CAP_MAX). */
  dailyCap: number
  /** Context-sufficiency thresholds (≥ this many evidenced items, else silent). */
  minItems: Record<GatedTrigger, number>
  /** Off: title + fixed sentence with a count only. On: event triggers may append a short label. */
  detail: boolean
  /** Show a 「提醒」 entry in the menu bar icon menu (needs the shell tray; see wiring request). */
  tray: boolean
  /** Proactive's own global shortcut: opens the page of the latest notification (else 今天). */
  shortcut: { enabled: boolean; accelerator: string }
}

export interface ProactiveSettingsPatch {
  enabled?: boolean
  triggers?: Partial<ProactiveTriggerSwitches>
  quietHours?: { start: string; end: string }
  briefTime?: string
  briefDays?: BriefDays
  dailyCap?: number
  minItems?: Partial<Record<GatedTrigger, number>>
  detail?: boolean
  tray?: boolean
  shortcut?: { enabled?: boolean; accelerator?: string }
}

/** Why a trigger did not fire (or 'fired'). Every evaluation of an enabled trigger is logged. */
export const DECISION_REASONS = [
  'not_due',
  'not_today',
  'no_source',
  'no_change',
  'no_event',
  'below_threshold',
  'expired',
  'quiet_hours',
  'daily_cap',
  'dedupe',
  'cooldown',
  'notify_failed',
  'permission',
  'no_window'
] as const
export type DecisionReason = (typeof DECISION_REASONS)[number]

export const DECISION_REASON_LABEL: Record<DecisionReason, string> = {
  get not_due() {
    return tr('Not yet the set time', '还没到设定时间')
  },
  get not_today() {
    return tr('Today is not a set day (weekdays only)', '今天不是设定的日子（只在工作日）')
  },
  get no_source() {
    return tr('Data source unreadable: staying silent', '数据源读不到：保持沉默')
  },
  get no_change() {
    return tr('No change in state', '状态没有变化')
  },
  get no_event() {
    return tr('No new events', '没有新事件')
  },
  get below_threshold() {
    return tr('Not enough content (below threshold): staying silent', '内容不足（低于门槛）：保持沉默')
  },
  get expired() {
    return tr('Event could not be sent within 24 hours and was dropped', '事件超过 24 小时未能发送，已丢弃')
  },
  get quiet_hours() {
    return tr('Quiet hours', '安静时段')
  },
  get daily_cap() {
    return tr('Today\'s limit reached', '已达今日上限')
  },
  get dedupe() {
    return tr('Already notified about the same thing', '同样的内容已经提醒过')
  },
  get cooldown() {
    return tr('Cooling down', '冷却中')
  },
  get notify_failed() {
    return tr('The system did not show the notification', '系统没有显示通知')
  },
  get permission() {
    return tr('No notification permission', '没有通知权限')
  },
  get no_window() {
    return tr('No Navalia window', '没有 Navalia 窗口')
  }
}

export interface ProactiveDecision {
  /** ISO instant of the first occurrence. */
  time: string
  /** ISO instant of the latest identical occurrence (consecutive repeats are folded). */
  last_time: string
  repeat: number
  trigger: ProactiveTrigger | 'all'
  outcome: 'fired' | 'suppressed'
  reason: DecisionReason | null
  /** Evidenced item count the gate saw (null when not applicable). */
  count: number | null
  threshold: number | null
  /** Categorical codes or 16-hex hashes, never text. */
  source_ids: string[]
}

export type ProactiveShortcutStatus =
  | { state: 'off'; accelerator: string; message: null }
  | { state: 'registered'; accelerator: string; message: null }
  | { state: 'failed'; accelerator: string; message: string }

/** One menu item the shell tray may show (pure model; see trayItems.ts). */
export type ProactiveTrayItem =
  | { kind: 'info'; label: string }
  | { kind: 'action'; id: ProactiveTrayAction; label: string }
export type ProactiveTrayAction = 'proactive_pause_all' | 'proactive_open_log'

/**
 * What Lens knows about macOS notification permission. Electron has no API that reports a denial on
 * macOS, so this records whether the test notification was shown and what the user told us.
 * - not_asked: master switch never turned on.
 * - shown: the test notification emitted `show`.
 * - not_shown: it did not (error / timeout). Nothing is sent.
 * - unsupported: Notification.isSupported() is false. Nothing is sent.
 * - denied: the user said they did not see it / turned it off in System Settings. Nothing is sent,
 *   and Lens does not ask again by itself (only the explicit 「重新测试」 button does).
 */
export type NotificationPermissionState = 'not_asked' | 'shown' | 'not_shown' | 'unsupported' | 'denied'

export interface ProactiveLogEntry {
  trigger: ProactiveTrigger | 'test'
  /** ISO instant. */
  time: string
  /** Categorical codes or short hashes; never text. */
  source_ids: string[]
}

export interface ProactiveView {
  settings: ProactiveSettings
  /** Set when proactive-settings.json was unreadable / invalid: everything is off. */
  settingsError: string | null
  permission: { state: NotificationPermissionState; at: string | null }
  /** True while the scheduler timer exists (master on, settings valid, permission shown). */
  running: boolean
  sentToday: number
  dailyCap: number
  quietNow: boolean
  lastTick: string | null
  /** Newest first, at most 20. */
  log: ProactiveLogEntry[]
  /** Newest first, at most 50: every fired / suppressed decision with its reason. */
  decisions: ProactiveDecision[]
  shortcut: ProactiveShortcutStatus
  /** Items the tray menu shows right now ([] when off). */
  tray: ProactiveTrayItem[]
  /** Event-trigger items waiting for a later tick (quiet hours / cap). */
  pendingEvents: number
}

export const PROACTIVE_CHANNELS = {
  get: 'lens:proactive:get',
  set: 'lens:proactive:set',
  test: 'lens:proactive:test',
  reportDenied: 'lens:proactive:report-denied',
  clearDecisions: 'lens:proactive:clear-decisions'
} as const

export interface ProactiveApi {
  proactive: {
    get(): Promise<LensResult<ProactiveView>>
    set(patch: ProactiveSettingsPatch): Promise<LensResult<ProactiveView>>
    /** User-initiated only: shows one test notification and records whether it was shown. */
    test(): Promise<LensResult<ProactiveView>>
    /** The user says notifications are denied / not visible: nothing is sent from now on. */
    reportDenied(): Promise<LensResult<ProactiveView>>
    /** Empties the local decision log (proactive-decisions.json). */
    clearDecisions(): Promise<LensResult<ProactiveView>>
  }
}
