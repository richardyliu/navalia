// S1-R3-09 OCR status view-model (pure; shared by the Capture and Ask pages).
//
// Source of truth is the Runtime's unauthenticated loopback GET /health (`ocr_enabled`, `ocr`,
// `ocr_worker`, `ocr_tier`), already fetched by the capture diagnostics IPC. The config.toml summary
// is only used to tell "config written but Runtime not restarted" apart from "config off".
// Lens never edits config.toml: enabling OCR is the user's own `persome ocr setup` (or manual edit),
// and a restart from Lens needs an explicit confirmation in the UI.
import type { OcrConfigView, RuntimeOcrHealth } from '../../../../main/capture/api'
import { tr } from '../../lib/i18n'

export type OcrStatusKind = 'on' | 'off' | 'degraded' | 'unknown'

/**
 * S1-R4-08: terminal commands the panel offers with a 复制 button. Lens only copies the text; it never
 * runs `persome ocr setup` and never writes `~/.persome/config.toml` itself.
 */
export const OCR_SETUP_COMMAND = 'persome ocr setup'
export const RUNTIME_RESTART_COMMAND = 'persome stop && persome start'
export const OCR_CHECK_COMMAND = 'persome ocr status --check'
export const RUNTIME_START_COMMAND = 'persome start'

export interface OcrCommand {
  /** What the command does, shown next to the copy button. */
  label: string
  command: string
}

const CMD_SETUP: OcrCommand = {
  get label() {
    return tr(
      'Turn on OCR (default tier tiny; writes config.toml and requests Screen Recording permission)',
      '开启 OCR（默认档位 tiny，会写入 config.toml 并请求屏幕录制权限）'
    )
  },
  command: OCR_SETUP_COMMAND
}
const CMD_RESTART: OcrCommand = {
  get label() {
    return tr('Restart Runtime so the config takes effect', '重启 Runtime，让配置生效')
  },
  command: RUNTIME_RESTART_COMMAND
}
const CMD_CHECK: OcrCommand = {
  get label() {
    return tr('Show detailed OCR status', '查看 OCR 详细状态')
  },
  command: OCR_CHECK_COMMAND
}
const CMD_START: OcrCommand = {
  get label() {
    return tr('Start Runtime', '启动 Runtime')
  },
  command: RUNTIME_START_COMMAND
}

/** Why WeChat matters here (shown whenever OCR is not confirmed on). */
export function wechatOnlyViaOcr(): string {
  return tr(
    'WeChat exposes no Accessibility text, so WeChat chats can reach screen capture only through OCR.',
    '微信不提供辅助功能文本，微信聊天内容只能通过 OCR 进入屏幕采集。'
  )
}

export interface OcrStatusView {
  kind: OcrStatusKind
  title: string
  /** Raw /health fields as shown to the user, in a fixed order. */
  fields: Array<[string, string]>
  /** Numbered steps (already in order; the UI numbers them). Empty when nothing to do. */
  steps: string[]
  /** Shown next to WeChat search / Ask cards whenever OCR is not confirmed on. */
  wechatWarning: string | null
  /** Offer the confirmed 「重启 Runtime…」 action (Recovery's existing restart path). */
  canRestart: boolean
  /** S1-R4-08: copyable terminal commands, in the order the steps use them. Empty when nothing to do. */
  commands: OcrCommand[]
}

const configStep = (): string =>
  tr(
    'Run `persome ocr setup` in a terminal (default tier tiny; add `--tier small` for another tier). It checks the local OCR worker, requests Screen Recording permission, and writes `enable_ocr_fallback = true`, `ocr_policy = "enabled"` and `ocr_tier = "tiny"` into the `[capture]` table of `~/.persome/config.toml`. You can also edit these three keys by hand. Navalia never modifies this file.',
    '在终端运行 `persome ocr setup`（默认档位 tiny；要换档位加 `--tier small`）。它会检查本机 OCR worker、请求屏幕录制权限，并在 `~/.persome/config.toml` 的 `[capture]` 表里写入 `enable_ocr_fallback = true`、`ocr_policy = "enabled"`、`ocr_tier = "tiny"`。也可以手动编辑这三个键。Navalia 不会修改这个文件。'
  )
