// S1-R3-04: 「本周 AI 工作计数」 on Home. Pure view-model + static render + click-through. No IPC, no
// DOM, no real ~/.persome or het.db: the ledger side uses an in-memory fixture het.db.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as React from 'react'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { ensureDefaultAnchors } from '../../src/main/het/anchors'
import { COMMIT_SIGNAL_DEFINITION, HET_COUNT_FILTERS, type HetCountFilter, type HetWeekCounts } from '../../src/main/het/api'
import { migrateHet } from '../../src/main/het/schema'
import { hetFilteredTasks, hetWeekCounts } from '../../src/main/het/weekCounts'
import { countFilterFromParams, countNavParams, filteredHeading } from '../../src/renderer/src/components/het/countFilter'
import { AiWorkCountsBody } from '../../src/renderer/src/components/home/AiWorkCounts'
import { aiCountsDisclaimer, aiCountsTitle, aiCountsView } from '../../src/renderer/src/components/home/aiCountsView'
;(globalThis as { React?: typeof React }).React = React

const SH = 'Asia/Shanghai'
const NOW = Date.parse('2026-11-05T02:00:00Z') // Thu 10:00 Shanghai, 2026-W45
const W_START = Date.parse('2026-11-01T16:00:00Z')
const HOUR = 3_600_000

function wc(over: Partial<HetWeekCounts> = {}): HetWeekCounts {
  return {
    iso_week: '2026-W45',
    week_start: '2026-11-02',
    week_end: '2026-11-08',
    start: '2026-11-01T16:00:00.000Z',
    end: '2026-11-08T16:00:00.000Z',
    timezone: SH,
    tasks: 6,
    counts: { accepted: 2, rejected: 1, not_agent: 0, commit_signal: 3 },
    commit_signal_definition: COMMIT_SIGNAL_DEFINITION,
    ...over
  }
}

const html = (c: HetWeekCounts, onOpen = (): void => undefined): string =>
  renderToStaticMarkup(createElement(AiWorkCountsBody, { view: aiCountsView(c), onOpen }))

/** Collect intrinsic elements in a rendered tree (AiWorkCountsBody uses intrinsic elements only). */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out))
  else if (isValidElement(node)) {
    out.push(node)
    elements((node.props as { children?: ReactNode }).children, out)
  }
  return out
}

describe('copy', () => {
  test('title and disclaimer are literal; no Performance / score / minutes / percentages', () => {
    expect(aiCountsTitle()).toBe('AI work counts this week')
    expect(aiCountsDisclaimer()).toBe('These are counts, not a rating of your work, and do not represent time saved')
    setLocale('zh')
    try {
      expect(aiCountsTitle()).toBe('本周 AI 工作计数')
      expect(aiCountsDisclaimer()).toBe('这是计数，不是绩效分，不代表节省时间')
    } finally {
      setLocale('en')
    }
    for (const c of [wc(), wc({ tasks: 0, counts: { accepted: 0, rejected: 0, not_agent: 0, commit_signal: 0 } })]) {
      const h = html(c)
      expect(h).toContain(aiCountsDisclaimer())
      expect(h).not.toMatch(/performance/i)
      expect(h).not.toMatch(/score/i)
      expect(h).not.toContain('%')
      expect(h).not.toMatch(/分钟|小时|minute/i)
    }
    const src = ['components/home/AiWorkCounts.tsx', 'components/home/aiCountsView.ts', 'components/het/countFilter.ts', 'components/het/FilteredTaskList.tsx']
      .map((f) => readFileSync(join(__dirname, '../../src/renderer/src', f), 'utf8'))
      .join('\n')
    expect(src).not.toMatch(/Performance score|绩效得分|效率分/i)
  })

  test('commit-signal tooltip carries the exact definition', () => {
    const v = aiCountsView(wc())
    if (v.kind !== 'counts') throw new Error('expected counts')
    expect(v.items.find((i) => i.filter === 'commit_signal')!.title).toBe(COMMIT_SIGNAL_DEFINITION)
    const h = html(wc())
    expect(h).toContain('git_commit')
    expect(h).toContain('does not mean the commit succeeded')
  })
})

describe('each count', () => {
  test('four items in fixed order with the ledger numbers, plus the week task total', () => {
    const v = aiCountsView(wc())
    expect(v.kind).toBe('counts')
    if (v.kind !== 'counts') return
    expect(v.items.map((i) => [i.filter, i.n])).toEqual([
      ['accepted', 2],
      ['rejected', 1],
      ['not_agent', 0],
      ['commit_signal', 3]
    ])
    expect(v.tasks).toBe(6)
    expect(v.weekLabel).toContain('2026-W45')
    expect(v.weekLabel).toContain('2026-11-02')
    expect(v.weekLabel).toContain('2026-11-08')
    const h = html(wc())
    for (const f of HET_COUNT_FILTERS) expect(h).toContain(`data-filter="${f}"`)
  })

  test('a real zero (tasks exist, nobody marked not_agent) is shown as 0, not hidden', () => {
    const h = html(wc())
    expect(h).toMatch(/data-filter="not_agent"[^>]*>[\s\S]*?<strong[^>]*>0<\/strong>/)
  })

  test('counts from a fixture ledger end up on the card unchanged', () => {
    const db = new DatabaseSync(':memory:')
    migrateHet(db)
    ensureDefaultAnchors(db, W_START)
    const ins = db.prepare(
      `INSERT INTO het_tasks (id, agent, start_ms, end_ms, status, correction, fingerprint, session_ids, stats, signals, created_ms, updated_ms)
       VALUES (?, 'codex', ?, ?, 'needs_assessment', ?, 'fp', '[]', '{}', ?, 0, 0)`
    )
    ins.run('het_00000000000000000001', W_START, W_START + HOUR, 'accepted', '["git_commit"]')
    ins.run('het_00000000000000000002', W_START, W_START + 2 * HOUR, 'not_agent', '[]')
    ins.run('het_00000000000000000003', W_START, W_START + 3 * HOUR, null, '["git_push"]')
    const v = aiCountsView(hetWeekCounts(db, { now: NOW, timezone: SH }))
    if (v.kind !== 'counts') throw new Error('expected counts')
    expect(Object.fromEntries(v.items.map((i) => [i.filter, i.n]))).toEqual({ accepted: 1, rejected: 0, not_agent: 1, commit_signal: 1 })
    expect(v.tasks).toBe(3)
  })
})

