import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { LlmConfig } from '../src/config.ts'

export const API_KEY = 'sk-TESTKEY-' + 'k'.repeat(24)

export interface SseEvent {
  event: string
  data: Record<string, unknown>
}

export function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = []
  for (const block of text.split('\n\n')) {
    if (block.trim() === '') continue
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data.push(line.slice(6))
    }
    out.push({ event, data: JSON.parse(data.join('\n')) as Record<string, unknown> })
  }
  return out
}

export interface Seen {
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
  closed: Promise<void>
}

export interface FakeUpstream {
  base: string
  seen: Seen[]
  close(): Promise<void>
}

/** Fake OpenAI-compatible upstream. `handler` drives the response; requests are recorded. */
export async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void | Promise<void>): Promise<FakeUpstream> {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    let resolveClosed!: () => void
    const closed = new Promise<void>((r) => (resolveClosed = r))
    res.on('close', () => resolveClosed())
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      seen.push({ headers: req.headers, body, closed })
      void handler(req, res, body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    base: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
  }
}

export function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export function deltaChunk(text: string, finish: string | null = null): string {
  return chunk({ id: 'x', object: 'chat.completion.chunk', model: 'up-model', choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })
}

export function usageChunk(p: number, c: number): string {
  return chunk({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } })
}

export function sseHead(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
}

export function openaiCfg(base: string, over: Partial<LlmConfig> = {}): LlmConfig {
  return { mode: 'openai', baseUrl: base, apiKey: API_KEY, model: 'gpt-test', timeoutMs: 5000, maxTokens: 321, ...over }
}

export const MOCK: LlmConfig = { mode: 'mock', baseUrl: '', apiKey: '', model: 'mock', timeoutMs: 5000, maxTokens: 1500 }

export function items(n: number, text = (i: number) => `context text ${i}`): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ id: `ctx-${i + 1}`, kind: 'memory', title: `Title ${i + 1}`, text: text(i + 1), ref: `mem:${i + 1}` }))
}

export const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}
