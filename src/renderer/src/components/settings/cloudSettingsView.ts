// B16: pure view helpers + controller for Settings → 云端. No React, no IPC import: the controller
// takes the `window.lens.cloud` bridge as an argument so tests can drive it with a mock.
//
// Boundary: deleting the account goes through the existing `lens:cloud:delete-account` handler,
// which shows a main-owned native dialog (security.ts nativeConfirm → dialog.showMessageBox) before
// DELETE /v1/account. The renderer never uses window.confirm and never sees the token.
// Cloud stays OFF by default: nothing here enables it; "开启" still needs the native confirm in main.
import type { CloudApi, CloudStatus } from '../../../../main/cloud/api'
import { tr } from '../../../../shared/i18n'

export type CloudBridge = CloudApi['cloud']

export type CloudSettingsState = 'loading' | 'never' | 'off' | 'signed_out' | 'signed_in'

/** `never` = no server ever configured (cloud.json missing / default). */
export function cloudSettingsState(status: CloudStatus | null | undefined): CloudSettingsState {
  if (!status) return 'loading'
  if (!status.enabled) return status.baseUrl ? 'off' : 'never'
  return status.signedIn ? 'signed_in' : 'signed_out'
}

export const CLOUD_STATE_LABEL = {
  get loading() {
    return tr('Loading…', '读取中…')
  },
  get never() {
    return tr('Never configured (off by default)', '从未配置（默认关闭）')
  },
  get off() {
    return tr('Off', '已关闭')
  },
  get signed_out() {
    return tr('On, not signed in', '已开启，未登录')
  },
  get signed_in() {
    return tr('Signed in', '已登录')
  }
} satisfies Record<CloudSettingsState, string>

/**
 * Short, non-reversible label for the account. The account id is the identity fingerprint
 * (sha256 hex): shown as head…tail. Anything else (unexpected server value, could be an email)
 * is never shown raw: it is reduced to an 8-hex FNV-1a digest.
 */
export function accountFingerprint(accountId: string | null | undefined): string | null {
  if (!accountId) return null
  if (/^[0-9a-f]{64}$/.test(accountId)) return `${accountId.slice(0, 8)}…${accountId.slice(-8)}`
  let h = 0x811c9dc5
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `#${h.toString(16).padStart(8, '0')}`
}

/** Origin only (main already normalizes to `https://host[:port]`); strips anything after it defensively. */
export function serverLabel(baseUrl: string | null | undefined): string {
  if (!baseUrl) return tr('Not set', '未设置')
  try {
    return new URL(baseUrl).origin
  } catch {
    return redactCloudText(baseUrl)
  }
}

/**
 * Defense in depth for any text shown to the user: main already sends fixed per-code messages,
 * but nothing token-, key-, email- or query-string-like may ever reach the page.
 */
