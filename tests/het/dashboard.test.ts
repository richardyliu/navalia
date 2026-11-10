import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, test } from 'vitest'
import { readClaudeProjects } from './readers'
import { ensureDefaultAnchors } from '../../src/main/het/anchors'
import { HET_CHANNELS, HET_DEFINITION } from '../../src/main/het/api'
import type { AssessorTransport } from '../../src/main/het/assessor'
import { registerHetIpc } from '../../src/main/het/ipc'
import { correctTask, hetTasks } from '../../src/main/het/ledger'
import { migrateHet } from '../../src/main/het/schema'
import { createHetService } from '../../src/main/het/service'
import { DEFAULT_HET_SETTINGS } from '../../src/main/het/settings'
import { createTranscriptSource } from '../../src/main/het/sources'
import { tick } from '../../src/main/het/tick'
import type { AgentEvent } from '../../src/main/het/types'
import { buildWeeklyReview, D2_FOOTER } from '../../src/main/het/weekly'

const FIX = join(__dirname, '..', 'fixtures', 'het')
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'het-test-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const BASE = new Date(2025, 8, 1, 9, 0, 0).getTime() // local Monday 2025-09-01 09:00
const MIN = 60_000
const ev = (s: string, min: number, over: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: 'claude-code',
  sessionId: s,
  ts: BASE + min * MIN,
  cwd: `/p/${s}`,
  project: `/p/${s}`,
  role: 'assistant',
  toolNames: [],
  filesWritten: [],
  filesRead: [],
  signals: [],
  summary: `a | b <script>x</script> ${s}`,
  sidechain: false,
  source: { file: `/t/${s}.jsonl`, line: min + 1 },
  ...over
})
const ok: AssessorTransport = {
  name: 'mock',
  async complete(req) {
    const strong = req.prompt.includes('git_commit')
    return {
      outcome: 'ok',
      text: JSON.stringify({ kind: 'coding', size: 'm', complexity: 'medium', agent_share: 1, adoption: strong ? 'strong' : 'unknown', evidence: strong ? ['signal:git_commit'] : [] })
    }
  }
}

describe('Weekly Review (E3.6)', () => {
  test('total = Σ rows; pending/excluded listed at 0; no network; D2 footer; escaped', async () => {
    const db = new DatabaseSync(':memory:')
    migrateHet(db)
    ensureDefaultAnchors(db, BASE)
    const events: AgentEvent[] = []
    for (let i = 0; i < 12; i++) {
      const s = `wk${i}`
      events.push(ev(s, i * 600, { role: 'user' }), ev(s, i * 600 + 2, i % 2 ? { signals: ['git_commit'] } : {}))
    }
    const now = BASE + 12 * 600 * MIN
    await tick({ db, transport: ok, settings: { ...DEFAULT_HET_SETTINGS, perTickCap: 8, perDayCap: 100 }, input: { events, sessionTitles: { wk1: 'Fix | pipes <b>' } } }, now)
    const ids = hetTasks(db, { limit: 200 }).filter((t) => t.status === 'assessed').map((t) => t.id)
    correctTask(db, ids[0], 'rejected', now)
    correctTask(db, ids[1], 'not_agent', now)
    const r = buildWeeklyReview(db, new Date(2025, 8, 1).getTime(), now)
    expect(r.counted.length).toBe(6) // 8 assessed − 2 excluded
    expect(r.waiting.length).toBe(4)
    expect(r.excluded.length).toBe(2)
    expect(r.totalTenths).toBe(r.counted.reduce((a, t) => a + (t.minutes_tenths ?? 0), 0))
    // the printed rows sum to the printed total
    const mdRows = r.markdown.split('\n').filter((l) => l.startsWith('| 2025-'))
    const printed = mdRows.map((l) => Number(l.split('|').at(-2)!.trim()))
    expect(Math.round(printed.reduce((a, b) => a + b, 0) * 10)).toBe(r.totalTenths)
    expect(r.markdown).toContain(`**Total: ${(r.totalTenths / 10).toFixed(1)} min**`)
    expect(r.markdown).toContain(HET_DEFINITION)
    expect(r.markdown).toContain(D2_FOOTER)
    expect(r.markdown).toContain('Fix \\| pipes')
    expect(r.html).toContain(D2_FOOTER)
    expect(r.html).not.toMatch(/<script|https?:\/\/|<link|<img|src=/i)
    expect(r.html).toContain("default-src 'none'")
    expect(r.html).toContain('&lt;b&gt;')
  })
})