describe('empty state', () => {
  test('no tasks in the week → empty view, no count buttons, no zeros', () => {
    const c = wc({ tasks: 0, counts: { accepted: 0, rejected: 0, not_agent: 0, commit_signal: 0 } })
    const v = aiCountsView(c)
    expect(v.kind).toBe('empty')
    const h = html(c)
    expect(h).not.toContain('data-filter')
    expect(h).not.toMatch(/>0</)
    expect(h).toContain('has no tasks')
    expect(h).toContain('2026-W45')
  })
})

describe('click-through filter', () => {
  test('each number is a button that opens the HET list with that filter and the same week window', () => {
    const c = wc()
    const onOpen = vi.fn()
    const tree = AiWorkCountsBody({ view: aiCountsView(c), onOpen })
    const buttons = elements(tree).filter((e) => e.type === 'button' && (e.props as Record<string, unknown>)['data-filter'])
    expect(buttons.map((b) => (b.props as Record<string, unknown>)['data-filter'])).toEqual([...HET_COUNT_FILTERS])
    for (const b of buttons) (b.props as { onClick: () => void }).onClick()
    expect(onOpen.mock.calls.map((a) => a[0])).toEqual([...HET_COUNT_FILTERS])

    for (const f of HET_COUNT_FILTERS) {
      const params = countNavParams(c, f)
      const parsed = countFilterFromParams(params)
      expect(parsed).toEqual({ filter: f, start: c.start, end: c.end, week: c.iso_week, timezone: SH })
    }
  })

  test('nav params → ledger filter returns exactly the counted tasks', () => {
    const db = new DatabaseSync(':memory:')
    migrateHet(db)
    ensureDefaultAnchors(db, W_START)
    const ins = db.prepare(
      `INSERT INTO het_tasks (id, agent, start_ms, end_ms, status, correction, fingerprint, session_ids, stats, signals, created_ms, updated_ms)
       VALUES (?, 'claude-code', ?, ?, 'assessed', ?, 'fp', '[]', '{}', ?, 0, 0)`
    )
    ins.run('het_000000000000000000a1', W_START, W_START + HOUR, 'accepted', '["git_commit"]')
    ins.run('het_000000000000000000a2', W_START, W_START + 2 * HOUR, 'rejected', '[]')
    ins.run('het_000000000000000000a3', W_START, W_START + 3 * HOUR, null, '["git_commit","git_push"]')
    ins.run('het_000000000000000000a4', W_START - 5 * HOUR, W_START - 1, 'accepted', '["git_commit"]') // last week
    const counts = hetWeekCounts(db, { now: NOW, timezone: SH })
    for (const f of HET_COUNT_FILTERS) {
      const p = countFilterFromParams(countNavParams(counts, f))!
      const r = hetFilteredTasks(db, { start: Date.parse(p.start), end: Date.parse(p.end), filter: p.filter, timezone: p.timezone })
      expect(r.total).toBe(counts.counts[f])
      expect(r.tasks.length).toBe(counts.counts[f])
    }
  })

  test('bad or missing params → no filter (the HET page shows its normal view)', () => {
    expect(countFilterFromParams({})).toBeNull()
    expect(countFilterFromParams({ filter: 'score', start: wc().start, end: wc().end })).toBeNull()
    expect(countFilterFromParams({ filter: 'accepted', start: 'x', end: wc().end })).toBeNull()
    expect(countFilterFromParams({ filter: 'accepted', start: wc().end, end: wc().start })).toBeNull()
  })

  test('filtered list heading names the filter, week and total; no minutes', () => {
    const h = filteredHeading('commit_signal' as HetCountFilter, '2026-W45', 3)
    expect(h).toContain('2026-W45')
    expect(h).toContain('3')
    expect(h).toContain('commit signal')
    expect(h).not.toMatch(/分钟|performance/i)
  })

  test('wiring: Home renders the card; Het page reads the count filter from nav params', () => {
    const home = readFileSync(join(__dirname, '../../src/renderer/src/pages/Home.tsx'), 'utf8')
    expect(home).toContain('AiWorkCountsCard')
    const het = readFileSync(join(__dirname, '../../src/renderer/src/pages/Het.tsx'), 'utf8')
    expect(het).toContain('countFilterFromParams')
    expect(het).toContain('FilteredTaskList')
  })
})
