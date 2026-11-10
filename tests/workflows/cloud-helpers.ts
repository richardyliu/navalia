// S1-FULL C15 test helpers: prefix-guarded temp dirs, a synthetic Claude Code session writer, and a
// fake `/v1/chat/completions` route for `task: workflow_extract` on the tests/cloud fake server.
// Nothing here touches ~/.persome, ~/.claude, ~/.codex or the real Lens Store.
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { FakeServer } from '../cloud/helpers'

export const TMP_PREFIX = 'lens-wf-c15-'

/** mkdtemp under the OS temp dir; the cleanup only removes that exact dir, and only with our prefix. */
export function guardedTemp(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX))
  return {
    dir,
    cleanup: () => {
      if (!path.basename(dir).startsWith(TMP_PREFIX) || path.dirname(dir) !== path.resolve(os.tmpdir())) throw new Error(`refusing to delete ${dir}`)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

export const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const KNOWN_SECRET = 'rt_known_secret_value_123456'

const base = (ts: string) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/work/demo', sessionId: SESSION_ID, version: '2.0.0', timestamp: ts })

export function userLine(ts: string, text: string): string {
  return JSON.stringify({ ...base(ts), uuid: `u-${ts}`, type: 'user', message: { role: 'user', content: text } })
}

export function assistantLine(ts: string, text: string, write?: string): string {
  const content: unknown[] = [{ type: 'text', text }]
  if (write) content.push({ type: 'tool_use', id: `tu-${ts}`, name: 'Write', input: { file_path: write, content: 'x' } })
  return JSON.stringify({ ...base(ts), uuid: `a-${ts}`, type: 'assistant', message: { id: 'm', type: 'message', role: 'assistant', model: 'synthetic', content } })
}

/** Writes `<root>/-work-demo/<SESSION_ID>.jsonl` with `turns` user/assistant pairs. */
export function writeSession(root: string, turns: Array<{ user: string; assistant: string; write?: string }>): string {
  const dir = path.join(root, '-work-demo')
  fs.mkdirSync(dir, { recursive: true })
  const lines: string[] = []
  turns.forEach((t, i) => {
    const m = String(i).padStart(2, '0')
    lines.push(userLine(`2026-11-05T10:${m}:00.000Z`, t.user))
    lines.push(assistantLine(`2026-11-05T10:${m}:30.000Z`, t.assistant, t.write))
  })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

export type ReplyMode = 'mock' | 'no_fence' | 'bad_json' | 'bad_schema' | 'foreign_cites' | 'length' | 'error_event'

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** The reply text per mode. `mock` follows the server's mock: one step per first ≤3 items. */
export function replyFor(mode: ReplyMode, items: Array<{ id: string; title: string; text: string }>): string {
  const steps = items.slice(0, 3).map((it) => ({ title: it.title, detail: it.text.replace(/\s+/g, ' ').slice(0, 200), cites: [it.id] }))
  if (mode === 'no_fence') return '我觉得步骤是：先打开，再保存。'
  if (mode === 'bad_json') return '```json\n{"title": "x", "steps": [ {"title": "a", }\n```'
  if (mode === 'bad_schema') return '```json\n{"title": "x", "steps": "not-a-list"}\n```'
  if (mode === 'foreign_cites') {
    const obj = {
      title: '混合引用',
      steps: [
        { title: '有效步骤', detail: '', cites: [items[0].id, 'ctx-99'] },
        { title: '编造的步骤', detail: '', cites: ['ctx-99'] },
        { title: '没有引用的步骤', detail: '', cites: [] }
      ],
      artifacts: [{ name: 'report.md', kind: 'path', cites: [items[0].id] }, { name: 'ghost.md', kind: 'path', cites: ['ctx-77'] }],
      rules: [{ text: '先测后发', cites: [items[0].id] }],
      problems: [{ text: '测试失败', resolution: '修复后重跑', cites: [items[0].id] }]
    }
    return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
  }
  return `\`\`\`json\n${JSON.stringify({ title: '（mock）抽取的工作流', steps, artifacts: [], rules: [], problems: [] }, null, 2)}\n\`\`\``
}

/** Installs the chat route; returns the captured request bodies. Uses `server.issued` to check the bearer. */
export function installExtractRoute(server: FakeServer, mode: () => ReplyMode): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  server.override = (req, res, body) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return false
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!bearer || !server.issued.includes(bearer)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }))
      return true
    }
    const parsed = JSON.parse(body) as { context?: { items: Array<{ id: string; title: string; text: string }> } }
    bodies.push(parsed as unknown as Record<string, unknown>)
    const items = parsed.context?.items ?? []
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const m = mode()
    if (m === 'error_event') {
      sse(res, 'delta', { text: '```json\n{' })
      sse(res, 'error', { code: 'upstream_error' })
      sse(res, 'done', { finish_reason: 'error' })
      res.end()
      return true
    }
    const text = replyFor(m, items)
    for (let i = 0; i < text.length; i += 9) sse(res, 'delta', { text: text.slice(i, i + 9) })
    sse(res, 'usage', { prompt_tokens: 40, completion_tokens: 20, model: 'mock-extract', estimated: true })
    sse(res, 'done', { finish_reason: m === 'length' ? 'length' : 'stop', citations: items.slice(0, 3).map((i) => i.id) })
    res.end()
    return true
  }
  return bodies
}
