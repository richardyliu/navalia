import { describe, expect, it } from 'vitest'
import { CONSENT_KINDS, CONSENT_TEXT, type ConnectorPreview, type ConsentView } from '../../src/main/connectors/api'
import {
  commitLines,
  consentFor,
  consentLine,
  csvMappingError,
  defaultSelection,
  deleteLines,
  hasTarget,
  imapNotSupported,
  IMAP_PROVIDERS,
  imapFormErrors,
  ITEM_LABEL,
  KIND_LABEL,
  KIND_ORDER,
  ledgerLine,
  previewSummary,
  providerFor,
  sameMapping,
  setCsvRole,
  toggle,
  toggleCsvBody
} from '../../src/renderer/src/pages/connectorsView'

const preview: ConnectorPreview = {
  cancelled: false,
  previewId: 'a'.repeat(24),
  kind: 'calendar',
  fileName: 'cal.ics',
  items: [
    { key: 'ev-1', title: 'A', when: null, text: 't', redactions: 1, state: 'new' },
    { key: 'ev-2', title: 'B', when: null, text: 't', redactions: 0, state: 'unchanged' },
    { key: 'ev-3', title: 'C', when: null, text: 't', redactions: 0, state: 'changed' }
  ],
  warnings: [],
  totals: { items: 3, events: 3, redactions: 1 },
  mapping: []
}

describe('connectors view-model', () => {
  it('pre-selects everything not already imported; toggles; summarises', () => {
    expect([...defaultSelection(preview)]).toEqual(['ev-1', 'ev-3'])
    expect([...toggle(new Set(['ev-1']), 'ev-1')]).toEqual([])
    expect(previewSummary(preview)).toBe('cal.ics: 3 events · 1 redacted · not imported 1 / changed 1 / imported 1')
  })

  it('commit lines show counts, notes, updated and failed items', () => {
    const lines = commitLines({
      kind: 'health',
      target: 'health',
      written: 1,
      updated: 1,
      unchanged: 0,
      failed: 1,
      items: [
        { key: 'day:2026-11-03', outcome: 'updated', detail: '已追加一条「更新」记忆' },
        { key: 'day:2026-11-04', outcome: 'failed', detail: 'boom' }
      ],
      health: { received: 3, inserted: 3, corrected: 0, duplicates: 0 },
      cli: null,
      notes: ['结构化记录：收到 3']
    })
    expect(lines[0]).toBe('Written 1 · updated 1 · unchanged, skipped 0 · failed 1')
    expect(lines).toContain('结构化记录：收到 3')
    expect(lines).toContain('day:2026-11-04: boom')
  })

  it('S1-R4-07 email: label, column header and a summary that counts duplicates once', () => {
    expect(KIND_LABEL.email).toBe('Email (.eml / mbox)')
    expect(ITEM_LABEL.email).toBe('Email')
    const p: ConnectorPreview = { ...preview, kind: 'email', fileName: 'inbox.mbox', totals: { items: 3, events: 4, redactions: 1 } }
    expect(previewSummary(p)).toBe('inbox.mbox: 3 emails (4 in the file, duplicates counted once) · 1 redacted · not imported 1 / changed 1 / imported 1')
  })
})

describe('C19 view-model', () => {
  const consents: ConsentView[] = CONSENT_KINDS.map((k) => ({ kind: k, text: CONSENT_TEXT[k], granted: k === 'email-file', grantedAt: k === 'email-file' ? '2026-11-06T10:00:00.000Z' : null, revokedAt: k === 'csv' ? '2026-11-06T11:00:00.000Z' : null }))

  it('consent lookup maps the email file connector to email-file; lines say what is allowed', () => {
    expect(consentFor(consents, 'email')?.kind).toBe('email-file')
    expect(consentFor(consents, 'imap')?.granted).toBe(false)
    expect(consentLine(consentFor(consents, 'email')!)).toBe('Agreed (2026-11-06 10:00)')
    expect(consentLine(consentFor(consents, 'csv')!)).toMatch(/Consent revoked.*cannot read or import/)
    expect(consentLine(consentFor(consents, 'calendar')!)).toMatch(/Not agreed yet/)
    expect(KIND_ORDER).toEqual(['calendar', 'health', 'email', 'imap', 'csv'])
    expect(hasTarget('csv') && hasTarget('calendar') && !hasTarget('imap')).toBe(true)
  })

  it('IMAP form validation, provider notes (app passwords, no OAuth)', () => {
    const ok = { host: 'imap.gmail.com', port: 993, user: 'me@gmail.com', password: 'abcd efgh ijkl mnop', mailbox: 'INBOX' }
    expect(imapFormErrors(ok, false)).toEqual([])
    expect(imapFormErrors({ ...ok, host: 'imaps://imap.gmail.com:993' }, false)[0]).toMatch(/server address/)
    expect(imapFormErrors({ ...ok, password: '' }, false)).toContain('Enter the app password')
    expect(imapFormErrors({ ...ok, password: '' }, true)).toEqual([])
    expect(imapFormErrors({ ...ok, mailbox: 'a\nb' }, false)).toContain('Account, password and mailbox name cannot contain line breaks')
    expect(providerFor(' IMAP.QQ.com ')?.name).toBe('QQ Mail')
    expect(IMAP_PROVIDERS.map((p) => p.host)).toEqual(['imap.gmail.com', 'imap.mail.me.com', 'imap.qq.com', 'imap.163.com'])
    expect(imapNotSupported().join()).toMatch(/OAuth/)
  })

  it('CSV mapping editing keeps roles exclusive', () => {
    const m = { date: 0, title: 1, body: [2, 3], tags: null }
    expect(setCsvRole(m, 'tags', 3)).toEqual({ date: 0, title: 1, body: [2], tags: 3 })
    expect(toggleCsvBody(m, 1)).toEqual({ date: 0, title: null, body: [1, 2, 3], tags: null })
    expect(toggleCsvBody(m, 2)).toEqual({ date: 0, title: 1, body: [3], tags: null })
    expect(csvMappingError({ date: 0, title: null, body: [], tags: null })).toMatch(/at least one/)
    expect(sameMapping(m, { ...m, body: [2, 3] })).toBe(true)
  })

  it('ledger and delete result lines never claim more than the Runtime did', () => {
    expect(ledgerLine({ kind: 'health', items: 3, memoryEntries: 2, memoryWithoutId: 1, healthEvents: 40, timelineDocs: 0, lastAt: '2026-11-06T10:00:00.000Z' })).toBe(
      '3 items · 2 memory entries · 1 without entry id · 40 structured health records · last written 2026-11-06 10:00'
    )
    const full = deleteLines({ kind: 'health', memoryRetired: 2, healthDeleted: 40, remaining: [], notes: [] })
    expect(full).toEqual(['Retired 2 memory entries · deleted 40 structured health records', 'Everything this connector wrote per the Navalia ledger has been deleted from Runtime.'])
    const partial = deleteLines({ kind: 'calendar', memoryRetired: 0, healthDeleted: 0, remaining: [{ what: 'memory', count: 3, reason: 'x', how: [], ids: [] }], notes: [] })
    expect(partial.join()).not.toMatch(/has been deleted from Runtime/)
    const r10 = deleteLines({ kind: 'csv', memoryRetired: 0, memoryErased: 4, timelineDeleted: 2, healthDeleted: 0, remaining: [], notes: [] })
    expect(r10[0]).toBe('Deleted 4 memory entries · deleted 2 timeline documents')
  })
})
