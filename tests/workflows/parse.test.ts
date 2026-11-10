import { describe, expect, test } from 'vitest'
import {
  isScrubStableId,
  observedIdFor,
  parseEntries,
  parseFields,
  parseFrontmatter,
  parseSkillFile,
  splitProblems,
  splitSequence,
  workflowFromPatternSkill,
  workflowFromSkillFile
} from '../../src/main/workflows/parse'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { WorkflowSchema } from '../../src/main/workflows/schema'
import { FIXTURE_RUNTIME, readFixture } from './helpers'

describe('Runtime skill file format', () => {
  test('frontmatter: block list, inline list, quoted scalars', () => {
    const a = parseFrontmatter(readFixture('memory/skills/skill-weekly-report.md'))
    expect(a.meta.tags).toEqual(['pattern', 'observed'])
    expect(a.meta.created).toBe('2026-10-02')
    expect(a.meta.status).toBe('active')
    const b = parseFrontmatter(readFixture('memory/skills/skill-inbox-triage.md'))
    expect(b.meta.tags).toEqual(['pattern', 'observed'])
    expect(parseFrontmatter('no frontmatter').meta).toEqual({})
  })

  test('entry headings: id, timestamp, tags, superseded-by', () => {
    const entries = parseEntries(parseFrontmatter(readFixture('memory/skills/skill-weekly-report.md')).body)
    expect(entries.map((e) => e.id)).toEqual(['wr-0001', 'wr-0002', 'wr-0003', 'wr-0004'])
    expect(entries[1].supersededBy).toBe('wr-0003')
    expect(entries[3].tags).toContain('confidence:high')
    expect(entries[3].timestamp).toBe('2026-10-16T15:12')
  })

  test('fields: aliases, unknown keys ignored, multi-line values', () => {
    const { stage, fields } = parseFields('stage: observed\n\n**Trigger**: daily\n**Frequency**: weekly\n**Steps**:\n- a\n- b')
    expect(stage).toBe('observed')
    expect(fields.context).toBe('daily')
    expect(fields.steps).toBe('- a\n- b')
    expect(Object.keys(fields).sort()).toEqual(['context', 'steps'])
  })

  test('sequence splitting: inline numbers, bullets, arrows, single', () => {
    expect(splitSequence('1. Mail. 2. Slack. 3. Project.')).toEqual(['Mail', 'Slack', 'Project'])
    expect(splitSequence('- one\n- two')).toEqual(['one', 'two'])
    expect(splitSequence('Mail → Slack -> Cursor')).toEqual(['Mail', 'Slack', 'Cursor'])
    expect(splitSequence('just one thing')).toEqual(['just one thing'])
    expect(splitSequence('upgrade to v2. then rest')).toEqual(['upgrade to v2. then rest'])
  })

  test('problem → solution pairs; a problem without solution keeps an empty solution', () => {
    expect(splitProblems('a breaks → do b; c is slow')).toEqual([
      { problem: 'a breaks', solution: 'do b' },
      { problem: 'c is slow', solution: '' }
    ])
  })

  test('observed ids are stable per memory path', () => {
    expect(observedIdFor('skills/skill-weekly-report.md')).toBe('rt-weekly-report')
    expect(observedIdFor('skill-Legacy Thing.md')).toBe('rt-legacy-thing')
    expect(observedIdFor('skills/skill-weekly-report.md')).toBe(observedIdFor('skills/skill-weekly-report.md'))
  })

  test('ids survive the Broker scrubber (else a hash id is used) so agents can call get_workflow with them', () => {
    // `sk` + 12 chars matches the scrubber's API-key rule.
    const id = observedIdFor('skills/skill-sketching-the-roadmap.md')
    expect(id).toMatch(/^rt-[0-9a-f]{12}$/)
    expect(isScrubStableId(id)).toBe(true)
    expect(isScrubStableId('skill-weekly-report')).toBe(false)
    expect(observedIdFor('skills/skill-other.md')).not.toBe(id)
  })
})

