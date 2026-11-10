// S1-R3-09 「把回答保存到记忆」: main-side preview → native confirm → MCP `remember`.
import { describe, expect, it } from 'vitest'
import { ASK_SAVE_CHANNELS, ASK_SAVE_HEADER, ASK_SAVE_MAX_CHARS, ASK_SAVE_TAGS } from '../../src/main/mcp/save-answer-api'
import { createAskSaveService, registerAskSaveIpc, type AskSaveDeps } from '../../src/main/mcp/save-answer'
import { McpError } from '../../src/main/mcp/client'
import type { LensResult } from '../../src/shared/types'

const TOKEN_HEX = /^[0-9a-f]{32}$/

function harness(over: Partial<AskSaveDeps> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const confirms: Array<{ excerpt: string; chars: number; redactions: number }> = []
  let answer = true
  let clock = Date.parse('2026-11-05T08:00:00Z')
  let n = 0
  const deps: AskSaveDeps = {
    callTool: async (name, args) => {
      calls.push({ name, args })
      return JSON.stringify({ entry_id: 'e-20261105-abc', file: 'memory/agent-runs.md', tags: ['source:agent-run', 'ask-answer'] })
    },
    confirm: async (summary) => {
      confirms.push(summary)
      return answer
    },
    knownSecrets: () => ['runtime-local-token-0123456789'],
    now: () => clock,
    randomToken: () => (++n).toString(16).padStart(32, '0'),
    ...over
  }
  const service = createAskSaveService(deps)
  return {
    service,
    calls,
    confirms,
    setAnswer: (a: boolean) => (answer = a),
    advance: (ms: number) => (clock += ms)
  }
}

