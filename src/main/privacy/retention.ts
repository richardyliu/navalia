import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRuntimeCaptureConfig } from '../capture/pipeline'
import type { RetentionValue, RetentionView } from './api'
import { tr } from '../../shared/i18n'

/**
 * PRIV-02 retention, read-only. The authoritative source is the Runtime's own
 * `<runtime root>/config.toml` `[capture]` section; keys it omits fall back to the OSS
 * `CaptureConfig` defaults (personal-model src/persome/config.py: 168 h / 24 h).
 * Lens never writes config.toml (the Runtime owns it) and the Runtime exposes no REST or CLI
 * setter (`persome config` only prints), so the view is always `editable: false`.
 */

export const RETENTION_DEFAULTS = { buffer_retention_hours: 168, screenshot_retention_hours: 24 } as const

const LABELS: Record<RetentionValue['key'], string> = {
  get buffer_retention_hours() {
    return tr('Raw frame retention', '原始帧保留')
  },
  get screenshot_retention_hours() {
    return tr('Screenshot retention', '截图保留')
  }
}

function tildify(p: string, home: string): string {
  return home && home !== '/' && p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

export function formatHours(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) return tr(`${hours} hours (${hours / 24} days)`, `${hours} 小时（${hours / 24} 天）`)
  return tr(`${hours} hours`, `${hours} 小时`)
}

export function readRetention(runtimeRoot: string, homeDir: string = os.homedir()): RetentionView {
  const file = path.join(runtimeRoot, 'config.toml')
  let configState: RetentionView['configState'] = 'ok'
  try {
    fs.accessSync(file, fs.constants.R_OK)
  } catch (error) {
    configState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  const configured = configState === 'ok' ? readRuntimeCaptureConfig(runtimeRoot) : {}

  const values: RetentionValue[] = (Object.keys(RETENTION_DEFAULTS) as Array<RetentionValue['key']>).map((key) => {
    const raw = configured[key]
    if (raw === undefined) {
      const hours = RETENTION_DEFAULTS[key]
      return { key, label: LABELS[key], hours, origin: 'default', display: tr(`${formatHours(hours)} · Runtime default`, `${formatHours(hours)} · Runtime 默认值`) }
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return { key, label: LABELS[key], hours: null, origin: 'invalid', display: tr('The configured value is not a non-negative integer (Runtime may refuse to start)', '配置值不是非负整数（Runtime 可能拒绝启动）') }
    }
    return { key, label: LABELS[key], hours: raw, origin: 'config', display: tr(`${formatHours(raw)} · from config.toml`, `${formatHours(raw)} · 来自 config.toml`) }
  })

  const shownPath = tildify(file, homeDir)
  return {
    configPath: shownPath,
    configState,
    values,
    editable: false,
    howToChange: [
      tr(
        'Runtime offers no REST or CLI interface to change retention (`persome config` only prints the config), and Navalia never rewrites the Runtime config.toml, so this is read-only.',
        'Runtime 没有提供修改保留期的 REST 或 CLI 接口（`persome config` 只打印配置），Navalia 也不改写 Runtime 的 config.toml，所以这里只读。'
      ),
      tr(
        `Open ${shownPath} in an editor and set the values in the [capture] section, e.g. buffer_retention_hours = 168 / screenshot_retention_hours = 24 (hours, integer).`,
        `在编辑器里打开 ${shownPath}，在 [capture] 段落里设置，例如：buffer_retention_hours = 168 / screenshot_retention_hours = 24（单位小时，整数）。`
      ),
      tr(
        'After saving, run persome stop and then persome start in a terminal (or restart Runtime on the Recovery page) for the new values to take effect.',
        '保存后在终端执行 persome stop，再执行 persome start（或在「恢复」页重启 Runtime），新值才生效。'
      )
    ],
    notes: [
      tr(
        'Runtime only deletes raw frames that the timeline has absorbed and that are older than the retention period; frames not yet absorbed are kept until they are.',
        'Runtime 只删除已被时间线吸收、且早于保留期的原始帧；尚未吸收的帧会保留到吸收之后。'
      ),
      tr(
        'Screenshots are stripped after the screenshot retention period; the text in a frame is kept until the raw frame retention period.',
        '截图在截图保留期之后被剥离，帧里的文字保留到原始帧保留期。'
      ),
      tr(
        'If extended_retention_enabled is on in [capture], screenshots of frames with user input are kept longer (actionable_retention_days).',
        '若 [capture] 打开了 extended_retention_enabled，带用户输入的帧的截图会保留更久（actionable_retention_days）。'
      )
    ]
  }
}
