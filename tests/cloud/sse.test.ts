// SSE parser over hand-built chunked byte streams, plus client.stream against a local server.
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { CloudError } from '../../src/main/cloud/errors'
import { createCloudService } from '../../src/main/cloud/service'
import { parseSse, type SseEvent } from '../../src/main/cloud/sse'
import { fakeBox, startFakeServer, tempStore, testIdentity, type FakeServer, LOOPBACK } from './helpers'

function streamOf(chunks: Array<string | Uint8Array>, opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) {
        const c = chunks[i++]
        ctrl.enqueue(typeof c === 'string' ? enc.encode(c) : c)
      } else if (!opts.hang) ctrl.close()
      // hang: never close (simulates an open connection)
    }
  })
}

/** Split bytes into chunks of size n (to cut lines and UTF-8 sequences anywhere). */
function bytesIn(text: string, n: number): Uint8Array[] {
  const b = new TextEncoder().encode(text)
  const out: Uint8Array[] = []
  for (let i = 0; i < b.length; i += n) out.push(b.slice(i, i + n))
  return out
}

async function collect(s: ReadableStream<Uint8Array>, opts?: Parameters<typeof parseSse>[1]): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const ev of parseSse(s, opts)) out.push(ev)
  return out
}

describe('parseSse', () => {
  it('parses event / data / id, default event name', async () => {
    const evs = await collect(streamOf(['event: delta\ndata: {"t":"hi"}\nid: 1\n\ndata: plain\n\n']))
    expect(evs).toEqual([
      { event: 'delta', data: '{"t":"hi"}', id: '1' },
      { event: 'message', data: 'plain', id: '1' }
    ])
  })

  it('joins multi-line data with \\n and strips exactly one leading space', async () => {
    const evs = await collect(streamOf(['data: a\ndata:b\ndata:  c\ndata\n\n']))
    expect(evs).toEqual([{ event: 'message', data: 'a\nb\n c\n', id: null }])
  })

  it('ignores comments, unknown fields, retry, and events without data', async () => {
    const evs = await collect(streamOf([': keep-alive\n\nretry: 100\nfoo: bar\n\nevent: ping\n\n:c\ndata: x\n\n']))
    expect(evs).toEqual([{ event: 'message', data: 'x', id: null }])
  })

  it('CRLF, lone CR and LF line endings all work', async () => {
    const evs = await collect(streamOf(['data: a\r\n\r\ndata: b\r\rdata: c\n\n']))
    expect(evs.map((e) => e.data)).toEqual(['a', 'b', 'c'])
  })

  it('a CRLF split across chunks is one line break, not two', async () => {
    const evs = await collect(streamOf(['data: a\r', '\ndata: b\r', '\n\r', '\n']))
    expect(evs).toEqual([{ event: 'message', data: 'a\nb', id: null }])
  })

  it('a trailing CR at EOF still terminates the line', async () => {
    const evs = await collect(streamOf(['data: a\r\r']))
    expect(evs.map((e) => e.data)).toEqual(['a'])
  })

  it('handles lines and multi-byte UTF-8 split at every possible byte boundary', async () => {
    const text = 'event: 回答\ndata: 你好，世界 🌏\ndata: ok\n\ndata: ü\n\n'
    for (const n of [1, 2, 3, 5, 7]) {
      const evs = await collect(streamOf(bytesIn(text, n)))
      expect(evs, `chunk ${n}`).toEqual([
        { event: '回答', data: '你好，世界 🌏\nok', id: null },
        { event: 'message', data: 'ü', id: null }
      ])
    }
  })

  it('strips a leading UTF-8 BOM', async () => {
    const evs = await collect(streamOf([new Uint8Array([0xef, 0xbb]), new Uint8Array([0xbf]), 'data: x\n\n']))
    expect(evs).toEqual([{ event: 'message', data: 'x', id: null }])
  })

  it('[DONE] ends the stream without being yielded; later events are not read', async () => {
    const evs = await collect(streamOf(['data: 1\n\ndata: [DONE]\n\ndata: 2\n\n']))
    expect(evs.map((e) => e.data)).toEqual(['1'])
    const all = await collect(streamOf(['data: 1\n\ndata: [DONE]\n\n']), { doneSentinel: null })
    expect(all.map((e) => e.data)).toEqual(['1', '[DONE]'])
  })

  it('[DONE] stops even if the server keeps the connection open', async () => {
    const evs = await collect(streamOf(['data: 1\n\ndata: [DONE]\n\n'], { hang: true }))
    expect(evs.map((e) => e.data)).toEqual(['1'])
  })

  it('discards an unterminated event at EOF', async () => {
    const evs = await collect(streamOf(['data: 1\n\ndata: partial']))
    expect(evs.map((e) => e.data)).toEqual(['1'])
  })

  it('id with NUL is ignored; id persists across events', async () => {
    const evs = await collect(streamOf(['id: 7\ndata: a\n\nid: bad\0\ndata: b\n\n']))
    expect(evs.map((e) => e.id)).toEqual(['7', '7'])
  })

  it('too_large when one event exceeds the bound (across many data lines)', async () => {
    const lines = Array.from({ length: 50 }, () => `data: ${'x'.repeat(100)}\n`).join('')
    await expect(collect(streamOf([lines, '\n']), { maxEventBytes: 1024 })).rejects.toMatchObject({ code: 'too_large' })
  })

  it('too_large when a single line never ends', async () => {
    const chunks = Array.from({ length: 20 }, () => 'data: ' + 'y'.repeat(200))
    await expect(collect(streamOf(chunks, { hang: true }), { maxEventBytes: 1024 })).rejects.toBeInstanceOf(CloudError)
  })

  it('events within the bound pass; the bound resets per event', async () => {
    const one = `data: ${'z'.repeat(900)}\n\n`
    const evs = await collect(streamOf([one, one, one]), { maxEventBytes: 1024 })
    expect(evs).toHaveLength(3)
  })

  it('AbortSignal stops a hanging stream', async () => {
    const ac = new AbortController()
    const it = parseSse(streamOf(['data: 1\n\n'], { hang: true }), { signal: ac.signal })
    expect((await it.next()).value).toMatchObject({ data: '1' })
    const pending = it.next()
    setTimeout(() => ac.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('an already-aborted signal throws before reading', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(collect(streamOf(['data: 1\n\n']), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('consumer break cancels the underlying stream', async () => {
    let cancelled = false
    const s = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('data: x\n\n'))
      },
      cancel() {
        cancelled = true
      }
    })
    for await (const _ of parseSse(s)) break
    expect(cancelled).toBe(true)
  })
})

describe('client.stream against a local server', () => {
  const roots: string[] = []
  let server: FakeServer | null = null
  afterEach(async () => {
    await server?.close()
    server = null
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
  })

  async function signedIn() {
    server = await startFakeServer()
    const root = tempStore(roots)
    writeCloudConfig(cloudPaths(root).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
    const id = testIdentity()
    const svc = createCloudService({ storeRoot: root, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true })
    await svc.signIn()
    return svc
  }

  it('streams events with the bearer, split across TCP writes, until [DONE]', async () => {
    const svc = await signedIn()
    let auth = ''
    let body = ''
    server!.override = (req, res, b) => {
      if (req.url !== '/v1/chat') return false
      auth = req.headers.authorization ?? ''
      body = b
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const text = 'event: delta\ndata: 你\r\n\r\nevent: delta\ndata: 好\n\ndata: [DONE]\n\n'
      const parts = bytesIn(text, 4)
      let i = 0
      const tick = (): void => {
        if (i < parts.length) {
          res.write(Buffer.from(parts[i++]))
          setTimeout(tick, 1)
        } // connection left open after [DONE]
      }
      tick()
      return true
    }
    const evs: SseEvent[] = []
    for await (const ev of svc.client.stream('/v1/chat', { q: 'hi' })) evs.push(ev)
    expect(evs.map((e) => e.data)).toEqual(['你', '好'])
    expect(auth).toBe(`Bearer ${server!.issued[0]}`)
    expect(JSON.parse(body)).toEqual({ q: 'hi' })
  })

  it('maps non-2xx and wrong content-type, and user abort ends quietly', async () => {
    const svc = await signedIn()
    server!.override = (req, res) => {
      if (req.url === '/v1/limited') {
        res.writeHead(429, { 'retry-after': '3', 'content-type': 'application/json' })
        res.end('{}')
        return true
      }
      if (req.url === '/v1/html') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>')
        return true
      }
      if (req.url === '/v1/hang') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        return true
      }
      return false
    }
    const drain = async (g: AsyncGenerator<SseEvent>): Promise<string[]> => {
      const out: string[] = []
      for await (const e of g) out.push(e.data)
      return out
    }
    await expect(drain(svc.client.stream('/v1/limited', {}))).rejects.toMatchObject({ code: 'rate_limited', retryAfterS: 3 })
    await expect(drain(svc.client.stream('/v1/html', {}))).rejects.toMatchObject({ code: 'bad_response' })
    const ac = new AbortController()
    const got: string[] = []
    for await (const e of svc.client.stream('/v1/hang', {}, { signal: ac.signal })) {
      got.push(e.data)
      setTimeout(() => ac.abort(), 10)
    }
    expect(got).toEqual(['first'])
  })
})
