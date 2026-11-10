// S2-07: does the Runtime skill parser read Steps / Artifacts / Rules / Problems sections?
// Fixtures cover the three shapes an LLM writer plausibly produces: bold keys with bullet lists,
// `### Heading` sections, and plain `Key:` lines (incl. Chinese aliases).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseFields, parseSkillFile, workflowFromSkillFile } from '../../src/main/workflows/parse'
import { WorkflowSchema } from '../../src/main/workflows/schema'

const DIR = path.join(__dirname, 'fixtures', 'skill-sections')
const load = (name: string) => {
  const w = workflowFromSkillFile(parseSkillFile(`skills/${name}`, fs.readFileSync(path.join(DIR, name), 'utf8')))!
  expect(w).not.toBeNull()
  expect(WorkflowSchema.parse(w)).toEqual(w)
  return w
}

describe('Runtime skill sections → Workflow fields', () => {
  test('bold keys with multi-line bullet values', () => {
    const w = load('skill-bold-multiline.md')
    expect(w.steps.map((s) => s.text)).toEqual(['Run the full test suite', 'Bump the version', 'Build the DMG'])
    expect(w.steps.map((s) => s.order)).toEqual([1, 2, 3])
    expect(w.artifacts).toEqual(['signed DMG', 'release notes'])
    expect(w.rules).toEqual(['never release on Friday', 'typecheck must be clean'])
    expect(w.problems).toEqual([
      { problem: 'notarization times out', solution: 'retry with the stapler' },
      { problem: 'DMG too large', solution: '' }
    ])
    expect(w.evidence.map((e) => e.ref)).toEqual(['rel-0002', '⟨ev-0201:event-2026-10-20.md⟩'])
    // not present in the file → stays empty
    expect([w.inputs, w.tools, w.context]).toEqual([[], [], ''])
  })

  test('### heading sections (unknown heading ends the previous section)', () => {
    const w = load('skill-heading-sections.md')
    expect(w.goal).toBe('Sends client invoices on the last working day of the month.')
    expect(w.steps.map((s) => s.text)).toEqual(['Export hours from the tracker', 'Fill the invoice template', 'Email the PDF'])
    expect(w.artifacts).toEqual(['invoice PDF'])
    expect(w.rules).toEqual(['one invoice per client'])
    expect(w.problems).toEqual([{ problem: 'template totals wrong', solution: 'recalc the sheet before export' }])
    expect(JSON.stringify(w)).not.toContain('free text that is not a Workflow field')
    expect(w.evidence_note).toBe('receipts `⟨ev-0301:event-2026-10-31.md⟩`')
  })

  test('plain `Key:` lines with Chinese aliases; an unknown plain key is not glued onto a field', () => {
    const w = load('skill-plain-keys.md')
    expect(w.goal).toBe('上班前清空收件箱')
    expect(w.steps.map((s) => s.text)).toEqual(['打开邮件', '归档通知', '回复紧急邮件'])
    expect(w.artifacts).toEqual(['清空的收件箱'])
    expect(w.rules).toEqual(['不在早上处理长邮件'])
    expect(w.problems).toEqual([{ problem: '通知太多', solution: '先用过滤规则归档' }])
    expect(JSON.stringify(w)).not.toContain('must not be parsed')
  })

  test('what the real Runtime emits today (pattern_detector.md "Entry format"): only Pattern/Context/Evidence/Confidence', () => {
    const body = 'stage: observed\n\n**Pattern**: On weekday mornings, the user reviews Mail and Slack before opening the active code project.\n**Context**: weekday start of work\n**Evidence**: 5 sessions across 4 days; receipts `...`\n**Confidence**: high'
    const { stage, fields } = parseFields(body)
    expect(stage).toBe('observed')
    expect(Object.keys(fields).sort()).toEqual(['confidence', 'context', 'evidence', 'goal'])
  })

  test('plain prose lines that are not aliases do not start fields', () => {
    expect(parseFields('stage: observed\n\nNote: hello\nhttps: //x').fields).toEqual({})
  })
})
