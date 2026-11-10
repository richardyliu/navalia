// S1-R3-SEC M2 + L6: `lens:mcp:remember` (main window RememberDialog and Quick Box) is redacted in
// main and needs a main-owned native confirm before MCP `remember`; every Runtime env secret value
// is scrubbed verbatim (not only the local token). Fakes only, no Electron, no real ~/.persome.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRememberHandler, registerRememberIpc, REMEMBER_CHANNEL, type RememberDeps } from '../../src/main/mcp/remember'
import { knownRuntimeSecrets } from '../../src/main/mcp/known-secrets'
import type { LensResult, RememberResult } from '../../src/shared/types'

const ROOT = resolve(__dirname, '../..')
const RUNTIME_TOKEN = 'runtime-local-token-0123456789'
const SCREENSHOT_KEY = 'shot-key-value-abcdefghijkl'

function harness(over: Partial<RememberDeps> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const confirms: Array<{ summary: { excerpt: string; chars: number; redactions: number; tags: string }; sender: unknown }> = []
  let answer = true
  const deps: RememberDeps = {
    callTool: async (name, args) => {
      calls.push({ name, args })
      return JSON.stringify({ entry_id: 'e-1', file: 'memory/agent-runs.md', tags: ['source:agent-run'] })
    },
    confirm: async (summary, sender) => {
      confirms.push({ summary, sender })
      return answer
    },
    knownSecrets: () => [RUNTIME_TOKEN, SCREENSHOT_KEY],
    ...over
  }
  return { handler: createRememberHandler(deps), calls, confirms, setAnswer: (a: boolean) => (answer = a) }
}

describe('M2 lens:mcp:remember needs a main-side confirm', () => {
  it('no write without confirm (Cancel)', async () => {
    const h = harness()
    h.setAnswer(false)
    await expect(h.handler({ content: '用户偏好本地优先' }, { id: 'main' })).rejects.toThrow(/Cancelled/)
    expect(h.confirms).toHaveLength(1)
    expect(h.calls).toHaveLength(0)
  })

  it('writes the redacted text after confirm, and the dialog shows that same redacted text', async () => {
    const h = harness()
    const secretText = `deploy with PGPASSWORD=hunter2secret and token ${RUNTIME_TOKEN} key ${SCREENSHOT_KEY} mail bob@example.com`
    const r = await h.handler({ content: secretText, tags: 'ops' }, { id: 'main' })
    expect(r.entry_id).toBe('e-1')
    expect(h.calls).toHaveLength(1)
    const written = String(h.calls[0].args.content)
    for (const s of ['hunter2secret', RUNTIME_TOKEN, SCREENSHOT_KEY, 'bob@example.com']) {
      expect(written).not.toContain(s)
      expect(h.confirms[0].summary.excerpt).not.toContain(s)
    }
    expect(written).toContain('deploy with')
    expect(h.confirms[0].summary.excerpt).toBe(written)
    expect(h.confirms[0].summary.redactions).toBeGreaterThanOrEqual(4)
    expect(h.calls[0].args.tags).toBe('ops')
  })

  it('the confirm excerpt is truncated for long text', async () => {
    const h = harness()
    await h.handler({ content: 'word '.repeat(1000).trim() + '.' }, null)
    expect(h.confirms[0].summary.excerpt.length).toBeLessThanOrEqual(401)
    expect(h.confirms[0].summary.chars).toBe(5000)
    expect(String(h.calls[0].args.content)).toHaveLength(5000)
  })

  it('refuses env / credential dumps without asking or writing', async () => {
    const h = harness()
    await expect(h.handler({ content: 'PATH=/usr/bin\nHOME=/Users/alice\nSHELL=/bin/zsh' }, null)).rejects.toThrow(/environment variable/)
    expect(h.confirms).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('rejects malformed args without asking', async () => {
    const h = harness()
    await expect(h.handler({ content: '' }, null)).rejects.toThrow()
    await expect(h.handler({ content: 'x'.repeat(20_001) }, null)).rejects.toThrow()
    expect(h.confirms).toHaveLength(0)
  })

  it('IPC: main window and Quick Box senders both get the confirm with their own sender', async () => {
    const h = harness()
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<LensResult<RememberResult>>>()
    registerRememberIpc({ handle: (c: string, fn: never) => void handlers.set(c, fn) } as never, h.handler)
    const fn = handlers.get(REMEMBER_CHANNEL)!
    const mainSender = { id: 'main-window' }
    const quickSender = { id: 'quickbox-window' }

    h.setAnswer(false)
    const cancelled = await fn({ sender: quickSender }, { content: 'quick note' })
    expect(cancelled.ok).toBe(false)
    expect(h.calls).toHaveLength(0)
    expect(h.confirms[0].sender).toBe(quickSender)

    h.setAnswer(true)
    const ok = await fn({ sender: quickSender }, { content: 'quick note' })
    expect(ok.ok).toBe(true)
    const ok2 = await fn({ sender: mainSender }, { content: 'main note', tags: 'pref' })
    expect(ok2.ok).toBe(true)
    expect(h.confirms.map((c) => c.sender)).toEqual([quickSender, quickSender, mainSender])
    expect(h.calls).toHaveLength(2)
  })

  it('ipc.ts routes lens:mcp:remember through the confirmed handler and fails closed without one', () => {
    const ipc = readFileSync(join(ROOT, 'src/main/ipc.ts'), 'utf8')
    expect(ipc).not.toMatch(/callTool\('remember'/)
    expect(ipc).toMatch(/registerRememberIpc\(/)
    const index = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    expect(index).toMatch(/confirmRemember:/)
  })

  it('save-answer.ts no longer claims lens:mcp:remember is the only unconfirmed path', () => {
    const src = readFileSync(join(ROOT, 'src/main/mcp/save-answer.ts'), 'utf8')
    expect(src).toMatch(/lens:mcp:remember/)
    expect(src).toMatch(/native confirm/i)
  })
})

describe('L6 known runtime secrets = local token + every env secret value', () => {
  let dir = ''
  afterEach(() => {
    if (dir && dir.startsWith(join(tmpdir(), 'lens-known-secrets-'))) rmSync(dir, { recursive: true, force: true })
  })

  it('returns the token and other *_KEY / *_TOKEN / *_SECRET values from <root>/env', () => {
    dir = mkdtempSync(join(tmpdir(), 'lens-known-secrets-'))
    writeFileSync(
      join(dir, 'env'),
      `PERSOME_LOCAL_API_TOKEN=${RUNTIME_TOKEN}\nPERSOME_SCREENSHOT_KEY=${SCREENSHOT_KEY}\nOPENAI_API_KEY=sk-test-abcdefghijklmnop\nAPP_NAME=demo-app-name-long\n`
    )
    chmodSync(join(dir, 'env'), 0o600)
    const s = knownRuntimeSecrets(dir)
    expect(s).toContain(RUNTIME_TOKEN)
    expect(s).toContain(SCREENSHOT_KEY)
    expect(s).toContain('sk-test-abcdefghijklmnop')
    expect(s).not.toContain('demo-app-name-long')
  })

  it('missing env ⇒ empty list, no throw', () => {
    dir = mkdtempSync(join(tmpdir(), 'lens-known-secrets-'))
    expect(knownRuntimeSecrets(dir)).toEqual([])
  })

  it('index.ts uses the helper for ask-save (not only readLocalToken)', () => {
    const index = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    expect(index).toMatch(/knownSecrets:\s*\(\)\s*=>\s*knownRuntimeSecrets\(/)
    expect(index).not.toMatch(/return \[readLocalToken\(locate\(\)\.root\)\]/)
  })
})