describe('transcript source cache', () => {
  test('equals the one-shot adapter; reparses only changed files', async () => {
    const src = createTranscriptSource({ claudeRoot: join(FIX, 'claude'), codexRoot: join(FIX, 'codex') })
    const a = await src.refresh()
    const one = readClaudeProjects({ root: join(FIX, 'claude') })
    expect(a.events.filter((e) => e.agent === 'claude-code')).toEqual(one.events)
    expect(a.sessionTitles).toEqual(one.sessionTitles)
    expect(a.reparsed).toBe(6)
    const b = await src.refresh()
    expect(b.reparsed).toBe(0)
    expect(b.events).toEqual(a.events)
  })
})

describe('HET service + IPC (E3.5)', () => {
  function fakeIpc() {
    const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>()
    return { handlers, ipc: { handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => void handlers.set(ch, fn) } }
  }

  test('start ticks once, no overlap, stop waits and closes; IPC validates with zod', async () => {
    const dir = tmp()
    let refreshes = 0
    const source = {
      async refresh() {
        refreshes++
        await new Promise((r) => setTimeout(r, 30))
        return { events: [ev('svc', 0, { role: 'user' }), ev('svc', 1, { signals: ['git_commit'] })], sessionTitles: {}, warnings: {}, files: 1, reparsed: 1 }
      }
    }
    const svc = createHetService({ dbFile: join(dir, 'het.db'), settingsFile: join(dir, 'het-settings.json'), source, now: () => BASE + 120 * MIN, intervalMs: 3_600_000 })
    svc.start()
    svc.start() // idempotent
    void svc.tickNow() // joins the in-flight tick
    expect(svc.status().running).toBe(true)
    await svc.tickNow()
    expect(refreshes).toBe(1)
    expect(svc.status()).toMatchObject({ running: false, lastError: null, transport: 'disabled' })
    expect(svc.summary(7)).toMatchObject({ pending: 1, total_minutes_tenths: 0, state: 'onePending' })

    const { handlers, ipc } = fakeIpc()
    let asked = ''
    registerHetIpc(ipc, { service: svc, chooseExportPath: async (name) => ((asked = name), join(dir, name)) })
    expect([...handlers.keys()].sort()).toEqual(Object.values(HET_CHANNELS).sort())
    const call = (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw) as Promise<{ ok: boolean; data?: any; error?: any }>
    expect((await call(HET_CHANNELS.summary, { days: 7 })).ok).toBe(true)
    expect((await call(HET_CHANNELS.summary, { days: 0 })).ok).toBe(false)
    expect((await call(HET_CHANNELS.summary, { days: 7, extra: 1 })).ok).toBe(false)
    const tasks = await call(HET_CHANNELS.tasks, { limit: 10, includeActivity: true })
    expect(tasks.data[0].evidence.length).toBeGreaterThan(0)
    const id = tasks.data[0].id
    expect((await call(HET_CHANNELS.correct, { taskId: id, action: 'override' })).ok).toBe(false)
    expect((await call(HET_CHANNELS.correct, { taskId: 'x; drop table', action: 'accepted' })).ok).toBe(false)
    expect((await call(HET_CHANNELS.correct, { taskId: id, action: 'not_agent' })).data).toEqual({ minutes_tenths: null, changed: true })
    const period = await call(HET_CHANNELS.period, { start: new Date(BASE - 86_400_000).toISOString(), end: new Date(BASE + 86_400_000).toISOString(), limit: 5, includeActivity: true })
    expect(period.ok).toBe(true)
    expect(period.data.tasks[0].evidence).toBeDefined()
    expect((await call(HET_CHANNELS.period, { start: 'yesterday', end: 'now' })).ok).toBe(false)
    const exp = await call(HET_CHANNELS.exportWeekly, { weekStart: new Date(2025, 8, 1).toISOString() })
    expect(asked).toBe('het-weekly-2025-09-01.md')
    expect(exp.data).toMatchObject({ markdownPath: join(dir, asked), htmlPath: join(dir, 'het-weekly-2025-09-01.html'), total_minutes_tenths: 0 })
    expect(readFileSync(exp.data.markdownPath, 'utf8')).toContain(D2_FOOTER)

    await svc.stop()
    expect(() => svc.summary()).toThrow(/closed/)
    await svc.tickNow() // no-op after stop
    expect(refreshes).toBe(1)
  })

  test('persistSummaries=false from het-settings.json is honoured', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'het-settings.json'), JSON.stringify({ version: 1, persistSummaries: false }))
    const source = {
      async refresh() {
        return { events: [ev('p', 0, { role: 'user' }), ev('p', 1)], sessionTitles: { p: 'real title' }, warnings: {}, files: 1, reparsed: 1 }
      }
    }
    const svc = createHetService({ dbFile: join(dir, 'het.db'), settingsFile: join(dir, 'het-settings.json'), source, now: () => BASE + 120 * MIN })
    await svc.tickNow()
    const t = svc.tasks(10, true)[0]
    expect(t.title).toBeNull()
    expect(t.evidence!.every((e) => e.summary === '')).toBe(true)
    await svc.stop()
  })
})
