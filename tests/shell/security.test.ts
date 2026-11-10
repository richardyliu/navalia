import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const opened: string[] = []

vi.mock('electron', () => ({
  app: { isPackaged: false, commandLine: { hasSwitch: () => false }, exit: () => undefined },
  net: { fetch: async () => new Response('') },
  protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  shell: { openExternal: async (url: string) => void opened.push(url) }
}))

const security = await import('../../src/main/security')
const appUrl = 'app://lens/index.html'

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
  opened.length = 0
})

describe('isAppUrl', () => {
  test('accepts only the app:// renderer origin', () => {
    expect(security.isAppUrl(appUrl)).toBe(true)
    expect(security.isAppUrl('app://lens/assets/x.js')).toBe(true)
    expect(security.isAppUrl('app://evil/index.html')).toBe(false)
    expect(security.isAppUrl(`${appUrl}#/card`)).toBe(true)
    expect(security.isAppUrl('file:///Users/someone/Downloads/evil.html')).toBe(false)
    expect(security.isAppUrl('https://example.com/')).toBe(false)
    expect(security.isAppUrl('')).toBe(false)
  })

  test('dev: same origin as ELECTRON_RENDERER_URL only', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(security.isAppUrl('http://localhost:5173/index.html')).toBe(true)
    expect(security.isAppUrl('http://localhost:5174/')).toBe(false)
    expect(security.isAppUrl('file:///tmp/x.html')).toBe(false)
  })
})

describe('installIpcSenderGuard', () => {
  test('rejects untrusted frames and subframes, passes the app frame', async () => {
    security.installIpcSenderGuard()
    const { ipcMain } = await import('electron')
    ipcMain.handle('t:ping', () => 'pong')
    const h = handlers.get('t:ping')!
    expect(h({ senderFrame: { url: appUrl, parent: null } })).toBe('pong')
    expect(() => h({ senderFrame: { url: 'file:///tmp/evil.html', parent: null } })).toThrow(/sender is not the app/)
    expect(() => h({ senderFrame: { url: appUrl, parent: {} } })).toThrow(/sender is not the app/)
    expect(() => h({ senderFrame: null })).toThrow(/sender is not the app/)
  })
})

describe('safeOpenExternal', () => {
  test('https without credentials only', () => {
    security.safeOpenExternal('https://github.com/x')
    security.safeOpenExternal('http://example.com')
    security.safeOpenExternal('https://user:pw@example.com')
    security.safeOpenExternal('file:///etc/passwd')
    security.safeOpenExternal('javascript:alert(1)')
    expect(opened).toEqual(['https://github.com/x'])
  })
})

describe('resolveAppPath', () => {
  const root = path.join('/opt', 'app', 'renderer')
  test('maps app://lens paths inside the renderer root only', () => {
    expect(security.resolveAppPath('app://lens/index.html', root)).toBe(path.join(root, 'index.html'))
    expect(security.resolveAppPath('app://lens/assets/a.js', root)).toBe(path.join(root, 'assets/a.js'))
    // WHATWG URL normalizes literal '..' away, so this stays inside the root.
    expect(security.resolveAppPath('app://lens/../main/index.js', root)).toBe(path.join(root, 'main/index.js'))
    // %2e%2e is also a dot segment for the URL parser: normalized, still inside the root.
    expect(security.resolveAppPath('app://lens/%2e%2e/%2e%2e/etc/passwd', root)).toBe(path.join(root, 'etc/passwd'))
    // Encoded slashes survive parsing and decode into a real escape: refused.
    expect(security.resolveAppPath('app://lens/..%2fmain%2findex.js', root)).toBeNull()
    expect(security.resolveAppPath('app://other/index.html', root)).toBeNull()
    expect(security.resolveAppPath('file:///etc/passwd', root)).toBeNull()
    expect(security.resolveAppPath('app://lens/%E0%A4%A', root)).toBeNull()
  })
})

describe('stripTestOverridesWhenPackaged', () => {
  test('removes test-only overrides only in packaged builds', () => {
    const env: NodeJS.ProcessEnv = { NAVALIA_NATIVE: '/tmp/evil.node', LENS_AGENT_HOME: '/tmp/a', LENS_HET_CLAUDE_ROOT: '/tmp/b', LENS_BROKER_PORT: '0', LENS_STORE_ROOT: '/tmp/s', PERSOME_ROOT: '/tmp/p' }
    security.stripTestOverridesWhenPackaged(env, false)
    expect(env.LENS_AGENT_HOME).toBe('/tmp/a')
    security.stripTestOverridesWhenPackaged(env, true)
    expect(env).toEqual({ LENS_STORE_ROOT: '/tmp/s', PERSOME_ROOT: '/tmp/p' })
  })
})
