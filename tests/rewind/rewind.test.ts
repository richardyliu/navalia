import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MAGIC } from '../../src/main/broker/rewind'
import { readScreenshotKey } from '../../src/main/runtime/token'
import { REWIND_CHANNELS, type RewindListResult, type RewindViewResult } from '../../src/main/rewind/api'
import { registerRewindIpc } from '../../src/main/rewind/ipc'
import type { LensResult } from '../../src/shared/types'

// OG-05 Rewind: temp runtime roots only, fixture frames sealed in-test with a test key.

const cleanups: Array<() => void> = []
const logs: string[] = []
beforeEach(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  logs.length = 0
  for (const c of cleanups.splice(0).reverse()) c()
})

/** Same envelope as runtime capture/screenshot_crypto.py: seals the image's base64 text. */
function seal(b64: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(Buffer.from(b64, 'ascii')), c.final()])
  return MAGIC + Buffer.concat([iv, body, c.getAuthTag()]).toString('base64')
}

/** A tiny JPEG-shaped payload with a unique marker so we can detect plaintext leaks on disk. */
const MARKER = 'REWIND-PLAINTEXT-MARKER-7f3a'
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARKER, 'ascii'), Buffer.from([0xff, 0xd9])])

const APPS = ['Safari', 'Cursor', 'Terminal']

interface Fixture {
  root: string
  keyHex: string
  key: Buffer
  stems: string[]
}

function fixture(opts: { withKey?: boolean; count?: number } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-rewind-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  expect(root.startsWith(os.homedir() + '/.persome')).toBe(false)
  const key = randomBytes(32)
  const keyHex = key.toString('hex')
  if (opts.withKey !== false) fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${'t'.repeat(40)}\nPERSOME_SCREENSHOT_KEY=${keyHex}\n`, { mode: 0o600 })
  const dir = path.join(root, 'capture-buffer')
  fs.mkdirSync(dir)
  const stems: string[] = []
  const n = opts.count ?? 12
  for (let i = 0; i < n; i++) {
    const mm = String(i).padStart(2, '0')
    const stem = `2026-11-05T10-${mm}-00.000000p00-00`
    stems.push(stem)
    const app = APPS[i % APPS.length]
    fs.writeFileSync(
      path.join(dir, `${stem}.json`),
      JSON.stringify({
        timestamp: `2026-11-05T10:${mm}:00+00:00`,
        window_meta: { app_name: app, title: `${app} window ${i}`, bundle_id: `com.test.${app.toLowerCase()}` },
        visible_text: `secret visible text ${i}`,
        url: app === 'Safari' ? `https://example.com/${i}` : null,
        // i=9: no screenshot (retention-stripped); i=10: legacy plaintext; others sealed.
        screenshot:
          i === 9
            ? {}
            : { image_base64: i === 10 ? JPEG.toString('base64') : seal(JPEG.toString('base64'), key), mime_type: 'image/jpeg', width: 4, height: 3 }
      })
    )
  }
  return { root, keyHex, key, stems }
}

function fakeIpc() {
  const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
  return {
    ipc: { handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => void handlers.set(ch, fn) },
    call: async <T>(ch: string, raw?: unknown) => (await handlers.get(ch)!({}, raw)) as LensResult<T>
  }
}

function setup(f: Fixture) {
  const { ipc, call } = fakeIpc()
  registerRewindIpc(ipc, { runtimeRoot: () => f.root, screenshotKey: () => readScreenshotKey(f.root) })
  return {
    list: (q?: unknown) => call<RewindListResult>(REWIND_CHANNELS.list, q),
    view: (raw: unknown) => call<RewindViewResult>(REWIND_CHANNELS.view, raw)
  }
}

function listTree(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listTree(p))
    else out.push(p)
  }
  return out
}

function assertNoSecrets(f: Fixture, payload: unknown) {
  const s = JSON.stringify(payload) + '\n' + logs.join('\n')
  for (const k of [f.keyHex, f.keyHex.toUpperCase(), f.key.toString('base64')]) expect(s).not.toContain(k)
}

