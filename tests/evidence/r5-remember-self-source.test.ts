import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { EvidenceResponse } from '../../src/shared/types'
import {
  pointNoSourcesReason,
  REMEMBER_PROVENANCE_TAG,
  REMEMBER_SELF_SOURCE,
  unresolvedMarker,
  buildEvidenceView
} from '../../src/renderer/src/components/evidence/model'

// These assertions pin the original Chinese wording; the English path has its own test at the end.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

// S1-R5-03: real `GET /model/evidence` responses captured 2026-11-06 from the user's Runtime
// (schema 2026-11-05.3); label/summary/context text redacted, structure untouched.
// See docs/test-evidence/PHASE4/evidence-chain/.
const load = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as EvidenceResponse
const REMEMBER = load('r5-remember-memory-no-sources.json')
const PERSON_EVENT = load('r5-person-event-point-no-sources.json')

describe('S1-R5-03 remember memory → 来源=本条记忆', () => {
  test('real remember response (kind=memory, tag source:agent-run, sources=[]) gets a self-source, not "无"', () => {
    expect(REMEMBER.kind).toBe('memory')
    expect(REMEMBER.sources).toEqual([])
    expect((REMEMBER.metadata as { tags: string[] }).tags).toContain(REMEMBER_PROVENANCE_TAG)
    const view = buildEvidenceView(REMEMBER)
    expect(view.selfSource).toEqual(REMEMBER_SELF_SOURCE)
    expect(view.selfSource!.label).toBe('来源=本条记忆')
    // Honest accounting: the memory is not counted as a direct source and nothing is marked unresolved.
    expect(view.sourceCount).toBe(0)
    expect(view.sources).toEqual([])
    expect(view.pointWithoutSources).toBe(false)
    expect(view.pointUnresolved).toBeNull()
    // Nearby captures stay context, never promoted to sources.
    expect(view.context.length).toBe(3)
    expect(view.context.every((c) => c.relation === 'nearby_context')).toBe(true)
  })

  test('the same shape returned as kind=point still takes the self-source path', () => {
    const view = buildEvidenceView({ ...REMEMBER, kind: 'point' })
    expect(view.selfSource).not.toBeNull()
    expect(view.pointWithoutSources).toBe(false)
  })

  test('without the source:agent-run tag there is no self-source (no guessing from path)', () => {
    const view = buildEvidenceView({ ...REMEMBER, metadata: { ...REMEMBER.metadata, tags: ['project'] } })
    expect(view.selfSource).toBeNull()
  })

  test('a remember memory whose sources exist or are unresolved does not get the self-source label', () => {
    const withUnresolved = buildEvidenceView({
      ...REMEMBER,
      sources: [{ relation: 'candidate_evidence', kind: 'receipt', id: 'x', reference: '⟨x:model_candidate_evidence⟩', label: 'x', status: 'missing', resolvable: false }]
    } as EvidenceResponse)
    expect(withUnresolved.selfSource).toBeNull()
    expect(withUnresolved.unresolvedSources).toHaveLength(1)
  })

  test('real person-event Point with sources=[] (no remember tag) still shows 证据未解析', () => {
    const view = buildEvidenceView(PERSON_EVENT)
    expect(view.selfSource).toBeNull()
    expect(view.pointWithoutSources).toBe(true)
    expect(view.pointUnresolved!.marker).toBe(unresolvedMarker())
    expect(view.pointUnresolved!.reasonText).toBe(pointNoSourcesReason())
  })
})

describe('S1-R5-03 English labels', () => {
  test('self-source and unresolved marker are English by default', () => {
    setLocale('en')
    expect(buildEvidenceView(REMEMBER).selfSource!.label).toBe('Source = this memory')
    expect(buildEvidenceView(PERSON_EVENT).pointUnresolved!.marker).toBe('Evidence unresolved')
  })
})
