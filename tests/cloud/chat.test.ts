// S1-FULL C5 / C6 / C7: preview → send of exactly the selected stored items, SSE → events to the
// sender, persisted conversation with resolved citations, cancel, error mapping, delete, remember
// via fake MCP with native confirm, IPC zod rejection of renderer-supplied text. Fake chat server
// (node:http) follows the C4 contract, including split [ctx-N] markers across 7-char deltas.
import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_CHANNELS, CHAT_EVENT_CHANNEL, type ChatEvent } from '../../src/main/cloud/chat-api'
import { createChatService, type ChatService } from '../../src/main/cloud/chat'
import { registerChatHandlers } from '../../src/main/cloud/chat-ipc'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { fakeOss, SECRET } from './fake-runtime'
import { errBody, fakeBox, fakeIpc, LOOPBACK, startFakeServer, tempStore, testIdentity, type FakeServer } from './helpers'

type Mode = 'mock' | 'mid_error' | 'quota' | 'llm_unavailable' | 'upstream_timeout' | 'hang' | 'no_done' | 'length'

const roots: string[] = []
let server: FakeServer
let mode: Mode
let bodies: Array<Record<string, unknown>>
let root: string
let cloud: CloudService
let hangingRes: http.ServerResponse | null


function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function json(res: http.ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(s)
}

function installChatRoutes(): void {
  server.override = (req, res, body) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (req.url === '/v1/usage' && req.method === 'GET') {
      if (!bearer || !server.issued.includes(bearer)) return (json(res, 401, errBody('unauthorized', 'x')), true)
      json(res, 200, { day: '2026-11-05', prompt_tokens: 120, completion_tokens: 30, limit: 100000 })
      return true
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return false
    if (!bearer || !server.issued.includes(bearer)) return (json(res, 401, errBody('unauthorized', `token ${bearer}`)), true)
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }>; context?: { items: Array<{ id: string; title: string }> }; task: string }
    bodies.push(parsed as unknown as Record<string, unknown>)
    if (mode === 'quota') return (json(res, 429, errBody('quota_exceeded', `quota for ${bearer}`), { 'retry-after': '3600' }), true)
    if (mode === 'llm_unavailable') return (json(res, 503, errBody('llm_unavailable', 'no llm')), true)
    if (mode === 'upstream_timeout') return (json(res, 502, errBody('upstream_timeout', 'slow')), true)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const items = parsed.context?.items ?? []
    let text = `（mock）收到 ${items.length} 条上下文。`
    for (const it of items.slice(0, 3)) text += `\n- ${it.title} [${it.id}]`
    if (mode === 'hang') {
      sse(res, 'delta', { text: '部分回答' })
      hangingRes = res
      return true
    }
    if (mode === 'mid_error') {
      sse(res, 'delta', { text: '写了一半' })
      sse(res, 'error', { code: 'upstream_error', message: `secret ${bearer}` })
      sse(res, 'usage', { prompt_tokens: 10, completion_tokens: 2, model: 'mock', estimated: true })
      sse(res, 'done', { finish_reason: 'error', citations: [] })
      res.end()
      return true
    }
    for (let i = 0; i < text.length; i += 7) sse(res, 'delta', { text: text.slice(i, i + 7) })
    if (mode === 'no_done') return (res.end(), true)
    sse(res, 'usage', { prompt_tokens: 50, completion_tokens: 20, model: 'mock', estimated: true })
    sse(res, 'done', { finish_reason: mode === 'length' ? 'length' : 'stop', citations: [...items.slice(0, 3).map((i) => i.id), 'ctx-99'] })
    res.end()
    return true
  }
}

function sender() {
  const events: ChatEvent[] = []
  return {
    events,
    s: {
      send: (ch: string, p: unknown) => {
        expect(ch).toBe(CHAT_EVENT_CHANNEL)
        events.push(p as ChatEvent)
      },
      isDestroyed: () => false
    }
  }
}

