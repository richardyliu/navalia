/**
 * S1-R3-03 (Runtime R8): Steps / Artifacts / Rules / Problems with evidence pointers.
 *
 * Fixtures under fixtures/runtime-r8 were produced by the Runtime branch og/r8-workflow-structure
 * itself: its fixture session (personal-model tests/fixtures/workflow_structure/triage_session.json)
 * ran through pattern_detector with a scripted LLM, and the resulting skill file and
 * behavior_patterns JSON were copied here verbatim.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { splitEvidence, workflowFromPatternSkill, type PatternSkill } from '../../src/main/workflows/parse'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { WorkflowEditSchema, WorkflowSchema } from '../../src/main/workflows/schema'
import { parsePatternSkills } from '../../src/main/workflows/service'
import { contentHash } from '../../src/main/workflows/store'
import { editFromDraft, draftFromWorkflow, playbookStructure, stepEvidenceLinks } from '../../src/renderer/src/components/workflows/viewModel'
import { FIXTURE_RUNTIME } from './helpers'

const R8 = path.join(__dirname, 'fixtures', 'runtime-r8')
const patternsText = fs.readFileSync(path.join(R8, 'behavior_patterns.json'), 'utf8')
const patterns = JSON.parse(patternsText) as { skills: PatternSkill[] }
const skill = patterns.skills[0]

const RECEIPT_D2 = '⟨20261105-1555-76a016:event-triage-d2.md⟩'
const RECEIPT_D1 = '⟨20261105-1555-b18767:event-triage-d1.md⟩'
const RECEIPT_D0 = '⟨20261105-1555-b2902e:event-triage-d0.md⟩'

const EXPECTED_STEPS = [
  { order: 1, text: 'Open the Linear triage view', evidence: ['cap-triage-d2', 'cap-triage-d1', 'cap-triage-d0'] },
  { order: 2, text: 'Merge duplicate issues before assigning owners', evidence: [RECEIPT_D1] },
  { order: 3, text: 'Update triage-notes.md with the queue size', evidence: [RECEIPT_D0, 'cap-notes-d0'] },
  { order: 4, text: 'Post the summary in #eng-triage', evidence: [RECEIPT_D2] }
]

describe('splitEvidence', () => {
  test('strips the clause and returns pointers (receipts and bare capture ids)', () => {
    expect(splitEvidence('Open the view — evidence: `cap-1`, `⟨a-1:event-x.md⟩`')).toEqual({ text: 'Open the view', evidence: ['⟨a-1:event-x.md⟩', 'cap-1'] })
    expect(splitEvidence('Post it (evidence: cap-2)')).toEqual({ text: 'Post it', evidence: ['cap-2'] })
    expect(splitEvidence('Mail')).toEqual({ text: 'Mail', evidence: [] })
  })
})

describe('behavior_patterns playbook (Runtime R8 shape) → Workflow', () => {
  test('fixture carries the new fields', () => {
    expect(parsePatternSkills(patternsText)).toHaveLength(1)
    expect(skill.steps).toHaveLength(4)
    expect(skill.structure_dropped).toBe(0)
  })

  test('structured steps/artifacts/rules/problems are mapped, each step with its evidence', () => {
    const w = WorkflowSchema.parse(workflowFromPatternSkill(skill))
    expect(w.id).toBe('rt-morning-bug-triage')
    expect(w.steps).toEqual(EXPECTED_STEPS)
    expect(w.artifacts).toEqual(['https://linear.app/acme/view/triage', 'triage-notes.md', '#eng-triage summary post'])
    expect(w.rules).toEqual(['P0 issues are assigned the same morning'])
    expect(w.problems).toEqual([{ problem: 'Duplicate issues clutter the queue', solution: 'merge them before assigning owners' }])
    // No evidence clause leaks into the visible text.
    for (const t of [...w.steps.map((s) => s.text), ...w.artifacts, ...w.rules, ...w.problems.flatMap((p) => [p.problem, p.solution])]) {
      expect(t).not.toMatch(/evidence/i)
    }
    // Every item pointer is also in the Workflow evidence list, typed.
    const refs = new Map(w.evidence.map((e) => [e.ref, e.kind]))
    for (const r of ['cap-triage-d2', 'cap-triage-d1', 'cap-triage-d0', 'cap-notes-d0', 'cap-notes-d1']) expect(refs.get(r)).toBe('capture')
    for (const r of [RECEIPT_D0, RECEIPT_D1, RECEIPT_D2]) expect(refs.get(r)).toBe('receipt')
    expect(refs.get(skill.entry_id!)).toBe('entry')
  })

  test('structured arrays win over the playbook text per field; malformed items are ignored, not invented', () => {
    const w = workflowFromPatternSkill({
      ...skill,
      steps: [{ order: 1, text: 'Real step', evidence: ['cap-x'] }, { order: 2, text: 'No pointer', evidence: [] }, { nonsense: true } as never],
      artifacts: [{ kind: 'url', value: 'https://a.example', evidence: ['cap-x'] }, 'bare string' as never],
      rules: [],
      problems: []
    })
    expect(w.steps).toEqual([{ order: 1, text: 'Real step', evidence: ['cap-x'] }])
    expect(w.artifacts).toEqual(['https://a.example'])
    // An empty structured array falls back to the (R8) playbook text, which carries the same items.
    expect(w.rules).toEqual(['P0 issues are assigned the same morning'])
    expect(w.problems).toEqual([{ problem: 'Duplicate issues clutter the queue', solution: 'merge them before assigning owners' }])
  })

  test('pre-R8 playbook (no new fields) still maps exactly as before', () => {
    const old: PatternSkill = { path: 'skills/skill-old.md', playbook: 'stage: observed\n\n**Pattern**: p\n**Steps**: 1. Mail. 2. Slack.' }
    const w = workflowFromPatternSkill(old)
    expect(w.steps).toEqual([
      { order: 1, text: 'Mail' },
      { order: 2, text: 'Slack' }
    ])
    expect(WorkflowSchema.safeParse(w).success).toBe(true)
  })
})

describe('Runtime skill file (R8 Markdown) → Workflow', () => {
  test('the Runtime-written file maps to the same structure as behavior_patterns', () => {
    const w = readRuntimeSkills(R8).workflows.find((x) => x.id === 'rt-morning-bug-triage')!
    expect(WorkflowSchema.safeParse(w).success).toBe(true)
    expect(w.steps).toEqual(EXPECTED_STEPS)
    expect(w.artifacts).toEqual(['https://linear.app/acme/view/triage', 'triage-notes.md', '#eng-triage summary post'])
    expect(w.rules).toEqual(['P0 issues are assigned the same morning'])
    expect(w.problems).toEqual([{ problem: 'Duplicate issues clutter the queue', solution: 'merge them before assigning owners' }])
    expect(w.evidence.find((e) => e.ref === 'cap-notes-d1')?.kind).toBe('capture')
  })

  test('in an R8 section, an item without a pointer is dropped (matching the Runtime)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-r8-'))
    try {
      fs.mkdirSync(path.join(dir, 'memory', 'skills'), { recursive: true })
      const src = fs.readFileSync(path.join(R8, 'memory', 'skills', 'skill-morning-bug-triage.md'), 'utf8')
      fs.writeFileSync(
        path.join(dir, 'memory', 'skills', 'skill-morning-bug-triage.md'),
        src.replace('4. Post the summary', '4. Hand-added step with no pointer\n5. Post the summary')
      )
      const w = readRuntimeSkills(dir).workflows[0]
      expect(w.steps.map((s) => s.text)).toEqual(EXPECTED_STEPS.map((s) => s.text))
      expect(w.steps.map((s) => s.order)).toEqual([1, 2, 3, 4])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('legacy skill files (no pointers anywhere) keep their steps unchanged', () => {
    const weekly = readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((x) => x.id === 'rt-weekly-report')!
    expect(weekly.steps.length).toBe(4)
    expect(weekly.steps.every((s) => s.evidence === undefined)).toBe(true)
  })
})

describe('view-model', () => {
  test('stepEvidenceLinks: one link per pointer, labelled by kind', () => {
    const w = workflowFromPatternSkill(skill)
    expect(stepEvidenceLinks(w.steps[0])).toEqual([
      { ref: 'cap-triage-d2', label: 'Screenshot cap-triage-d2' },
      { ref: 'cap-triage-d1', label: 'Screenshot cap-triage-d1' },
      { ref: 'cap-triage-d0', label: 'Screenshot cap-triage-d0' }
    ])
    expect(stepEvidenceLinks(w.steps[3])).toEqual([{ ref: RECEIPT_D2, label: 'Memory event-triage-d2.md' }])
    expect(stepEvidenceLinks({ order: 1, text: 'legacy' })).toEqual([])
  })

  test('playbookStructure: Playbook page view of a behavior_patterns skill', () => {
    const v = playbookStructure(skill)
    expect(v.steps.map((s) => s.text)).toEqual(EXPECTED_STEPS.map((s) => s.text))
    expect(v.steps[2].links.map((l) => l.ref)).toEqual([RECEIPT_D0, 'cap-notes-d0'])
    expect(v.artifacts).toEqual([
      { kind: 'url', value: 'https://linear.app/acme/view/triage', links: [{ ref: 'cap-triage-d0', label: 'Screenshot cap-triage-d0' }] },
      { kind: 'path', value: 'triage-notes.md', links: [{ ref: 'cap-notes-d1', label: 'Screenshot cap-notes-d1' }] },
      { kind: 'name', value: '#eng-triage summary post', links: [{ ref: RECEIPT_D2, label: 'Memory event-triage-d2.md' }] }
    ])
    expect(v.rules).toHaveLength(1)
    expect(v.problems[0]).toMatchObject({ problem: 'Duplicate issues clutter the queue', solution: 'merge them before assigning owners' })
    expect(v.empty).toBe(false)
    expect(playbookStructure({ path: 'skills/skill-old.md', description: '', playbook: 'x' }).empty).toBe(true)
  })

  test('a manual edit keeps text and drops per-step pointers (edits are not observations); content hash ignores pointers', () => {
    const w = workflowFromPatternSkill(skill)
    const edit = WorkflowEditSchema.parse(editFromDraft(draftFromWorkflow(w)))
    expect(edit.steps.map((s) => s.text)).toEqual(EXPECTED_STEPS.map((s) => s.text))
    expect(contentHash({ ...w, steps: w.steps.map(({ order, text }) => ({ order, text })) })).toBe(contentHash(w))
  })
})
