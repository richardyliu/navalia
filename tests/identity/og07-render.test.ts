// OG-07: static renders of the identity surfaces against the original reference (§5.2 / §9 / §15 ID rows).
// Temp Lens Store roots only (os.tmpdir); never the real Lens Store, ~/.claude, ~/.codex or ~/.persome.
import fs from 'node:fs'
import path from 'node:path'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'
import type { AgentView } from '../../src/main/broker/api'
import { openAuditLog, type AuditInput } from '../../src/main/broker/audit'
import { PersonalCard } from '../../src/renderer/src/components/card/PersonalCard'
import { LocalClaim } from '../../src/renderer/src/components/card/LocalClaim'
import { SwipeAgents } from '../../src/renderer/src/components/card/SwipeAgents'
import { AccessChart } from '../../src/renderer/src/components/connections/AccessChart'
import { AccessLogList } from '../../src/renderer/src/components/connections/AccessLogList'
import { typingTimeCopy } from '../../src/renderer/src/components/connections/stack'
import { setLocale } from '../../src/shared/i18n'
import { createIssuedCard } from './card-helpers'
import { tempRoot } from './helpers'

// vitest's esbuild transform uses the classic JSX runtime for .tsx; components need a global React.
;(globalThis as { React?: typeof React }).React = React

const cleanups: Array<() => unknown> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const html = (el: React.ReactElement) => renderToStaticMarkup(el)

function auditRow(client: string, over: Partial<AuditInput> = {}): AuditInput {
  return {
    grantId: null,
    client,
    capability: 'search',
    argsSha256: 'x',
    argsPreview: '{"query":"ARGS_SECRET"}',
    itemIds: [],
    itemCount: 0,
    responseChars: 0,
    resultPreview: 'RESULT_SECRET',
    outcome: 'ok',
    httpStatus: 200,
    errorCode: null,
    durationMs: 1,
    ...over
  }
}

function agent(id: AgentView['id'], state: AgentView['state'], over: Partial<AgentView> = {}): AgentView {
  return { id, name: id, state, detail: `${state} detail`, configPath: `/tmp/${id}.json`, autoConnect: true, access: 'full', grant: null, ...over }
}