describe('skill file → Workflow', () => {
  test('ACCEPTANCE: the weekly-report fixture becomes a fully structured, schema-valid Workflow', () => {
    const w = workflowFromSkillFile(parseSkillFile('skills/skill-weekly-report.md', readFixture('memory/skills/skill-weekly-report.md')))!
    expect(WorkflowSchema.parse(w)).toEqual(w)
    expect(w.id).toBe('rt-weekly-report')
    expect(w.title).toBe('Friday afternoon weekly status report for the demo project')
    expect(w.goal).toMatch(/^Every Friday afternoon, compiles the weekly status report/)
    expect(w.context).toBe('Friday 15:00, after the team sync')
    expect(w.inputs).toEqual(['closed issues of the week', 'sync notes'])
    expect(w.tools).toEqual(['Tracker', 'Notes', 'Mail'])
    expect(w.steps).toEqual([
      { order: 1, text: 'Filter closed issues in Tracker' },
      { order: 2, text: 'Group them by milestone in Notes' },
      { order: 3, text: 'Draft the summary' },
      { order: 4, text: 'Mail it to the team list' }
    ])
    expect(w.artifacts).toEqual(['weekly-report draft', 'sent mail'])
    expect(w.rules).toEqual(['only closed issues', 'no customer names'])
    expect(w.problems).toEqual([{ problem: 'tracker filter misses reopened issues', solution: 're-run the filter with the reopened label' }])
    expect(w.provenance.kind).toBe('observed')
    expect(w.provenance.observed_at).toBe('2026-10-16T15:12')
    expect(w.source).toMatchObject({ type: 'runtime_skill_file', path: 'skills/skill-weekly-report.md', stage: 'observed', confidence: 'high' })
    expect(w.version).toBe(1)
  })

  test('evidence keeps every existing ref (entries + receipts), excludes superseded entries, invents none', () => {
    const w = workflowFromSkillFile(parseSkillFile('skills/skill-weekly-report.md', readFixture('memory/skills/skill-weekly-report.md')))!
    const refs = w.evidence.map((e) => e.ref)
    expect(refs).toEqual(['wr-0004', '⟨ev-0003:event-2026-10-16.md⟩', '⟨ev-0002:event-2026-10-09.md⟩', 'wr-0003', 'wr-0001', '⟨ev-0001:event-2026-10-02.md⟩'])
    expect(refs).not.toContain('wr-0002')
    expect(refs).not.toContain('⟨ev-0099:event-2026-10-09.md⟩')
    expect(w.source.entry_ids).toEqual(['wr-0004', 'wr-0003', 'wr-0001'])
    for (const e of w.evidence) expect(readFixture('memory/skills/skill-weekly-report.md')).toContain(e.ref)
  })

  test('unmappable fields stay empty (arrow sequence in Pattern is NOT turned into steps)', () => {
    const w = workflowFromSkillFile(parseSkillFile('skills/skill-inbox-triage.md', readFixture('memory/skills/skill-inbox-triage.md')))!
    expect(w.goal).toBe('Weekday mornings the user opens Mail → Chat → Editor.')
    expect([w.context, w.inputs, w.tools, w.steps, w.artifacts, w.rules, w.problems]).toEqual(['', [], [], [], [], [], []])
    expect(w.evidence_note).toBe('2 sessions across 2 days')
  })

  test('non-active files and files without an observed pattern entry are skipped', () => {
    expect(workflowFromSkillFile(parseSkillFile('skills/skill-archived-thing.md', readFixture('memory/skills/skill-archived-thing.md')))).toBeNull()
    expect(workflowFromSkillFile(parseSkillFile('skills/skill-not-a-pattern.md', readFixture('memory/skills/skill-not-a-pattern.md')))).toBeNull()
  })

  test('readRuntimeSkills scans memory/skills and legacy memory/skill-*.md, ignores other files', () => {
    const r = readRuntimeSkills(FIXTURE_RUNTIME)
    expect(r.status).toBe('ok')
    expect(r.workflows.map((w) => w.id).sort()).toEqual(['rt-inbox-triage', 'rt-legacy-standup', 'rt-weekly-report'])
    const legacy = r.workflows.find((w) => w.id === 'rt-legacy-standup')!
    expect(legacy.steps.map((s) => s.text)).toEqual(['Open the board', "Read yesterday's notes", 'Post the update'])
    expect(legacy.context).toBe('daily standup')
    expect(readRuntimeSkills('/nonexistent-runtime-root-for-test').status).toBe('missing')
  })

  test('behavior_patterns playbook → observed Workflow with its entry id + receipts', () => {
    const w = workflowFromPatternSkill({
      path: 'skills/skill-x.md',
      description: 'X',
      entry_id: 'x-1',
      observed_at: '2026-10-30T11:00',
      playbook: 'stage: observed\n\n**Pattern**: p\n**Steps**: a → b\n**Evidence**: receipts `⟨r-1:e.md⟩`'
    })
    expect(WorkflowSchema.parse(w)).toEqual(w)
    expect(w.source.type).toBe('runtime_behavior_patterns')
    expect(w.steps.map((s) => s.text)).toEqual(['a', 'b'])
    expect(w.evidence.map((e) => e.ref)).toEqual(['x-1', '⟨r-1:e.md⟩'])
  })
})
