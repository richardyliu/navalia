import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRewindReader, MAGIC, SCAN_BUDGET, type RewindFrame } from '../../src/main/broker/rewind'
import { REWIND_CHANNELS, type RewindListResult, type RewindViewResult } from '../../src/main/rewind/api'
import { registerRewindHandlers } from '../../src/main/rewind/ipc'
import { createRewindService } from '../../src/main/rewind/service'
import type { LensResult } from '../../src/shared/types'
import { connectClient, fakeBackend, startBroker, textOf } from '../identity/broker-helpers'

/**
 * Security review F6 (scan budget + async reads) and F7 (Broker refuses plaintext frames, OG-D6b).
 * Temp runtime roots only.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0).reverse()) await c()
})

function seal(b64: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(Buffer.from(b64, 'ascii')), c.final()])
  return MAGIC + Buffer.concat([iv, body, c.getAuthTag()]).toString('base64')
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])

/** n frames one second apart; every `every`-th frame is app 'Needle', the rest 'Hay'. */
function buffer(n: number, every = 0, key = randomBytes(32)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-rewind-scan-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  expect(root.startsWith(path.join(os.homedir(), '.persome'))).toBe(false)
  const dir = path.join(root, 'capture-buffer')
  fs.mkdirSync(dir)
  const stems: string[] = []
  const needles: string[] = []
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.UTC(2026, 10, 5, 10, 0, 0) + i * 1000)
    const iso = t.toISOString()
    const stem = `${iso.slice(0, 10)}T${iso.slice(11, 13)}-${iso.slice(14, 16)}-${iso.slice(17, 19)}.000000p00-00`
    stems.push(stem)
    const needle = every > 0 && i % every === 0
    if (needle) needles.push(stem)
    fs.writeFileSync(
      path.join(dir, `${stem}.json`),
      JSON.stringify({
        timestamp: iso,
        window_meta: { app_name: needle ? 'Needle' : 'Hay', title: `w ${i}` },
        visible_text: `t ${i}`,
        screenshot: { image_base64: i === 1 ? JPEG.toString('base64') : seal(JPEG.toString('base64'), key), mime_type: 'image/jpeg' }
      })
    )
  }
  return { root, dir, stems, needles, key }
}

async function drain(
  frames: (cursor?: string) => Promise<{ frames: RewindFrame[]; next_cursor: string | null; scanned: number; partial: boolean }>,
  maxCalls = 1000
) {
  const got: string[] = []
  const scans: number[] = []
  let partials = 0
  let cursor: string | undefined
  for (let i = 0; i < maxCalls; i++) {
    const r = await frames(cursor)
    got.push(...r.frames.map((f) => f.file_stem))
    scans.push(r.scanned)
    if (r.partial) partials++
    if (!r.next_cursor) return { got, scans, partials, calls: i + 1 }
    cursor = r.next_cursor
  }
  throw new Error('cursor did not terminate')
}

