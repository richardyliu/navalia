// S1-R4-04: X4 = option B formalized (DECISIONS-ROUND3 §1). The 「本周 AI 工作计数」 view is owner-only:
// it is not a Broker tool or REST route, and it is not written into the Card or the weekly letter.
// Also covers the card's error state, click-through and the non-score copy. Synthetic data only.
import fs from 'node:fs'
import path from 'node:path'
import * as React from 'react'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { TOOL_CATALOG } from '../../src/main/broker/catalog'
import { COMMIT_SIGNAL_DEFINITION, HET_COUNT_FILTERS, type HetWeekCounts } from '../../src/main/het/api'
import { createHetRestRouter } from '../../src/main/het/rest'
import { AiWorkCountsStatus, type AiWorkCountsQueryState } from '../../src/renderer/src/components/home/AiWorkCounts'
import { aiCountsDisclaimer, aiCountsTitle } from '../../src/renderer/src/components/home/aiCountsView'
;(globalThis as { React?: typeof React }).React = React

const ROOT = path.resolve(__dirname, '../..')

function wc(over: Partial<HetWeekCounts> = {}): HetWeekCounts {
  return {
    iso_week: '2026-W45',
    week_start: '2026-11-02',
    week_end: '2026-11-08',
    start: '2026-11-01T16:00:00.000Z',
    end: '2026-11-08T16:00:00.000Z',
    timezone: 'Asia/Shanghai',
    tasks: 9,
    counts: { accepted: 4, rejected: 3, not_agent: 2, commit_signal: 7 },
    commit_signal_definition: COMMIT_SIGNAL_DEFINITION,
    ...over
  }
}

const render = (state: AiWorkCountsQueryState, onOpen = (): void => undefined): string =>
  renderToStaticMarkup(createElement(AiWorkCountsStatus, { state, onOpen }))

function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out))
  else if (isValidElement(node)) {
    out.push(node)
    if (typeof node.type === 'function') elements((node.type as (p: unknown) => ReactNode)(node.props), out)
    else elements((node.props as { children?: ReactNode }).children, out)
  }
  return out
}

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [abs]
  return fs.readdirSync(abs).flatMap((n) => files(path.join(rel, n)))
}

describe('copy: a count, not a score', () => {
  test('the disclaimer is the ledger wording, verbatim', () => {
    expect(aiCountsDisclaimer()).toBe('These are counts, not a rating of your work, and do not represent time saved')
    expect(aiCountsTitle()).not.toMatch(/分数|score|绩效|performance/i)
    setLocale('zh')
    try {
      expect(aiCountsDisclaimer()).toBe('这是计数，不是绩效分，不代表节省时间')
      expect(fs.readFileSync(path.join(ROOT, 'docs/design/DECISIONS-ROUND3.md'), 'utf8')).toContain(`「${aiCountsDisclaimer()}」`)
      expect(aiCountsTitle()).not.toMatch(/分数|score|绩效|performance/i)
    } finally {
      setLocale('en')
    }
  })

  test('every state renders without "score" / 分数 / Performance; 绩效 only inside the disclaimer', () => {
    const states: AiWorkCountsQueryState[] = [
      { kind: 'data', data: wc() },
      { kind: 'data', data: wc({ tasks: 0, counts: { accepted: 0, rejected: 0, not_agent: 0, commit_signal: 0 } }) },
      { kind: 'error', message: 'het.db 打不开' },
      { kind: 'loading' },
      { kind: 'none' }
    ]
    for (const s of states) {
      const h = render(s)
      expect(h).not.toMatch(/score|performance|分数|得分|评分|排名|%/i)
      expect(h.replaceAll(aiCountsDisclaimer(), '')).not.toContain('绩效')
      if (s.kind === 'data' || s.kind === 'error') expect(h).toContain(aiCountsDisclaimer())
    }
  })

  test('HET page eyebrow no longer says Performance', () => {
    const het = fs.readFileSync(path.join(ROOT, 'src/renderer/src/pages/Het.tsx'), 'utf8')
    expect(het).not.toMatch(/Performance/)
    expect(het).toContain('HET · 等效人工时间（未测量）')
  })
})

