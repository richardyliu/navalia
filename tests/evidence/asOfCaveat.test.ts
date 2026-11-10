// MOD-12 mitigation: the EvidenceDrawer as-of view is labelled as an ingest-time context cut-off,
// never as "the state at T". Static render only; no Runtime call.
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { AsOfBar } from '../../src/renderer/src/components/EvidenceDrawer'
import { asOfCaveatText, asOfCaveat } from '../../src/renderer/src/components/evidence/asOf'

;(globalThis as { React?: typeof React }).React = React

const render = (asOf: string | undefined) => renderToStaticMarkup(createElement(AsOfBar, { asOf, onApply: () => undefined }))

describe('MOD-12: as-of view is a history/context cut-off, not the state at T', () => {
  test('caveat text is exact and only shown while a cut-off is active', () => {
    expect(asOfCaveatText()).toBe('Context cut off by ingest time; not the state at that time. See MOD-12')
    expect(asOfCaveat(undefined)).toBeNull()
    expect(asOfCaveat('bogus')).toBeNull()
    expect(asOfCaveat('2026-03-01')).toBe(asOfCaveatText())
  })

  test('render: cut-off active → caveat note; action no longer promises "当时"; live view has no caveat', () => {
    const on = render('2026-03-01T10:30')
    expect(on).toContain(asOfCaveatText())
    expect(on).toContain('role="note"')
    expect(on).toContain('View context up to then')
    expect(on).not.toContain('>查看当时<')
    const off = render(undefined)
    expect(off).not.toContain(asOfCaveatText().slice(0, 10) + '</p>')
    expect(off).not.toContain('role="note"')
    expect(off).toContain('View context up to then')
  })

  test('zh: the original Chinese caveat and action label', () => {
    setLocale('zh')
    expect(asOfCaveatText()).toBe('按录入时间截止的上下文，不等于当时状态；见 MOD-12')
    const on = render('2026-03-01T10:30')
    expect(on).toContain(asOfCaveatText())
    expect(on).toContain('查看截止上下文')
    expect(on).not.toContain('>查看当时<')
  })
  afterEach(() => setLocale('en'))
})
