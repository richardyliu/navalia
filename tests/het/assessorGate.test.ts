import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { HET_CHANNELS, type HetAssessorStatus } from '../../src/main/het/api'
import { disabledTransport, type AssessorTransport } from '../../src/main/het/assessor'
import { registerHetIpc } from '../../src/main/het/ipc'
import { setLocale } from '../../src/shared/i18n'
import { assessorGate, createHetService, type HetBudgetState } from '../../src/main/het/service'
import { DEFAULT_HET_SETTINGS, readHetSettings, setAssessorEnabled, writeHetSettings } from '../../src/main/het/settings'
import {
  assessorBanner,
  assessorRunning,
  assessorToggleText,
  reasonRows,
  totalCard
} from '../../src/renderer/src/components/het/labels'

/**
 * S1-02 — HET honesty. Minutes only when assessorEnabled AND a real transport AND budget.
 * Uses the synthetic Claude transcript fixtures (3 settled tasks at Date.UTC(2025, 8, 2)).
 */
const FIX = join(__dirname, '..', 'fixtures', 'het')
const NOW = Date.UTC(2025, 8, 2)
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'het-gate-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const VERDICT = JSON.stringify({ kind: 'coding', size: 'm', complexity: 'medium', agent_share: 1, adoption: 'unknown', evidence: [] })
function spy(): AssessorTransport & { calls: number } {
  const t = {
    name: 'spy',
    calls: 0,
    async complete() {
      t.calls++
      return { outcome: 'ok' as const, text: VERDICT }
    }
  }
  return t
}

interface Opts {
  settings?: Record<string, unknown>
  transport?: AssessorTransport
  budget?: () => HetBudgetState
  now?: () => number
}
function make(o: Opts = {}) {
  const d = tmp()
  const settingsFile = join(d, 'het-settings.json')
  if (o.settings) writeFileSync(settingsFile, JSON.stringify({ version: 1, ...o.settings }))
  const dbFile = join(d, 'het.db')
  const svc = createHetService({
    dbFile,
    settingsFile,
    transport: o.transport,
    budget: o.budget,
    env: { LENS_HET_CLAUDE_ROOT: join(FIX, 'claude'), LENS_HET_CODEX_ROOT: '' },
    now: o.now ?? (() => NOW)
  })
  return { svc, dbFile, settingsFile }
}
function ledger(dbFile: string) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const calls = (db.prepare('SELECT COUNT(*) AS n FROM agent_calls').get() as { n: number }).n
    const minutes = (db.prepare('SELECT COUNT(*) AS n FROM het_tasks WHERE minutes_tenths IS NOT NULL').get() as { n: number }).n
    const rows = db.prepare('SELECT status, last_error, attempts, last_attempt_ms FROM het_tasks ORDER BY id').all() as Array<{
      status: string
      last_error: string | null
      attempts: number
      last_attempt_ms: number | null
    }>
    return { calls, minutes, rows }
  } finally {
    db.close()
  }
}
const allTime = (svc: ReturnType<typeof make>['svc']) => svc.period(0, NOW + 86_400_000)

describe('assessorGate decision rule (pure)', () => {
  test('only enabled + real transport + available budget opens the gate', () => {
    const budgets: Array<HetBudgetState | null> = [null, { available: false }, { available: false, reason: 'exhausted' }, { available: true }]
    let open = 0
    for (const enabled of [false, true])
      for (const transportPresent of [false, true])
        for (const budget of budgets) {
          const g = assessorGate({ fixture: false, enabled, transportPresent, budget })
          if (g.gate === null) {
            open++
            expect({ enabled, transportPresent, budget }).toEqual({ enabled: true, transportPresent: true, budget: { available: true } })
            expect(g.state).toBe('ready')
          }
        }
    expect(open).toBe(1)
    expect(assessorGate({ fixture: false, enabled: false, transportPresent: true, budget: { available: true } }).gate).toBe('assessor_disabled')
    expect(assessorGate({ fixture: false, enabled: true, transportPresent: false, budget: { available: true } }).gate).toBe('no_transport')
    expect(assessorGate({ fixture: false, enabled: true, transportPresent: true, budget: null }).gate).toBe('budget_unavailable:no_budget_probe')
    expect(assessorGate({ fixture: false, enabled: true, transportPresent: true, budget: { available: false, reason: 'ex hausted!' } }).gate).toBe(
      'budget_unavailable:ex_hausted_'
    )
    // fixture is the unpackaged E2E path (main passes allowFakeAssessor = !app.isPackaged)
    expect(assessorGate({ fixture: true, enabled: false, transportPresent: false, budget: null })).toMatchObject({ state: 'fixture', gate: null })
  })
})

