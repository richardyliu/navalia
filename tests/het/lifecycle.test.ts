import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { CLAUDE_PROJECTS_ROOT } from '../../src/main/het/adapters/claudeCode'
import { readClaudeProjects } from './readers'
import { CODEX_SESSIONS_ROOT } from '../../src/main/het/adapters/codex'
import type { AssessorTransport } from '../../src/main/het/assessor'
import { createHetService } from '../../src/main/het/service'
import { createTranscriptSource, hetRootsFromEnv, HetAbortError, type TranscriptSource } from '../../src/main/het/sources'
import type { AgentEvent } from '../../src/main/het/types'

const FIX = join(__dirname, '..', 'fixtures', 'het')
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'het-life-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const BASE = Date.UTC(2025, 8, 1)
const ev = (s: string, min: number, over: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: 'claude-code', sessionId: s, ts: BASE + min * 60_000, cwd: `/p/${s}`, project: `/p/${s}`, role: 'assistant',
  toolNames: [], filesWritten: [], filesRead: [], signals: [], summary: '', sidechain: false,
  source: { file: `/t/${s}.jsonl`, line: min + 1 }, ...over
})

describe('LENS_HET_CLAUDE_ROOT / LENS_HET_CODEX_ROOT', () => {
  test('unset → defaults; empty → disabled; ~ expanded; relative resolved', () => {
    expect(hetRootsFromEnv({})).toEqual({ claudeRoot: CLAUDE_PROJECTS_ROOT, codexRoot: CODEX_SESSIONS_ROOT })
    expect(hetRootsFromEnv({ LENS_HET_CLAUDE_ROOT: '', LENS_HET_CODEX_ROOT: '  ' })).toEqual({ claudeRoot: null, codexRoot: null })
    expect(hetRootsFromEnv({ LENS_HET_CLAUDE_ROOT: '~/x/projects' }).claudeRoot).toBe(join(homedir(), 'x/projects'))
    expect(hetRootsFromEnv({ LENS_HET_CODEX_ROOT: 'rel/dir' }).codexRoot).toBe(resolve('rel/dir'))
  })

  test('service reads the env: fixture Claude root, Codex disabled', async () => {
    const d = tmp()
    const svc = createHetService({
      dbFile: join(d, 'het.db'),
      settingsFile: join(d, 'het-settings.json'),
      env: { LENS_HET_CLAUDE_ROOT: join(FIX, 'claude'), LENS_HET_CODEX_ROOT: '' },
      now: () => Date.UTC(2025, 8, 2)
    })
    await svc.tickNow()
    const tasks = svc.tasks(50)
    expect(tasks).toHaveLength(3) // the 3 Claude fixture tasks, no Codex task
    expect(new Set(tasks.map((t) => t.agent))).toEqual(new Set(['claude-code']))
    await svc.stop()
  })

  test('both disabled → zero files, zero tasks', async () => {
    const src = createTranscriptSource(hetRootsFromEnv({ LENS_HET_CLAUDE_ROOT: '', LENS_HET_CODEX_ROOT: '' }))
    const r = await src.refresh()
    expect(r.files).toBe(0)
    expect(r.events).toHaveLength(0)
  })
})

describe('R3: bounded stop()', () => {
  test('real source aborts at a file boundary and stays consistent', async () => {
    const src = createTranscriptSource({ claudeRoot: join(FIX, 'claude'), codexRoot: null })
    const ac = new AbortController()
    ac.abort()
    await expect(src.refresh(ac.signal)).rejects.toBeInstanceOf(HetAbortError)
    const r = await src.refresh()
    expect(r.events).toEqual(readClaudeProjects({ root: join(FIX, 'claude') }).events)
  })

  test('cooperative slow refresh (cold cache, ~10 s) is aborted promptly', async () => {
    const d = tmp()
    let aborted = false
    const source: TranscriptSource = {
      async refresh(signal) {
        for (let i = 0; i < 1000; i++) {
          if (signal?.aborted) {
            aborted = true
            throw new HetAbortError()
          }
          await sleep(10)
        }
        return { events: [], sessionTitles: {}, warnings: {}, files: 0, reparsed: 0, partial: 0 }
      }
    }
    const logs: string[] = []
    const svc = createHetService({ dbFile: join(d, 'het.db'), settingsFile: join(d, 's.json'), source, log: (m) => logs.push(m) })
    svc.start()
    await sleep(50)
    const t = Date.now()
    await svc.stop()
    expect(Date.now() - t).toBeLessThan(500)
    expect(aborted).toBe(true)
    expect(svc.status().lastError).toBeNull()
    expect(logs).toContain('[het] tick aborted by stop()')
  })

  test('non-cooperative refresh: stop returns at the deadline, late completion is harmless', async () => {
    const d = tmp()
    let finished = false
    const source: TranscriptSource = {
      async refresh() {
        await sleep(1500) // ignores the signal
        finished = true
        return { events: [ev('x', 0, { role: 'user' }), ev('x', 1)], sessionTitles: {}, warnings: {}, files: 1, reparsed: 1, partial: 0 }
      }
    }
    const logs: string[] = []
    const svc = createHetService({ dbFile: join(d, 'het.db'), settingsFile: join(d, 's.json'), source, stopTimeoutMs: 200, log: (m) => logs.push(m) })
    svc.start()
    const t = Date.now()
    await svc.stop()
    const took = Date.now() - t
    expect(took).toBeGreaterThanOrEqual(190)
    expect(took).toBeLessThan(600)
    expect(() => svc.summary()).toThrow(/closed/)
    await sleep(1500)
    expect(finished).toBe(true)
    expect(logs.some((l) => l.includes('did not finish within 200 ms'))).toBe(true)
    await svc.stop() // idempotent
  })

  test('abort during the assess phase stops before the next transport call', async () => {
    const d = tmp()
    const events: AgentEvent[] = []
    for (let i = 0; i < 5; i++) events.push(ev(`a${i}`, i * 120, { role: 'user' }), ev(`a${i}`, i * 120 + 1))
    let calls = 0
    const slow: AssessorTransport = {
      name: 'slow',
      async complete() {
        calls++
        await sleep(100)
        return { outcome: 'ok', text: JSON.stringify({ kind: 'ops', size: 'm', complexity: 'low', agent_share: 1, adoption: 'unknown', evidence: [] }) }
      }
    }
    const source: TranscriptSource = { async refresh() { return { events, sessionTitles: {}, warnings: {}, files: 1, reparsed: 1, partial: 0 } } }
    // S1-02: a transport alone is not enough; the user switch and a budget probe are required.
    writeFileSync(join(d, 's.json'), JSON.stringify({ version: 1, assessorEnabled: true }))
    const svc = createHetService({ dbFile: join(d, 'het.db'), settingsFile: join(d, 's.json'), source, transport: slow, budget: () => ({ available: true }), now: () => BASE + 5 * 120 * 60_000 + 3_600_000 })
    svc.start()
    await sleep(150)
    expect(calls).toBeGreaterThan(0)
    const t = Date.now()
    await svc.stop()
    expect(Date.now() - t).toBeLessThan(400)
    expect(calls).toBeLessThan(5)
  })
})
