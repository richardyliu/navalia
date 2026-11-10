// DEPLOY-05: evidence shapes from Runtime schema 2026-11-05.3 (personal-model-og be0a0bc).
// - MOD-07/08 (17ede48): `⟨digest:model_candidate_evidence⟩` resolves (kind candidate_evidence, status resolved,
//   metadata.quote/window_*); promoted Points list `candidate_evidence` sources.
// - MOD-12 (0249572): with `as_of`, Points / relation edges come back with their status AT T and
//   metadata {status_now, as_of, effective_from, effective_basis}; `not_yet_effective` empties sources/context.
// Shapes copied from evidence.py `_base` / `_link` / `_status_as_of`; no Runtime call.
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { EvidenceResponse } from '../../src/shared/types'
import { AsOfBar } from '../../src/renderer/src/components/EvidenceDrawer'
import { asOfCaveatText, asOfStatusCaveatText, asOfCaveat } from '../../src/renderer/src/components/evidence/asOf'
import { trimDeltaReport } from '../../src/main/runtime/deltaReport'
import {
  mod07KnownIssue,
  mod07PointKnownIssue,
  NO_FALLBACK,
  buildEvidenceView,
  droppedFromDeltaReport,
  parseDeltaReport
} from '../../src/renderer/src/components/evidence/model'

// These assertions pin the original Chinese wording; the English path has its own test at the end.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))
;(globalThis as { React?: typeof React }).React = React

const CANDIDATE: EvidenceResponse = {
  reference: '⟨6fd77af9aa:model_candidate_evidence⟩',
  canonical_reference: '6fd77af9aa',
  kind: 'candidate_evidence',
  id: '6fd77af9aa',
  status: 'resolved',
  label: 'Zhang Wei is my manager',
  summary: 'Zhang Wei is my manager',
  timestamp: '2026-11-04T10:30:00+00:00',
  path: 'model_candidate_evidence',
  metadata: { provenance: 'observed_quote', quote: 'Zhang Wei is my manager', session_id: 's1', window_start: '2026-11-04T10:00:00+00:00', window_end: '2026-11-04T10:30:00+00:00', point_ids: ['pt-9'] },
  sources: [],
  context: [],
  history: []
}

const PROMOTED_POINT: EvidenceResponse = {
  reference: 'pt-9',
  canonical_reference: '⟨pt-9:person-zhang-wei.md⟩',
  kind: 'point',
  id: 'pt-9',
  status: 'active',
  label: 'Zhang Wei is my manager',
  summary: '',
  timestamp: '2026-11-04T11:00:00+00:00',
  path: 'person-zhang-wei.md',
  metadata: { observed_from: '2026-11-03T10:00:00+00:00', observed_until: '2026-11-04T10:30:00+00:00' },
  sources: [
    { relation: 'candidate_evidence', kind: 'candidate_evidence', id: '6fd77af9aa', reference: '6fd77af9aa', label: 'Zhang Wei is my manager', timestamp: '2026-11-04T10:30:00+00:00', status: 'resolved', resolvable: true, quote: 'Zhang Wei is my manager' }
  ],
  context: [],
  history: []
}

const NOT_YET: EvidenceResponse = {
  ...PROMOTED_POINT,
  status: 'not_yet_effective',
  metadata: { status_now: 'active', as_of: '2026-03-01T00:00:00+00:00', effective_from: '2026-11-03T10:00:00+00:00', effective_basis: 'valid_from' },
  sources: [],
  context: []
}

