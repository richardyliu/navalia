// OG-04 shell IPC. Every channel is zod-validated and returns LensResult<T>.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensResult } from '../../shared/types'
import { CLIPBOARD_MAX_CHARS, QUICK_OPEN_PAGE_IDS, SHELL_CHANNELS, type QuickOpenPage } from './api'
import type { ShellController } from './controller'
import { applyShellPatch } from './settings'
import { tr } from '../../shared/i18n'

const NoArgs = z.undefined()
const OpenPageArgs = z.strictObject({ page: z.enum(QUICK_OPEN_PAGE_IDS as [QuickOpenPage, ...QuickOpenPage[]]) })

/** OG9: fixed renderer-facing messages; raw error text (paths, errno detail) stays in main's log. */
export const SHELL_ERROR_MESSAGES = {
  get get() { return tr('Failed to read desktop settings', '读取桌面设置失败') },
  get set() { return tr('Failed to save desktop settings', '保存桌面设置失败') },
  get quickBoxOpen() { return tr("Can't open Quick Box", '无法打开 Quick Box') },
  get quickBoxClose() { return tr("Can't close Quick Box", '无法关闭 Quick Box') },
  get openPage() { return tr("Can't open the page", '无法打开页面') },
  get readClipboard() { return tr('Failed to read the clipboard', '读取剪贴板失败') }
} satisfies Record<keyof typeof SHELL_CHANNELS, string>

async function run<T>(failMessage: string, fn: () => T | Promise<T>): Promise<LensResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) } }
    }
    console.warn(`[shell] ${failMessage}:`, error instanceof Error ? error.name : typeof error)
    return { ok: false, error: { code: 'unknown', message: failMessage } }
  }
}

export interface ShellIpcDeps {
  /** Called only from the explicit "粘贴剪贴板" button; never on open / focus / timer. */
  readClipboardText(): string
}

export function registerShellIpc(ipc: Pick<IpcMain, 'handle'>, controller: ShellController, deps: ShellIpcDeps): void {
  const C = SHELL_CHANNELS
  ipc.handle(C.get, (_e, raw: unknown) => run(SHELL_ERROR_MESSAGES.get, () => (NoArgs.parse(raw), controller.state())))
  ipc.handle(C.set, (_e, raw: unknown) =>
    run(SHELL_ERROR_MESSAGES.set, () => {
      const patch = z.strictObject({ patch: z.unknown() }).parse(raw).patch
      // Validate before touching anything: an invalid patch writes nothing and changes nothing.
      return controller.update((current) => applyShellPatch(current, patch))
    })
  )
  ipc.handle(C.quickBoxOpen, (_e, raw: unknown) => run(SHELL_ERROR_MESSAGES.quickBoxOpen, () => (NoArgs.parse(raw), controller.openQuickBox(), true)))
  ipc.handle(C.quickBoxClose, (_e, raw: unknown) => run(SHELL_ERROR_MESSAGES.quickBoxClose, () => (NoArgs.parse(raw), controller.closeQuickBox(), true)))
  ipc.handle(C.openPage, (_e, raw: unknown) => run(SHELL_ERROR_MESSAGES.openPage, () => (controller.openPage(OpenPageArgs.parse(raw).page), true)))
  ipc.handle(C.readClipboard, (_e, raw: unknown) =>
    run(SHELL_ERROR_MESSAGES.readClipboard, () => {
      NoArgs.parse(raw)
      const text = deps.readClipboardText() ?? ''
      return { text: text.slice(0, CLIPBOARD_MAX_CHARS), truncated: text.length > CLIPBOARD_MAX_CHARS }
    })
  )
}
