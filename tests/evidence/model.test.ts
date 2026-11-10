import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { EvidenceResponse } from '../../src/shared/types'
import {
  mod07KnownIssue,
  mod07PointKnownIssue,
  NO_FALLBACK,
  pointNoSourcesReason,
  RUNTIME_MISSING_REASONS,
  unresolvedMarker,
  buildEvidenceView,
  droppedFromDeltaReport,
  droppedText,
  parseDeltaReport,
  readDropped,
  receiptPath,
  reproduceCommands
} from '../../src/renderer/src/components/evidence/model'

// These assertions pin the original Chinese wording; the English path has its own test at the end.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

// Real Runtime 0.3.2 output captured by the fidelity audit (docs/test-evidence/MOD-07/receipt-resolve.json).
const MOD07 = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mod07-receipt-missing.json'), 'utf8')
) as EvidenceResponse

// Real Runtime 0.3.2 output for a promoted Point (docs/test-evidence/_scripts/mod07_08_recheck.py, 2026-11-05).
const MOD07_POINT = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mod07-promoted-point-no-sources.json'), 'utf8')
) as EvidenceResponse

// Same shape as tests/mock-runtime.mjs `evidence` (a normal, fully resolved Point).
const NORMAL: EvidenceResponse = {
  reference: '⟨pt-001:user-preferences.md⟩',
  canonical_reference: '⟨pt-001:user-preferences.md⟩',
  kind: 'point',
  id: 'pt-001',
  status: 'active',
  label: '偏好 Rust 写 CLI 工具',
  summary: '…',
  timestamp: '2026-10-12T14:03:00-07:00',
  path: 'user-preferences.md',
  metadata: { confidence: 0.92 },
  sources: [
    {
      relation: 'derived_from',
      kind: 'capture',
      id: 'cap-1',
      reference: '⟨cap:2026-10-12T14-03-11⟩',
      label: 'Terminal · iTerm — cargo init',
      timestamp: '2026-10-12T14:03:11-07:00',
      status: 'ok',
      resolvable: true
    },
    {
      relation: 'direct_lineage',
      kind: 'point',
      id: 'pt-0007',
      reference: '⟨pt-0007:user-preferences.md⟩',
      label: '父 Point',
      timestamp: null,
      status: null,
      resolvable: true
    }
  ],
  context: [
    { relation: 'nearby', kind: 'capture', id: 'cap-0', reference: '⟨cap:0⟩', label: 'VS Code', status: 'ok', resolvable: true }
  ],
  history: [
    { relation: 'previous_version', kind: 'point', id: 'pt-0009', reference: '⟨pt-0009:x.md⟩', label: '早前', resolvable: true }
  ]
}

describe('S1-01 unresolved receipt (MOD-07)', () => {
  test('a missing model_candidate_evidence receipt becomes an explicit unresolved entry, not a source', () => {
    const view = buildEvidenceView(MOD07)
    expect(view.rootUnresolved).not.toBeNull()
    const root = view.rootUnresolved!
    expect(root.marker).toBe(unresolvedMarker())
    expect(root.marker).toBe('证据未解析')
    expect(root.status).toBe('missing')
    expect(root.reasonCode).toBe('source_not_found_or_retained')
    expect(root.reasonText).toBe(RUNTIME_MISSING_REASONS.source_not_found_or_retained)
    expect(root.receiptPreserved).toBe(true)
    expect(root.receiptPath).toBe('model_candidate_evidence')
    expect(root.knownIssue).toBe(mod07KnownIssue())
    expect(view.sources).toEqual([])
    expect(view.sourceCount).toBe(0)
    expect(view.dropped).toBeNull()
  })

  test('only reasons Runtime returned are shown; no reason → says so, never invents one', () => {
    const noReason = buildEvidenceView({ ...MOD07, metadata: {} })
    expect(noReason.rootUnresolved!.reasonCode).toBeNull()
    expect(noReason.rootUnresolved!.reasonText).toBe('Runtime 未提供原因')
    const unknownCode = buildEvidenceView({ ...MOD07, metadata: { reason: 'brand_new_code' } })
    expect(unknownCode.rootUnresolved!.reasonText).toBe('Runtime 原因：brand_new_code')
    // the gloss table only contains the codes evidence.py emits
    expect(Object.keys(RUNTIME_MISSING_REASONS).sort()).toEqual(['empty_reference', 'source_not_found_or_retained'])
  })

  test('unresolved items inside sources are split out and not counted', () => {
    const response: EvidenceResponse = {
      ...NORMAL,
      sources: [
        ...NORMAL.sources,
        {
          relation: 'direct_lineage',
          kind: 'unknown',
          id: 'abc',
          reference: '⟨abc:model_candidate_evidence⟩',
          label: 'Model Candidate Evidence',
          status: 'missing',
          resolvable: false,
          reason: 'source_not_found_or_retained'
        },
        { relation: 'x', kind: 'capture', id: 'gone', reference: '⟨gone:capture⟩', resolvable: false }
      ]
    }
    const view = buildEvidenceView(response)
    expect(view.sourceCount).toBe(2)
    expect(view.sources.map((s) => s.id)).toEqual(['cap-1', 'pt-0007'])
    expect(view.unresolvedSources).toHaveLength(2)
    expect(view.unresolvedSources[0]).toMatchObject({
      status: 'missing',
      reasonCode: 'source_not_found_or_retained',
      receiptPath: 'model_candidate_evidence',
      marker: '证据未解析'
    })
    expect(view.unresolvedSources[1]).toMatchObject({ status: 'unresolvable', reasonCode: null, receiptPath: 'capture' })
    expect(view.rootUnresolved).toBeNull()
  })

  test('a promoted Point with sources=[] is flagged (MOD-07 step 3)', () => {
    const view = buildEvidenceView({ ...NORMAL, sources: [] })
    expect(view.pointWithoutSources).toBe(true)
    expect(view.sourceCount).toBe(0)
  })
})