describe('Runtime 2026-11-05.3 evidence', () => {
  test('MOD-07/08: a candidate-evidence receipt resolves; nothing is marked unresolved', () => {
    const v = buildEvidenceView(CANDIDATE)
    expect(v.rootUnresolved).toBeNull()
    expect(v.pointUnresolved).toBeNull()
    const p = buildEvidenceView(PROMOTED_POINT)
    expect(p).toMatchObject({ sourceCount: 1, pointWithoutSources: false, pointUnresolved: null, unresolvedSources: [] })
  })

  test('known-issue notes are version-qualified (fixed in 2026-11-05.3), not stated as current fact', () => {
    for (const text of [mod07KnownIssue(), mod07PointKnownIssue(), NO_FALLBACK.text]) {
      expect(text).toContain('2026-11-05.3')
      expect(text).not.toContain('总是返回 missing。')
    }
  })

  test('MOD-12: status at T is shown with today\'s status beside it; not_yet_effective is not "证据未解析"', () => {
    const v = buildEvidenceView(NOT_YET)
    expect(v.pointWithoutSources).toBe(false)
    expect(v.pointUnresolved).toBeNull()
    expect(v.asOfStatus).toMatchObject({ statusAt: 'not_yet_effective', statusNow: 'active', effectiveFrom: '2026-11-03T10:00:00+00:00', basis: 'valid_from' })
    expect(v.asOfStatus!.text).toContain('尚未生效')
    expect(v.asOfStatus!.text).toContain('active')
    const sup = buildEvidenceView({ ...PROMOTED_POINT, status: 'superseded', metadata: { status_now: 'superseded', as_of: '2026-11-04T12:00:00+00:00', effective_from: '2026-11-03T10:00:00+00:00', effective_basis: 'valid_from' } })
    expect(sup.asOfStatus).toMatchObject({ statusAt: 'superseded', statusNow: 'superseded' })
    expect(buildEvidenceView(PROMOTED_POINT).asOfStatus).toBeNull()
  })

  test('caveat: status-aware Runtime → MOD-12 fixed note; older Runtime (no status_now) → the old cut-off caveat', () => {
    expect(asOfCaveat('2026-03-01', NOT_YET)).toBe(asOfStatusCaveatText())
    expect(asOfCaveat('2026-03-01', PROMOTED_POINT)).toBe(asOfCaveatText())
    expect(asOfCaveat('2026-03-01')).toBe(asOfCaveatText())
    expect(asOfCaveat(undefined, NOT_YET)).toBeNull()
    const html = renderToStaticMarkup(createElement(AsOfBar, { asOf: '2026-03-01', onApply: () => undefined, response: NOT_YET }))
    expect(html).toContain(asOfStatusCaveatText())
  })
})

// MOD-07 drop itemization (17ede48): `persome delta-report --json-out` now carries aggregate.drop_reasons
// {reason: count} and recent[].drop_reasons [{head, index, reason, summary}] (cli.py delta_report,
// store/memory_deltas.py stats). `summary` is memory content and must never leave main.

describe('Runtime 2026-11-05.3 delta-report drop reasons', () => {
  const report = {
    aggregate: { rows: 3, sessions: 2, heads: { entities: 1 }, dropped_by_gates: 5, drop_reasons: { quote_not_in_source: 3, no_quote: 1, 'Bad Reason!': 9 } },
    recent: [
      {
        session_id: 's1', created_at: '2026-11-05T10:00:00', status: 'applied', dropped: 2, payload: '{"entities":["SECRET payload"]}',
        drop_reasons: [
          { head: 'assertions', index: 0, reason: 'quote_not_in_source', summary: 'SECRET summary text' },
          { head: 'assertions', index: 1, reason: 'quote_not_in_source', summary: 'SECRET 2' }
        ]
      },
      { session_id: 's0', created_at: '2026-11-04T10:00:00', status: 'applied', dropped: 1, drop_reasons: [] }
    ]
  }

  test('main keeps reason codes and counts only; summaries and payloads never leave main', () => {
    const t = trimDeltaReport(report)
    expect(t.aggregate).toEqual({ rows: 3, sessions: 2, dropped_by_gates: 5, drop_reasons: { no_quote: 1, quote_not_in_source: 3 } })
    expect(t.recent).toEqual([
      { session_id: 's1', created_at: '2026-11-05T10:00:00', status: 'applied', dropped: 2, drop_reasons: { quote_not_in_source: 2 } },
      { session_id: 's0', created_at: '2026-11-04T10:00:00', status: 'applied', dropped: 1, drop_reasons: {} }
    ])
    expect(JSON.stringify(t)).not.toContain('SECRET')
  })

  test('renderer: global notice names the Runtime reason codes instead of claiming there are none', () => {
    const notice = droppedFromDeltaReport(parseDeltaReport(trimDeltaReport(report)))
    expect(notice!.count).toBe(5)
    expect(notice!.text).toContain('quote_not_in_source=3')
    expect(notice!.text).toContain('no_quote=1')
    expect(notice!.text).not.toContain('Runtime 未提供逐条原因')
  })
})

describe('Runtime 2026-11-05.3 English copy', () => {
  test('as-of status and known-issue notes read in English by default', () => {
    setLocale('en')
    expect(buildEvidenceView(NOT_YET).asOfStatus!.text).toContain('not yet in effect')
    expect(mod07KnownIssue()).toContain('2026-11-05.3')
    expect(asOfCaveatText()).toContain('MOD-12')
  })
})