describe('ask save-answer service', () => {
  it('preview does not call remember; content gets a provenance header and fixed tags', async () => {
    const h = harness()
    const p = h.service.preview({ text: '  结论：周三前发布 Lens 0.4。  ' })
    expect(p.token).toMatch(TOKEN_HEX)
    expect(p.content.startsWith(ASK_SAVE_HEADER)).toBe(true)
    expect(p.content).toContain('结论：周三前发布 Lens 0.4。')
    expect(p.tags).toEqual([...ASK_SAVE_TAGS])
    expect(p.redactions).toBe(0)
    expect(p.dropped).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('no save without the confirm gesture: cancel ⇒ remember never called, token kept', async () => {
    const h = harness()
    h.setAnswer(false)
    const p = h.service.preview({ text: '一条回答' })
    const r = await h.service.save(p.token, null)
    expect(r).toEqual({ saved: false, reason: 'cancelled' })
    expect(h.calls).toEqual([])
    expect(h.confirms).toHaveLength(1)
    // user changes their mind: same preview can be confirmed afterwards
    h.setAnswer(true)
    const ok = await h.service.save(p.token, null)
    expect(ok.saved).toBe(true)
    expect(h.calls).toHaveLength(1)
  })

  it('confirm ⇒ exactly the previewed (redacted) content is sent to remember, then the token is spent', async () => {
    const h = harness()
    const p = h.service.preview({ text: '答：用 sk-ant-api03-abcdefghijklmnopqrstuvwxyz 调 API', agent: 'claude-code' })
    const r = await h.service.save(p.token, null)
    expect(r).toEqual({ saved: true, entryId: 'e-20261105-abc', file: 'memory/agent-runs.md', tags: ['source:agent-run', 'ask-answer'] })
    expect(h.calls).toEqual([{ name: 'remember', args: { content: p.content, tags: [...ASK_SAVE_TAGS, 'agent-claude-code'].join(',') } }])
    await expect(h.service.save(p.token, null)).rejects.toThrow(/preview has expired/)
    expect(h.calls).toHaveLength(1)
  })

  it('save with an unknown token never calls confirm or remember', async () => {
    const h = harness()
    await expect(h.service.save('f'.repeat(32), null)).rejects.toThrow(/preview has expired/)
    expect(h.confirms).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('previews expire after 10 minutes', async () => {
    const h = harness()
    const p = h.service.preview({ text: '回答' })
    h.advance(10 * 60_000 + 1)
    await expect(h.service.save(p.token, null)).rejects.toThrow(/preview has expired/)
    expect(h.calls).toEqual([])
  })

  it('redacts secrets (known Runtime token verbatim, API keys, bearer, emails, home paths) before preview and save', async () => {
    const h = harness()
    const text = [
      'Runtime token 是 runtime-local-token-0123456789',
      'Authorization: Bearer abcdefghijklmnop1234567890',
      'OPENAI key sk-proj-ABCDEFGHIJKLMNOP1234567890',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      '联系 alice@example.com，文件在 /Users/alice/secret/notes.md',
      'password=hunter2'
    ].join('\n')
    const p = h.service.preview({ text })
    for (const leaked of ['runtime-local-token-0123456789', 'abcdefghijklmnop1234567890', 'sk-proj-ABCDEFGHIJKLMNOP', 'ghp_abcdefghij', 'alice@example.com', '/Users/alice', 'hunter2']) {
      expect(p.content).not.toContain(leaked)
    }
    expect(p.redactions).toBeGreaterThanOrEqual(6)
    await h.service.save(p.token, null)
    const sent = String(h.calls[0].args.content)
    expect(sent).toBe(p.content)
    expect(sent).not.toContain('hunter2')
  })

  it('an env / credential dump is dropped and cannot be saved', async () => {
    const h = harness()
    const p = h.service.preview({ text: 'PATH=/usr/bin\nHOME=/Users/x\nUSER=x\nAPI_TOKEN=abc' })
    expect(p.dropped).toBe(true)
    await expect(h.service.save(p.token, null)).rejects.toThrow(/looks like environment variables/)
    expect(h.confirms).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('confirm dialog gets only an excerpt of the redacted content', async () => {
    const h = harness()
    const p = h.service.preview({ text: 'x'.repeat(2000) + ' password=hunter2' })
    await h.service.save(p.token, 'sender')
    expect(h.confirms[0].excerpt.length).toBeLessThanOrEqual(401)
    expect(h.confirms[0].chars).toBe(p.chars)
    expect(JSON.stringify(h.confirms)).not.toContain('hunter2')
  })

  it('rejects empty and oversized input', () => {
    const h = harness()
    expect(() => h.service.preview({ text: '   ' })).toThrow(/Content is empty/)
    expect(() => h.service.preview({ text: 'a'.repeat(ASK_SAVE_MAX_CHARS + 1) })).toThrow(/too long/)
  })

  it('MCP failure surfaces an error, keeps the preview for a confirmed retry', async () => {
    let fail = true
    const h = harness({
      callTool: async () => {
        if (fail) throw new McpError('Persome MCP 进程退出（code 1）')
        return JSON.stringify({ entry_id: 'e-2', file: 'memory/agent-runs.md', tags: [] })
      }
    })
    const p = h.service.preview({ text: '回答' })
    await expect(h.service.save(p.token, null)).rejects.toThrow(/MCP/)
    fail = false
    const r = await h.service.save(p.token, null)
    expect(r.saved).toBe(true)
    expect(h.confirms).toHaveLength(2)
  })

  it('a malformed remember response is an error, not a fake success', async () => {
    const h = harness({ callTool: async () => 'not json' })
    const p = h.service.preview({ text: '回答' })
    await expect(h.service.save(p.token, null)).rejects.toThrow(/Can't parse/)
    const h2 = harness({ callTool: async () => JSON.stringify({ ok: true }) })
    const p2 = h2.service.preview({ text: '回答' })
    await expect(h2.service.save(p2.token, null)).rejects.toThrow(/Can't parse/)
  })

  it('a second save while the first is still pending is refused', async () => {
    let release: () => void = () => {}
    const h = harness({ confirm: () => new Promise<boolean>((res) => (release = () => res(true))) })
    const p = h.service.preview({ text: '回答' })
    const first = h.service.save(p.token, null)
    await expect(h.service.save(p.token, null)).rejects.toThrow(/being saved/)
    release()
    await expect(first).resolves.toMatchObject({ saved: true })
    expect(h.calls).toHaveLength(1)
  })

  it('discard drops the preview', async () => {
    const h = harness()
    const p = h.service.preview({ text: '回答' })
    expect(h.service.discard(p.token)).toBe(true)
    await expect(h.service.save(p.token, null)).rejects.toThrow(/preview has expired/)
  })

  it('keeps at most 8 pending previews (oldest evicted)', async () => {
    const h = harness()
    const tokens = Array.from({ length: 9 }, (_, i) => h.service.preview({ text: `回答 ${i}` }).token)
    await expect(h.service.save(tokens[0], null)).rejects.toThrow(/preview has expired/)
    await expect(h.service.save(tokens[8], null)).resolves.toMatchObject({ saved: true })
  })
})

describe('ask save-answer IPC', () => {
  type Handler = (event: unknown, raw: unknown) => Promise<LensResult<unknown>>
  function ipc(over: Partial<AskSaveDeps> = {}) {
    const h = harness(over)
    const handlers = new Map<string, Handler>()
    registerAskSaveIpc({ handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) } as never, h.service)
    const call = async <T>(ch: string, raw?: unknown) => (await handlers.get(ch)!({ sender: 'wc' }, raw)) as LensResult<T>
    return { ...h, handlers, call }
  }

  it('registers exactly the three channels', () => {
    const { handlers } = ipc()
    expect([...handlers.keys()].sort()).toEqual(Object.values(ASK_SAVE_CHANNELS).sort())
  })

  it('save channel accepts only a token: arbitrary content cannot be written through it', async () => {
    const h = ipc()
    const r = await h.call(ASK_SAVE_CHANNELS.save, { token: '0'.repeat(32), content: 'injected' })
    expect(r.ok).toBe(false)
    const r2 = await h.call(ASK_SAVE_CHANNELS.save, { token: 'not-a-token' })
    expect(r2.ok).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.confirms).toEqual([])
  })

  it('preview validates agent enum and strips unknown keys', async () => {
    const h = ipc()
    expect((await h.call(ASK_SAVE_CHANNELS.preview, { text: 'x', agent: 'evil,tag' })).ok).toBe(false)
    expect((await h.call(ASK_SAVE_CHANNELS.preview, { text: 'x', tags: 'evil' })).ok).toBe(false)
    const ok = await h.call<{ token: string }>(ASK_SAVE_CHANNELS.preview, { text: 'x', agent: 'codex' })
    expect(ok.ok).toBe(true)
  })

  it('full flow over IPC: preview → cancel → confirm; MCP error is redacted', async () => {
    const h = ipc({
      callTool: async () => {
        throw new McpError('remember failed at /Users/alice/.persome with token=abcdef123456')
      }
    })
    const p = await h.call<{ token: string }>(ASK_SAVE_CHANNELS.preview, { text: '回答' })
    if (!p.ok) throw new Error('preview failed')
    h.setAnswer(false)
    const c = await h.call(ASK_SAVE_CHANNELS.save, { token: p.data.token })
    expect(c).toEqual({ ok: true, data: { saved: false, reason: 'cancelled' } })
    h.setAnswer(true)
    const e = await h.call(ASK_SAVE_CHANNELS.save, { token: p.data.token })
    expect(e.ok).toBe(false)
    if (e.ok) return
    expect(e.error.code).toBe('unreachable')
    expect(e.error.message).not.toContain('alice')
    expect(e.error.message).not.toContain('abcdef123456')
  })
})
