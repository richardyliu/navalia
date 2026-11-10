import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LIBRARY_CHANNELS } from '../../src/main/library/api'
import { registerLibraryIpc } from '../../src/main/library/ipc'
import { RuntimeError } from '../../src/main/runtime/client'
import type { S1Deps } from '../../src/main/s1/deps'
import { emptyGraph, patterns, richGraph } from './fixtures'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function setup(over: Partial<S1Deps> & { graph?: () => Promise<unknown> } = {}) {
  const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
  const toolCalls: Array<[string, Record<string, unknown>]> = []
  const deps = {
    storeRoot: '/nonexistent',
    runtimeRoot: () => '/nonexistent',
    persomeBin: () => null,
    runtime: () => ({ modelGraph: over.graph ?? (async () => richGraph) }) as never,
    ossTool: async (name: string, args: Record<string, unknown>) => {
      toolCalls.push([name, args])
      if (name === 'behavior_patterns') return JSON.stringify(patterns)
      if (name === 'entity_graph') return JSON.stringify({ resolved: null, layer: 'none', note: 'miss' })
      throw new Error(`unexpected tool ${name}`)
    },
    homeDir: () => '/nonexistent',
    saveDialog: async () => null,
    openDialog: async () => null,
    ...over
  } as S1Deps
  registerLibraryIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, deps)
  const invoke = (ch: string, raw?: unknown) => handlers.get(ch)!(null, raw) as Promise<any>
  return { handlers, invoke, toolCalls }
}

describe('library IPC', () => {
  it('registers every lens:library:* channel', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(LIBRARY_CHANNELS).sort())
    for (const ch of handlers.keys()) expect(ch.startsWith('lens:library:')).toBe(true)
  })

  it('overview with data', async () => {
    const { invoke, toolCalls } = setup()
    const r = await invoke(LIBRARY_CHANNELS.overview)
    expect(r.ok).toBe(true)
    expect(r.data.counts).toEqual({ people: 2, projects: 1, unclassified: 3, skills: 1 })
    expect(toolCalls.map(([n]) => n)).toEqual(['behavior_patterns'])
  })

  it('overview empty state', async () => {
    const { invoke } = setup({ graph: async () => emptyGraph, ossTool: async () => JSON.stringify({ root: null, faces: [], skills: [], rendered: '' }) })
    const r = await invoke(LIBRARY_CHANNELS.overview)
    expect(r).toMatchObject({ ok: true, data: { counts: { people: 0, projects: 0, unclassified: 0, skills: 0 }, skillsError: null } })
  })

  it('surfaces a Runtime error in-band (graphError, not swallowed); skills still render', async () => {
    const { invoke } = setup({
      graph: async () => {
        throw new RuntimeError('unreachable', '连不上 Runtime（127.0.0.1），请先启动 persome')
      }
    })
    const r = await invoke(LIBRARY_CHANNELS.overview)
    expect(r.ok).toBe(true)
    expect(r.data.graphError).toEqual({ code: 'unreachable', message: '连不上 Runtime（127.0.0.1），请先启动 persome' })
    expect(r.data.portrait).toBeNull()
    expect(r.data.counts).toEqual({ people: 0, projects: 0, unclassified: 0, skills: 1 })
  })

  it('surfaces a missing token as token_unavailable', async () => {
    const { TokenError } = await import('../../src/main/runtime/token')
    const { invoke } = setup({
      runtime: () => {
        throw new TokenError('no token')
      }
    })
    const r = await invoke(LIBRARY_CHANNELS.overview)
    expect(r).toMatchObject({ ok: true, data: { graphError: { code: 'token_unavailable' } } })
  })

  it('reports a skills failure in-band while keeping people/projects', async () => {
    const { invoke } = setup({
      ossTool: async () => {
        throw new Error('persome mcp 退出')
      }
    })
    const r = await invoke(LIBRARY_CHANNELS.overview)
    expect(r.ok).toBe(true)
    expect(r.data.skillsError).toEqual({ code: 'unknown', message: 'persome mcp 退出' })
    expect(r.data.counts.people).toBe(2)
  })

  it('rejects unexpected payloads', async () => {
    const { invoke } = setup()
    expect(await invoke(LIBRARY_CHANNELS.overview, { x: 1 })).toMatchObject({ ok: false })
    expect(await invoke(LIBRARY_CHANNELS.entity, { name: '' })).toMatchObject({ ok: false })
    expect(await invoke(LIBRARY_CHANNELS.entity, { name: 'a', depth: 4 })).toMatchObject({ ok: false })
    expect(await invoke(LIBRARY_CHANNELS.exportBrief, { markdown: '# x', date: 'today' })).toMatchObject({ ok: false })
  })

  it('entity calls read-only entity_graph with depth 1', async () => {
    const { invoke, toolCalls } = setup()
    const r = await invoke(LIBRARY_CHANNELS.entity, { name: 'Mira' })
    expect(r).toEqual({ ok: true, data: { resolved: null, layer: 'none', note: 'miss' } })
    expect(toolCalls).toEqual([['entity_graph', { name: 'Mira', depth: 1 }]])
  })

  it('export-brief writes the markdown to the chosen path; cancel writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-brief-'))
    tmp.push(dir)
    let asked: { defaultPath: string } | null = null
    const { invoke } = setup({
      saveDialog: async (opts) => {
        asked = opts
        return path.join(dir, path.basename(opts.defaultPath))
      }
    })
    const r = await invoke(LIBRARY_CHANNELS.exportBrief, { markdown: '# 今日 brief', date: '2026-11-05' })
    expect(asked!.defaultPath).toBe('persome-brief-2026-11-05.md')
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(r.data.path, 'utf8')).toBe('# 今日 brief\n')
    expect(r.data.bytes).toBe(Buffer.byteLength('# 今日 brief\n'))

    const cancelled = setup()
    expect(await cancelled.invoke(LIBRARY_CHANNELS.exportBrief, { markdown: '# x', date: '2026-11-05' })).toEqual({
      ok: true,
      data: { path: null, bytes: 0 }
    })
  })
})
