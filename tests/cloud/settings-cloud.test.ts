// B16: Settings → 云端. Static renders of the view + the controller against a mock bridge.
// No network, no real cloud: the bridge is a vi.fn() mock; delete confirm lives in main (native dialog).
import fs from 'node:fs'
import path from 'node:path'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { CloudStatus } from '../../src/main/cloud/api'
import { CloudSettingsView } from '../../src/renderer/src/components/settings/CloudSettingsSection'
import {
  accountFingerprint,
  cloudErrorText,
  cloudSettingsState,
  createCloudSettingsController,
  redactCloudText,
  type CloudBridge
} from '../../src/renderer/src/components/settings/cloudSettingsView'

;(globalThis as { React?: typeof React }).React = React

describe('Settings → Cloud (English default)', () => {
  it('renders English labels and messages', async () => {
    setLocale('en')
    const out = html(NEVER)
    expect(out).toContain('Never configured (off by default)')
    expect(out).toContain('Turn on Cloud…')
    expect(html(SIGNED_IN)).toContain('Delete cloud account…')
    expect(redactCloudText('Bearer abcdefghijkl alice@example.com')).toBe('Bearer [hidden] [email hidden]')
    expect(cloudErrorText(new Error('x'))).toBe('Operation failed. Please try again later')
    const c = createCloudSettingsController(bridge())
    expect((await c.signOut()).message).toBe('Signed out, and the server session was signed out')
  })
})

// The remaining suites pin the original Chinese copy.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FP = 'a1b2c3d4' + '0'.repeat(48) + 'e5f6a7b8'
const NEVER: CloudStatus = { enabled: false, baseUrl: null, signedIn: false, accountId: null, expiresAt: null }
const OFF: CloudStatus = { ...NEVER, baseUrl: 'https://cloud.example.com' }
const SIGNED_OUT: CloudStatus = { ...OFF, enabled: true }
const SIGNED_IN: CloudStatus = { ...SIGNED_OUT, signedIn: true, accountId: FP, expiresAt: '2026-12-01T00:00:00.000Z' }

const html = (status: CloudStatus | null, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(CloudSettingsView, { status, ...extra }))

function bridge(over: Partial<CloudBridge> = {}): CloudBridge {
  return {
    status: vi.fn(async () => ({ ok: true as const, data: SIGNED_IN })),
    configure: vi.fn(async () => ({ ok: true as const, data: { ...NEVER, remoteRevoked: false } })),
    signIn: vi.fn(async () => ({ ok: true as const, data: SIGNED_IN })),
    signOut: vi.fn(async () => ({ ok: true as const, data: { ...SIGNED_OUT, remoteRevoked: true } })),
    deleteAccount: vi.fn(async () => ({ ok: true as const, data: SIGNED_OUT })),
    ...over
  }
}

