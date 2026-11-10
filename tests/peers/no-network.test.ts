// S1-11 zero-network guarantee: the peers module imports no network module and, exercised end
// to end, never touches fetch / http / https / net / tls / dgram. Runtime access only goes
// through the injected deps (faked here), which in production are loopback REST + stdio MCP.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PEERS_CHANNELS } from '../../src/main/peers/api'
import { registerPeersIpc } from '../../src/main/peers/ipc'
import type { RuntimeClient } from '../../src/main/runtime/client'
import { signSkill } from '../../src/main/skillshare/package'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { FIXTURE_RUNTIME } from '../workflows/helpers'
import { friend, tempDir, text, userGraph } from './fixtures'

const SOURCES = [
  'src/main/peers',
  'src/preload/peers.ts',
  'src/renderer/src/pages/Peers.tsx',
  'src/renderer/src/components/peers'
]

function files(p: string): string[] {
  const abs = path.resolve(p)
  if (fs.statSync(abs).isFile()) return [abs]
  return fs.readdirSync(abs).flatMap((n) => files(path.join(p, n)))
}

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

describe('peers: no network', () => {
  it('no source file imports or calls a network API', () => {
    const banned = [
      /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
      /require\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bnet\.request\b/,
      /\bsendBeacon\b/,
      /\bfs\.watch\b|\bwatchFile\b|chokidar/,
      // S2-09: no polling intervals anywhere in the peers feature. S1-R4-06 (X2): the only timer is
      // the opt-in one-shot setTimeout in subscription-scheduler.ts (checked below).
      /\bsetInterval\s*\(|\brefetchInterval\b/
    ]
    const all = SOURCES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f))
    expect(all.length).toBeGreaterThanOrEqual(8)
    for (const f of all) {
      const src = fs.readFileSync(f, 'utf8')
      for (const re of banned) expect(re.test(src), `${path.relative(process.cwd(), f)} matches ${re}`).toBe(false)
      if (/\bsetTimeout\s*\(/.test(src) && !/(subscription-scheduler\.ts|\.tsx)$/.test(f)) {
        expect.fail(`${path.relative(process.cwd(), f)}: timers belong in subscription-scheduler.ts only`)
      }
    }
  })

  it('full flow (import, list, suggestions, letter, export, subscription refresh) makes zero network calls', async () => {
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
    const storeRoot = tempDir('nonet')
    const out = tempDir('nonet-out')
    const subFolder = tempDir('nonet-sub')
    const runtimeRoot = tempDir('nonet-runtime')
    const f = friend('nonet')
    roots.push(storeRoot, out, f.root, subFolder, runtimeRoot)
    // S2-09: a subscription folder with a card and a signed skill.
    fs.writeFileSync(path.join(subFolder, 'a.navaliacard'), text(f.card({ issuedAt: '2026-11-02T00:00:00.000Z' })))
    const weekly = readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((w) => w.id === 'rt-weekly-report')!
    fs.writeFileSync(path.join(subFolder, 'w.navaliaskill'), signSkill(weekly, f.keys).text)
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
    registerPeersIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, {
      storeRoot,
      now: () => new Date('2026-11-05T02:00:00Z'),
      runtime: () => ({ modelGraph: async () => userGraph() }) as unknown as RuntimeClient,
      ossTool: async (name) => (name === 'recent_activity' ? '{"count":0,"entries":[]}' : '{"query":"","results":[]}'),
      saveDialog: async () => path.join(out, 'l.md'),
      openDialog: async () => null,
      runtimeRoot: () => runtimeRoot,
      openDirectoryDialog: async () => subFolder
    })
    const call = (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw) as Promise<{ ok: boolean }>
    const fp = f.fingerprint
    for (const r of [
      await call(PEERS_CHANNELS.importText, { text: text(f.card()) }),
      await call(PEERS_CHANNELS.importText, { text: text(f.card({ issuedAt: '2026-11-03T00:00:00.000Z' })) }),
      await call(PEERS_CHANNELS.list),
      await call(PEERS_CHANNELS.get, { fingerprint: fp }),
      await call(PEERS_CHANNELS.suggestions, { fingerprint: fp }),
      await call(PEERS_CHANNELS.sharedMoments, { fingerprint: fp }),
      await call(PEERS_CHANNELS.letterDraft, { fingerprint: fp, timezone: 'UTC' }),
      await call(PEERS_CHANNELS.exportLetter, { fingerprint: fp, markdown: '# x' }),
      await call(PEERS_CHANNELS.importFile),
      await call(PEERS_CHANNELS.subStatus),
      await call(PEERS_CHANNELS.subChoose),
      await call(PEERS_CHANNELS.subRefresh),
      await call(PEERS_CHANNELS.subRefresh),
      await call(PEERS_CHANNELS.subDisable),
      await call(PEERS_CHANNELS.subEnable),
      await call(PEERS_CHANNELS.remove, { fingerprint: fp })
    ]) {
      expect(r.ok).toBe(true)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})
