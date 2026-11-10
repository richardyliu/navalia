import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for the Runtime's POST /captures/ingest (personal-model
 * api/routes.py). Each request is answered by the next scripted response;
 * the server records bodies and the maximum observed concurrency.
 */
export type Scripted =
  | { status: 200; result: 'written' | 'deduped' | 'skipped'; delayMs?: number }
  /** 200 with an arbitrary body, e.g. no envelope (a misbehaving Runtime). */
  | { status: 200; raw: string; delayMs?: number }
  | { status: number; body?: string; delayMs?: number }

export interface MockRuntime {
  baseUrl: string
  port: number
  token: string
  received: Array<{ auth: string | undefined; body: Record<string, unknown>; at: number }>
  /** Date.now() when each ingest request arrived (before its body was read). */
  arrivals: number[]
  maxConcurrent: number
  script: Scripted[]
  fallback: Scripted
  close(): Promise<void>
}

export async function startMockRuntime(token = 'test-token-0123456789abcdef'): Promise<MockRuntime> {
  let active = 0
  let written = 0
  const state: MockRuntime = {
    baseUrl: '',
    port: 0,
    token,
    received: [],
    arrivals: [],
    maxConcurrent: 0,
    script: [],
    fallback: { status: 200, result: 'written' },
    close: async () => undefined
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/captures/ingest') state.arrivals.push(Date.now())
    active++
    state.maxConcurrent = Math.max(state.maxConcurrent, active)
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      // Hold each request briefly so overlapping clients would be observable.
      const step = state.script.shift() ?? state.fallback
      setTimeout(() => {
        const respond = (status: number, body: string) => {
          active--
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(body)
        }
        if (req.url !== '/captures/ingest' || req.method !== 'POST') return respond(404, '{}')
        if (req.headers.authorization !== `Bearer ${token}`) return respond(401, '{"detail":"unauthorized"}')
        if (step.status !== 200) return respond(step.status, (step as { body?: string }).body ?? '{"detail":"x"}')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        state.received.push({ auth: req.headers.authorization, body, at: Date.now() })
        if ('raw' in step) return respond(200, step.raw)
        const result = (step as { result: string }).result
        const data =
          result === 'skipped'
            ? { id: null, deduped: false, skipped: true }
            : result === 'deduped'
              ? { id: null, deduped: true, skipped: false }
              : { id: `2026-11-04T20:00:00.${String(++written).padStart(6, '0')}+00:00`, deduped: false, skipped: false }
        respond(200, JSON.stringify({ success: true, data }))
      }, step.delayMs ?? 5)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = (server.address() as AddressInfo).port
  state.baseUrl = `http://127.0.0.1:${state.port}`
  state.close = () => new Promise((resolve) => server.close(() => resolve()))
  return state
}
