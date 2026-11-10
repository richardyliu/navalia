// OG-04 desktop shell: menu bar Tray, global shortcut, Quick Box.
// Types + constants only: no node / electron imports, so the renderer typecheck can include it.
// Everything here is local and opt-in: every toggle defaults to OFF, no network, no TCC prompts.
import type { LensResult } from '../../shared/types'
import { tr } from '../../shared/i18n'

export const SHELL_CHANNELS = {
  get: 'lens:shell:get',
  set: 'lens:shell:set',
  quickBoxOpen: 'lens:shell:quickbox-open',
  quickBoxClose: 'lens:shell:quickbox-close',
  openPage: 'lens:shell:open-page',
  /** Reads the clipboard ONCE, only when the user presses the explicit "粘贴剪贴板" button. */
  readClipboard: 'lens:shell:read-clipboard'
} as const

/** main → renderer event (main window only): navigate to a page. */
export const SHELL_NAVIGATE_EVENT = 'lens:shell:navigate'

/** URL hash that makes the renderer mount the Quick Box instead of the full App. */
export const QUICKBOX_HASH = '#quickbox'

export const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space'
export const ACCELERATOR_MAX_LENGTH = 64
export const CLIPBOARD_MAX_CHARS = 20_000

export interface ShellSettings {
  version: 1
  /** 菜单栏图标 */
  trayEnabled: boolean
  /** 全局快捷键 */
  shortcutEnabled: boolean
  shortcutAccelerator: string
  /** 关闭窗口后保持常驻（only effective while the menu bar icon is visible） */
  keepResidentOnClose: boolean
}

export type ShellSettingsPatch = Partial<Omit<ShellSettings, 'version'>>

export type ShortcutStatus =
  | { state: 'off'; accelerator: string; message: null }
  | { state: 'registered'; accelerator: string; message: null }
  /** Enabled by the user, but the OS / another app refused it (or the accelerator is invalid). */
  | { state: 'failed'; accelerator: string; message: string }

export interface ShellState {
  settings: ShellSettings
  tray: { active: boolean; error: string | null }
  shortcut: ShortcutStatus
  /** keepResidentOnClose && tray active: closing the main window hides it instead of closing it. */
  resident: { effective: boolean; reason: string }
  /** Set when the settings file was unreadable; defaults (all off) are in use. */
  settingsError: string | null
}

/** Pages Quick Box can jump to. Must stay a subset of the renderer `Page` union (App.tsx checks it). */
export const QUICK_OPEN_PAGES = [
  { id: 'home', get label() { return tr('Home', '主页') }, aliases: ['home', 'zhuye', 'main', '主页'] },
  { id: 'today', get label() { return tr('Today', '今天') }, aliases: ['today', 'brief', 'jintian', '今天'] },
  { id: 'ask', get label() { return tr('Ask', '问') }, aliases: ['ask', 'wen', 'prompt', '问'] },
  { id: 'overview', get label() { return tr('Overview', '总览') }, aliases: ['overview', 'runtime', 'zonglan', '总览'] },
  { id: 'library', get label() { return tr('Library', '资料库') }, aliases: ['library', 'ziliaoku', 'people', 'projects', '资料库'] },
  { id: 'model', get label() { return tr('Model', '模型') }, aliases: ['model', 'moxing', 'root', 'face', '模型'] },
  { id: 'search', get label() { return tr('Search', '搜索') }, aliases: ['search', 'sousuo', 'memory', '记忆', '搜索'] },
  { id: 'playbook', label: 'Playbook', aliases: ['playbook', 'workflow', '工作流'] },
  { id: 'capture', get label() { return tr('Capture', '采集') }, aliases: ['capture', 'caiji', 'pause', '暂停', '采集'] },
  { id: 'rewind', label: 'Rewind', aliases: ['rewind', 'screenshots', '截图'] },
  { id: 'card', get label() { return tr('Personal Card', '个人卡片') }, aliases: ['card', 'personal card', '卡片', '个人卡片'] },
  { id: 'peers', get label() { return tr('Peers', '朋友') }, aliases: ['peers', 'friends', 'pengyou', '朋友'] },
  { id: 'swipe', label: 'Swipe', aliases: ['swipe', 'export', '导出'] },
  { id: 'connections', label: 'Connections', aliases: ['connections', 'agents', 'access log', '连接'] },
  { id: 'het', label: 'HET', aliases: ['het', 'human equivalent time'] },
  { id: 'performance', get label() { return tr('Performance', '表现') }, aliases: ['biaoxian', '表现', 'projects', '项目', 'counts', 'performance'] },
  { id: 'meetings', get label() { return tr('Meetings', '会议') }, aliases: ['meetings', 'huiyi', '会议'] },
  { id: 'import', get label() { return tr('Import', '导入') }, aliases: ['import', 'daoru', 'claude', 'codex', '导入'] },
  { id: 'settings', get label() { return tr('Settings', '设置') }, aliases: ['settings', 'shezhi', 'preferences', '偏好', '设置'] }
] as const

export type QuickOpenPage = (typeof QUICK_OPEN_PAGES)[number]['id']

export const QUICK_OPEN_PAGE_IDS: readonly QuickOpenPage[] = QUICK_OPEN_PAGES.map((p) => p.id)

export function isQuickOpenPage(value: unknown): value is QuickOpenPage {
  return typeof value === 'string' && (QUICK_OPEN_PAGE_IDS as readonly string[]).includes(value)
}

export interface ShellApi {
  shell: {
    get(): Promise<LensResult<ShellState>>
    set(patch: ShellSettingsPatch): Promise<LensResult<ShellState>>
    openQuickBox(): Promise<LensResult<boolean>>
    closeQuickBox(): Promise<LensResult<boolean>>
    openPage(page: QuickOpenPage): Promise<LensResult<boolean>>
    readClipboard(): Promise<LensResult<{ text: string; truncated: boolean }>>
    /** Main window only. Returns an unsubscribe function. */
    onNavigate(listener: (page: QuickOpenPage) => void): () => void
  }
}