export function redactCloudText(text: string): string {
  const hidden = tr('[hidden]', '[已隐藏]')
  return (
    text
      // URL query strings / fragments (keep the origin + path)
      .replace(/(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, `$1?${hidden}`)
      // Authorization headers / bearer tokens
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${hidden}`)
      // key=value style secrets
      .replace(/\b(token|access_token|refresh_token|api[_-]?key|key|secret|password|signature|sig)\s*[=:]\s*[^\s&,;"']+/gi, `$1=${hidden}`)
      // emails
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, tr('[email hidden]', '[邮箱已隐藏]'))
      // known token prefixes and long opaque strings (hex / base64url / JWT-like)
      .replace(/\b(tok|sk|pk|key)_[A-Za-z0-9_-]{6,}/gi, hidden)
      .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, hidden)
      .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, hidden)
  )
}

const ERROR_HINT: Partial<Record<string, string>> = {
  get disabled() {
    return tr('Cloud is off.', '云端未开启。')
  },
  get unauthorized() {
    return tr('Please sign in to Cloud again.', '请重新登录云端。')
  },
  get cancelled() {
    return tr('Cancelled.', '已取消。')
  },
  get network() {
    return tr('Cannot connect to the server.', '无法连接服务器。')
  },
  get timeout() {
    return tr('Connecting to the server timed out.', '连接服务器超时。')
  }
}

export function cloudErrorText(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const e = error as { code?: unknown; message?: unknown }
    const code = typeof e.code === 'string' ? e.code : 'unknown'
    const message = typeof e.message === 'string' && e.message ? e.message : tr('Operation failed', '操作失败')
    const hint = ERROR_HINT[code]
    const text = hint && !message.includes(hint) ? tr(`${message}. ${hint}`, `${message}。${hint}`) : message
    return redactCloudText(text)
  }
  // Thrown IPC errors may carry anything (paths, bodies): never forward their text.
  return tr('Operation failed. Please try again later', '操作失败，请稍后再试')
}

/** Cloud features that use the shared connection. There are no per-feature switches: each one only
 * talks to the server when the user acts on its page, and all of them stop when cloud is OFF. */
export const CLOUD_FEATURES: ReadonlyArray<{ id: string; label: string; note: string }> = [
  {
    id: 'chat',
    label: 'Navalia Chat',
    get note() {
      return tr('Preview the context before sending', '发送前先预览上下文')
    }
  },
  {
    id: 'cards',
    get label() {
      return tr('Cloud card', '云端名片')
    },
    get note() {
      return tr('Publish / withdraw yourself', '主动发布 / 撤回')
    }
  },
  {
    id: 'subs',
    get label() {
      return tr('Subscriptions / weekly letter', '订阅 / 周信')
    },
    get note() {
      return tr('You publish it yourself', '主动发布')
    }
  },
  {
    id: 'meetings',
    get label() {
      return tr('Meetings', '会议记录')
    },
    get note() {
      return tr('Records only after participants are told', '需要告知参会者后才录音')
    }
  },
  {
    id: 'moments',
    get label() {
      return tr('Shared moments', '共同经历')
    },
    get note() {
      return tr('Exchanged only with friends', '只和好友交换')
    }
  }
]

export interface CloudActionResult {
  status: CloudStatus | null
  message: string
  ok: boolean
}

/** Every action returns a redacted message; it never throws. */
export function createCloudSettingsController(bridge: CloudBridge) {
  async function call<T extends CloudStatus>(
    fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }>,
    done: (d: T) => string
  ): Promise<CloudActionResult> {
    try {
      const r = await fn()
      if (r.ok) return { ok: true, status: r.data, message: done(r.data) }
      // `cancelled` from the native dialog is a normal outcome, not an error banner.
      return { ok: false, status: null, message: r.error.code === 'cancelled' ? tr('Cancelled, nothing was changed', '已取消，未做任何更改') : cloudErrorText(r.error) }
    } catch (e) {
      return { ok: false, status: null, message: cloudErrorText(e) }
    }
  }
  return {
    async load(): Promise<CloudActionResult> {
      return call(() => bridge.status(), () => '')
    },
    enable(baseUrl: string): Promise<CloudActionResult> {
      return call(() => bridge.configure({ enabled: true, baseUrl: baseUrl.trim(), confirm: true }), () => tr('Cloud is on (it goes online only when you use a cloud feature)', '已开启云端（仅在你主动使用云端功能时联网）'))
    },
    disable(baseUrl: string | null): Promise<CloudActionResult> {
      return call(
        () => bridge.configure({ enabled: false, baseUrl }),
        (d) => (d.remoteRevoked ? tr('Cloud is off and the server session was signed out', '已关闭云端，服务器端会话已注销') : tr('Cloud is off and stays offline', '已关闭云端，不再联网'))
      )
    },
    signIn(): Promise<CloudActionResult> {
      return call(() => bridge.signIn(), () => tr('Signed in', '已登录'))
    },
    signOut(): Promise<CloudActionResult> {
      return call(
        () => bridge.signOut(),
        (d) =>
          d.remoteRevoked
            ? tr('Signed out, and the server session was signed out', '已退出，服务器端会话已注销')
            : tr('Signed out on this Mac; the server session was not confirmed as signed out (it expires on its own)', '已在本机退出；服务器端会话未确认注销（到期后失效）')
      )
    },
    /** Main shows the native confirm; the renderer only passes the literal `confirm: true`. */
    deleteAccount(): Promise<CloudActionResult> {
      return call(() => bridge.deleteAccount({ confirm: true }), () => tr('Your cloud account and its data were deleted from the server; data on this Mac is not affected', '云端账号及其数据已从服务器删除；本机数据不受影响'))
    }
  }
}