describe('service: no code path produces minutes without the full gate', () => {
  test('default (no settings file, no transport): 0 minutes, 0 agent_calls, reason assessor_disabled', async () => {
    const { svc, dbFile } = make()
    expect(svc.status()).toMatchObject({ transport: 'disabled', assessor: { enabled: false, transport_present: false, state: 'disabled' } })
    await svc.tickNow()
    const p = allTime(svc)
    expect(p.counts.tasks).toBe(3)
    expect(p.total_minutes_tenths).toBe(0)
    expect(p.counts).toMatchObject({ counted: 0, needs_assessment: 3, waiting_by_reason: { assessor_disabled: 3 } })
    expect(svc.summary(366)).toMatchObject({ total_minutes_tenths: 0, pending: 3 })
    await svc.stop()
    const l = ledger(dbFile)
    expect(l.calls).toBe(0)
    expect(l.minutes).toBe(0)
    expect(l.rows.every((r) => r.status === 'needs_assessment' && r.last_error === 'assessor_disabled' && r.attempts === 0 && r.last_attempt_ms === null)).toBe(true)
  })

  test('default with a working transport + budget injected: the spy is never called', async () => {
    const t = spy()
    const { svc, dbFile } = make({ transport: t, budget: () => ({ available: true }) })
    await svc.tickNow()
    await svc.tickNow()
    expect(t.calls).toBe(0)
    expect(allTime(svc).total_minutes_tenths).toBe(0)
    expect(svc.status().assessor).toMatchObject({ enabled: false, transport_present: true, state: 'disabled' })
    await svc.stop()
    expect(ledger(dbFile)).toMatchObject({ calls: 0, minutes: 0 })
  })

  test('enabled + no transport ⇒ needs_assessment (no_transport), 0 minutes', async () => {
    for (const transport of [undefined, disabledTransport]) {
      const { svc, dbFile } = make({ settings: { assessorEnabled: true }, transport, budget: () => ({ available: true }) })
      expect(svc.status().assessor).toMatchObject({ enabled: true, transport_present: false, state: 'no_transport' })
      await svc.tickNow()
      const p = allTime(svc)
      expect(p.total_minutes_tenths).toBe(0)
      expect(p.counts.waiting_by_reason).toEqual({ no_transport: 3 })
      await svc.stop()
      const l = ledger(dbFile)
      expect(l).toMatchObject({ calls: 0, minutes: 0 })
      expect(l.rows.every((r) => r.status === 'needs_assessment' && r.last_error === 'no_transport')).toBe(true)
    }
  })

  test('enabled + transport + no budget ⇒ needs_assessment (budget_unavailable), spy not called', async () => {
    const cases: Array<[(() => HetBudgetState) | undefined, string]> = [
      [undefined, 'budget_unavailable:no_budget_probe'],
      [() => ({ available: false, reason: 'exhausted' }), 'budget_unavailable:exhausted'],
      [
        () => {
          throw new Error('boom')
        },
        'budget_unavailable:probe_error'
      ]
    ]
    for (const [budget, reason] of cases) {
      const t = spy()
      const { svc, dbFile } = make({ settings: { assessorEnabled: true }, transport: t, budget })
      await svc.tickNow()
      expect(t.calls).toBe(0)
      const p = allTime(svc)
      expect(p.total_minutes_tenths).toBe(0)
      expect(p.counts.waiting_by_reason).toEqual({ budget_unavailable: 3 })
      expect(svc.status().assessor.state).toBe('budget_unavailable')
      await svc.stop()
      const l = ledger(dbFile)
      expect(l).toMatchObject({ calls: 0, minutes: 0 })
      expect(l.rows.every((r) => r.status === 'needs_assessment' && r.last_error === reason && r.attempts === 0)).toBe(true)
    }
  })

  test('positive control: enabled + transport + budget ⇒ assessed with minutes; gated tasks are picked up once the gate opens', async () => {
    const t = spy()
    let budget: HetBudgetState = { available: false, reason: 'exhausted' }
    let now = NOW
    const { svc, dbFile, settingsFile } = make({ settings: { assessorEnabled: true }, transport: t, budget: () => budget, now: () => now })
    await svc.tickNow()
    expect(t.calls).toBe(0)
    budget = { available: true }
    now += 60_000
    await svc.tickNow()
    expect(t.calls).toBe(3) // gating set no last_attempt_ms → no backoff penalty
    const p = allTime(svc)
    expect(p.counts.counted).toBe(3)
    expect(p.total_minutes_tenths).toBeGreaterThan(0)
    expect(p.total_minutes_tenths).toBe(p.tasks.reduce((a, x) => a + (x.minutes_tenths ?? 0), 0))
    // turning it off does not erase measured minutes, and no further calls happen
    const st = svc.setAssessorEnabled(false)
    expect(st).toMatchObject({ enabled: false, state: 'disabled' })
    expect(readHetSettings(settingsFile).assessorEnabled).toBe(false)
    now += 60_000
    await svc.tickNow()
    expect(t.calls).toBe(3)
    await svc.stop()
    expect(ledger(dbFile)).toMatchObject({ calls: 3, minutes: 3 })
  })
})