describe('F6: per-call scan budget with cursor continuation (Broker reader)', () => {
  test('non-matching app filter: returns partial with a cursor after the budget, never scans everything', async () => {
    const b = buffer(50)
    const r = createRewindReader({ root: () => b.root, screenshotKey: () => null, scanBudget: 10 })
    const readSpy = vi.spyOn(fs.promises, 'readFile')
    const p = await r.frames({ app_name: 'NoSuchApp', limit: 20 })
    expect(p).toEqual({ frames: [], next_cursor: b.stems[9], scanned: 10, partial: true })
    expect(readSpy).toHaveBeenCalledTimes(10)
    const all = await drain((cursor) => r.frames({ app_name: 'NoSuchApp', limit: 20, cursor }))
    expect(all.got).toEqual([])
    expect(all.scans).toEqual([10, 10, 10, 10, 10])
    expect(all.scans.reduce((a, x) => a + x, 0)).toBe(50) // every file examined exactly once across calls
  })

  test('default budget is SCAN_BUDGET (300) files per call', async () => {
    const b = buffer(SCAN_BUDGET + 20)
    const r = createRewindReader({ root: () => b.root, screenshotKey: () => null })
    const p = await r.frames({ app_name: 'NoSuchApp' })
    expect([p.scanned, p.partial, p.next_cursor]).toEqual([SCAN_BUDGET, true, b.stems[SCAN_BUDGET - 1]])
    const p2 = await r.frames({ app_name: 'NoSuchApp', cursor: p.next_cursor! })
    expect([p2.scanned, p2.partial, p2.next_cursor]).toEqual([20, false, null])
  })

  test('cursor continuation covers every matching frame exactly once, asc and desc', async () => {
    const b = buffer(61, 7)
    const r = createRewindReader({ root: () => b.root, screenshotKey: () => null, scanBudget: 5 })
    const asc = await drain((cursor) => r.frames({ app_name: 'Needle', limit: 3, cursor }))
    expect(asc.got).toEqual(b.needles)
    expect(asc.partials).toBeGreaterThan(0)
    expect(Math.max(...asc.scans)).toBeLessThanOrEqual(5)
    const desc = await drain((cursor) => r.frames({ app_name: 'Needle', limit: 3, cursor, order: 'desc' }))
    expect(desc.got).toEqual([...b.needles].reverse())
    const plain = await drain((cursor) => r.frames({ limit: 4, cursor }))
    expect(plain.got).toEqual(b.stems)
    expect(plain.partials).toBe(0) // budget 5 ≥ limit 4: no partial pages without a filter
  })

  test('a cursor whose file was deleted (retention) continues after it instead of restarting', async () => {
    const b = buffer(10)
    const r = createRewindReader({ root: () => b.root, screenshotKey: () => null })
    const p1 = await r.frames({ limit: 3 })
    fs.rmSync(path.join(b.dir, `${p1.next_cursor}.json`))
    const p2 = await r.frames({ limit: 3, cursor: p1.next_cursor! })
    expect(p2.frames.map((f) => f.file_stem)).toEqual(b.stems.slice(3, 6))
  })

  test('reader uses async fs only (no sync read/stat/readdir on the main thread)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/main/broker/rewind.ts'), 'utf8')
    expect(src).not.toMatch(/readFileSync|statSync|readdirSync/)
  })

  test('Broker rewind_frames tool: budget applies to agent calls; result carries partial + next_cursor', async () => {
    const b = buffer(40)
    const reader = createRewindReader({ root: () => b.root, screenshotKey: () => null, scanBudget: 8 })
    const br = await startBroker(fakeBackend({ rewindFrames: (q) => reader.frames(q) }))
    cleanups.push(() => fs.rmSync(br.root, { recursive: true, force: true }), () => br.audit.close(), () => br.broker.stop())
    const { token } = br.grants.create({ client: 'claude-code' })
    const c = await connectClient(br.url, token)
    cleanups.push(() => c.close())
    const res = JSON.parse(textOf(await c.callTool({ name: 'rewind_frames', arguments: { app_name: 'NoSuchApp' } })))
    expect(res).toMatchObject({ frames: [], scanned: 8, partial: true, next_cursor: b.stems[7] })
  })
})

