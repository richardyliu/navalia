import { createRewindReader, MAGIC, RewindReaderError } from '../broker/rewind'
import type { LensErrorCode } from '../../shared/types'
import { REWIND_VIEW_MAX_BYTES, type RewindListQuery, type RewindListResult, type RewindViewResult } from './api'
import { tr } from '../../shared/i18n'

/**
 * OG-05 Rewind service (main process only). Reuses the Broker's capture-buffer reader and
 * AES-256-GCM envelope decryption (src/main/broker/rewind.ts); nothing is duplicated here.
 *
 * Invariants:
 * - The key is read through the injected `screenshotKey()` per call and only handed to the reader.
 *   It is never returned, logged, or included in an error message.
 * - Decrypted bytes live only in memory and leave main only as one display-only data URL.
 *   Nothing is written to disk.
 * - No key => BLOCKED ("缺少截图密钥"), even for a frame stored unencrypted. Unencrypted frames are
 *   refused ("plaintext_refused") rather than shown: CAP-03 says screenshots are sealed at rest.
 */

export class RewindError extends Error {
  constructor(
    readonly code: LensErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RewindError'
  }
}

export interface RewindServiceDeps {
  /** Runtime root (`locate().root`); capture-buffer lives at `<root>/capture-buffer`. */
  runtimeRoot: () => string
  /** PERSOME_SCREENSHOT_KEY (32 bytes) or null. Main only. */
  screenshotKey: () => Buffer | null
  maxViewBytes?: number
  /** Capture files examined per `list` call (default SCAN_BUDGET); tests lower it. */
  scanBudget?: number
}

export interface RewindService {
  list(q: RewindListQuery): Promise<RewindListResult>
  view(fileStem: string): Promise<RewindViewResult>
}

export function missingKeyMessage(): string {
  return tr('Screenshot key missing', '缺少截图密钥')
}

/** Map reader errors (which may embed fs paths) to fixed, sanitized messages. */
export function sanitizeRewindError(error: unknown): RewindError {
  if (error instanceof RewindError) return error
  const msg = error instanceof Error ? error.message : ''
  if (/invalid file_stem/.test(msg)) return new RewindError('schema', tr('Invalid frame id', '帧标识不合法'))
  if (/invalid cursor/.test(msg)) return new RewindError('schema', tr('Invalid page cursor', '分页游标不合法'))
  if (/since\/until/.test(msg)) return new RewindError('schema', tr('Invalid time range', '时间范围不合法'))
  if (/decrypt failed|PSOMEGCM1|envelope too short/.test(msg)) return new RewindError('unknown', tr('Screenshot decryption failed (key mismatch or tampered data)', '截图解密失败（密钥不匹配或数据被篡改）'))
  if (/ENOENT/.test(msg)) return new RewindError('not_found', tr("This frame doesn't exist (it may have been deleted by the retention period)", '该帧不存在（可能已按保留期删除）'))
  if (/too large/.test(msg)) return new RewindError('unknown', tr('Screenshot too large to display', '截图过大，无法显示'))
  if (/payload is empty/.test(msg)) return new RewindError('unknown', tr('Screenshot data is empty', '截图数据为空'))
  if (error instanceof SyntaxError) return new RewindError('schema', tr("Frame file is corrupt and can't be parsed", '帧文件损坏，无法解析'))
  return new RewindError('unknown', tr('Failed to read the Rewind frame', '读取 Rewind 帧失败'))
}

const plaintextRefused = (): RewindViewResult => ({
  status: 'unavailable',
  reason: 'plaintext_refused',
  message: tr(
    `This frame's screenshot is not encrypted (no ${MAGIC.slice(0, -1)} envelope); refused per CAP-03.`,
    `该帧截图未加密（缺少 ${MAGIC.slice(0, -1)} 封装），按 CAP-03 拒绝显示。`
  )
})

export function createRewindService(deps: RewindServiceDeps): RewindService {
  const maxView = deps.maxViewBytes ?? REWIND_VIEW_MAX_BYTES
  const keyAvailable = (): boolean => {
    try {
      return deps.screenshotKey() !== null
    } catch {
      return false
    }
  }

  return {
    async list(q) {
      const reader = createRewindReader({ root: deps.runtimeRoot, screenshotKey: () => null, scanBudget: deps.scanBudget })
      try {
        const r = await reader.frames({
          since: q.since,
          until: q.until,
          app_name: q.appName,
          limit: q.limit,
          cursor: q.cursor,
          order: 'desc'
        })
        return {
          // Metadata only: visible text is deliberately not forwarded.
          frames: r.frames.map((f) => ({
            fileStem: f.file_stem,
            timestamp: f.timestamp,
            appName: f.app_name,
            bundleId: f.bundle_id,
            windowTitle: f.window_title,
            url: f.url,
            hasScreenshot: f.has_screenshot
          })),
          nextCursor: r.next_cursor,
          partial: r.partial,
          scanned: r.scanned,
          keyAvailable: keyAvailable()
        }
      } catch (error) {
        throw sanitizeRewindError(error)
      }
    },

    async view(fileStem) {
      let key: Buffer | null
      try {
        key = deps.screenshotKey()
      } catch {
        key = null
      }
      if (!key) return { status: 'blocked', reason: 'missing_key', message: tr(
            `${missingKeyMessage()}: the Runtime env has no usable PERSOME_SCREENSHOT_KEY, so screenshots can't be decrypted.`,
            `${missingKeyMessage()}：Runtime env 中没有可用的 PERSOME_SCREENSHOT_KEY，截图无法解密。`
          )
        }
      const k = key
      const reader = createRewindReader({ root: deps.runtimeRoot, screenshotKey: () => k })
      try {
        const shot = await reader.screenshot(fileStem)
        if (!shot.encrypted) {
          // Defense in depth: the reader already refuses plaintext frames.
          shot.data.fill(0)
          return plaintextRefused()
        }
        if (shot.data.length > maxView) {
          const n = shot.data.length
          shot.data.fill(0)
          return { status: 'unavailable', reason: 'too_large', message: tr(
              `Screenshot is ${(n / 1024 / 1024).toFixed(1)} MiB, over the ${(maxView / 1024 / 1024).toFixed(0)} MiB display limit.`,
              `截图 ${(n / 1024 / 1024).toFixed(1)} MiB，超过显示上限 ${(maxView / 1024 / 1024).toFixed(0)} MiB。`
            )
          }
        }
        if (!/^image\/(jpeg|png|webp)$/.test(shot.mime)) {
          shot.data.fill(0)
          return { status: 'unavailable', reason: 'unsupported_format', message: tr('Unrecognized screenshot format; refused.', '截图格式无法识别，拒绝显示。') }
        }
        const dataUrl = `data:${shot.mime};base64,${shot.data.toString('base64')}`
        const bytes = shot.data.length
        shot.data.fill(0)
        return { status: 'ok', fileStem: shot.file_stem, mime: shot.mime, dataUrl, bytes, width: shot.width, height: shot.height }
      } catch (error) {
        if (error instanceof RewindReaderError && error.code === 'plaintext_refused') return plaintextRefused()
        if (error instanceof Error && /no screenshot/.test(error.message)) {
          return { status: 'unavailable', reason: 'no_screenshot', message: tr(
              'This frame has no screenshot (not captured, or stripped after the screenshot retention period).',
              '该帧没有截图（未采集，或已超过截图保留期被剥离）。'
            )
          }
        }
        throw sanitizeRewindError(error)
      }
    }
  }
}
