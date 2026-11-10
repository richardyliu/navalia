import { describe, expect, test } from 'vitest'
import { isoWeekKey, skillsHeadline } from '../../src/renderer/src/components/workflows/headline'
import { formatFingerprint, provenanceBadge } from '../../src/renderer/src/components/workflows/viewModel'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { provenance } from '../../src/main/workflows/schema'
import { FIXTURE_RUNTIME } from '../workflows/helpers'

const ev = (...ts: Array<string | null>) => ({ evidence: ts.map((t) => ({ ref: 'x', kind: 'entry' as const, timestamp: t, origin: 'local' as const })) })

describe('skills headline: N skill files. M weeks of judgment.', () => {
  test('N = workflow count, M = distinct ISO weeks of real evidence dates', () => {
    const h = skillsHeadline([ev('2026-10-05T09:00', '2026-10-06'), ev('2026-10-12T10:00'), ev(null)])
    expect(h).toEqual({ n: 3, m: 2, text: '3 skill files. 2 weeks of judgment.' })
  })

  test('no real dates → M is unknown and shown as —', () => {
    expect(skillsHeadline([ev(null, 'yesterday', '2026-02-30', '')])).toEqual({ n: 1, m: null, text: '1 skill files. — weeks of judgment.' })
    expect(skillsHeadline([])).toEqual({ n: 0, m: null, text: '0 skill files. — weeks of judgment.' })
  })

  test('ISO weeks across a year boundary', () => {
    expect(isoWeekKey('2026-12-31')).toBe('2026-W53')
    expect(isoWeekKey('2027-01-01T08:00')).toBe('2026-W53')
    expect(isoWeekKey('2027-01-04')).toBe('2027-W01')
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01')
    expect(isoWeekKey('2026-13-01')).toBeNull()
  })

  test('fixture: weekly report entries on 10-02, 10-09, 10-16 are three weeks', () => {
    const weekly = readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((w) => w.id === 'rt-weekly-report')!
    expect(skillsHeadline([weekly]).m).toBe(3)
  })
})

describe('provenance badges', () => {
  test('来自观察 / 导入 / 别人分享; an edit keeps its origin', () => {
    expect(provenanceBadge({ provenance: provenance('observed') }).label).toBe('Observed')
    expect(provenanceBadge({ provenance: provenance('imported') }).label).toBe('Imported')
    expect(provenanceBadge({ provenance: provenance('shared') }).label).toBe('Shared by others')
    expect(provenanceBadge({ provenance: provenance('user_edited', { original_kind: 'imported' }) })).toEqual({ label: 'Imported', edited: true })
    expect(provenanceBadge({ provenance: provenance('user_edited') })).toEqual({ label: 'Observed', edited: true })
  })

  test('fingerprints are shown in full, grouped by 4', () => {
    const fp = 'ab'.repeat(32)
    const shown = formatFingerprint(fp)
    expect(shown.replace(/ /g, '')).toBe(fp)
    expect(shown.split(' ')).toHaveLength(16)
  })
})