describe('F6: Rewind page IPC (lens:rewind:list) uses the same budget', () => {
  test('partial page with a cursor; continuation reaches the match; IPC shape stays camelCase', async () => {
    const b = buffer(30, 0)
    // Make exactly one old frame match.
    const target = b.stems[2]
    const file = path.join(b.dir, `${target}.json`)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), window_meta: { app_name: 'Needle' } }))
    const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
    registerRewindHandlers({ handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => void handlers.set(ch, fn) }, createRewindService({ runtimeRoot: () => b.root, screenshotKey: () => null, scanBudget: 10 }))
    const list = async (q: unknown) => (await handlers.get(REWIND_CHANNELS.list)!({}, q)) as LensResult<RewindListResult>
    const p1 = await list({ appName: 'Needle', limit: 5 })
    if (!p1.ok) throw new Error(p1.error.message)
    expect(p1.data).toMatchObject({ frames: [], partial: true, scanned: 10, nextCursor: b.stems[20] }) // newest first
    const p2 = await list({ appName: 'Needle', limit: 5, cursor: p1.data.nextCursor })
    if (!p2.ok) throw new Error()
    expect(p2.data).toMatchObject({ frames: [], partial: true, scanned: 10, nextCursor: b.stems[10] })
    const p3 = await list({ appName: 'Needle', limit: 5, cursor: p2.data.nextCursor })
    if (!p3.ok) throw new Error()
    expect(p3.data.frames.map((f) => f.fileStem)).toEqual([target])
    expect([p3.data.partial, p3.data.nextCursor]).toEqual([false, null])
  })
})

describe('F7 (OG-D6b): the Broker refuses plaintext legacy screenshots like the Rewind page', () => {
  test('view_rewind_screenshot on a plaintext frame → error plaintext_refused, no image, Access-logged', async () => {
    const b = buffer(3)
    const reader = createRewindReader({ root: () => b.root, screenshotKey: () => b.key })
    const br = await startBroker(fakeBackend({ rewindScreenshot: (s) => reader.screenshot(s) }))
    cleanups.push(() => fs.rmSync(br.root, { recursive: true, force: true }), () => br.audit.close(), () => br.broker.stop())
    const { token } = br.grants.create({ client: 'claude-code' })
    const c = await connectClient(br.url, token)
    cleanups.push(() => c.close())
    const plain = await c.callTool({ name: 'view_rewind_screenshot', arguments: { file_stem: b.stems[1] } })
    expect(plain.isError).toBe(true)
    expect(textOf(plain)).toContain('unencrypted')
    expect((plain.content as Array<{ type: string }>).some((x) => x.type === 'image')).toBe(false)
    expect(JSON.stringify(plain)).not.toContain(JPEG.toString('base64'))
    const row = br.audit.list({ includeFailures: true }).find((x) => x.capability === 'view_rewind_screenshot')!
    expect([row.outcome, row.errorCode]).toEqual(['error', 'plaintext_refused'])
    // Sealed frames are still served.
    const sealed = await c.callTool({ name: 'view_rewind_screenshot', arguments: { file_stem: b.stems[0] } })
    expect((sealed.content as Array<{ type: string }>).some((x) => x.type === 'image')).toBe(true)
  })

  test('tool-level defense: a backend that hands back an unencrypted shot is still refused', async () => {
    const br = await startBroker(
      fakeBackend({ rewindScreenshot: async (s) => ({ file_stem: s, mime: 'image/jpeg', data: Buffer.from(JPEG), width: null, height: null, encrypted: false }) })
    )
    cleanups.push(() => fs.rmSync(br.root, { recursive: true, force: true }), () => br.audit.close(), () => br.broker.stop())
    const { token } = br.grants.create({ client: 'claude-code' })
    const c = await connectClient(br.url, token)
    cleanups.push(() => c.close())
    const r = await c.callTool({ name: 'view_rewind_screenshot', arguments: { file_stem: '2026-11-05T10-00-00.000000p00-00' } })
    expect(r.isError).toBe(true)
    expect((r.content as Array<{ type: string }>).some((x) => x.type === 'image')).toBe(false)
    const row = br.audit.list({ includeFailures: true }).find((x) => x.capability === 'view_rewind_screenshot')!
    expect(row.errorCode).toBe('plaintext_refused')
  })

  test('Rewind page view of the same frame stays plaintext_refused (shared reader rule)', async () => {
    const b = buffer(3)
    const svc = createRewindService({ runtimeRoot: () => b.root, screenshotKey: () => b.key })
    const v: RewindViewResult = await svc.view(b.stems[1])
    expect(v).toMatchObject({ status: 'unavailable', reason: 'plaintext_refused' })
  })
})