describe('Settings → 云端: states', () => {
  it('empty state (never configured): OFF by default, no server, no fingerprint, no delete/sign-out', () => {
    expect(cloudSettingsState(NEVER)).toBe('never')
    const out = html(NEVER)
    expect(out).toContain('data-state="never"')
    expect(out).toContain('从未配置（默认关闭）')
    expect(out).toContain('未设置')
    expect(out).toContain('开启云端…')
    expect(out).not.toContain('settings-cloud-delete')
    expect(out).not.toContain('settings-cloud-signout')
    expect(out).toMatch(/data-testid="settings-cloud-fingerprint">—</)
    // every feature shows as off
    expect(out.match(/可用（主动使用时才联网）/g)).toBeNull()
  })

  it('configured but OFF keeps the server address and stays off', () => {
    expect(cloudSettingsState(OFF)).toBe('off')
    const out = html(OFF, { url: OFF.baseUrl })
    expect(out).toContain('已关闭')
    expect(out).toContain('https://cloud.example.com')
    expect(out).not.toContain('settings-cloud-delete')
  })

  it('enabled but not logged in: sign-in + disable, no delete, no fingerprint', () => {
    expect(cloudSettingsState(SIGNED_OUT)).toBe('signed_out')
    const out = html(SIGNED_OUT)
    expect(out).toContain('已开启，未登录')
    expect(out).toContain('用本机身份登录')
    expect(out).toContain('关闭云端')
    expect(out).not.toContain('settings-cloud-delete')
    expect(out).not.toContain('a1b2c3d4')
  })

  it('logged in: server, short fingerprint (never the full id), sign out, delete', () => {
    expect(cloudSettingsState(SIGNED_IN)).toBe('signed_in')
    const out = html(SIGNED_IN)
    expect(out).toContain('已登录')
    expect(out).toContain('https://cloud.example.com')
    expect(out).toContain('a1b2c3d4…e5f6a7b8')
    expect(out).not.toContain(FP)
    expect(out).toContain('退出登录')
    expect(out).toContain('删除云账号…')
    expect(out.match(/可用（主动使用时才联网）/g)?.length).toBe(5)
  })

  it('fingerprint never shows a raw non-hash account id (e.g. an email)', () => {
    const fp = accountFingerprint('alice@example.com')
    expect(fp).toMatch(/^#[0-9a-f]{8}$/)
    const out = html({ ...SIGNED_IN, accountId: 'alice@example.com' })
    expect(out).not.toContain('alice')
    expect(out).not.toContain('@')
    expect(accountFingerprint(null)).toBeNull()
  })

  it('source uses the existing IPC with confirm:true and no window.confirm', () => {
    const src = ['CloudSettingsSection.tsx', 'cloudSettingsView.ts']
      .map((f) => fs.readFileSync(path.resolve('src/renderer/src/components/settings', f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).toMatch(/bridge\.deleteAccount\(\{ confirm: true \}\)/)
    expect(src).not.toMatch(/window\.confirm|\bconfirm\(\s*['"`]/)
    expect(src).not.toMatch(/ipcRenderer|fetch\(/)
    const settings = fs.readFileSync(path.resolve('src/renderer/src/pages/Settings.tsx'), 'utf8')
    expect(settings).toContain('<CloudSettingsSection />')
  })
})

describe('Settings → 云端: delete account confirm', () => {
  it('confirmed in the native dialog: deleteAccount({confirm:true}) once, status becomes signed out', async () => {
    const b = bridge()
    const r = await createCloudSettingsController(b).deleteAccount()
    expect(b.deleteAccount).toHaveBeenCalledTimes(1)
    expect(b.deleteAccount).toHaveBeenCalledWith({ confirm: true })
    expect(r).toMatchObject({ ok: true, status: { signedIn: false } })
    expect(r.message).toContain('已从服务器删除')
  })

  it('cancelled in the native dialog: main returns `cancelled`, nothing changes, no error banner', async () => {
    const b = bridge({ deleteAccount: vi.fn(async () => ({ ok: false as const, error: { code: 'cancelled' as const, message: '已取消' } })) })
    const r = await createCloudSettingsController(b).deleteAccount()
    expect(r.ok).toBe(false)
    expect(r.status).toBeNull()
    expect(r.message).toBe('已取消，未做任何更改')
    const out = html(SIGNED_IN, { message: { ok: true, text: r.message } })
    expect(out).toContain('删除云账号…') // still signed in
  })

  it('sign out uses the existing handler', async () => {
    const b = bridge()
    const r = await createCloudSettingsController(b).signOut()
    expect(b.signOut).toHaveBeenCalledTimes(1)
    expect(r.status?.signedIn).toBe(false)
    expect(r.message).toContain('服务器端会话已注销')
  })
})

describe('Settings → 云端: error redaction', () => {
  const SECRETS = [
    'tok_abcdefghijklmnop',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'alice@example.com',
    'https://cloud.example.com/v1/x?token=s3cr3t&sig=zzz',
    'api_key=sk_live_1234567890',
    'A'.repeat(43)
  ]

  it('redactCloudText strips tokens, keys, emails and URL query strings', () => {
    const out = redactCloudText(`failed: ${SECRETS.join(' | ')}`)
    for (const s of ['tok_abcdefghijklmnop', 'eyJhbGciOiJIUzI1NiJ9', 'alice@example.com', 'token=s3cr3t', 's3cr3t', 'sig=zzz', 'sk_live_1234567890', 'A'.repeat(43)]) {
      expect(out).not.toContain(s)
    }
    expect(out).toContain('https://cloud.example.com/v1/x?[已隐藏]')
    expect(out).toContain('[邮箱已隐藏]')
  })

  it('IPC error results are redacted before display', async () => {
    const message = `服务器错误 ${SECRETS.join(' ')}`
    const b = bridge({ deleteAccount: vi.fn(async () => ({ ok: false as const, error: { code: 'server' as const, message } })) })
    const r = await createCloudSettingsController(b).deleteAccount()
    const out = html(SIGNED_IN, { message: { ok: r.ok, text: r.message } })
    expect(out).toContain('role="alert"')
    for (const s of ['tok_abcdefghijklmnop', 'eyJhbGciOiJIUzI1NiJ9', 'alice@example.com', 's3cr3t', 'sk_live', 'A'.repeat(43)]) expect(out).not.toContain(s)
  })

  it('a thrown IPC error never forwards its text', async () => {
    const b = bridge({ signOut: vi.fn(async () => Promise.reject(new Error('ENOENT /Users/x/tok_abcdefghijklmnop'))) })
    const r = await createCloudSettingsController(b).signOut()
    expect(r).toEqual({ ok: false, status: null, message: '操作失败，请稍后再试' })
    expect(cloudErrorText('raw string tok_abcdefgh')).toBe('操作失败，请稍后再试')
  })

  it('unauthorized adds the re-login hint', () => {
    expect(cloudErrorText({ code: 'unauthorized', message: '未登录或登录已过期' })).toBe('未登录或登录已过期。请重新登录云端。')
  })
})
