// OG-03: static render of the drawer's 直接来源 section for a real promoted Point with sources=[]
// (Runtime 0.3.2 output, fixtures/mod07-promoted-point-no-sources.json). Asserts the Point is never
// shown as a bare "无".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { EvidenceResponse } from '../../src/shared/types'
import { Section } from '../../src/renderer/src/components/EvidenceDrawer'
import { buildEvidenceView } from '../../src/renderer/src/components/evidence/model'

// These assertions pin the original Chinese wording; the English path has its own test at the end.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const POINT = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mod07-promoted-point-no-sources.json'), 'utf8')
) as EvidenceResponse

// vitest's esbuild transform uses the classic JSX runtime for .tsx; the component needs a global React.
;(globalThis as { React?: typeof React }).React = React

function render(view: ReturnType<typeof buildEvidenceView>): string {
  return renderToStaticMarkup(
    createElement(Section, { title: '直接来源', items: view.sources, onNavigate: () => undefined, unresolved: view.pointUnresolved })
  )
}

describe('OG-03 drawer render', () => {
  test('Point with sources=[] renders 证据未解析 + ref + reason + labelled fallback, not 无', () => {
    const html = render(buildEvidenceView(POINT))
    expect(html).toContain('证据未解析')
    expect(html).toContain('⟨20261105-1039-5b1c2a:person-zhang-wei.md⟩')
    expect(html).toContain('sources=[]')
    expect(html).toContain('Navalia 回退：无')
    expect(html).toContain('data-fallback="none"')
    expect(html).not.toContain('>无<')
  })

  test('non-Point with no sources still renders 无', () => {
    const html = render(buildEvidenceView({ ...POINT, kind: 'memory' }))
    expect(html).toContain('>无<')
    expect(html).not.toContain('证据未解析')
  })
})

describe('OG-03 drawer render (English)', () => {
  test('Point with sources=[] renders the English marker, reason and fallback; empty non-Point says None', () => {
    setLocale('en')
    const html = render(buildEvidenceView(POINT))
    expect(html).toContain('Evidence unresolved')
    expect(html).toContain('Navalia fallback: none')
    expect(html).toContain('sources=[]')
    expect(render(buildEvidenceView({ ...POINT, kind: 'memory' }))).toContain('>None<')
  })
})
