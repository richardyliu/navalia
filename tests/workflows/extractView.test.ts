import { describe, expect, test } from 'vitest'
import { extractPreview, extractSaveSummary, resolveAgent, workflowIdFromParams } from '../../src/renderer/src/components/workflows/extractView'

describe('extract panel view-model', () => {
  test('preview: empty / invalid / valid with filled + left-empty fields', () => {
    expect(extractPreview('').status).toBe('empty')
    const bad = extractPreview('{"goal": 1}')
    expect(bad).toMatchObject({ status: 'invalid', errors: ['goal: wrong type, expected text'] })
    const good = extractPreview('{"title":"T","goal":"g","steps":["a","b"]}')
    expect(good.status).toBe('valid')
    expect(good.title).toBe('T')
    expect(good.fields.find((f) => f.key === 'steps')!.count).toBe(2)
    expect(good.empty).toEqual(['Inputs', 'Tools', 'Artifacts', 'Rules', 'Problems → fixes', 'Evidence'])
    expect(good.formLabel).toBe('Extraction JSON')
  })

  test('agent label: preset or custom text for 其他', () => {
    expect(resolveAgent('Codex', 'ignored')).toBe('Codex')
    expect(resolveAgent('其他', '  Cursor ')).toBe('Cursor')
    expect(resolveAgent('其他', '')).toBe('')
  })

  test('save summary: new vs duplicate', () => {
    expect(extractSaveSummary({ item: { id: 'ext-1', title: 'T', outcome: 'imported', detail: null }, form: 'extraction' })).toBe('Saved as ext-1 "T"')
    expect(extractSaveSummary({ item: { id: 'rt-a', title: '', outcome: 'duplicate', detail: 'rt-a' }, form: 'workflow' })).toMatch(/existing Workflow "rt-a"/)
  })

  test('Playbook deep link: go("playbook", { workflowId }) → a valid id, else null', () => {
    expect(workflowIdFromParams({ workflowId: 'rt-weekly-report' })).toBe('rt-weekly-report')
    expect(workflowIdFromParams({ workflowId: '../etc' })).toBeNull()
    expect(workflowIdFromParams({})).toBeNull()
    expect(workflowIdFromParams(undefined)).toBeNull()
  })
})
