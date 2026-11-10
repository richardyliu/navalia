// S2-07: paste-back validation of an external-agent extraction (Lens never calls an LLM).
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import {
  EXTRACTION_EXAMPLE,
  EXTRACTION_FORMAT,
  ExtractedWorkflowSchema,
  buildExtractionPrompt,
  extractionJsonSchema,
  parseExtraction
} from '../../src/main/workflows/extract'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import { WORKFLOW_EXPORT_FORMAT, WorkflowSchema } from '../../src/main/workflows/schema'
import { FIXTURE_RUNTIME } from './helpers'

// Most assertions below check the Chinese UI strings; English is covered by the `English locale` block.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const ok = (text: string) => {
  const r = parseExtraction(text)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r
}
const errs = (text: string) => {
  const r = parseExtraction(text)
  expect(r.ok).toBe(false)
  return r.ok ? [] : r.errors
}

describe('prompt + schema cannot drift from the validator', () => {
  test('the example parses with the extraction schema and with parseExtraction', () => {
    expect(ExtractedWorkflowSchema.safeParse(EXTRACTION_EXAMPLE).success).toBe(true)
    const r = ok(JSON.stringify(EXTRACTION_EXAMPLE))
    expect(r.form).toBe('extraction')
    expect(r.draft.steps.map((s) => s.order)).toEqual([1, 2, 3, 4])
  })

  test('JSON Schema text is derived from the zod schema: same property set, no required fields, no extras', () => {
    const schema = JSON.parse(extractionJsonSchema())
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(ExtractedWorkflowSchema.shape).sort())
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required ?? []).toEqual([])
    expect(schema.properties.evidence.items.properties.kind.enum).toEqual(['receipt', 'entry', 'file', 'quote', 'capture'])
  })

  test('the prompt embeds the schema + example, names the Persome MCP tools and the no-invention rule', () => {
    const p = buildExtractionPrompt('每周五写周报')
    expect(p).toContain('要抽取的工作：每周五写周报')
    expect(p).toContain(extractionJsonSchema())
    expect(p).toContain(JSON.stringify(EXTRACTION_EXAMPLE, null, 2))
    for (const t of ['search', 'read_memory', 'read_receipt']) expect(p).toContain(t)
    expect(p).toMatch(/只输出一个 JSON 对象/)
    expect(p).toMatch(/不知道的字段留空/)
    expect(p).toMatch(/不要推测/)
    expect(buildExtractionPrompt()).not.toContain('要抽取的工作')
  })
})

describe('parseExtraction: accepted forms', () => {
  test('missing fields stay empty; nothing is invented', () => {
    const r = ok('{"goal": "整理周报"}')
    expect(r.draft).toEqual({
      title: '',
      goal: '整理周报',
      context: '',
      inputs: [],
      tools: [],
      steps: [],
      artifacts: [],
      rules: [],
      problems: [],
      tags: [],
      evidence: [],
      evidence_note: ''
    })
  })

  test('steps: strings or {order,text}, renumbered in order; blank list items dropped; solution defaults to ""', () => {
    const r = ok(JSON.stringify({ steps: [{ order: 3, text: 'c' }, 'a ', { order: 2, text: 'b' }], tools: ['x', ' '], problems: [{ problem: 'p' }] }))
    expect(r.draft.steps).toEqual([
      { order: 1, text: 'a' },
      { order: 2, text: 'b' },
      { order: 3, text: 'c' }
    ])
    expect(r.draft.tools).toEqual(['x'])
    expect(r.draft.problems).toEqual([{ problem: 'p', solution: '' }])
  })

  test('evidence (receipt + quote) is kept verbatim', () => {
    const r = ok(JSON.stringify({ goal: 'g', evidence: [{ kind: 'receipt', ref: '⟨ev-1:event-2026-10-01.md⟩', timestamp: '2026-10-01' }, { kind: 'quote', ref: '“按里程碑分组”' }] }))
    expect(r.draft.evidence).toEqual([
      { kind: 'receipt', ref: '⟨ev-1:event-2026-10-01.md⟩', timestamp: '2026-10-01' },
      { kind: 'quote', ref: '“按里程碑分组”', timestamp: null }
    ])
  })

  test('wrapped forms, ```json fences, a full Workflow and a one-Workflow export envelope', () => {
    expect(ok(JSON.stringify({ format: EXTRACTION_FORMAT, workflow: { goal: 'g' } })).form).toBe('wrapped')
    expect(ok(JSON.stringify({ workflow: { goal: 'g' } })).form).toBe('wrapped')
    expect(ok('```json\n{"goal": "g"}\n```').draft.goal).toBe('g')
    const w = readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((x) => x.id === 'rt-weekly-report')!
    const full = ok(JSON.stringify(w))
    expect(full.form).toBe('workflow')
    expect(full.draft.steps).toEqual(w.steps)
    expect(full.draft.evidence.map((e) => e.ref)).toEqual(w.evidence.map((e) => e.ref))
    expect(full.draft).not.toHaveProperty('id')
    expect(full.draft).not.toHaveProperty('provenance')
    const env = { format: WORKFLOW_EXPORT_FORMAT, format_version: 1, exported_at: 'x', workflows: [WorkflowSchema.parse(w)] }
    expect(ok(JSON.stringify(env)).form).toBe('export')
    expect(errs(JSON.stringify({ ...env, workflows: [w, w] }))[0]).toMatch(/一次只能保存一个/)
  })
})

