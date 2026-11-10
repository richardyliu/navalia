import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ensureDefaultAnchors } from '../../src/main/het/anchors'
import { waitingKey } from '../../src/main/het/api'
import { disabledTransport, type AssessorTransport } from '../../src/main/het/assessor'
import { correctTask, hetPeriod, hetSummary } from '../../src/main/het/ledger'
import { migrateHet } from '../../src/main/het/schema'
import { DEFAULT_HET_SETTINGS } from '../../src/main/het/settings'
import { tick } from '../../src/main/het/tick'
import type { AgentEvent } from '../../src/main/het/types'
import { assessorLabel, reasonRows, scopeLabels } from '../../src/renderer/src/components/het/labels'
import { setLocale } from '../../src/shared/i18n'

const BASE = Date.UTC(2025, 8, 1)
const MIN = 60_000
const ev = (s: string, min: number, over: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: 'claude-code', sessionId: s, ts: BASE + min * MIN, cwd: `/p/${s}`, project: `/p/${s}`, role: 'assistant',
  toolNames: [], filesWritten: [], filesRead: [], signals: [], summary: '', sidechain: false,
  source: { file: `/t/${s}.jsonl`, line: min + 1 }, ...over
})
const ok: AssessorTransport = {
  name: 'mock',
  async complete() {
    return { outcome: 'ok', text: JSON.stringify({ kind: 'ops', size: 'm', complexity: 'low', agent_share: 1, adoption: 'unknown', evidence: [] }) }
  }
}

describe('HET period counts are whole-range, not page-capped (UI scope nit)', () => {
  test('counts and reason buckets match the rows across all pages', async () => {
    const db = new DatabaseSync(':memory:')
    migrateHet(db)
    ensureDefaultAnchors(db, BASE)
    const events: AgentEvent[] = []
    for (let i = 0; i < 260; i++) events.push(ev(`s${i}`, i * 60, { role: 'user' }), ev(`s${i}`, i * 60 + 1))
    events.push(ev('live', 260 * 60, { role: 'user' }), ev('live', 260 * 60 + 1)) // still running at `now`
    const now = BASE + (260 * 60 + 5) * MIN
    const s = { ...DEFAULT_HET_SETTINGS, perTickCap: 3 }
    await tick({ db, transport: ok, settings: s, input: { events } }, now) // 3 assessed
    await tick({ db, transport: disabledTransport, settings: s, input: { events } }, now + 1) // 1 budget_unavailable
    const assessed = db.prepare("SELECT id FROM het_tasks WHERE status = 'assessed' ORDER BY id").all() as Array<{ id: string }>
    expect(assessed).toHaveLength(3)
    correctTask(db, assessed[0].id, 'not_agent', now + 2)

    const p = hetPeriod(db, { start: BASE, end: now + 1, limit: 50 })
    expect(p.tasks).toHaveLength(50) // the page is capped …
    expect(p.counts).toEqual({
      tasks: 261,
      counted: 2,
      needs_assessment: 257,
      unsettled: 1,
      failed: 0,
      excluded: 1,
      waiting_by_reason: { budget_unavailable: 1, queued: 256, unsettled: 1 }
    }) // … the counts are not
    // all-time banner and range card agree when the range covers everything
    expect(hetSummary(db, { now, days: 366 }).pending).toBe(p.counts.needs_assessment)

    // row-level waitingKey uses the same buckets as the SQL
    const all: string[] = []
    let cursor: string | null = null
    do {
      const pg = hetPeriod(db, { start: BASE, end: now + 1, cursor, limit: 200 })
      for (const t of pg.tasks) if (!t.counted && !t.correction) all.push(waitingKey(t))
      cursor = pg.next_cursor
    } while (cursor)
    const byKey = all.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})
    expect(byKey).toEqual(p.counts.waiting_by_reason)
  })
})

describe('HET labels (English default)', () => {
  const counts = { tasks: 60, counted: 0, needs_assessment: 49, unsettled: 1, failed: 0, excluded: 0, waiting_by_reason: { queued: 49, unsettled: 1 } }
  test('stat card, queue and assessor labels', () => {
    const l = scopeLabels('month', counts)
    expect(l.pendingCardLabel).toBe('Awaiting assessment · This month')
    expect(l.pendingCardDetail).toContain('1 more in progress')
    expect(l.queueTitle).toBe('Not counted · This month (50)')
    expect(assessorLabel('disabled')).toEqual({ value: 'Off (LLM calls not authorized)', tone: 'warn' })
    expect(reasonRows(counts, 'disabled')[1].text).toContain('LLM calls not authorized')
  })
})

describe('HET labels', () => {
  beforeEach(() => setLocale('zh'))
  afterEach(() => setLocale('en'))
  const counts = { tasks: 60, counted: 0, needs_assessment: 49, unsettled: 1, failed: 0, excluded: 0, waiting_by_reason: { queued: 49, unsettled: 1 } }
  test('stat card and queue are scoped to the selected range', () => {
    const l = scopeLabels('month', counts)
    expect(l.pendingCardLabel).toBe('本月等待评估')
    expect(l.pendingCardValue).toBe(49)
    expect(l.pendingCardDetail).toContain('另有 1 个进行中')
    expect(l.failedCardLabel).toBe('本月评估失败')
    expect(l.queueTitle).toBe('本月未计入（50）')
    expect(scopeLabels('today', undefined).pendingCardValue).toBeNull()
  })
  test('assessor card states the reason, not just "disabled"', () => {
    expect(assessorLabel('disabled')).toEqual({ value: '未启用（未授权 LLM 调用）', tone: 'warn' })
    expect(assessorLabel(undefined).value).toBe('—')
  })
  test('reason rows in stable order with transport-aware text', () => {
    const rows = reasonRows(counts, 'disabled')
    expect(rows.map((r) => [r.key, r.n])).toEqual([['unsettled', 1], ['queued', 49]])
    expect(rows[1].text).toContain('未授权 LLM 调用')
  })
})