describe('states', () => {
  test('error state: message shown, no number, no click target', () => {
    const h = render({ kind: 'error', message: 'het.db 打不开' })
    expect(h).toContain('data-state="error"')
    expect(h).toContain('Failed to load: het.db 打不开')
    expect(h).toContain('counts not shown')
    expect(h).not.toContain('data-filter')
    expect(h).not.toMatch(/<strong/)
    expect(render({ kind: 'error', message: null })).toContain('unknown error')
  })

  test('empty state: week without tasks shows no zeros and no buttons', () => {
    const h = render({ kind: 'data', data: wc({ tasks: 0, counts: { accepted: 0, rejected: 0, not_agent: 0, commit_signal: 0 } }) })
    expect(h).toContain('data-state="empty"')
    expect(h).not.toContain('data-filter')
    expect(h).not.toMatch(/>0</)
  })

  test('click-through: each number calls onOpen with the same week data and its own filter', () => {
    const data = wc()
    const onOpen = vi.fn()
    const tree = AiWorkCountsStatus({ state: { kind: 'data', data }, onOpen })
    const buttons = elements(tree).filter((e) => e.type === 'button')
    expect(buttons.map((b) => (b.props as Record<string, unknown>)['data-filter'])).toEqual([...HET_COUNT_FILTERS])
    for (const b of buttons) (b.props as { onClick: () => void }).onClick()
    expect(onOpen.mock.calls).toEqual(HET_COUNT_FILTERS.map((f) => [data, f]))
  })
})

describe('owner-only: not exposed outside the owner UI', () => {
  test('no Broker MCP tool serves the counts', () => {
    const names = TOOL_CATALOG.map((t) => t.name)
    expect(names.length).toBeGreaterThan(10)
    for (const n of names) expect(n).not.toMatch(/count|week|het|score|performance/i)
    const text = JSON.stringify(TOOL_CATALOG)
    expect(text).not.toMatch(/weekCounts|week_counts|commit_signal|本周 AI 工作计数/)
  })

  test('no Broker REST route serves the counts or the filtered list', () => {
    const router = createHetRestRouter({ service: () => { throw new Error('must not be called') } } as never)
    for (const p of ['/het/week-counts', '/het/weekCounts', '/het/counts', '/het/filtered-tasks', '/het/filteredTasks']) {
      for (const m of ['GET', 'POST']) expect(router.resolve(m, p)).toEqual({ status: 404, code: 'not_found' })
    }
  })

  test('Broker, identity (Card), peers (weekly letter) and skillshare never reference the count view', () => {
    const scoped = ['src/main/broker', 'src/main/identity', 'src/main/peers', 'src/main/skillshare', 'src/main/het/rest.ts', 'src/main/het/weekly.ts']
      .flatMap(files)
      .filter((f) => /\.(ts|tsx|json)$/.test(f))
    expect(scoped.some((f) => f.endsWith(path.join('peers', 'letter.ts')))).toBe(true)
    expect(scoped.some((f) => f.endsWith(path.join('broker', 'catalog.ts')))).toBe(true)
    expect(scoped.some((f) => f.endsWith(path.join('identity', 'card-content.ts')))).toBe(true)
    const banned = /het\/weekCounts|hetWeekCounts|hetFilteredTasks|weekCounts|filteredTasks|week-counts|filtered-tasks|AI_COUNTS|aiCountsView|本周 AI 工作计数|COMMIT_SIGNAL|commit_signal/
    for (const f of scoped) {
      expect(banned.test(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f)).toBe(false)
    }
  })

  test('only the HET IPC (owner window), the HET service and the renderer use the count functions', () => {
    const users = files('src')
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /\bhetWeekCounts\b|\bhetFilteredTasks\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
      .sort()
    expect(users).toEqual(['src/main/het/service.ts', 'src/main/het/weekCounts.ts'])
  })
})