describe('S1-01 dropped-only case', () => {
  test('dropped=N with no per-item reason renders the honest notice', () => {
    expect(droppedText(2)).toBe('已丢弃 2 条（Runtime 未提供逐条原因）')
    const view = buildEvidenceView({ ...MOD07, metadata: { ...MOD07.metadata, dropped: 2 } })
    expect(view.dropped).toEqual({ count: 2, text: '已丢弃 2 条（Runtime 未提供逐条原因）' })
    expect(view.sources).toEqual([])
  })

  test('non-integer / zero / absent dropped is ignored (no fabricated count)', () => {
    expect(readDropped(undefined)).toBeNull()
    expect(readDropped({ dropped: 0 })).toBeNull()
    expect(readDropped({ dropped: '2' })).toBeNull()
    expect(readDropped({ dropped: 1.5 })).toBeNull()
  })

  test('persome delta-report --json-out shape → dropped notice', () => {
    // Shape from personal-model cli.py delta_report + store/memory_deltas.stats(); numbers from MOD-07 run.json.
    const report = {
      aggregate: { rows: 4, sessions: 4, heads: { entities: 0, assertions: 0 }, dropped_by_gates: 8 },
      recent: [
        { id: 4, session_id: 'mod07-fake-b', created_at: '2026-11-04T10:00:00Z', dropped: 2, status: 'applied' },
        { id: 3, session_id: 'mod07-fake-a', created_at: '2026-11-04T09:59:00Z', dropped: 2, status: 'applied' }
      ]
    }
    const summary = parseDeltaReport(report)
    expect(summary).toMatchObject({ droppedByGates: 8, rows: 4, sessions: 4 })
    expect(summary!.recent[0]).toEqual({ sessionId: 'mod07-fake-b', createdAt: '2026-11-04T10:00:00Z', dropped: 2, status: 'applied' })
    expect(droppedFromDeltaReport(summary)).toEqual({ count: 8, text: 'Runtime 全局：最近的 memory_delta 中门控共丢弃 8 条（不是这条证据专属；Runtime 未提供逐条原因）' })
    expect(parseDeltaReport({})).toBeNull()
    expect(parseDeltaReport({ aggregate: { dropped_by_gates: -1 } })).toBeNull()
    expect(droppedFromDeltaReport(parseDeltaReport({ aggregate: { dropped_by_gates: 0 }, recent: [] }))).toBeNull()
  })

  test('reproduce commands are copyable and never contain a token', () => {
    const ref = "⟨f67c:model_candidate_evidence⟩"
    const cmds = reproduceCommands({ reference: ref, root: '/tmp/rt root', port: 8761, asOf: '2026-03-01' })
    expect(cmds.evidence).toContain("--data-urlencode 'ref=⟨f67c:model_candidate_evidence⟩'")
    expect(cmds.evidence).toContain("--data-urlencode 'as_of=2026-03-01'")
    expect(cmds.evidence).toContain("'/tmp/rt root'/env")
    expect(cmds.evidence).toContain('http://127.0.0.1:8761/model/evidence')
    expect(cmds.evidence).toContain('$PERSOME_LOCAL_API_TOKEN')
    expect(cmds.deltaReport).toBe("PERSOME_ROOT='/tmp/rt root' persome delta-report --limit 20")
    const def = reproduceCommands({ reference: "a'b" })
    expect(def.evidence).toContain("~/'.persome'/env")
    expect(def.evidence).toContain(`'ref=a'\\''b'`)
    expect(def.evidence).toContain(':8742/')
    expect(def.evidence).not.toContain('as_of')
  })
})

