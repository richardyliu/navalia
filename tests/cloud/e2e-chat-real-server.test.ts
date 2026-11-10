// S1-FULL C3–C7 ↔ C4: the Lens chat client against the REAL `cloud/` server in mock LLM mode
// (CLOUD_LLM_MODE=mock), spawned like tests/cloud/e2e-real-server.test.ts. Temp DB, temp Lens
// Store, throwaway identity, fake local Runtime (ossTool). No real ~/.persome, no real keys.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatEvent } from '../../src/main/cloud/chat-api'
import { createChatService } from '../../src/main/cloud/chat'
import { createCloudService } from '../../src/main/cloud/service'
import { fakeOss, SECRET } from './fake-runtime'
import { fakeBox, testIdentity } from './helpers'

let child: ChildProcess
let origin: string
let dir: string
let serverOut = ''

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-cloud-e2e-chat-'))
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve('cloud'),
    env: { PATH: process.env.PATH, PORT: String(port), CLOUD_DB_PATH: path.join(dir, 'db', 'cloud.db'), CLOUD_PUBLIC_ORIGIN: origin, CLOUD_LLM_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b) => (serverOut += String(b)))
  child.stderr?.on('data', (b) => (serverOut += String(b)))
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`cloud server did not start:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}, 20_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 200))
  if (path.basename(dir).startsWith('lens-cloud-e2e-chat-')) fs.rmSync(dir, { recursive: true, force: true })
})

describe('chat e2e: Lens chat client ↔ real cloud server (mock LLM)', () => {
  it('preview → send selected items → streamed mock answer with split [ctx-N] → citations resolved → usage', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-cloud-e2e-chat-store-'))
    try {
      const id = testIdentity()
      const cloud = createCloudService({ storeRoot: store, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true, nativeConfirm: async () => true })
      await cloud.configure({ enabled: true, baseUrl: origin, confirm: true })
      await cloud.signIn()
      const oss = fakeOss()
      const chat = createChatService({ storeRoot: store, cloud, ossTool: oss.ossTool, knownSecrets: () => [SECRET] })

      const p = await chat.preview({ question: '我这周在忙什么？' })
      const pick = p.items.slice(0, 2).map((i) => i.id)
      const events: ChatEvent[] = []
      const r = await chat.send({ previewId: p.previewId, includeIds: pick }, { send: (_c, e) => events.push(e as ChatEvent) })
      await chat.settled(r.streamId)

      const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
      expect(text.startsWith('（mock）收到 2 条上下文。')).toBe(true)
      for (const i of p.items.slice(0, 2)) expect(text).toContain(`- ${i.title} [${i.id}]`)
      expect(events.filter((e) => e.type === 'usage')).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: 'end', status: 'complete' })

      const a = chat.get(r.conversationId).messages[1]
      expect(a).toMatchObject({ role: 'assistant', status: 'complete', partial: false, usage: { estimated: true } })
      if (a.role !== 'assistant') throw new Error('expected assistant')
      expect(a.citations.map((c) => c.id)).toEqual(pick)

      const u = await chat.usage()
      expect(u.prompt_tokens + u.completion_tokens).toBeGreaterThan(0)

      // Follow-up keeps history; the server accepts it.
      const p2 = await chat.preview({ question: '继续', conversationId: r.conversationId })
      const r2 = await chat.send({ previewId: p2.previewId, includeIds: [] }, null)
      await chat.settled(r2.streamId)
      expect(chat.get(r.conversationId).messages.at(-1)).toMatchObject({ status: 'complete', content: '（mock）收到 0 条上下文。' })

      await new Promise((res) => setTimeout(res, 100))
      expect(serverOut.includes(SECRET)).toBe(false)
      expect(serverOut.includes('我这周在忙什么')).toBe(false)
    } finally {
      if (path.basename(store).startsWith('lens-cloud-e2e-chat-store-')) fs.rmSync(store, { recursive: true, force: true })
    }
  })
})

describe('Phase 1 gate: "我这周在做什么" end to end (real server, mock LLM)', () => {
  it('preview == exactly what goes on the wire; no images / screenshot paths / DB / token leave; cited answer; remember write-back', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-cloud-e2e-chat-store-'))
    try {
      const id = testIdentity()
      const wire: string[] = []
      const capture = async (input: string, init: RequestInit): Promise<Response> => {
        if (input.endsWith('/v1/chat/completions') && typeof init.body === 'string') wire.push(init.body)
        return fetch(input, init)
      }
      const cloud = createCloudService({ storeRoot: store, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true, nativeConfirm: async () => true, fetch: capture })
      await cloud.configure({ enabled: true, baseUrl: origin, confirm: true })
      await cloud.signIn()
      const oss = fakeOss({ remember: () => ({ entry_id: 'mem-gate-1', file: 'agent-run.md', tags: ['lens-chat', 'cloud-chat'] }) })
      let confirmed = 0
      const chat = createChatService({ storeRoot: store, cloud, ossTool: oss.ossTool, knownSecrets: () => [SECRET], nativeConfirm: async () => (++confirmed, true) })

      const p = await chat.preview({ question: '我这周在做什么' })
      expect(p.items.length).toBeGreaterThan(0)
      const all = p.items.map((i) => i.id)
      const r = await chat.send({ previewId: p.previewId, includeIds: all }, null)
      await chat.settled(r.streamId)

      // Exactly one chat request; its context equals the previewed items byte for byte.
      expect(wire).toHaveLength(1)
      const body = JSON.parse(wire[0]) as { messages: Array<{ role: string; content: string }>; context: { items: Array<{ id: string; title: string; text: string }> } }
      expect(body.messages.at(-1)).toEqual({ role: 'user', content: '我这周在做什么' })
      expect(body.context.items.map((i) => [i.id, i.title, i.text])).toEqual(p.items.map((i) => [i.id, i.title, i.text]))
      // Nothing that must stay local crosses the wire.
      for (const banned of [SECRET, 'data:image', 'iVBORw0KGgo', '.png', 'screenshots/', 'index.db', '13812345678', id.getPublicIdentity()!.public_key]) {
        expect(wire[0].includes(banned), `wire contains ${banned}`).toBe(false)
      }
      for (const k of Object.keys(body)) expect(['messages', 'context', 'task']).toContain(k)

      // Cited answer, citations resolve to the snapshots that were sent.
      const a = chat.get(r.conversationId).messages[1]
      if (a.role !== 'assistant') throw new Error('expected assistant')
      expect(a.status).toBe('complete')
      expect(a.citations.length).toBeGreaterThan(0)
      for (const c of a.citations) expect(a.content).toContain(`[${c.id}]`)

      // 「记住这条」: preview shows exact text + source, native confirm, MCP remember with tags.
      const pv = chat.rememberPreview({ conversationId: r.conversationId, messageIndex: 1 })
      expect(pv.content).toContain(a.content)
      expect(pv.content).toContain(r.conversationId)
      const w = await chat.remember(pv.rememberId, null)
      expect(w.entryId).toBe('mem-gate-1')
      expect(confirmed).toBe(1)
      const call = oss.calls.find((c) => c.name === 'remember')!
      expect(call.args).toEqual({ content: pv.content, tags: 'lens-chat,cloud-chat' })
      expect(chat.get(r.conversationId).messages[1]).toMatchObject({ rememberedEntryId: 'mem-gate-1' })

      // Server never logged question / context / answer.
      await new Promise((res) => setTimeout(res, 100))
      for (const s of ['我这周在做什么', ...p.items.map((i) => i.text.slice(0, 20)), a.content.slice(0, 20)]) expect(serverOut.includes(s)).toBe(false)
    } finally {
      if (path.basename(store).startsWith('lens-cloud-e2e-chat-store-')) fs.rmSync(store, { recursive: true, force: true })
    }
  })
})
