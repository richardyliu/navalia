import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { fixtureTransport, readAssessorFixture } from '../../src/main/het/fixtureTransport'
import { createHetService } from '../../src/main/het/service'

/**
 * LENS_HET_FAKE_ASSESSOR: the E2E path for counted minutes (assessed → minutes →
 * correction recomputes) without any LLM. Fixture: tests/fixtures/het/fake-assessor.json
 * over the Claude transcript fixtures (tests/fixtures/het/claude).
 */
const FIX = join(__dirname, '..', 'fixtures', 'het')
const A = 'het_0ebde115074148232698' // /work/demo-app 10:00, signals git_commit, pr_link
const B = 'het_c6321821a6a457af5367' // /work/other → research xs low unknown
const C = 'het_cf6caafab90e4f757cc3' // /work/demo-app 11:10 → default verdict
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'het-fake-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function svcWith(env: NodeJS.ProcessEnv, allowFakeAssessor: boolean | undefined) {
  const d = tmp()
  const logs: string[] = []
  const svc = createHetService({
    dbFile: join(d, 'het.db'),
    settingsFile: join(d, 'het-settings.json'),
    env: { LENS_HET_CLAUDE_ROOT: join(FIX, 'claude'), LENS_HET_CODEX_ROOT: '', ...env },
    allowFakeAssessor,
    now: () => Date.UTC(2025, 8, 2),
    log: (m) => logs.push(m)
  })
  return { svc, logs }
}

describe('fake assessor (unpackaged E2E only)', () => {
  test('enabled: assessed → minutes → correction recomputes', async () => {
    const { svc, logs } = svcWith({ LENS_HET_FAKE_ASSESSOR: join(FIX, 'fake-assessor.json') }, true)
    expect(svc.status().transport).toBe('fixture')
    expect(logs).toContain('[het] fake assessor fixture enabled (unpackaged build, no LLM)')
    await svc.tickNow()
    const byId = Object.fromEntries(svc.tasks(10).map((t) => [t.id, t]))
    // A: coding m medium strong → 45 × 1 × 0.85 × 1 = 38.25 → 38.3
    expect(byId[A]).toMatchObject({ status: 'assessed', kind: 'coding', adoption: 'strong', minutes: 38.3, counted: true })
    // C: default writing s low unknown → 30 × 0.5 × 0.3 × 0.75 = 3.375 → 3.4
    expect(byId[C]).toMatchObject({ status: 'assessed', kind: 'writing', minutes: 3.4 })
    // B: research xs low unknown → 20 × 0.25 × 0.3 × 0.75 = 1.125 → 1.1
    expect(byId[B]).toMatchObject({ status: 'assessed', kind: 'research', minutes: 1.1 })
    expect(svc.summary(366).total_minutes_tenths).toBe(383 + 11 + 34) // 42.8 min
    expect(svc.correct(A, 'accepted')).toEqual({ minutes_tenths: 450, changed: true })
    expect(svc.summary(366).total_minutes_tenths).toBe(450 + 11 + 34) // 49.5
    expect(svc.correct(C, 'not_agent')).toEqual({ minutes_tenths: 0, changed: true })
    expect(svc.summary(366).total_minutes_tenths).toBe(450 + 11) // 46.1
    await svc.stop()
  })

  test('an outcome string (quota) stops the tick: first-in-queue pending, the rest untouched', async () => {
    const d = tmp()
    writeFileSync(join(d, 'q.json'), JSON.stringify({ byTaskId: { [B]: 'quota' }, default: { kind: 'ops', size: 'm', complexity: 'low', agent_share: 1, adoption: 'unknown', evidence: [] } }))
    const { svc } = svcWith({ LENS_HET_FAKE_ASSESSOR: join(d, 'q.json') }, true)
    await svc.tickNow()
    const byId = Object.fromEntries(svc.tasks(10).map((t) => [t.id, t]))
    expect(byId[B]).toMatchObject({ status: 'needs_assessment', last_error: 'quota', minutes: null }) // queue is end-ascending: B first
    expect(byId[A].status).toBe('needs_assessment')
    expect(byId[A].last_error).toBeNull()
    expect(svc.summary(366).total_minutes_tenths).toBe(0)
    await svc.stop()
  })

  test('a fixture verdict containing minutes is rejected as invalid (normal zod path)', async () => {
    const { svc } = svcWith({ LENS_HET_FAKE_ASSESSOR: join(FIX, 'fake-assessor-invalid.json') }, true)
    await svc.tickNow()
    const tasks = svc.tasks(10)
    expect(tasks.every((t) => t.status === 'needs_assessment' && t.minutes === null)).toBe(true)
    expect(tasks.filter((t) => t.last_error === 'invalid:minutes_forbidden')).toHaveLength(3)
    expect(svc.summary(366).total_minutes_tenths).toBe(0)
    await svc.stop()
  })

  test('not allowed (packaged) or unset → disabled transport, env ignored', async () => {
    for (const allow of [false, undefined]) {
      const { svc, logs } = svcWith({ LENS_HET_FAKE_ASSESSOR: join(FIX, 'fake-assessor.json') }, allow)
      expect(svc.status().transport).toBe('disabled')
      expect(logs.some((l) => l.includes('LENS_HET_FAKE_ASSESSOR ignored'))).toBe(true)
      await svc.tickNow()
      expect(svc.summary(366).total_minutes_tenths).toBe(0)
      await svc.stop()
    }
    const { svc } = svcWith({}, true)
    expect(svc.status().transport).toBe('disabled')
    await svc.stop()
  })

  test('fixture file is schema-checked; unknown task without default → budget_unavailable', async () => {
    const d = tmp()
    writeFileSync(join(d, 'bad.json'), JSON.stringify({ byKind: {} }))
    expect(() => readAssessorFixture(join(d, 'bad.json'))).toThrow()
    writeFileSync(join(d, 'bad2.json'), JSON.stringify({ byTaskId: { nope: 'quota' } }))
    expect(() => readAssessorFixture(join(d, 'bad2.json'))).toThrow()
    const t = fixtureTransport({ byTaskId: {} })
    expect(await t.complete({ taskId: A, prompt: '' })).toEqual({ outcome: 'budget_unavailable' })
    expect(t.calls).toEqual([A])
  })
})
