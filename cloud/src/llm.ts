// LLM adapters for /v1/chat/completions.
//
// - `openai`: any OpenAI-compatible POST {base}/chat/completions with stream:true.
//   No retries. The API key goes only into the upstream Authorization header; it is
//   never logged and never appears in any error we produce (upstream bodies are
//   discarded, not forwarded).
// - `mock`: deterministic, no network. Used by tests and Lens E2E.

import type { LlmConfig } from './config.ts'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'finish'; reason: 'stop' | 'length' }

export interface LlmStream {
  model: string
  events: AsyncIterable<LlmEvent>
}

export type LlmErrorCode = 'upstream_error' | 'upstream_timeout' | 'aborted'

/** Safe-to-show failure. `message` never contains upstream bodies, URLs or keys. */
export class LlmError extends Error {
  readonly code: LlmErrorCode
  constructor(code: LlmErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface MockItem {
  id: string
  title: string
  text?: string
}

export interface LlmCall {
  messages: LlmMessage[]
  /** Client-disconnect signal. */
  signal: AbortSignal
  /** Only the mock reads this (to produce deterministic citations). */
  items: MockItem[]
  /** Only the mock reads this (workflow_extract → JSON output). The real prompt is already in `messages`. */
  task?: string
}

export interface LlmAdapter {
  /** Resolves once the upstream accepted the request (headers OK); rejects with LlmError otherwise. */
  start(call: LlmCall): Promise<LlmStream>
}

export function createAdapter(cfg: LlmConfig): LlmAdapter | null {
  if (cfg.mode === 'mock') return mockAdapter(cfg.model || 'mock')
  if (cfg.mode === 'openai') return openaiAdapter(cfg)
  return null
}

// ---------------------------------------------------------------- mock

export function mockAnswer(items: MockItem[]): string {
  let s = `（mock）收到 ${items.length} 条上下文。`
  for (const it of items.slice(0, 3)) s += `\n- ${it.title.replace(/\s+/g, ' ').trim()} [${it.id}]`
  return s
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Deterministic workflow_extract output: one step per item for the first ≤ 3 items, each citing
 * that item; no artifacts / rules / problems. Valid JSON inside a ```json fence (as the prompt asks).
 */
export function mockWorkflowAnswer(items: MockItem[]): string {
  const first = items.slice(0, 3)
  const wf = {
    title: first.length > 0 ? `（mock）工作流：${oneLine(first[0].title, 80) || first[0].id}` : '（mock）工作流',
    steps: first.map((it) => ({
      title: oneLine(it.title, 120) || it.id,
      detail: oneLine(it.text ?? '', 200),
      cites: [it.id]
    })),
    artifacts: [],
    rules: [],
    problems: []
  }
  return '```json\n' + JSON.stringify(wf, null, 2) + '\n```'
}

function mockAdapter(model: string): LlmAdapter {
  return {
    async start(call) {
      if (call.signal.aborted) throw new LlmError('aborted', 'aborted')
      const text = call.task === 'workflow_extract' ? mockWorkflowAnswer(call.items) : mockAnswer(call.items)
      // Split into several deltas, deliberately cutting through a [ctx-N] marker
      // so clients must concatenate before parsing citations.
      const parts: string[] = []
      const step = 7
      for (let i = 0; i < text.length; i += step) parts.push(text.slice(i, i + step))
      async function* events(): AsyncGenerator<LlmEvent> {
        for (const p of parts) {
          await new Promise((r) => setImmediate(r))
          if (call.signal.aborted) throw new LlmError('aborted', 'aborted')
          yield { type: 'delta', text: p }
        }
        yield { type: 'finish', reason: 'stop' }
      }
      return { model, events: events() }
    }
  }
}

// ---------------------------------------------------------------- openai

/**
 * Incremental parser for an SSE byte stream. Handles arbitrary chunk splits,
 * including inside multi-byte UTF-8 sequences and between \r and \n.
 * Returns the `data` payload of each completed event.
 */
export class SseParser {
  private readonly dec = new TextDecoder('utf-8')
  private buf = ''
  private data: string[] = []

  push(chunk: Uint8Array): string[] {
    this.buf += this.dec.decode(chunk, { stream: true })
    return this.drain(false)
  }

  end(): string[] {
    this.buf += this.dec.decode()
    return this.drain(true)
  }

  private drain(final: boolean): string[] {
    const out: string[] = []
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf)
      if (!m) break
      // A lone trailing \r may be the first half of \r\n: wait for more input.
      if (m[0] === '\r' && m.index === this.buf.length - 1 && !final) break
      const line = this.buf.slice(0, m.index)
      this.buf = this.buf.slice(m.index + m[0].length)
      this.line(line, out)
    }
    if (final) {
      if (this.buf !== '') this.line(this.buf, out)
      this.buf = ''
      this.line('', out)
    }
    return out
  }

  private line(line: string, out: string[]): void {
    if (line === '') {
      if (this.data.length > 0) out.push(this.data.join('\n'))
      this.data = []
      return
    }
    if (line.startsWith(':')) return
    const i = line.indexOf(':')
    const field = i === -1 ? line : line.slice(0, i)
    let value = i === -1 ? '' : line.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
  }
}

interface UpstreamChunk {
  model?: unknown
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

function openaiAdapter(cfg: LlmConfig): LlmAdapter {
  const url = `${cfg.baseUrl}/chat/completions`
  return {
    async start(call) {
      const ac = new AbortController()
      let why: LlmErrorCode | null = null
      const abort = (code: LlmErrorCode): void => {
        if (why === null) why = code
        ac.abort()
      }
      const onClientAbort = (): void => abort('aborted')
      if (call.signal.aborted) throw new LlmError('aborted', 'aborted')
      call.signal.addEventListener('abort', onClientAbort, { once: true })
      // Idle timeout: reset on headers and on every body chunk.
      let timer: NodeJS.Timeout | undefined
      const arm = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => abort('upstream_timeout'), cfg.timeoutMs)
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        call.signal.removeEventListener('abort', onClientAbort)
      }
      const fail = (): LlmError => {
        const code = why ?? 'upstream_error'
        return new LlmError(code, code === 'upstream_timeout' ? 'LLM upstream timed out' : code === 'aborted' ? 'aborted' : 'LLM upstream failed')
      }

      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
      arm()
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: cfg.model,
            messages: call.messages,
            max_tokens: cfg.maxTokens,
            stream: true,
            stream_options: { include_usage: true }
          }),
          signal: ac.signal,
          redirect: 'error'
        })
      } catch {
        cleanup()
        throw fail()
      }
      const ct = res.headers.get('content-type') ?? ''
      if (res.status !== 200 || !ct.toLowerCase().startsWith('text/event-stream') || !res.body) {
        cleanup()
        ac.abort() // discard body; never read or forward it
        throw new LlmError('upstream_error', `LLM upstream returned HTTP ${res.status}`)
      }
      arm()
      const body = res.body

      async function* events(): AsyncGenerator<LlmEvent> {
        const parser = new SseParser()
        let done = false
        let finished = false
        try {
          const handle = function* (payloads: string[]): Generator<LlmEvent> {
            for (const p of payloads) {
              if (done) return
              if (p.trim() === '[DONE]') {
                done = true
                return
              }
              let j: UpstreamChunk
              try {
                j = JSON.parse(p) as UpstreamChunk
              } catch {
                throw new LlmError('upstream_error', 'LLM upstream sent malformed data')
              }
              if (j && typeof j === 'object' && 'error' in j) throw new LlmError('upstream_error', 'LLM upstream reported an error')
              const c = Array.isArray(j.choices) ? j.choices[0] : undefined
              const text = c?.delta?.content
              if (typeof text === 'string' && text !== '') yield { type: 'delta', text }
              if (c && typeof c.finish_reason === 'string') {
                finished = true
                yield { type: 'finish', reason: c.finish_reason === 'length' ? 'length' : 'stop' }
              }
              if (j.usage && isCount(j.usage.prompt_tokens) && isCount(j.usage.completion_tokens)) {
                yield { type: 'usage', promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens }
              }
            }
          }
          try {
            for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
              arm()
              yield* handle(parser.push(chunk))
              if (done) break
            }
            if (!done) yield* handle(parser.end())
          } catch (err) {
            if (err instanceof LlmError) throw err
            throw fail()
          }
          if (!done && !finished) throw new LlmError(why ?? 'upstream_error', why === 'upstream_timeout' ? 'LLM upstream timed out' : 'LLM upstream stream ended unexpectedly')
        } finally {
          cleanup()
          // Release the upstream connection if we stop early (client gone, error, [DONE]).
          if (!done) ac.abort()
        }
      }
      return { model: cfg.model, events: events() }
    }
  }
}