function chatService(extra: Partial<Parameters<typeof createChatService>[0]> = {}): { chat: ChatService; oss: ReturnType<typeof fakeOss>; confirm: ReturnType<typeof vi.fn> } {
  const oss = fakeOss({ remember: () => ({ entry_id: 'mem-new-1', file: 'agent-run.md', tags: ['lens-chat', 'cloud-chat'] }) })
  const confirm = vi.fn(async () => true)
  const chat = createChatService({ storeRoot: root, cloud, ossTool: oss.ossTool, knownSecrets: () => [SECRET], nativeConfirm: confirm, now: () => new Date('2026-11-05T10:00:00+08:00'), ...extra })
  return { chat, oss, confirm }
}

beforeEach(async () => {
  server = await startFakeServer()
  mode = 'mock'
  bodies = []
  hangingRes = null
  installChatRoutes()
  root = tempStore(roots)
  writeCloudConfig(cloudPaths(root).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
  const id = testIdentity()
  cloud = createCloudService({ storeRoot: root, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true })
  await cloud.signIn()
})

afterEach(async () => {
  hangingRes?.end()
  await server.close()
  // `roots` holds the mkdtemp dirs themselves (tempStore returns <dir>/store).
  for (const r of roots.splice(0)) {
    if (!path.basename(r).startsWith('lens-cloud-')) throw new Error(`refusing to delete ${r}`)
    fs.rmSync(r, { recursive: true, force: true })
  }
})

describe('C5 chat: preview → send → stream → persist', () => {
  it('sends exactly the selected stored items; events go to the sender; citations resolved; file 0600 / dir 0700', async () => {
    const { chat } = chatService()
    const p = await chat.preview({ question: '我这周主要在忙什么？' })
    expect(p.items.length).toBeGreaterThanOrEqual(4)
    const pick = [p.items[1].id, p.items[3].id]
    const { s, events } = sender()
    const started = await chat.send({ previewId: p.previewId, includeIds: pick }, s)
    expect(started.streamId).toMatch(/^[0-9a-f]{32}$/)
    await chat.settled(started.streamId)

    // Wire body: exactly the two stored snapshots, the question fixed at preview time, task chat.
    expect(bodies).toHaveLength(1)
    const body = bodies[0] as { messages: unknown[]; context: { items: Array<Record<string, unknown>> }; task: string }
    expect(body.task).toBe('chat')
    expect(body.messages).toEqual([{ role: 'user', content: '我这周主要在忙什么？' }])
    const expected = [p.items[1], p.items[3]].map(({ id, kind, title, text, ref }) => (ref === null ? { id, kind, title, text } : { id, kind, title, text, ref }))
    expect(body.context.items).toEqual(expected)
    expect(JSON.stringify(bodies)).not.toContain(SECRET)
    expect(Object.keys(body).sort()).toEqual(['context', 'messages', 'task'])

    // Events (only to this sender), deltas reassemble to the mock text with split markers.
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe(`（mock）收到 2 条上下文。\n- ${p.items[1].title} [${pick[0]}]\n- ${p.items[3].title} [${pick[1]}]`)
    expect(events.some((e) => e.type === 'delta' && (e as { text: string }).text.includes('[ctx-') && !(e as { text: string }).text.includes(']'))).toBe(true)
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { model: 'mock', estimated: true } })
    expect(events.at(-1)).toEqual({ streamId: started.streamId, type: 'end', status: 'complete', conversationId: started.conversationId })
    expect(events.every((e) => e.streamId === started.streamId)).toBe(true)

    // Persisted conversation.
    const conv = chat.get(started.conversationId)
    expect(conv.messages).toHaveLength(2)
    const a = conv.messages[1]
    if (a.role !== 'assistant') throw new Error('expected assistant')
    expect(a).toMatchObject({ content: text, status: 'complete', partial: false, errorCode: null, task: 'chat', usage: { prompt_tokens: 50, completion_tokens: 20 } })
    expect(a.context.map((i) => i.id)).toEqual(pick)
    // ctx-99 (not sent) is dropped; the two sent ones resolve to their snapshots.
    expect(a.citations).toEqual([p.items[1], p.items[3]])
    const file = path.join(root, 'chat', `${started.conversationId}.json`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(chat.list()).toEqual([{ id: started.conversationId, title: '我这周主要在忙什么？', updatedAt: a.at, messages: 2 }])

    // The preview is single use.
    await expect(chat.send({ previewId: p.previewId, includeIds: pick }, s)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a follow-up in the same conversation sends the history; unknown ids are refused', async () => {
    const { chat } = chatService()
    const p1 = await chat.preview({ question: '第一问' })
    const r1 = await chat.send({ previewId: p1.previewId, includeIds: [] }, null)
    await chat.settled(r1.streamId)
    const p2 = await chat.preview({ question: '第二问', conversationId: r1.conversationId })
    await expect(chat.send({ previewId: p2.previewId, includeIds: ['ctx-77'] }, null)).rejects.toMatchObject({ code: 'invalid_args' })
    const r2 = await chat.send({ previewId: p2.previewId, includeIds: [] }, null)
    expect(r2.conversationId).toBe(r1.conversationId)
    await chat.settled(r2.streamId)
    const msgs = (bodies[1] as { messages: Array<{ role: string; content: string }> }).messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[2].content).toBe('第二问')
    expect(bodies[1]).toMatchObject({ context: { items: [] } })
    expect(chat.get(r1.conversationId).messages).toHaveLength(4)
  })

  it('cancel aborts the stream and persists the partial text marked cancelled', async () => {
    mode = 'hang'
    const { chat } = chatService()
    const p = await chat.preview({ question: '长回答' })
    const { s, events } = sender()
    const r = await chat.send({ previewId: p.previewId, includeIds: [] }, s)
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'delta'); i++) await new Promise((res) => setTimeout(res, 10))
    expect(chat.cancel(r.streamId)).toBe(true)
    await chat.settled(r.streamId)
    const a = chat.get(r.conversationId).messages[1]
    expect(a).toMatchObject({ role: 'assistant', content: '部分回答', status: 'cancelled', partial: true })
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'cancelled' })
    expect(chat.cancel(r.streamId)).toBe(false)
  })

  it('mid-stream upstream error ⇒ partial text kept, status error, usage still recorded; no server text leaks', async () => {
    mode = 'mid_error'
    const { chat } = chatService()
    const p = await chat.preview({ question: '问' })
    const { s, events } = sender()
    const r = await chat.send({ previewId: p.previewId, includeIds: [] }, s)
    await chat.settled(r.streamId)
    const a = chat.get(r.conversationId).messages[1]
    expect(a).toMatchObject({ content: '写了一半', status: 'error', partial: true, errorCode: 'upstream_error', usage: { estimated: true } })
    const err = events.find((e) => e.type === 'error') as { code: string; message: string }
    expect(err.code).toBe('upstream_error')
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(JSON.stringify(events)).not.toContain('tok_')
  })

  it('stream ending without done ⇒ error / partial; finish_reason length ⇒ truncated', async () => {
    mode = 'no_done'
    const { chat } = chatService()
    let p = await chat.preview({ question: '问' })
    let r = await chat.send({ previewId: p.previewId, includeIds: [] }, null)
    await chat.settled(r.streamId)
    expect(chat.get(r.conversationId).messages[1]).toMatchObject({ status: 'error', partial: true, errorCode: 'bad_response' })
    mode = 'length'
    p = await chat.preview({ question: '问' })
    r = await chat.send({ previewId: p.previewId, includeIds: [] }, null)
    await chat.settled(r.streamId)
    expect(chat.get(r.conversationId).messages[1]).toMatchObject({ status: 'truncated', partial: true })
  })

  it.each([
    ['quota', 'quota_exceeded', 3600],
    ['llm_unavailable', 'llm_unavailable', undefined],
    ['upstream_timeout', 'upstream_timeout', undefined]
  ] as const)('pre-stream %s ⇒ %s error event, message fixed', async (m, code, retry) => {
    mode = m
    const { chat } = chatService()
    const p = await chat.preview({ question: '问' })
    const { s, events } = sender()
    const r = await chat.send({ previewId: p.previewId, includeIds: [] }, s)
    await chat.settled(r.streamId)
    const err = events.find((e) => e.type === 'error') as { code: string; message: string }
    expect(err.code).toBe(code)
    expect(err.message).not.toMatch(/tok_|quota for|no llm|slow/)
    if (retry) expect(err.message).toContain(`retry in ${retry}s`)
    expect(chat.get(r.conversationId).messages[1]).toMatchObject({ status: 'error', errorCode: code, content: '' })
  })

  it('cloud disabled ⇒ preview works locally, send fails disabled with no request; signed out ⇒ unauthorized', async () => {
    const { chat } = chatService()
    await cloud.signOut()
    let p = await chat.preview({ question: '问' })
    expect(p.items.length).toBeGreaterThan(0)
    await expect(chat.send({ previewId: p.previewId, includeIds: [] }, null)).rejects.toMatchObject({ code: 'unauthorized' })
    await cloud.configure({ enabled: false, baseUrl: server.origin })
    p = await chat.preview({ question: '问' })
    await expect(chat.send({ previewId: p.previewId, includeIds: [] }, null)).rejects.toMatchObject({ code: 'disabled' })
    expect(bodies).toHaveLength(0)
    expect(chat.list()).toEqual([])
  })

  it('preview LRU is bounded and expires after the TTL', async () => {
    let t = new Date('2026-11-05T10:00:00Z').getTime()
    const { chat } = chatService({ maxPreviews: 2, now: () => new Date(t) })
    const a = await chat.preview({ question: 'a' })
    await chat.preview({ question: 'b' })
    await chat.preview({ question: 'c' })
    await expect(chat.send({ previewId: a.previewId, includeIds: [] }, null)).rejects.toMatchObject({ code: 'not_found' })
    const d = await chat.preview({ question: 'd' })
    t += 16 * 60_000
    await expect(chat.send({ previewId: d.previewId, includeIds: [] }, null)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('delete removes the local file; usage reads /v1/usage', async () => {
    const { chat } = chatService()
    const p = await chat.preview({ question: '问' })
    const r = await chat.send({ previewId: p.previewId, includeIds: [] }, null)
    await chat.settled(r.streamId)
    const file = path.join(root, 'chat', `${r.conversationId}.json`)
    expect(fs.existsSync(file)).toBe(true)
    expect(chat.delete(r.conversationId)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(chat.delete(r.conversationId)).toBe(false)
    expect(() => chat.get(r.conversationId)).toThrow()
    expect(() => chat.delete('../../etc/passwd')).toThrow()
    expect(await chat.usage()).toEqual({ day: '2026-11-05', prompt_tokens: 120, completion_tokens: 30, limit: 100000 })
  })
})

describe('C6 remember', () => {
  it('previews the exact text + source line, needs native confirm, writes via MCP remember with tags, records entry id', async () => {
    const { chat, oss, confirm } = chatService()
    const p = await chat.preview({ question: '问' })
    const r = await chat.send({ previewId: p.previewId, includeIds: [p.items[0].id] }, null)
    await chat.settled(r.streamId)
    const pv = chat.rememberPreview({ conversationId: r.conversationId, messageIndex: 1 })
    expect(pv.tags).toEqual(['lens-chat', 'cloud-chat'])
    expect(pv.content).toContain('（mock）收到 1 条上下文。')
    expect(pv.content).toContain(`来源：Navalia Chat ${r.conversationId} · 引用 ctx-1 (mem-a)`)
    expect(() => chat.rememberPreview({ conversationId: r.conversationId, messageIndex: 0 })).toThrow()

    confirm.mockResolvedValueOnce(false)
    await expect(chat.remember(pv.rememberId, { id: 1 })).rejects.toMatchObject({ code: 'cancelled' })
    expect(oss.calls.some((c) => c.name === 'remember')).toBe(false)

    expect(await chat.remember(pv.rememberId, { id: 1 })).toEqual({ entryId: 'mem-new-1' })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1][0]).toEqual({ id: 1 })
    const call = oss.calls.find((c) => c.name === 'remember')!
    expect(call.args).toEqual({ content: pv.content, tags: 'lens-chat,cloud-chat' })
    expect(chat.get(r.conversationId).messages[1]).toMatchObject({ rememberedEntryId: 'mem-new-1' })
    await expect(chat.remember(pv.rememberId, null)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('without nativeConfirm nothing is written', async () => {
    const { chat, oss } = chatService({ nativeConfirm: undefined })
    const p = await chat.preview({ question: '问' })
    const r = await chat.send({ previewId: p.previewId, includeIds: [] }, null)
    await chat.settled(r.streamId)
    const pv = chat.rememberPreview({ conversationId: r.conversationId, messageIndex: 1 })
    await expect(chat.remember(pv.rememberId, null)).rejects.toMatchObject({ code: 'cancelled' })
    expect(oss.calls.some((c) => c.name === 'remember')).toBe(false)
  })
})

describe('C7 WeChat digest', () => {
  it('group_digest task with capture items; empty captures ⇒ honest empty preview and send refused', async () => {
    const caps = [
      { file_stem: 'f1', timestamp: '2026-11-04T10:00:00+08:00', app_name: 'WeChat', bundle_id: 'com.tencent.xinWeChat', window_title: '产品群', snippet: '周五发版' }
    ]
    let oss = fakeOss({ search_captures: () => ({ results: caps }) })
    let chat = createChatService({ storeRoot: root, cloud, ossTool: oss.ossTool, now: () => new Date('2026-11-05T10:00:00+08:00') })
    const p = await chat.wechatPreview({})
    expect(p.task).toBe('group_digest')
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ kind: 'capture', title: '微信 · 产品群（1 次采集）' })
    const r = await chat.send({ previewId: p.previewId, includeIds: ['ctx-1'] }, null)
    await chat.settled(r.streamId)
    expect(bodies[0]).toMatchObject({ task: 'group_digest', context: { items: [{ id: 'ctx-1', kind: 'capture', ref: 'capture:f1' }] } })
    expect(chat.get(r.conversationId).title).toBe('微信群整理')

    oss = fakeOss({ search_captures: () => ({ results: [] }) })
    chat = createChatService({ storeRoot: root, cloud, ossTool: oss.ossTool })
    const e = await chat.wechatPreview({ keyword: '发版' })
    expect(e.items).toEqual([])
    expect(e.warnings.join()).toContain('No WeChat content was found')
    await expect(chat.send({ previewId: e.previewId, includeIds: [] }, null)).rejects.toMatchObject({ code: 'invalid_args' })
  })
})

describe('chat IPC', () => {
  it('zod rejects renderer-supplied text / context / unknown keys; events go to the invoking sender only', async () => {
    const { chat } = chatService()
    const ipc = fakeIpc()
    registerChatHandlers(ipc, chat)
    expect(ipc.channels().sort()).toEqual(Object.values(CHAT_CHANNELS).sort())
    const pv = (await ipc.invoke(CHAT_CHANNELS.preview, { question: '问' })) as { ok: true; data: { previewId: string; items: Array<{ id: string }> } }
    expect(pv.ok).toBe(true)
    for (const bad of [
      { previewId: pv.data.previewId, includeIds: ['ctx-1'], context: [{ id: 'ctx-1', text: 'injected' }] },
      { previewId: pv.data.previewId, includeIds: [{ id: 'ctx-1', text: 'injected' }] },
      { previewId: pv.data.previewId, includeIds: ['ctx-1'], question: 'other' },
      { previewId: 'nope', includeIds: [] },
      { previewId: pv.data.previewId }
    ]) {
      expect(await ipc.invoke(CHAT_CHANNELS.send, bad)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    }
    expect(await ipc.invoke(CHAT_CHANNELS.preview, { question: '' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await ipc.invoke(CHAT_CHANNELS.get, { conversationId: '../x' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await ipc.invoke(CHAT_CHANNELS.list, { x: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(bodies).toHaveLength(0)

    // fakeIpc's event sender has no `send`: the stream runs, nothing is emitted, message persisted.
    const sent = (await ipc.invoke(CHAT_CHANNELS.send, { previewId: pv.data.previewId, includeIds: ['ctx-1'] })) as { ok: true; data: { streamId: string; conversationId: string } }
    expect(sent.ok).toBe(true)
    await chat.settled(sent.data.streamId)
    expect((bodies[0] as { context: { items: Array<{ text: string }> } }).context.items[0].text).not.toBe('injected')
    expect(await ipc.invoke(CHAT_CHANNELS.list)).toMatchObject({ ok: true, data: [{ id: sent.data.conversationId }] })
  })
})