const permissionStep = (): string =>
  tr(
    'In System Settings → Privacy & Security → Screen Recording, allow Persome Runtime (or the terminal that runs it). setup tells you if it did not get the permission.',
    '在 系统设置 → 隐私与安全性 → 屏幕录制 里允许 Persome Runtime（或运行它的终端）。setup 没有拿到权限时会提示。'
  )
const restartStep = (): string =>
  tr(
    'Restart Runtime so the config takes effect: run `persome stop && persome start` in a terminal, or click "Restart Runtime…" below (asks for confirmation).',
    '重启 Runtime 让配置生效：在终端运行 `persome stop && persome start`，或点下面的「重启 Runtime…」（需要确认）。'
  )
const verifyStep = (): string =>
  tr(
    'Come back here and refresh: Runtime should show `ocr_enabled = true` and `ocr = ready`. You can also run `persome ocr status --check`.',
    '回到这里刷新：Runtime 实时应显示 `ocr_enabled = true`、`ocr = ready`。也可以运行 `persome ocr status --check`。'
  )

const wechatOff = (): string =>
  tr(
    'OCR is off: WeChat exposes no Accessibility text, so WeChat chats can reach screen capture only through OCR, and capture has almost no WeChat chat text right now. Searching capture for WeChat content, or asking an Agent to "sort out my WeChat groups", returns little or nothing; that does not mean there are no chats.',
    'OCR 已关闭：微信不提供辅助功能文本，微信聊天内容只能通过 OCR 进入屏幕采集，所以现在采集里几乎没有微信聊天文字。在采集里搜微信内容、或让 Agent「整理微信群」，会返回空或很少的结果；这不代表没有聊天。'
  )
const wechatDegraded = (): string =>
  tr(
    `OCR is on but not ready: ${wechatOnlyViaOcr()} WeChat chat text may not be captured right now, so WeChat search results are incomplete.`,
    `OCR 已开启但未就绪：${wechatOnlyViaOcr()}微信聊天文字目前可能没有被采集，搜索微信内容的结果不完整。`
  )
const wechatUnknown = (): string =>
  tr(
    `Cannot confirm whether OCR is on (could not reach Runtime /health): ${wechatOnlyViaOcr()} WeChat search results may be empty or incomplete.`,
    `无法确认 OCR 是否开启（没有连上 Runtime /health）：${wechatOnlyViaOcr()}微信内容的搜索结果可能为空或不完整。`
  )

function fieldsOf(rt: RuntimeOcrHealth): Array<[string, string]> {
  const s = (v: string | boolean | null): string => (v === null ? tr('unknown', '未知') : String(v))
  return [
    ['ocr_enabled', s(rt.enabled)],
    ['ocr', s(rt.state)],
    ['ocr_worker', s(rt.worker)],
    ['ocr_tier', s(rt.tier)]
  ]
}