describe('OG-05 Rewind IPC', () => {
  test('list: newest first, metadata only, app + time filters, cursor pagination', async () => {
    const f = fixture()
    const r = setup(f)
    const p1 = await r.list({ limit: 5 })
    if (!p1.ok) throw new Error(p1.error.message)
    expect(p1.data.keyAvailable).toBe(true)
    expect(p1.data.frames.map((x) => x.fileStem)).toEqual([...f.stems].reverse().slice(0, 5))
    expect(Object.keys(p1.data.frames[0]).sort()).toEqual(['appName', 'bundleId', 'fileStem', 'hasScreenshot', 'timestamp', 'url', 'windowTitle'])
    expect(JSON.stringify(p1.data)).not.toContain('secret visible text')
    const all: string[] = [...p1.data.frames.map((x) => x.fileStem)]
    let cursor = p1.data.nextCursor
    while (cursor) {
      const p = await r.list({ limit: 5, cursor })
      if (!p.ok) throw new Error(p.error.message)
      all.push(...p.data.frames.map((x) => x.fileStem))
      cursor = p.data.nextCursor
    }
    expect(all).toEqual([...f.stems].reverse())

    const cursorOnly = await r.list({ appName: 'Cursor' })
    if (!cursorOnly.ok) throw new Error()
    expect(cursorOnly.data.frames.map((x) => x.appName)).toEqual(['Cursor', 'Cursor', 'Cursor', 'Cursor'])

    const range = await r.list({ since: '2026-11-05T10:03:00Z', until: '2026-11-05T10:05:00Z' })
    if (!range.ok) throw new Error()
    expect(range.data.frames.map((x) => x.fileStem)).toEqual([f.stems[5], f.stems[4], f.stems[3]])

    const both = await r.list({ since: '2026-11-05T10:03:00Z', until: '2026-11-05T10:08:00Z', appName: 'Safari', limit: 1 })
    if (!both.ok) throw new Error()
    expect(both.data.frames.map((x) => x.fileStem)).toEqual([f.stems[6]])
    const both2 = await r.list({ since: '2026-11-05T10:03:00Z', until: '2026-11-05T10:08:00Z', appName: 'Safari', limit: 1, cursor: both.data.nextCursor })
    if (!both2.ok) throw new Error()
    expect(both2.data.frames.map((x) => x.fileStem)).toEqual([f.stems[3]])

    expect(p1.data.frames.find((x) => x.fileStem === f.stems[9])?.hasScreenshot ?? false).toBe(false)
    expect((await r.list()).ok).toBe(true)
  })

  test('list: zod validation and sanitized errors', async () => {
    const f = fixture()
    const r = setup(f)
    for (const bad of [{ limit: 0 }, { limit: 101 }, { cursor: '../env' }, { since: 'yesterday' }, { extra: 1 }, { appName: '' }, 'x']) {
      const res = await r.list(bad)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.code).toBe('schema')
    }
    const inverted = await r.list({ since: '2026-11-05T11:00:00Z', until: '2026-11-05T10:00:00Z' })
    expect(inverted.ok).toBe(false)
    // Missing capture buffer: empty list, no path in output.
    fs.rmSync(path.join(f.root, 'capture-buffer'), { recursive: true })
    const empty = await r.list()
    expect(empty).toEqual({ ok: true, data: { frames: [], nextCursor: null, partial: false, scanned: 0, keyAvailable: true } })
  })

  test('view: decrypt roundtrip to a display-only data URL; no plaintext file created; key never returned or logged', async () => {
    const f = fixture()
    const r = setup(f)
    const before = listTree(f.root).sort()
    const v = await r.view({ fileStem: f.stems[0] })
    if (!v.ok) throw new Error(v.error.message)
    expect(v.data.status).toBe('ok')
    if (v.data.status !== 'ok') throw new Error()
    expect(v.data.mime).toBe('image/jpeg')
    expect(v.data.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Buffer.from(v.data.dataUrl.split(',')[1], 'base64').equals(JPEG)).toBe(true)
    expect([v.data.bytes, v.data.width, v.data.height]).toEqual([JPEG.length, 4, 3])
    // No new files, and no file under the temp root contains the decrypted marker.
    expect(listTree(f.root).sort()).toEqual(before)
    for (const file of listTree(f.root)) {
      const buf = fs.readFileSync(file)
      if (path.basename(file) === `${f.stems[10]}.json`) continue // legacy plaintext fixture, written by the test itself
      expect(buf.includes(Buffer.from(MARKER))).toBe(false)
      expect(buf.toString('utf8')).not.toContain(JPEG.toString('base64'))
    }
    assertNoSecrets(f, v)
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  test('missing key -> structured BLOCKED "缺少截图密钥", never plaintext, even for a plaintext frame', async () => {
    const f = fixture({ withKey: false })
    const r = setup(f)
    const l = await r.list()
    expect(l.ok && l.data.keyAvailable).toBe(false)
    for (const stem of [f.stems[0], f.stems[10]]) {
      const v = await r.view({ fileStem: stem })
      expect(v.ok).toBe(true)
      if (!v.ok) throw new Error()
      expect(v.data).toMatchObject({ status: 'blocked', reason: 'missing_key' })
      if (v.data.status === 'blocked') expect(v.data.message).toContain('Screenshot key missing')
      expect(JSON.stringify(v)).not.toContain('data:image')
    }
    // Key file with loose permissions is treated as absent (token-module rule).
    fs.writeFileSync(path.join(f.root, 'env'), `PERSOME_SCREENSHOT_KEY=${f.keyHex}\n`, { mode: 0o644 })
    fs.chmodSync(path.join(f.root, 'env'), 0o644)
    const loose = await r.view({ fileStem: f.stems[0] })
    expect(loose.ok && loose.data.status).toBe('blocked')
    assertNoSecrets(f, [l, loose])
  })

  test('tampered ciphertext / wrong key -> sanitized error, no fallback, no key in output', async () => {
    const f = fixture()
    const r = setup(f)
    const file = path.join(f.root, 'capture-buffer', `${f.stems[1]}.json`)
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    const blob = Buffer.from(d.screenshot.image_base64.slice(MAGIC.length), 'base64')
    blob[20] ^= 0x01
    d.screenshot.image_base64 = MAGIC + blob.toString('base64')
    fs.writeFileSync(file, JSON.stringify(d))
    const v = await r.view({ fileStem: f.stems[1] })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.error.message).toBe('Screenshot decryption failed (key mismatch or tampered data)')
      expect(v.error.message).not.toContain(f.root)
    }
    // Wrong key
    fs.writeFileSync(path.join(f.root, 'env'), `PERSOME_SCREENSHOT_KEY=${'cd'.repeat(32)}\n`, { mode: 0o600 })
    const w = await r.view({ fileStem: f.stems[0] })
    expect(w.ok).toBe(false)
    assertNoSecrets(f, [v, w])
    expect(JSON.stringify([v, w])).not.toContain('cd'.repeat(32))
  })

  test('view: plaintext frame refused, stripped frame reported, invalid/missing stem rejected without paths', async () => {
    const f = fixture()
    const r = setup(f)
    const plain = await r.view({ fileStem: f.stems[10] })
    expect(plain.ok && plain.data).toMatchObject({ status: 'unavailable', reason: 'plaintext_refused' })
    expect(JSON.stringify(plain)).not.toContain('data:image')
    const stripped = await r.view({ fileStem: f.stems[9] })
    expect(stripped.ok && stripped.data).toMatchObject({ status: 'unavailable', reason: 'no_screenshot' })
    for (const bad of [{ fileStem: '../env' }, { fileStem: '2026-11-05T10-00-00p00-00/../../env' }, {}, { fileStem: f.stems[0], x: 1 }, undefined]) {
      const res = await r.view(bad)
      expect(res.ok).toBe(false)
    }
    const missing = await r.view({ fileStem: '2026-11-05T23-59-59p00-00' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error.code).toBe('not_found')
      expect(missing.error.message).not.toContain(f.root)
    }
  })

  test('view: size cap', async () => {
    const f = fixture({ count: 1 })
    const { ipc, call } = fakeIpc()
    const { createRewindService } = await import('../../src/main/rewind/service')
    const { registerRewindHandlers } = await import('../../src/main/rewind/ipc')
    registerRewindHandlers(ipc, createRewindService({ runtimeRoot: () => f.root, screenshotKey: () => readScreenshotKey(f.root), maxViewBytes: 4 }))
    const v = await call<RewindViewResult>(REWIND_CHANNELS.view, { fileStem: f.stems[0] })
    expect(v.ok && v.data).toMatchObject({ status: 'unavailable', reason: 'too_large' })
  })

  test('source boundary: rewind module never reads env/process.env itself and never logs or writes files', () => {
    const dir = path.resolve(__dirname, '../../src/main/rewind')
    const src = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n')
    expect(src).not.toMatch(/process\.env|readScreenshotKey|console\.|writeFile|createWriteStream|appendFile/)
    const preload = fs.readFileSync(path.resolve(__dirname, '../../src/preload/rewind.ts'), 'utf8')
    expect(preload).not.toMatch(/screenshotKey|PERSOME_SCREENSHOT_KEY/)
  })
})