describe('assessorEnabled persistence', () => {
  test('default false; set preserves other keys; old files without the key read as false', () => {
    const d = tmp()
    const f = join(d, 'het-settings.json')
    expect(readHetSettings(f).assessorEnabled).toBe(false)
    expect(DEFAULT_HET_SETTINGS.assessorEnabled).toBe(false)
    writeFileSync(f, JSON.stringify({ version: 1, persistSummaries: false, perTickCap: 2 })) // pre-S1-02 file
    expect(readHetSettings(f)).toMatchObject({ assessorEnabled: false, persistSummaries: false, perTickCap: 2 })
    setAssessorEnabled(f, true)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ assessorEnabled: true, persistSummaries: false, perTickCap: 2 })
    expect(readHetSettings(f).assessorEnabled).toBe(true)
    setAssessorEnabled(f, false)
    expect(readHetSettings(f).assessorEnabled).toBe(false)
    expect(() => writeHetSettings(f, { ...DEFAULT_HET_SETTINGS, assessorEnabled: 'yes' as unknown as boolean })).toThrow()
    writeFileSync(f, JSON.stringify({ version: 1, assessorEnabled: 1 }))
    expect(() => readHetSettings(f)).toThrow()
  })

  test('IPC channel validates and persists; status reflects it', async () => {
    const { svc, settingsFile } = make()
    const handlers = new Map<string, (e: unknown, raw?: unknown) => unknown>()
    registerHetIpc({ handle: (ch: string, fn: (e: unknown, raw?: unknown) => unknown) => void handlers.set(ch, fn) } as never, {
      service: svc,
      chooseExportPath: async () => null
    })
    const call = (raw?: unknown) => handlers.get(HET_CHANNELS.setAssessorEnabled)!({}, raw) as Promise<{ ok: boolean; data?: HetAssessorStatus }>
    expect((await call({ enabled: 'yes' })).ok).toBe(false)
    expect((await call({ enabled: true, extra: 1 })).ok).toBe(false)
    expect((await call(undefined)).ok).toBe(false)
    const r = await call({ enabled: true })
    expect(r).toMatchObject({ ok: true, data: { enabled: true, transport_present: false, state: 'no_transport' } })
    expect(readHetSettings(settingsFile).assessorEnabled).toBe(true)
    expect(svc.status().assessor.state).toBe('no_transport')
    await svc.tickNow()
    expect(allTime(svc).total_minutes_tenths).toBe(0)
    await svc.stop()
  })
})

