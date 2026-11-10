// MOD-13: literal model-readiness reason codes. Lens shows only codes present in the Runtime response; it
// never derives no_* from counts. Fixture = the real Runtime 0.3.2 `/model/graph` shape for an empty root
// (docs/test-evidence/MOD-13/2026-11-05-raw.json: degraded_stages=["model_contract"], no issues field).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { ModelGraphResponse } from '../../src/shared/types'
import { ModelIssues } from '../../src/renderer/src/components/ModelIssues'
import { ISSUE_EXPLANATIONS, modelIssuesView } from '../../src/renderer/src/lib/modelIssues'
import { setLocale } from '../../src/shared/i18n'
;(globalThis as { React?: typeof React }).React = React

const EMPTY_STATS = { points: 0, evolution_lines: 0, relation_lines: 0, faces: 0, volumes: 0, roots: 0, receipts: 0 }

function graph(extra: Partial<ModelGraphResponse> = {}, stages: string[] = ['model_contract']): ModelGraphResponse {
  return {
    generated_at: '2026-11-05T11:00:00-08:00',
    model: {
      schema_version: 1,
      generated_at: '2026-11-05T11:00:00-08:00',
      build: {
        build_id: '1dc68c82ce7ffe020d81', core_commit: 'unknown', models: {}, prompt_hashes: {}, config_hash: null,
        input_window: null, mode: 'mock', trigger: 'cli', started_at: null, completed_at: '2026-11-05T18:51:15Z',
        duration_ms: 78, degraded_stages: stages, status: stages.length ? 'degraded' : 'complete'
      },
      points: [], lines: [], faces: [], volumes: [], root: null, receipts: [], stats: { ...EMPTY_STATS }
    },
    ...extra
  }
}

const html = (g: ModelGraphResponse): string => renderToStaticMarkup(createElement(ModelIssues, { view: modelIssuesView(g) }))

describe('MOD-13 model issue codes', () => {
  test('Runtime 0.3.2 shape (no model_status): no no_* code is invented; CLI-only note + literal model_contract', () => {
    const v = modelIssuesView(graph())
    expect(v.codes).toEqual([])
    expect(v.runtimeProvidesCodes).toBe(false)
    expect(v.showCliOnlyNote).toBe(true)
    expect(v.stages.map((s) => s.code)).toEqual(['model_contract'])
    const out = html(graph())
    expect(out).not.toMatch(/no_(points|lines|faces|volumes|root)/)
    expect(out).toContain('model_contract')
    expect(out).toContain('persome model status')
  })

  test('codes present in the response are rendered literally, in Runtime order, each next to its explanation', () => {
    const issues = ['no_points', 'no_lines', 'no_faces', 'no_volumes', 'no_root']
    const g = graph({ model_status: { ready: false, issues } })
    const v = modelIssuesView(g)
    expect(v.codes.map((c) => c.code)).toEqual(issues)
    expect(v.showCliOnlyNote).toBe(false)
    const out = html(g)
    for (const code of issues) {
      expect(out).toContain(`<code class="mono">${code}</code> <span>${ISSUE_EXPLANATIONS[code]}</span>`)
    }
    expect(out.indexOf('no_points')).toBeLessThan(out.indexOf('no_root'))
    expect(out).not.toContain('persome model status')
  })

  test('only the codes Runtime sent: partial list stays partial even though counts are all zero', () => {
    const v = modelIssuesView(graph({ model_status: { ready: false, issues: ['no_root'] } }))
    expect(v.codes.map((c) => c.code)).toEqual(['no_root'])
  })

  test('unknown code from Runtime is shown literally with a generic explanation; junk values are dropped', () => {
    const v = modelIssuesView(graph({ model_status: { issues: ['no_completed_build', 'future_code', 42 as unknown as string, '<b>x', 'no_root', 'no_root'] } }))
    expect(v.codes.map((c) => c.code)).toEqual(['no_completed_build', 'future_code', 'no_root'])
    expect(v.codes[1].explanation).toContain('has no description')
  })

  test('complete model with empty issues renders nothing', () => {
    const g = graph({ model_status: { ready: true, issues: [] } }, [])
    g.model.stats = { points: 3, evolution_lines: 1, relation_lines: 1, faces: 1, volumes: 1, roots: 1, receipts: 1 }
    g.model.root = { signature: 'r', observations: 1, confidence: 0.9 }
    expect(html(g)).toBe('')
    expect(modelIssuesView(undefined).showCliOnlyNote).toBe(false)
  })

  test('Overview and Model pages render the component (wiring)', () => {
    for (const page of ['Overview.tsx', 'Model.tsx']) {
      const src = readFileSync(join(__dirname, '../../src/renderer/src/pages', page), 'utf8')
      expect(src).toContain('modelIssuesView(graph.data)')
      expect(src).toContain('<ModelIssues view={issues} />')
    }
  })
})

// DEPLOY-05: Runtime schema 2026-11-05.3 (personal-model-og be0a0bc, e61fd6e) ships MOD-13: `/model/graph`
// carries `model_status: {ready, issues}` from snapshot.py model_status(), which emits exactly these codes in
// this order; build.py `_run_stage` names are the only other literals that reach `degraded_stages`.
const UPSTREAM_ISSUE_CODES = ['no_points', 'no_lines', 'no_faces', 'no_volumes', 'no_root', 'no_completed_build', 'build_in_progress']
const UPSTREAM_STAGES = ['state_formation', 'evomem_baseline', 'entity_relation_enrichment', 'schema_miner', 'cross_domain_sweeper', 'root_synthesis', 'vector_backfill', 'model_contract']

describe('MOD-13 against Runtime 2026-11-05.3', () => {
  test('every upstream issue code and build stage has a Chinese explanation (no fallback text)', () => {
    const v = modelIssuesView(graph({ model_status: { ready: false, issues: UPSTREAM_ISSUE_CODES } }, UPSTREAM_STAGES))
    expect(v.runtimeProvidesCodes).toBe(true)
    expect(v.showCliOnlyNote).toBe(false)
    expect(v.codes.map((c) => c.code)).toEqual(UPSTREAM_ISSUE_CODES)
    expect(v.stages.map((c) => c.code)).toEqual(UPSTREAM_STAGES)
    for (const c of [...v.codes, ...v.stages]) {
      expect([c.code, c.explanation.includes('has no description')]).toEqual([c.code, false])
    }
    setLocale('zh')
    try {
      const zh = modelIssuesView(graph({ model_status: { ready: false, issues: UPSTREAM_ISSUE_CODES } }, UPSTREAM_STAGES))
      for (const c of [...zh.codes, ...zh.stages]) {
        expect([c.code, c.explanation.includes('未收录')]).toEqual([c.code, false])
        expect(c.explanation).toMatch(/[一-鿿]/)
      }
    } finally {
      setLocale('en')
    }
    expect(Object.keys(ISSUE_EXPLANATIONS).sort()).toEqual([...UPSTREAM_ISSUE_CODES].sort())
  })

  test('ready model: model_status {ready: true, issues: []} renders no issue block content', () => {
    const v = modelIssuesView(graph({ model_status: { ready: true, issues: [] } }, []))
    expect(v).toMatchObject({ codes: [], runtimeProvidesCodes: true, stages: [], showCliOnlyNote: false })
  })
})