export function ocrStatusView(runtime: RuntimeOcrHealth | null, config: OcrConfigView | null): OcrStatusView {
  if (!runtime) {
    return {
      kind: 'unknown',
      title: tr('OCR status unknown: could not reach Runtime /health', 'OCR 状态未知：没有连上 Runtime /health'),
      fields: [],
      steps: [
        tr(
          'Make sure Runtime is running: run `persome start` in a terminal (or start it on the Recovery page), then come back here and refresh.',
          '确认 Runtime 在运行：在终端运行 `persome start`（或在「恢复」页启动），然后回到这里刷新。'
        )
      ],
      wechatWarning: wechatUnknown(),
      canRestart: false,
      commands: [CMD_START]
    }
  }
  const fields = fieldsOf(runtime)
  const state = runtime.state
  const tier = runtime.tier ?? tr('unknown', '未知')

  if (state === 'disabled_by_environment') {
    return {
      kind: 'off',
      title: tr('OCR is turned off by the PERSOME_DISABLE_OCR environment variable', 'OCR 被环境变量 PERSOME_DISABLE_OCR 关闭'),
      fields,
      steps: [
        tr(
          'Remove `PERSOME_DISABLE_OCR` from the environment that starts Runtime (for example your shell config file).',
          '从启动 Runtime 的环境里移除 `PERSOME_DISABLE_OCR`（例如 shell 配置文件）。'
        ),
        restartStep(),
        verifyStep()
      ],
      wechatWarning: wechatOff(),
      canRestart: true,
      commands: [CMD_RESTART]
    }
  }

  const off = runtime.enabled === false || (runtime.enabled === null && state === 'disabled')
  if (off) {
    const configOn = config?.enabled === true
    return {
      kind: 'off',
      title: configOn
        ? tr('OCR is on in config.toml, but Runtime has not been restarted to load it', 'OCR 已在 config.toml 里开启，但 Runtime 尚未重启加载')
        : tr('OCR is off', 'OCR 已关闭'),
      fields,
      steps: configOn ? [restartStep(), verifyStep()] : [configStep(), permissionStep(), restartStep(), verifyStep()],
      wechatWarning: wechatOff(),
      canRestart: true,
      commands: configOn ? [CMD_RESTART, CMD_CHECK] : [CMD_SETUP, CMD_RESTART, CMD_CHECK]
    }
  }

  if (state === 'permission_required') {
    return {
      kind: 'degraded',
      title: tr('OCR is on, but Screen Recording permission is missing', 'OCR 已开启，但缺少屏幕录制权限'),
      fields,
      steps: [permissionStep(), restartStep(), verifyStep()],
      wechatWarning: wechatDegraded(), canRestart: true, commands: [CMD_RESTART, CMD_CHECK] }
  }
  if (state === 'models_missing') {
    return {
      kind: 'degraded',
      title: tr('OCR is on, but the model files are missing', 'OCR 已开启，但模型文件缺失'),
      fields,
      steps: [
        tr('Run `persome ocr setup` again in a terminal, or reinstall Runtime.', '在终端重新运行 `persome ocr setup`，或重新安装 Runtime。'),
        restartStep(),
        verifyStep()
      ],
      wechatWarning: wechatDegraded(),
      canRestart: true,
      commands: [CMD_SETUP, CMD_RESTART]
    }
  }
  if (state === 'runtime_unavailable') {
    return {
      kind: 'degraded',
      title: tr('Local OCR is not available on this Mac (Runtime reports runtime_unavailable)', '这台 Mac 上本地 OCR 不可用（Runtime 报告 runtime_unavailable）'),
      fields,
      steps: [
        tr(
          'Run `persome ocr status --check` to see why. Accessibility capture is unaffected, but apps like WeChat have no text.',
          '运行 `persome ocr status --check` 查看原因。辅助功能采集不受影响，但微信这类应用没有文字。'
        )
      ],
      wechatWarning: wechatDegraded(),
      canRestart: false,
      commands: [CMD_CHECK]
    }
  }
  if (runtime.worker === 'failed') {
    return {
      kind: 'degraded',
      title: tr('OCR is on, but the OCR worker failed to start', 'OCR 已开启，但 OCR worker 启动失败'),
      fields,
      steps: [
        tr('Run `persome ocr status --check` in a terminal to see why it failed.', '在终端运行 `persome ocr status --check` 查看失败原因。'),
        restartStep(),
        verifyStep()
      ],
      wechatWarning: wechatDegraded(),
      canRestart: true,
      commands: [CMD_CHECK, CMD_RESTART]
    }
  }
  if (runtime.worker === 'warming') {
    return {
      kind: 'degraded',
      title: tr('OCR worker is warming up', 'OCR worker 正在预热'),
      fields,
      steps: [tr('Wait a few tens of seconds, then refresh.', '等几十秒后刷新。')],
      wechatWarning: wechatDegraded(), canRestart: false, commands: [] }
  }
  if (state === 'ready') {
    return { kind: 'on', title: tr(`OCR on · tier ${tier}`, `OCR 已开启 · 档位 ${tier}`), fields, steps: [], wechatWarning: null, canRestart: false, commands: [] }
  }
  return {
    kind: 'unknown',
    title: tr(`OCR status unknown (Runtime reports ${state ?? 'empty'})`, `OCR 状态未知（Runtime 报告 ${state ?? '空'}）`),
    fields,
    steps: [tr('Run `persome ocr status --check` in a terminal for details.', '在终端运行 `persome ocr status --check` 查看详情。')],
    wechatWarning: wechatUnknown(),
    canRestart: false,
    commands: [CMD_CHECK]
  }
}