const st = (state: HetAssessorStatus['state'], enabled = state !== 'disabled', transport_present = state !== 'disabled' && state !== 'no_transport'): HetAssessorStatus => ({
  enabled,
  transport_present,
  state,
  reason: state === 'budget_unavailable' ? 'exhausted' : null
})

describe('HET page view-models (S1-02 copy, English default)', () => {
  test('banner, total card, toggle and reason rows in English', () => {
    expect(assessorBanner(st('disabled'), 7)!.text).toContain('Assessor off, 0 minutes')
    expect(assessorBanner(st('disabled'), 7)!.text).toContain('7 tasks in this range await assessment')
    expect(totalCard(st('disabled'), 0, 0, '0.0 min')).toMatchObject({ value: 'Unmeasured', tone: 'warn' })
    expect(totalCard(st('disabled'), 120, 2, '12.0 min', 1)).toMatchObject({ value: 'Est. 12.0 min', tone: 'warn' })
    expect(assessorToggleText(st('disabled')).explain).toContain('count as 0 minutes')
    expect(reasonRows({ tasks: 1, counted: 0, needs_assessment: 1, unsettled: 0, failed: 0, excluded: 0, waiting_by_reason: { assessor_disabled: 1 } }, 'disabled')[0].text).toContain('counted as 0 minutes')
  })
})

describe('HET page view-models (S1-02 copy)', () => {
  beforeEach(() => setLocale('zh'))
  afterEach(() => setLocale('en'))
  test('banner says plainly that nothing is counted, with the waiting count', () => {
    expect(assessorBanner(st('disabled'), 7)!.text).toContain('评估器未启用，0 分钟')
    expect(assessorBanner(st('disabled'), 7)!.text).toContain('7 个任务等待评估')
    expect(assessorBanner(st('no_transport'), 2)!.text).toContain('本构建没有可用的 assessor transport')
    expect(assessorBanner(st('budget_unavailable'), 1)!.text).toContain('预算不可用（Runtime 今日调用额度已用完')
    expect(assessorBanner(st('ready'), 3)).toBeNull()
    expect(assessorBanner(st('fixture'), 3)).toBeNull()
    expect(assessorRunning(undefined)).toBe(false)
  })
  test('total card does not show a 0 that looks like a measurement', () => {
    expect(totalCard(st('disabled'), 0, 0, '0.0 分钟')).toMatchObject({ value: '未测量', tone: 'warn' })
    expect(totalCard(st('no_transport'), 0, 0, '0.0 分钟').value).toBe('未测量')
    expect(totalCard(st('disabled'), 120, 2, '12.0 分钟', 1)).toMatchObject({ value: '估计 12.0 分钟', tone: 'warn' })
    expect(totalCard(st('ready'), 120, 2, '12.0 分钟', 3).detail).toContain('估计值（anchors v3）：不是绩效、不是节省时间')
    expect(totalCard(st('disabled'), 120, 2, '12.0 分钟').detail).toContain('评估器当前未运行')
    expect(totalCard(st('ready'), 0, 0, '0.0 分钟')).toMatchObject({ value: '0.0 分钟', tone: 'muted' })
  })
  test('toggle copy explains effect and says when no transport is present', () => {
    expect(assessorToggleText(st('disabled')).explain).toContain('计 0 分钟')
    expect(assessorToggleText(st('disabled')).note).toBeNull()
    expect(assessorToggleText(st('no_transport')).note).toContain('本构建没有可用的 assessor transport')
    expect(assessorToggleText(st('fixture')).note).toContain('fixture')
  })
  test('gate reasons appear in the waiting list in a stable order', () => {
    const counts = { tasks: 5, counted: 0, needs_assessment: 4, unsettled: 1, failed: 0, excluded: 0, waiting_by_reason: { no_transport: 1, assessor_disabled: 3, unsettled: 1 } }
    const rows = reasonRows(counts, 'disabled')
    expect(rows.map((r) => r.key)).toEqual(['unsettled', 'assessor_disabled', 'no_transport'])
    expect(rows[1].text).toContain('计 0 分钟')
  })
})
