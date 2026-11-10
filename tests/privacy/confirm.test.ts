import { afterEach, describe, expect, test } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { PRIVACY_ACTIONS } from '../../src/main/privacy/api'
import { PRIVACY_CONFIRM_SPECS, PRIVACY_CONFIRM_TTL_MS, createPrivacyConfirmGate } from '../../src/main/privacy/confirm'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

afterEach(() => setLocale('en'))

describe('privacy confirm gate (main-issued nonce + typed phrase)', () => {
  test('every action has a distinct non-empty phrase and a warning', () => {
    const phrases = PRIVACY_ACTIONS.map((a) => PRIVACY_CONFIRM_SPECS[a].phrase)
    expect(new Set(phrases).size).toBe(PRIVACY_ACTIONS.length)
    for (const a of PRIVACY_ACTIONS) expect(PRIVACY_CONFIRM_SPECS[a].warning.length).toBeGreaterThan(10)
  })

  test('right phrase within TTL succeeds once; replay is refused', () => {
    const c = clock()
    const gate = createPrivacyConfirmGate({ now: c.now })
    const ch = gate.issue('delete-captures')
    expect(ch.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(ch.phrase).toBe('delete raw captures')
    expect(Date.parse(ch.expiresAt) - c.now()).toBe(PRIVACY_CONFIRM_TTL_MS)
    expect(() => gate.consume('delete-captures', ch.nonce, `  ${ch.phrase} `)).not.toThrow()
    expect(() => gate.consume('delete-captures', ch.nonce, ch.phrase)).toThrow(/no longer valid or was already used/)
  })

  test('wrong phrase burns the nonce (the right phrase afterwards is refused too)', () => {
    const gate = createPrivacyConfirmGate()
    const ch = gate.issue('delete-memory')
    expect(() => gate.consume('delete-memory', ch.nonce, 'delete all')).toThrow(/confirmation phrase is incorrect/)
    expect(() => gate.consume('delete-memory', ch.nonce, ch.phrase)).toThrow(/no longer valid or was already used/)
  })

  test('expired nonce is refused', () => {
    const c = clock()
    const gate = createPrivacyConfirmGate({ now: c.now })
    const ch = gate.issue('withdraw-all')
    c.advance(PRIVACY_CONFIRM_TTL_MS)
    expect(() => gate.consume('withdraw-all', ch.nonce, ch.phrase)).toThrow(/expired|no longer valid/)
  })

  test('a nonce for one action cannot confirm another', () => {
    const gate = createPrivacyConfirmGate()
    const ch = gate.issue('delete-captures')
    expect(() => gate.consume('delete-all', ch.nonce, PRIVACY_CONFIRM_SPECS['delete-all'].phrase)).toThrow(/does not match/)
    expect(() => gate.consume('delete-captures', ch.nonce, ch.phrase)).toThrow(/no longer valid/)
  })

  test('renderer-invented nonce is refused; outstanding table is bounded', () => {
    const gate = createPrivacyConfirmGate()
    expect(() => gate.consume('delete-all', 'a'.repeat(32), PRIVACY_CONFIRM_SPECS['delete-all'].phrase)).toThrow(/no longer valid/)
    for (let i = 0; i < 20; i++) gate.issue('delete-timeline')
    expect(gate.outstanding()).toBeLessThanOrEqual(8)
  })

  test('zh: the Chinese phrase and messages are unchanged', () => {
    setLocale('zh')
    const gate = createPrivacyConfirmGate()
    const ch = gate.issue('delete-captures')
    expect(ch.phrase).toBe('删除原始采集')
    expect(() => gate.consume('delete-captures', ch.nonce, '删除')).toThrow(/确认短语不正确/)
    expect(() => gate.consume('delete-captures', ch.nonce, ch.phrase)).toThrow(/已失效或已被使用/)
  })

  test('the phrase is pinned at issue: a locale switch before typing does not change what must be typed', () => {
    const gate = createPrivacyConfirmGate()
    const ch = gate.issue('delete-timeline')
    setLocale('zh')
    expect(() => gate.consume('delete-timeline', ch.nonce, 'delete timeline')).not.toThrow()
  })
})
