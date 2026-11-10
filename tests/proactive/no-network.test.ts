// S1-R4-05 zero-network / no-LLM guarantee for the proactive module (same pattern as
// tests/peers/no-network.test.ts): static scan + an end-to-end run with every network API spied on.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProactiveService } from '../../src/main/proactive/service'
import { clock, fakeNotifier, fakeSources, GOOD_CAPTURE, HOUR, tempDir, safeRm } from './helpers'

const ROOT = path.resolve(__dirname, '../..')
const SOURCES = ['src/main/proactive', 'src/preload/proactive.ts', 'src/renderer/src/components/settings/ProactiveSection.tsx', 'src/renderer/src/components/settings/proactiveView.ts', 'src/renderer/src/components/proactive']

function files(p: string): string[] {
  const abs = path.join(ROOT, p)
  if (fs.statSync(abs).isFile()) return [abs]
  return fs.readdirSync(abs).flatMap((n) => files(path.join(p, n)))
}

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const r of roots.splice(0)) safeRm(r)
})

describe('proactive: no network, no LLM', () => {
  it('no source file imports or calls a network API or an LLM', () => {
    const banned = [
      /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
      /require\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bnet\.request\b/,
      /\bsendBeacon\b/,
      /from\s+['"][^'"]*(?:anthropic|openai|het\/assessor|het\/service|agent_cli|mcp\/client)['"]/i,
      /\bchild_process\b|\bspawn\(|\bexec\(/
    ]
    const all = SOURCES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f))
    expect(all.length).toBeGreaterThanOrEqual(10)
    for (const f of all) {
      const src = fs.readFileSync(f, 'utf8')
      for (const re of banned) expect(re.test(src), `${path.relative(ROOT, f)} matches ${re}`).toBe(false)
    }
  })

  it('only main.ts touches Electron Notification', () => {
    const users = files('src/main/proactive')
      .filter((f) => /from 'electron'/.test(fs.readFileSync(f, 'utf8')) && /\bNotification\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
    expect(users).toEqual(['src/main/proactive/main.ts'])
  })

  it('enable + ticks over every trigger make zero network calls', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network forbidden')))
    vi.stubGlobal('fetch', fetchSpy)
    const spies = [
      vi.spyOn(http, 'request'),
      vi.spyOn(http, 'get'),
      vi.spyOn(https, 'request'),
      vi.spyOn(https, 'get'),
      vi.spyOn(net, 'connect'),
      vi.spyOn(net, 'createConnection'),
      vi.spyOn(tls, 'connect'),
      vi.spyOn(dgram, 'createSocket')
    ]
    const root = tempDir('nonet')
    roots.push(root)
    const c = clock()
    const notifier = fakeNotifier()
    const src = fakeSources({
      aliases: ['a', 'b'],
      capture: { ...GOOD_CAPTURE, screenRecording: false },
      runtime: { reachable: false, revision: null },
      brief: { nextSteps: ['x'], yesterdayTodos: ['x'] }
    })
    const svc = createProactiveService({
      storeRoot: root,
      now: c.now,
      timezone: () => 'Asia/Shanghai',
      notifier,
      sources: src.sources,
      openPage: () => undefined,
      hasWindow: () => true,
      timers: { setInterval: () => 1, clearInterval: () => undefined }
    })
    await svc.update({ enabled: true, triggers: { owner_aliases: true, capture_degraded: true, runtime: true, daily_brief: true, carried_todos: true } })
    for (let i = 0; i < 4; i++) {
      c.advance(HOUR)
      await svc.tick()
    }
    svc.stop()
    expect(notifier.shown.length).toBeGreaterThan(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})
