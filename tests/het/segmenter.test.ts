import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { taskId } from '../../src/main/het/segmenter'
import { readClaudeProjects, readCodexSessions, segment } from './readers'
import { attendedFromBlocks, attendedFromTrajectory } from '../../src/main/het/timeline'
import type { AgentEvent } from '../../src/main/het/types'

const FIX = join(__dirname, '..', 'fixtures', 'het')
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'
const BASE = Date.UTC(2025, 8, 1, 10, 0, 0)
const T = (min: number): number => BASE + min * 60_000
const MIN = 60_000

const claude = readClaudeProjects({ root: join(FIX, 'claude') })
const input = { events: claude.events, sessionTitles: claude.sessionTitles }

function ev(sessionId: string, min: number, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    agent: 'claude-code',
    sessionId,
    ts: T(min),
    cwd: '/p',
    project: '/p',
    role: 'assistant',
    toolNames: [],
    filesWritten: [],
    filesRead: [],
    signals: [],
    summary: '',
    sidechain: false,
    source: { file: sessionId, line: Math.round(min * 10) },
    ...over
  }
}

describe('segmenter on Claude fixtures', () => {
  const tasks = segment(input, T(200))

  test('idle-gap split + same-project merge + separate project', () => {
    expect(tasks.map((t) => [t.project, t.start, t.end, t.sessionIds])).toEqual([
      ['/work/demo-app', T(0), T(13), [S1, S2]],
      ['/work/other', T(2), T(2), [S3]],
      ['/work/demo-app', T(70), T(73), [S1]]
    ])
  })

  test('task fields', () => {
    const [a, , b] = tasks
    expect(a.kind).toBe('unassessed')
    expect(a.status).toBe('settled')
    expect(a.title).toBe('Add dry-run flag to export')
    expect(a.stats).toEqual({
      events: 16,
      userTurns: 2,
      assistantTurns: 7,
      toolCalls: 7,
      filesWritten: 3,
      filesRead: 0,
      sidechainEvents: 2
    })
    expect(a.filesWritten).toEqual([
      '/work/demo-app/CHANGELOG.md',
      '/work/demo-app/src/export.ts',
      '/work/demo-app/tests/export.test.ts'
    ])
    expect(a.signals).toEqual(['git_commit', 'pr_link', 'tool_error'])
    expect(a.attendedMs).toBeNull()
    expect(b.stats.userTurns).toBe(1)
    expect(b.filesWritten).toEqual(['/work/demo-app/README.md'])
    expect(a.id).toBe(taskId('claude-code', S1, T(0)))
  })

  test('settle boundary is clock-driven', () => {
    const at = segment(input, T(73) + 30 * MIN - 1)
    expect(at.find((t) => t.start === T(70))!.status).toBe('unsettled')
    const after = segment(input, T(73) + 30 * MIN)
    expect(after.find((t) => t.start === T(70))!.status).toBe('settled')
  })

  test('replay at earlier now only sees past events; ids stay stable', () => {
    const early = segment(input, T(5))
    expect(early.map((t) => [t.project, t.end, t.status])).toEqual([
      ['/work/demo-app', T(5), 'unsettled'],
      ['/work/other', T(2), 'unsettled']
    ])
    expect(early[0].id).toBe(tasks[0].id)
  })

  test('deterministic and order-independent', () => {
    const shuffled = [...claude.events].reverse()
    expect(segment({ ...input, events: shuffled }, T(200))).toEqual(tasks)
    expect(segment(input, T(200))).toEqual(tasks)
  })

  test('attended overlap from runtime trajectory payload', () => {
    const attended = attendedFromTrajectory(
      JSON.stringify({
        trajectory: [
          { surface: 'Terminal', start: new Date(T(0)).toISOString(), end: new Date(T(5)).toISOString() },
          { surface: 'Editor', start: new Date(T(4)).toISOString(), end: new Date(T(8)).toISOString() },
          { surface: 'bad', start: 'nope', end: 'x' }
        ]
      })
    )
    expect(attended).toHaveLength(2)
    const t = segment({ ...input, attended }, T(200))
    expect(t[0].attendedMs).toBe(8 * MIN)
    expect(t[1].attendedMs).toBe(0) // zero-length task at T(2)
    expect(t[2].attendedMs).toBe(0)
    expect(attendedFromBlocks([{ start_time: new Date(T(0)).toISOString(), end_time: new Date(T(1)).toISOString() }])).toEqual([
      { start: T(0), end: T(1) }
    ])
  })
})

describe('segmenter boundaries (inline synthetic events)', () => {
  test('gap exactly idleGap does not split; idleGap+1ms does', () => {
    const same = segment({ events: [ev('a', 0), ev('a', 30)] }, T(500))
    expect(same).toHaveLength(1)
    const split = segment(
      { events: [ev('a', 0), ev('a', 0.5), ev('a', 30.5, { ts: T(30.5) + 1 }), ev('a', 31)] },
      T(500),
      { mergeGapMs: 0 }
    )
    expect(split).toHaveLength(2)
  })

  test('merge gap boundary across sessions in one project', () => {
    const mk = (gapMin: number, extraMs = 0) =>
      segment({ events: [ev('a', 0), ev('a', 1), ev('b', 1 + gapMin, { ts: T(1 + gapMin) + extraMs }), ev('b', 2 + gapMin)] }, T(500))
    expect(mk(10)).toHaveLength(1)
    expect(mk(10, 1)).toHaveLength(2)
  })

  test('different agents or unknown project never merge', () => {
    const agents = segment({ events: [ev('a', 0), ev('a', 1), ev('b', 1, { agent: 'codex' }), ev('b', 2, { agent: 'codex' })] }, T(500))
    expect(agents).toHaveLength(2)
    const noProj = segment(
      { events: [ev('a', 0, { project: null }), ev('a', 1, { project: null }), ev('b', 1, { project: null }), ev('b', 2, { project: null })] },
      T(500)
    )
    expect(noProj).toHaveLength(2)
  })

  test('noise filters: minEvents and requireTurn', () => {
    expect(segment({ events: [ev('a', 0)] }, T(500))).toHaveLength(0)
    const sysOnly = segment({ events: [ev('a', 0, { role: 'system' }), ev('a', 1, { role: 'tool_result' })] }, T(500))
    expect(sysOnly).toHaveLength(0)
    const sidechainUserOnly = segment(
      { events: [ev('a', 0, { role: 'user', sidechain: true }), ev('a', 1, { role: 'system' })] },
      T(500)
    )
    expect(sidechainUserOnly).toHaveLength(0)
  })

  test('dominant project wins inside a session', () => {
    const t = segment({ events: [ev('a', 0, { project: '/x' }), ev('a', 1, { project: '/y' }), ev('a', 2, { project: '/y' })] }, T(500))
    expect(t[0].project).toBe('/y')
  })

  test('invalid option ordering throws', () => {
    expect(() => segment({ events: [] }, 0, { mergeGapMs: 40 * MIN })).toThrow()
    expect(() => segment({ events: [] }, 0, { settleAfterMs: MIN })).toThrow()
  })

  test('codex fixture segments into one task', () => {
    const cx = readCodexSessions({ root: join(FIX, 'codex') })
    const t = segment({ events: cx.events }, Date.UTC(2025, 8, 2))
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ agent: 'codex', project: '/work/codex-proj', status: 'settled' })
    expect(t[0].stats.userTurns).toBe(1)
  })
})