describe('ID-01 Personal Card: front / flip / as-of / Mini Map', () => {
  test('front shows identity summary + "as of"; back is the Mini Map; flip swaps aria-hidden', () => {
    const { signed, cleanup } = createIssuedCard()
    cleanups.push(cleanup)
    const front = html(createElement(PersonalCard, { signed, issuer: 'current', flipped: false, onFlip: () => undefined }))
    expect(front).toContain('as of ')
    expect(front).toContain('Mini Map')
    expect(front).toMatch(/class="pcard "/)
    expect(front).toMatch(/pcard-front" aria-hidden="false"/)
    expect(front).toMatch(/pcard-back" aria-hidden="true"/)
    expect(front).toContain('aria-label="Flip"')
    const back = html(createElement(PersonalCard, { signed, issuer: 'current', flipped: true, onFlip: () => undefined }))
    expect(back).toMatch(/class="pcard flipped"/)
    expect(back).toMatch(/pcard-front" aria-hidden="true"/)
    expect(back).toMatch(/pcard-back" aria-hidden="false"/)
    // Mini Map is drawn (fixture has Root/Volume/Face nodes) as an SVG, not the empty state.
    expect(back).toContain('aria-label="Mini Map"')
    expect(back).toContain('<circle')
  })
})

describe('ID-02: local card creation is labelled DEVIATION', () => {
  test('empty state says DEVIATION · D3, needs no account, and offers no login', () => {
    const out = html(createElement(LocalClaim, { fingerprint: null, pending: false, disabled: false, onCreate: () => undefined }))
    expect(out).toContain('DEVIATION · D3')
    expect(out).toContain('data-deviation="D3"')
    expect(out).not.toContain('Claim your Personal Card')
    expect(out).toContain('No account is needed')
    expect(out).not.toMatch(/Google|\bApple\b|邀请码|Sign in|登录账号来/i)
  })
})

describe('ID-03..06 Swipe: install detection, mismatch / partial, disconnect', () => {
  const list = [
    agent('claude-code', 'connected'),
    agent('codex', 'not_installed'),
    agent('cursor', 'mismatch'),
    agent('claude-desktop', 'partial')
  ]
  const out = html(createElement(SwipeAgents, { agents: list, pending: false, onAction: () => undefined }))
  const block = (state: string) => {
    const i = out.indexOf(`data-state="${state}"`)
    const j = out.indexOf('data-state=', i + 1)
    return out.slice(i, j < 0 ? undefined : j)
  }
  test('all four original states are rendered with their original labels', () => {
    for (const label of ['Connected', 'Not installed', 'Mismatch', 'Partial']) expect(out).toContain(`>${label}<`)
  })
  test('not installed: no connect / repair / disconnect button (never mis-connects)', () => {
    expect(block('not_installed')).not.toMatch(/swipe-connect|swipe-disconnect/)
  })
  test('mismatch / partial: repair + disconnect; connected: full access + disconnect; available: connect only', () => {
    for (const s of ['mismatch', 'partial']) {
      expect(block(s)).toContain('>Repair<')
      expect(block(s)).toContain('swipe-disconnect')
    }
    expect(block('connected')).toContain('full access')
    expect(block('connected')).toContain('swipe-disconnect')
    expect(block('connected')).not.toContain('swipe-connect')
    const avail = html(createElement(SwipeAgents, { agents: [agent('codex', 'available')], pending: false, onAction: () => undefined }))
    expect(avail).toContain('>Connect<')
    expect(avail).not.toContain('swipe-disconnect')
  })
  test('ID-07: no per-scope control in the Swipe list', () => {
    expect(out).not.toMatch(/card:read|evidence:read|identity:read|scope/i)
  })
})

describe('ID-09/10/12/13 Access log render', () => {
  function seededLog() {
    const root = tempRoot('og07-audit')
    const log = openAuditLog(path.join(root, 'audit.db'))
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }), () => log.close())
    log.record(auditRow('claude-code', { itemIds: ['m1', 'm2'], itemCount: 2, responseChars: 600 }))
    log.record(auditRow('claude-code')) // empty result: count 0, still a successful read
    log.record(auditRow('codex', { capability: 'card_get', itemCount: 1, itemIds: ['card'], responseChars: 300 }))
    log.record(auditRow('codex', { outcome: 'denied', httpStatus: 403 })) // not a successful read
    return log
  }

  test('ID-10: 30 day columns, today stacked per agent (pure SVG), empty-result read counted', () => {
    const log = seededLog()
    const out = html(createElement(AccessChart, { daily: log.daily(30) }))
    expect((out.match(/<g>/g) ?? []).length).toBe(30)
    expect(out).toContain('<svg')
    expect(out).toMatch(/· claude-code · 2 reads</) // 1 non-empty + 1 empty-result read
    expect(out).toMatch(/· codex · 1 reads</) // denied call not stacked
    expect(out).toContain(' (today)')
    // legend per agent
    expect(out).toMatch(/<\/i> claude-code/)
    expect(out).toMatch(/<\/i> codex/)
    expect(out).not.toMatch(/ARGS_SECRET|RESULT_SECRET/)
  })

  test('ID-09: empty result appears as a row with count 0', () => {
    const log = seededLog()
    const rows = log.list()
    const empty = rows.find((r) => r.itemCount === 0 && r.client === 'claude-code')
    expect(empty).toMatchObject({ outcome: 'ok', itemCount: 0, responseChars: 0, capability: 'search' })
  })

  test('ID-12: collapsed by default; no arguments/result preview in the markup', () => {
    const log = seededLog()
    const out = html(createElement(AccessLogList, { rows: log.list() }))
    expect(out).toContain('aria-expanded="false"')
    expect(out).not.toContain('conn-table') // day not expanded
    expect(out).not.toMatch(/argumentsPreview|resultPreview|ARGS_SECRET|RESULT_SECRET/)
    // rows from list() carry no preview fields at all
    expect(JSON.stringify(log.list())).not.toMatch(/ARGS_SECRET|RESULT_SECRET/)
  })

  test('ID-13: "打字时间" = chars ÷ 300 字/分, explicitly not time saved', () => {
    expect(typingTimeCopy(900)).toBe('Typing time ≈ 3 min (response chars ÷ 300 chars/min; not time saved)')
    expect(typingTimeCopy(500)).toContain('≈ 1.7 min')
    expect(typingTimeCopy(0)).toContain('≈ 0 min')
    setLocale('zh')
    try {
      expect(typingTimeCopy(900)).toBe('打字时间 ≈ 3 分钟（返回字符 ÷ 300 字/分；不代表节省时间）')
      expect(typingTimeCopy(500)).toContain('≈ 1.7 分钟')
    } finally {
      setLocale('en')
    }
  })
})