describe('S1-01 normal sources unchanged', () => {
  test('resolved sources/context/history pass through untouched', () => {
    const view = buildEvidenceView(NORMAL)
    expect(view.rootUnresolved).toBeNull()
    expect(view.unresolvedSources).toEqual([])
    expect(view.sources).toEqual(NORMAL.sources)
    expect(view.context).toEqual(NORMAL.context)
    expect(view.history).toEqual(NORMAL.history)
    expect(view.sourceCount).toBe(2)
    expect(view.pointWithoutSources).toBe(false)
    expect(view.dropped).toBeNull()
  })

  test('receiptPath parses ⟨id:path⟩ on the last colon like Runtime', () => {
    expect(receiptPath('⟨a:b:model_candidate_evidence⟩')).toBe('model_candidate_evidence')
    expect(receiptPath('pt-001')).toBeNull()
    expect(receiptPath('⟨nopath⟩')).toBeNull()
  })
})

describe('S1-01 reproduce command keeps the token out of argv', () => {
  test('pipes the Authorization header via the printf builtin into curl -H @-', async () => {
    const { reproduceCommands } = await import('../../src/renderer/src/components/evidence/model')
    const { evidence } = reproduceCommands({ reference: 'pt:x', root: '/tmp/r', port: 8742 })
    expect(evidence).toContain(`printf 'Authorization: Bearer %s\\n' "$PERSOME_LOCAL_API_TOKEN" | curl -sG -H @-`)
    expect(evidence).not.toMatch(/-H "Authorization/)
  })
})

describe('OG-03 Point never renders silently source-less (MOD-07)', () => {
  test('real promoted Point with sources=[] → explicit 证据未解析 with ref, reason and labelled fallback', () => {
    const view = buildEvidenceView(MOD07_POINT)
    expect(view.pointWithoutSources).toBe(true)
    expect(view.sourceCount).toBe(0)
    const p = view.pointUnresolved!
    expect(p).not.toBeNull()
    expect(p.marker).toBe('证据未解析')
    expect(p.reference).toBe('⟨20261105-1039-5b1c2a:person-zhang-wei.md⟩')
    expect(p.status).toBe('no_sources')
    // Runtime gave no reason code; Lens says exactly that and does not invent one.
    expect(p.reasonCode).toBeNull()
    expect(p.reasonText).toBe(pointNoSourcesReason())
    expect(p.knownIssue).toBe(mod07PointKnownIssue())
    expect(p.fallback).toEqual(NO_FALLBACK)
    expect(p.fallback!.source).toBe('lens_fallback')
    expect(p.fallback!.outcome).toBe('none')
  })

  test('Point whose sources are all unresolved → points at the per-item reasons, no MOD-07 lineage note', () => {
    const view = buildEvidenceView({
      ...MOD07_POINT,
      sources: [{ reference: '⟨abc:model_candidate_evidence⟩', status: 'missing', reason: 'source_not_found_or_retained' }]
    })
    expect(view.pointUnresolved!.status).toBe('sources_unresolved')
    expect(view.pointUnresolved!.reasonText).toContain('1 条来源都无法解析')
    expect(view.pointUnresolved!.knownIssue).toBeNull()
    expect(view.unresolvedSources[0].fallback).toEqual(NO_FALLBACK)
  })

  test('candidate receipts carry the labelled no-fallback; other unresolved kinds carry none', () => {
    expect(buildEvidenceView(MOD07).rootUnresolved!.fallback).toEqual(NO_FALLBACK)
    const other = buildEvidenceView({ ...MOD07, path: 'capture', reference: '⟨x:capture⟩', canonical_reference: '⟨x:capture⟩' })
    expect(other.rootUnresolved!.fallback).toBeNull()
  })

  test('a Point with resolved sources has no unresolved entry', () => {
    expect(buildEvidenceView(NORMAL).pointUnresolved).toBeNull()
  })
})

describe('evidence view-model (English)', () => {
  test('marker, reasons and drop notices are English by default', () => {
    setLocale('en')
    const root = buildEvidenceView(MOD07).rootUnresolved!
    expect(root.marker).toBe('Evidence unresolved')
    expect(root.reasonText).toBe(RUNTIME_MISSING_REASONS.source_not_found_or_retained)
    expect(root.reasonText).toMatch(/^Runtime could not find/)
    expect(droppedText(2)).toBe('2 dropped (Runtime gave no per-item reason)')
  })
})
