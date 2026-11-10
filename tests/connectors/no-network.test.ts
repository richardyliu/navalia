// S1-R4-07 / C19: static no-network check for every connector file except the IMAP module (the one
// network path, `src/main/connectors/imap/**`: implicit TLS only, checked here too) plus a runtime
// check that previewing and committing file connectors opens no socket.
// `ipc.ts` is the one place that talks to the Runtime REST API; it is checked to be loopback-only.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grantAll } from './consent-helper'
import { createConnectorService } from '../../src/main/connectors/service'

// C19: every connector file EXCEPT the IMAP module (`src/main/connectors/imap/**`, the only network
// path) and `ipc.ts` (loopback Runtime REST, checked separately), plus the preload bridge and UI.
function walk(dir: string): string[] {
  return fs.readdirSync(path.resolve(dir), { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(d.name) ? [p] : []
  })
}
const IMAP_DIR = path.join('src', 'main', 'connectors', 'imap')
const PURE = [
  ...walk('src/main/connectors').filter((f) => !f.startsWith(IMAP_DIR + path.sep) && path.basename(f) !== 'ipc.ts'),
  'src/preload/connectors.ts',
  'src/renderer/src/pages/Connectors.tsx',
  'src/renderer/src/pages/connectorsView.ts',
  ...walk('src/renderer/src/components/connectors')
]
const BANNED = [
  /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
  /require\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bnet\.request\b/,
  /\bshell\.openExternal\b/,
  /https?:\/\/(?!127\.0\.0\.1)[a-z]/i
]

afterEach(() => vi.restoreAllMocks())

describe('connectors: no network', () => {
  it('parsers, service, preload and page import / call no network API', () => {
    for (const f of PURE) {
      const src = fs.readFileSync(path.resolve(f), 'utf8')
      for (const re of BANNED) expect(re.test(src), `${f} matches ${re}`).toBe(false)
    }
  })

  it('the scan covers the new C19 files', () => {
    for (const f of ['service.ts', 'consent.ts', 'apple-health.ts', 'csv-import.ts']) expect(PURE).toContain(path.join('src/main/connectors', f))
    expect(PURE.some((f) => f.includes(`${path.sep}imap${path.sep}`))).toBe(false)
    expect(PURE.some((f) => f.endsWith('ImapPanel.tsx'))).toBe(true)
  })

  it('network exists only in connectors/imap/**: TLS socket in tls.ts only; no http / fetch / dns there', () => {
    const files = walk(IMAP_DIR)
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(f), 'utf8')
      const nodeNet = /from\s+['"](?:node:)?(?:net|tls)['"]/.test(src)
      expect(nodeNet, f).toBe(path.basename(f) === 'tls.ts')
      for (const re of [/from\s+['"](?:node:)?(?:http|https|http2|dgram|dns)['"]/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /net\.(?:connect|createConnection)\s*\(/, /https?:\/\//]) {
        expect(re.test(src), `${f} matches ${re}`).toBe(false)
      }
    }
    const t = fs.readFileSync(path.resolve(IMAP_DIR, 'tls.ts'), 'utf8')
    expect(t).toMatch(/tls\.connect\(/)
    expect(t).toMatch(/rejectUnauthorized: true/)
    expect(t).toMatch(/minVersion: 'TLSv1\.2'/)
    // Only the IPC layer wires the IMAP module in; the service never imports it at runtime.
    expect(fs.readFileSync(path.resolve('src/main/connectors/service.ts'), 'utf8')).not.toMatch(/^import \{[^}]*\} from '\.\/imap\/(fetch|tls|protocol)'/m)
  })

  it('ipc.ts only fetches http://127.0.0.1 (the local Runtime) with redirects refused', () => {
    const src = fs.readFileSync(path.resolve('src/main/connectors/ipc.ts'), 'utf8')
    expect(src.match(/\bfetch\s*\(/g)).toHaveLength(1)
    expect(src).toMatch(/`http:\/\/127\.0\.0\.1:\$\{resolvePort\(runtimeRoot\)\}\$\{route\}`/)
    expect(src).toMatch(/redirect: 'error'/)
    expect(/from\s+['"](?:node:)?(?:http|https|net|tls|dgram|dns)['"]/.test(src)).toBe(false)
    expect(src).toMatch(/from '\.\/imap\/fetch'/)
  })

  it('previewing and committing .eml / mbox opens no socket and calls no fetch', async () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-mail-nn-'))
    try {
      const svc = createConnectorService({
        storeRoot: store,
        runtimeRoot: () => store,
        persomeBin: () => null,
        ossTool: async () => JSON.stringify({ entry_id: 'x' }),
        postRuntime: async () => {
          throw new Error('no REST for email')
        }
      })
      grantAll(svc)
      for (const f of ['multipart.eml', 'small.mbox']) {
        const p = await svc.previewFile('email', path.join(__dirname, 'fixtures', f))
        await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
      }
      // C19 file connectors: CSV (remember) and Apple Health XML preview.
      fs.writeFileSync(path.join(store, 'n.csv'), 'date,title\n2026-11-03,hello\n')
      const c = await svc.previewFile('csv', path.join(store, 'n.csv'))
      await svc.commit(c.previewId!, c.items.map((i) => i.key), {})
      fs.writeFileSync(path.join(store, 'export.xml'), '<HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-11-03 08:00:00 +0800" endDate="2026-11-03 08:01:00 +0800" value="5"/></HealthData>')
      expect((await svc.previewFile('health', path.join(store, 'export.xml'))).items).toHaveLength(1)
      expect(connect).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })
})
