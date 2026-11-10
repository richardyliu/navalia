import type { UpdateCheckResult } from './api'
import { tr } from '../../shared/i18n'

/**
 * OG-D4 (DECISIONS-OG.md): updates are check + notify only, and even that is BLOCKED because
 * there is no release feed (`RELEASES.json`) and no Developer ID signature to verify against
 * (OG-D3). This module therefore performs NO network request of any kind and schedules no
 * polling: it only reports the current version and why checking is blocked.
 * tests/privacy/updates.test.ts statically asserts this file imports no network module.
 */

export function updateBlockedReasons(): string[] {
  return [
    tr(
      'No release feed: there is no RELEASES.json (the original 6-hour polling feed), so Navalia does not know where to check.',
      '无发布源：没有 RELEASES.json（原版的 6 小时轮询源），Navalia 不知道去哪里检查。'
    ),
    tr(
      'Unsigned: the build is ad-hoc signed (no Apple Developer ID, OG-D3 BLOCKED), so downloads cannot be verified.',
      '未签名：构建是 ad-hoc 签名（无 Apple Developer ID，OG-D3 BLOCKED），无法校验下载内容。'
    ),
    tr(
      'Per OG-D4: check and notify only, never download or install; until a release feed exists, no network request is made and nothing is polled.',
      '按 OG-D4：只检查、只通知，不下载、不安装；在有发布源之前不发任何网络请求，也不轮询。'
    )
  ]
}

export function checkForUpdates(currentVersion: () => string | null): UpdateCheckResult {
  let version: string | null = null
  try {
    version = currentVersion()
  } catch {
    version = null
  }
  return {
    status: 'blocked',
    currentVersion: version,
    reasons: updateBlockedReasons(),
    networkRequested: false,
    decision: 'OG-D4'
  }
}
