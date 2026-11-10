import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { createRewindReader, decryptEnvelope, MAGIC, stemTime } from '../../src/main/broker/rewind'
import { connectClient, fakeBackend, startBroker } from './broker-helpers'
import { tempRoot } from './helpers'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** Same envelope as runtime capture/screenshot_crypto.py encrypt(): seals the base64 *text*. */
function seal(b64: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(Buffer.from(b64, 'ascii')), c.final()])
  return MAGIC + Buffer.concat([iv, body, c.getAuthTag()]).toString('base64')
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])

function runtimeRoot(key: Buffer) {
  const root = tempRoot('rt')
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'capture-buffer')
  fs.mkdirSync(dir)
  const frames: string[] = []
  for (let i = 0; i < 7; i++) {
    const stem = `2026-11-05T01-0${i}-12.916631p00-00`
    frames.push(stem)
    fs.writeFileSync(
      path.join(dir, `${stem}.json`),
      JSON.stringify({
        timestamp: `2026-11-05T01:0${i}:12.916631+00:00`,
        window_meta: { app_name: i % 2 ? 'Cursor' : 'Safari', title: `win ${i}`, bundle_id: 'b' },
        visible_text: i === 3 ? 'x'.repeat(5000) : `frame ${i} text`,
        url: 'https://example.com',
        screenshot: i === 6 ? {} : { image_base64: i === 5 ? JPEG.toString('base64') : seal(JPEG.toString('base64'), key), mime_type: 'image/jpeg', width: 10, height: 10, screenshot_enc: i !== 5 }
      })
    )
  }
  fs.writeFileSync(path.join(dir, 'not-a-capture.json'), '{}')
  return { root, frames }
}

describe('Rewind reader (Lens-defined shapes over the runtime capture buffer)', () => {
  test('stem time parsing', () => {
    expect(stemTime('2026-11-05T01-03-12.916631p00-00')?.toISOString()).toBe('2026-11-05T01:03:12.916Z')
    expect(stemTime('2026-11-05T01-03-12m08-00')?.toISOString()).toBe('2026-11-05T09:03:12.000Z')
    expect(stemTime('../../etc/passwd')).toBeNull()
  })

  test('frames: time range, app filter, bounded text, cursor pagination', async () => {
    const key = randomBytes(32)
    const { root, frames } = runtimeRoot(key)
    const r = createRewindReader({ root: () => root, screenshotKey: () => key })
    const p1 = await r.frames({ limit: 3 })
    expect(p1.frames.map((f) => f.file_stem)).toEqual(frames.slice(0, 3))
    const p2 = await r.frames({ limit: 3, cursor: p1.next_cursor! })
    expect(p2.frames.map((f) => f.file_stem)).toEqual(frames.slice(3, 6))
    expect(p2.frames[0].text).toHaveLength(1500)
    expect(p2.frames[0].text_truncated).toBe(true)
    const p3 = await r.frames({ limit: 3, cursor: p2.next_cursor! })
    expect(p3).toEqual({ frames: [expect.objectContaining({ file_stem: frames[6], has_screenshot: false })], next_cursor: null, scanned: 1, partial: false })
    expect((await r.frames({ since: '2026-11-05T01:02:00Z', until: '2026-11-05T01:04:00Z' })).frames.map((f) => f.file_stem)).toEqual(frames.slice(2, 4))
    expect((await r.frames({ app_name: 'Cursor' })).frames.every((f) => f.app_name === 'Cursor')).toBe(true)
    expect((await r.frames({ limit: 10_000 })).frames.length).toBeLessThanOrEqual(100)
    await expect(r.frames({ cursor: '../x' })).rejects.toThrow(/cursor/)
  })

  test('screenshot: decrypts the runtime envelope; plaintext legacy refused (OG-D6b); failures are explicit', async () => {
    const key = randomBytes(32)
    const { root, frames } = runtimeRoot(key)
    const r = createRewindReader({ root: () => root, screenshotKey: () => key })
    const s = await r.screenshot(frames[0])
    expect([s.mime, s.encrypted, s.data.equals(JPEG)]).toEqual(['image/jpeg', true, true])
    await expect(r.screenshot(frames[5])).rejects.toMatchObject({ code: 'plaintext_refused' })
    await expect(r.screenshot(frames[6])).rejects.toThrow(/no screenshot/)
    await expect(createRewindReader({ root: () => root, screenshotKey: () => randomBytes(32) }).screenshot(frames[0])).rejects.toThrow(/decrypt failed/)
    await expect(createRewindReader({ root: () => root, screenshotKey: () => null }).screenshot(frames[0])).rejects.toThrow(/key is unavailable/)
    for (const bad of ['../env', '..%2Fenv', 'x', '2026-11-05T01-00-12p00-00/../../env']) await expect(r.screenshot(bad)).rejects.toThrow(/invalid file_stem/)
    expect(() => decryptEnvelope('PSOMEGCM1:AAAA', key)).toThrow()
  })

  test('via the Broker: image content, Access log says "image, not scrubbed", key never in any output', async () => {
    const key = randomBytes(32)
    const { root, frames } = runtimeRoot(key)
    const reader = createRewindReader({ root: () => root, screenshotKey: () => key })
    const b = await startBroker(fakeBackend({ rewindFrames: (q) => reader.frames(q), rewindScreenshot: (s) => reader.screenshot(s) }))
    cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }), () => b.audit.close(), () => b.broker.stop())
    const { token } = b.grants.create({ client: 'claude-code' })
    const c = await connectClient(b.url, token)
    cleanups.push(() => c.close())
    const r = await c.callTool({ name: 'view_rewind_screenshot', arguments: { file_stem: frames[0] } })
    const img = (r.content as Array<{ type: string; data?: string; mimeType?: string }>).find((x) => x.type === 'image')!
    expect([img.mimeType, Buffer.from(img.data!, 'base64').equals(JPEG)]).toEqual(['image/jpeg', true])
    const fr = await c.callTool({ name: 'rewind_frames', arguments: { limit: 2 } })
    expect(JSON.stringify(fr)).toContain(frames[1])
    const row = b.audit.list().find((x) => x.capability === 'view_rewind_screenshot')!
    expect(b.audit.preview(row.id)?.resultPreview).toContain('image, not scrubbed')
    const everything = JSON.stringify([r, fr, b.audit.list({ includeFailures: true }), b.audit.preview(row.id)])
    for (const k of [key.toString('hex'), key.toString('base64')]) expect(everything).not.toContain(k)
  })
})
