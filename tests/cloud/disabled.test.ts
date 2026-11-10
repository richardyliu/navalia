// Local-only mode (the default) makes zero network calls: every client / service / IPC entry point
// throws `disabled` before fetch. Plus a static scan that only client.ts may call fetch.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CLOUD_CHANNELS } from '../../src/main/cloud/api'
import { CHAT_CHANNELS } from '../../src/main/cloud/chat-api'
import { CLOUD_CARDS_CHANNELS, SUBS_CHANNELS } from '../../src/main/cloud/subs-api'
import { MEETINGS_CHANNELS } from '../../src/main/cloud/meetings-api'
import { MOMENTS_CHANNELS } from '../../src/main/cloud/moments-api'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { registerCloudIpc } from '../../src/main/cloud/ipc'
import { createCloudService } from '../../src/main/cloud/service'
import { fakeBox, fakeIpc, tempStore, testIdentity } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p)
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? 'no-code'
  }
}

async function drain(it: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of it) {
    /* nothing */
  }
}

describe('cloud: disabled ⇒ zero fetch', () => {
  it.each([
    ['no config file', null],
    ['configured server but OFF', { enabled: false, baseUrl: 'https://cloud.example.com' }]
  ] as const)('%s: every method throws disabled and global fetch is never called', async (_n, cfg) => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    const root = tempStore(roots)
    if (cfg) writeCloudConfig(cloudPaths(root).configFile, cfg)
    const id = testIdentity()
    const sign = vi.fn(id.sign)
    const confirm = vi.fn(async () => true)
    const svc = createCloudService({ storeRoot: root, box: fakeBox(), sign, getPublicIdentity: id.getPublicIdentity, nativeConfirm: confirm })
    const c = svc.client

    expect(await code(() => c.origin())).toBe('disabled')
    expect(await code(c.signIn())).toBe('disabled')
    expect(await code(c.session())).toBe('disabled')
    expect(await code(c.signOut())).toBe('disabled')
    expect(await code(c.deleteAccount())).toBe('disabled')
    expect(await code(c.requestJson('GET', '/v1/anything', undefined, z.unknown()))).toBe('disabled')
    expect(await code(drain(c.stream('/v1/chat', { q: 1 })))).toBe('disabled')
    expect(await code(svc.signIn())).toBe('disabled')
    expect(await code(svc.deleteAccount())).toBe('disabled')
    expect((await svc.signOut()).remoteRevoked).toBe(false)
    expect(svc.status()).toMatchObject({ enabled: false, signedIn: false, accountId: null, expiresAt: null })

    const ipc = fakeIpc()
    registerCloudIpc(ipc, { storeRoot: root, box: fakeBox(), sign, getPublicIdentity: id.getPublicIdentity, nativeConfirm: confirm })
    for (const ch of [CLOUD_CHANNELS.status, CLOUD_CHANNELS.signIn, CLOUD_CHANNELS.signOut]) await ipc.invoke(ch)
    expect(await ipc.invoke(CLOUD_CHANNELS.signIn)).toMatchObject({ ok: false, error: { code: 'disabled' } })
    expect(await ipc.invoke(CLOUD_CHANNELS.deleteAccount, { confirm: true })).toMatchObject({ ok: false, error: { code: 'disabled' } })
    // Turning OFF (again) is local only.
    expect(await ipc.invoke(CLOUD_CHANNELS.configure, { enabled: false, baseUrl: null })).toMatchObject({ ok: true })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('an injected fetch is not called either', async () => {
    const f = vi.fn(async () => new Response('{}'))
    const id = testIdentity()
    const svc = createCloudService({ storeRoot: tempStore(roots), box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, fetch: f })
    expect(await code(svc.client.signIn())).toBe('disabled')
    expect(await code(drain(svc.client.stream('/v1/x', {})))).toBe('disabled')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('cloud: static network scan', () => {
  const dir = path.resolve('src/main/cloud')
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))

  it('only client.ts calls fetch; no module imports node network APIs', () => {
    expect(all).toEqual(expect.arrayContaining(['api.ts', 'client.ts', 'config.ts', 'ipc.ts', 'service.ts', 'sse.ts', 'token.ts', 'errors.ts']))
    const netImport = [
      /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici)['"]/,
      /require\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici)['"]/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bnet\.request\b/,
      /\bsendBeacon\b/,
      /^import\s+(?!type\b)[^\n]*from\s+['"]electron['"]/m
    ]
    const fetchCall = /\bfetch\s*\(|globalThis\.fetch|\bf\s*\(\s*`\$\{base\}/
    for (const f of all) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const re of netImport) expect(re.test(src), `${f} matches ${re}`).toBe(false)
      if (f !== 'client.ts') expect(fetchCall.test(src), `${f} must not call fetch`).toBe(false)
    }
    expect(fetchCall.test(fs.readFileSync(path.join(dir, 'client.ts'), 'utf8'))).toBe(true)
  })

  it('the preload bridge only invokes lens:cloud:* channels', () => {
    const src = fs.readFileSync(path.resolve('src/preload/cloud.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/\bfetch\b|token/i)
    expect((src.match(/ipcRenderer\.invoke\(CLOUD_CHANNELS\.\w+/g) ?? []).length).toBe(5)
    // Chat (C3–C7): every invoke goes to a lens:chat:* channel; the only listener is the chat event.
    expect((src.match(/ipcRenderer\.invoke\(CHAT_CHANNELS\.\w+/g) ?? []).length).toBe(Object.keys(CHAT_CHANNELS).length)
    // C8 / C10 (subs + cloud cards): every invoke goes to a lens:subs:* / lens:cloud-cards:* channel.
    expect((src.match(/ipcRenderer\.invoke\(SUBS_CHANNELS\.\w+/g) ?? []).length).toBe(Object.keys(SUBS_CHANNELS).length)
    expect((src.match(/ipcRenderer\.invoke\(CLOUD_CARDS_CHANNELS\.\w+/g) ?? []).length).toBe(Object.keys(CLOUD_CARDS_CHANNELS).length)
    // C12–C14 (meetings): every invoke goes to a lens:meetings:* channel.
    expect((src.match(/ipcRenderer\.invoke\(MEETINGS_CHANNELS\.\w+/g) ?? []).length).toBe(Object.keys(MEETINGS_CHANNELS).length)
    expect(Object.values(MEETINGS_CHANNELS).every((c) => c.startsWith('lens:meetings:'))).toBe(true)
    // C18 (moments): every invoke goes to a lens:moments:* channel.
    expect((src.match(/ipcRenderer\.invoke\(MOMENTS_CHANNELS\.\w+/g) ?? []).length).toBe(Object.keys(MOMENTS_CHANNELS).length)
    expect(Object.values(MOMENTS_CHANNELS).every((c) => c.startsWith('lens:moments:'))).toBe(true)
    expect((src.match(/ipcRenderer\.invoke\(/g) ?? []).length).toBe(
      5 + Object.keys(CHAT_CHANNELS).length + Object.keys(SUBS_CHANNELS).length + Object.keys(CLOUD_CARDS_CHANNELS).length + Object.keys(MEETINGS_CHANNELS).length + Object.keys(MOMENTS_CHANNELS).length
    )
    expect((src.match(/ipcRenderer\.on\(/g) ?? []).length).toBe(1)
    expect(src).toContain('ipcRenderer.on(CHAT_EVENT_CHANNEL')
    expect(Object.values(CHAT_CHANNELS).every((c) => c.startsWith('lens:chat:'))).toBe(true)
  })

  it('chat renderer files never call fetch / open sockets (all network stays in main client.ts)', () => {
    const files = [
      'src/renderer/src/pages/Chat.tsx',
      'src/renderer/src/pages/chatView.ts',
      ...fs.readdirSync(path.resolve('src/renderer/src/components/chat')).map((f) => `src/renderer/src/components/chat/${f}`)
    ]
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(f), 'utf8')
      expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(src), f).toBe(false)
    }
    expect(fs.readdirSync(path.resolve('src/main/cloud'))).toEqual(expect.arrayContaining(['chat.ts', 'chat-ipc.ts', 'chat-api.ts', 'context.ts']))
  })
})