describe('parseExtraction: Chinese errors with paths', () => {
  test('syntax error reports line and column', () => {
    expect(errs('{"goal": "a",\n "b"}')[0]).toMatch(/^JSON 语法错误（第 2 行第 \d+ 列）/)
    expect(errs('Here is the JSON: {"goal": "a"}')[0]).toMatch(/JSON 语法错误/)
  })

  test('schema errors carry the JSON path', () => {
    const e = errs(JSON.stringify({ goal: 1, extra: true, steps: [3], problems: [{}], evidence: [{ kind: 'guess', ref: 'x' }] }))
    expect(e).toContain('goal：类型不对，应为文本')
    expect(e).toContain('（根）：不认识的字段 extra')
    expect(e.some((m) => m.startsWith('steps[0]：'))).toBe(true)
    expect(e).toContain('problems[0].problem：缺少必填字段')
    expect(e.some((m) => m.startsWith('evidence[0].kind：取值必须是'))).toBe(true)
    expect(errs(JSON.stringify({ workflow: { goal: 2 } }))).toEqual(['workflow.goal：类型不对，应为文本'])
    expect(errs(JSON.stringify({ steps: ['x'.repeat(4001)] }))[0]).toMatch(/^steps\[0\]/)
  })

  test('empty, array, non-object and all-empty inputs are rejected', () => {
    expect(errs('  ')).toEqual(['还没有粘贴 JSON'])
    expect(errs('[{"goal":"a"}]')[0]).toMatch(/不是数组/)
    expect(errs('"text"')[0]).toMatch(/应为一个 JSON 对象/)
    expect(errs('{"goal": "  ", "steps": []}')[0]).toMatch(/所有字段都是空的/)
  })

  test('a full Workflow with a broken field is rejected with its path', () => {
    const w = readRuntimeSkills(FIXTURE_RUNTIME).workflows[0]
    expect(errs(JSON.stringify({ ...w, version: 0 }))[0]).toMatch(/^完整 Workflow 格式 · version/)
  })
})

// S2-SEC M2 (c): evidence timestamps must be real ISO 8601 dates / date-times.
describe('extraction evidence timestamp validation (S2-SEC M2)', () => {
  const withTs = (timestamp: unknown) => JSON.stringify({ goal: 'g', evidence: [{ kind: 'quote', ref: '原话', timestamp }] })

  test('accepts ISO dates and date-times (incl. the prompt example form without seconds)', () => {
    for (const ts of ['2026-10-16', '2026-10-16T15:12', '2026-10-16T15:12:05', '2026-10-16T15:12:05.123Z', '2026-10-16T15:12:05+08:00', '2026-10-16 15:12']) {
      expect(ok(withTs(ts)).draft.evidence[0].timestamp).toBe(ts)
    }
    expect(ok(withTs(null)).draft.evidence[0].timestamp).toBeNull()
  })

  test('rejects garbage with a Chinese error carrying the JSON path', () => {
    for (const ts of ['yesterday', '2026-02-30', '2026-13-01', '2026-10-16T25:00', '2026-10-16junk', '16/10/2026', '']) {
      const r = parseExtraction(withTs(ts))
      expect(r.ok, ts).toBe(false)
      if (!r.ok) expect(r.errors[0]).toBe('evidence[0].timestamp：时间格式不对：应为 ISO 8601 日期或时间（如 2026-10-16 或 2026-10-16T15:12），不知道就省略')
    }
  })

  test('a full Workflow pasted back is held to the same rule', () => {
    const w = structuredClone(readRuntimeSkills(FIXTURE_RUNTIME).workflows[0])
    w.evidence = [{ ref: 'x', kind: 'entry', timestamp: 'not a date', origin: 'local' }]
    expect(parseExtraction(JSON.stringify(w)).ok).toBe(false)
  })
})

describe('English locale', () => {
  beforeEach(() => setLocale('en'))
  test('validation errors are English by default; the prompt stays Chinese (model input)', () => {
    expect(errs('')).toEqual(['No JSON pasted yet'])
    expect(errs('[]')).toEqual(['(root): expected one JSON object (paste one Workflow at a time), not an array'])
    expect(errs('{"goal": 1}')).toEqual(['goal: wrong type, expected text'])
    expect(buildExtractionPrompt('')).toContain('你在帮我把一段真实发生过的重复工作整理成一个 Workflow')
  })
})
