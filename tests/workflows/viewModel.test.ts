import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { WorkflowCatalog } from '../../src/main/workflows/api'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { WorkflowEditSchema, type Workflow } from '../../src/main/workflows/schema'
import {
  draftDirty,
  draftFromWorkflow,
  editFromDraft,
  filledFields,
  habitOfFace,
  habitOfPatternSkill,
  importSummary,
  provenanceLine,
  sourceWarnings,
  workflowListItems
} from '../../src/renderer/src/components/workflows/viewModel'
import { FIXTURE_RUNTIME } from './helpers'

// Most assertions below check the Chinese UI strings; English is covered by the `English locale` block.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const observed = readRuntimeSkills(FIXTURE_RUNTIME).workflows
const catalog: WorkflowCatalog = { workflows: observed, sources: { runtimeFiles: 'ok', behaviorPatterns: 'ok', store: 0 } }
const weekly = observed.find((w) => w.id === 'rt-weekly-report')!

describe('Playbook view-model', () => {
  test('list items: provenance label, step count, filled fields, habit label from evidence dates', () => {
    const items = workflowListItems(catalog)
    const w = items.find((i) => i.id === 'rt-weekly-report')!
    expect(w).toMatchObject({ provenanceLabel: '观察到', sourceLabel: 'Runtime 技能文件', steps: 4, filled: 7 })
    // Entries on 2026-10-02, -09, -16 (superseded entry excluded) → 3 distinct dates.
    expect(w.habit).toMatchObject({ status: 'stable', distinctDates: 3 })
    const inbox = items.find((i) => i.id === 'rt-inbox-triage')!
    expect(inbox.filled).toBe(1)
    expect(inbox.habit?.label).toBe('观察中（未满 3 个不同日期）· 2 个日期')
    expect(inbox.habit?.basis).toBe('declared_text')
    expect(workflowListItems(catalog, 'standup').map((i) => i.id)).toEqual(['rt-legacy-standup'])
    expect(workflowListItems(undefined)).toEqual([])
  })

  test('imported workflows get no habit label (their evidence is not local proof)', () => {
    const imp: Workflow = { ...weekly, id: 'imp-1', provenance: { ...weekly.provenance, kind: 'imported' } }
    expect(workflowListItems({ ...catalog, workflows: [imp] })[0].habit).toBeNull()
  })

  test('draft round trip is lossless and produces a schema-valid edit', () => {
    const d = draftFromWorkflow(weekly)
    const edit = editFromDraft(d)
    expect(WorkflowEditSchema.parse(edit)).toEqual(edit)
    expect(edit.steps).toEqual(weekly.steps)
    expect(edit.problems).toEqual(weekly.problems)
    expect(draftDirty(d, weekly)).toBe(false)
    const changed = { ...d, steps: `${d.steps}\n\n  Archive it  \n`, problems: `${d.problems}\nno solution yet` }
    const e2 = editFromDraft(changed)
    expect(e2.steps.at(-1)).toEqual({ order: 5, text: 'Archive it' })
    expect(e2.problems.at(-1)).toEqual({ problem: 'no solution yet', solution: '' })
    expect(draftDirty(changed, weekly)).toBe(true)
  })

  test('filledFields counts only the 7 structured fields', () => {
    expect(filledFields({ ...weekly, goal: ' ', inputs: [], tools: [], steps: [], artifacts: [], rules: [], problems: [] })).toBe(0)
  })

  test('provenance line, import summary, source warnings', () => {
    expect(provenanceLine(weekly)).toBe('观察到 · v1')
    expect(provenanceLine({ ...weekly, version: 3, provenance: { ...weekly.provenance, kind: 'user_edited', based_on_version: 2, original_kind: 'imported', from: 'a.json' } })).toBe(
      '手动编辑 · v3 · 基于 v2 · 最初：导入 · 来自 a.json'
    )
    expect(importSummary(null)).toBe('已取消')
    expect(importSummary({ file: 'a.json', imported: 1, duplicates: 2, items: [{ id: 'x~1', title: '', outcome: 'imported', detail: 'x' }] })).toBe('a.json：导入 1 个，跳过重复 2 个，1 个与现有 id 冲突，已改名')
    expect(sourceWarnings({ runtimeFiles: 'missing', behaviorPatterns: 'skipped', store: 0 })).toEqual([])
    expect(sourceWarnings({ runtimeFiles: 'EACCES', behaviorPatterns: 'timeout', store: 0 })).toHaveLength(2)
  })

  test('S1-05 behavior_patterns display: skills use the skill file dates; faces are 日期未知', () => {
    const skill = { path: 'skills/skill-weekly-report.md', description: '', playbook: 'x', observed_at: '2026-10-16T15:12' }
    expect(habitOfPatternSkill(skill, catalog)).toMatchObject({ status: 'stable', distinctDates: 3 })
    // Without the file, one observed_at is only a lower bound → observing + partial.
    const alone = habitOfPatternSkill(skill, undefined)
    expect(alone).toMatchObject({ status: 'observing', distinctDates: 1, partial: true })
    expect(habitOfPatternSkill({ path: 'p', description: '', playbook: 'no dates here' }, undefined).label).toBe('日期未知')
    // Pre-2026-11-05.3 Runtime: faces carry no dates → 日期未知.
    expect(habitOfFace()).toMatchObject({ status: 'unknown', label: '日期未知', partial: true })
    expect(habitOfFace({ signature: 's', observations: 4, confidence: 0.8 })).toMatchObject({ status: 'unknown', label: '日期未知' })
  })

  test('Runtime 2026-11-05.3 behavior_patterns faces carry observation_dates (HABIT-3-DATES gate upstream)', () => {
    const face = (dates: string[]) => ({ signature: 's', observations: 5, confidence: 0.8, observation_dates: dates })
    expect(habitOfFace(face(['2026-11-01', '2026-11-03', '2026-11-04']))).toMatchObject({ status: 'stable', distinctDates: 3, basis: 'evidence_timestamps', partial: false })
    expect(habitOfFace(face(['2026-11-01', '2026-11-01']))).toMatchObject({ status: 'observing', distinctDates: 1 })
    expect(habitOfFace(face([]))).toMatchObject({ status: 'unknown', label: '日期未知' })
    // Garbage in the list is ignored, never counted.
    expect(habitOfFace({ ...face(['2026-11-01', 'x', '2026-11-02']), observation_dates: ['2026-11-01', 'x', '2026-11-02', 7 as never] })).toMatchObject({ distinctDates: 2 })
  })
})

describe('English locale', () => {
  beforeEach(() => setLocale('en'))
  test('summaries and warnings are English by default', () => {
    expect(importSummary(null)).toBe('Cancelled')
    expect(importSummary({ file: 'a.json', imported: 2, duplicates: 1, items: [] } as never)).toBe('a.json: imported 2, skipped 1 duplicates')
    expect(sourceWarnings({ runtimeFiles: 'unreadable', behaviorPatterns: 'ok' } as never)).toEqual(['Failed to read Runtime skill files: unreadable'])
  })
})
