import { describe, expect, test } from 'vitest'
import { STABLE_HABIT_MIN_DATES, assessHabit, dateOf, declaredDays, distinctDates } from '../../src/renderer/src/components/workflows/habit'

describe('S1-05 habit rule: ≥3 distinct dates for a stable habit', () => {
  test('threshold is 3 (S1 article), stricter than Runtime admission (2 observations)', () => {
    expect(STABLE_HABIT_MIN_DATES).toBe(3)
  })

  test('distinct dates come from the date part of timestamps; same-day repeats count once', () => {
    expect(dateOf('2026-10-16T15:12')).toBe('2026-10-16')
    expect(dateOf('garbage')).toBeNull()
    expect(distinctDates(['2026-10-02T09:00', '2026-10-02T17:00', '2026-10-09T09:00', null, undefined, 'x'])).toEqual(['2026-10-02', '2026-10-09'])
  })

  test('2 observations on 2 dates → 观察中 (Runtime would already admit it)', () => {
    const h = assessHabit({ timestamps: ['2026-10-02T09:00', '2026-10-09T09:00'] })
    expect(h).toMatchObject({ status: 'observing', distinctDates: 2, basis: 'evidence_timestamps', partial: false })
    expect(h.label).toBe('Observing (fewer than 3 distinct dates) · 2 dates')
  })

  test('many observations on one long day are still 1 date → 观察中', () => {
    const h = assessHabit({ timestamps: ['2026-10-02T09:00', '2026-10-02T11:00', '2026-10-02T15:00', '2026-10-02T18:00'] })
    expect(h.status).toBe('observing')
    expect(h.distinctDates).toBe(1)
  })

  test('3 distinct dates → 稳定习惯', () => {
    const h = assessHabit({ timestamps: ['2026-10-02T09:00', '2026-10-09T09:00', '2026-10-16T09:00'] })
    expect(h).toMatchObject({ status: 'stable', distinctDates: 3, partial: false, label: 'Stable habit · 3 distinct dates' })
  })

  test('no dates at all → 日期未知, PARTIAL', () => {
    const h = assessHabit({})
    expect(h).toMatchObject({ status: 'unknown', distinctDates: null, basis: 'none', partial: true, label: 'Dates unknown' })
  })

  test('declared text ("across N days") is used only when it exceeds the evidence dates, and is flagged partial', () => {
    expect(declaredDays('5 sessions across 4 days; receipts ...')).toBe(4)
    expect(declaredDays('high (3 consecutive days)')).toBe(3)
    expect(declaredDays('覆盖 4 个不同日期')).toBe(4)
    expect(declaredDays('three independent sessions')).toBeNull()
    const h = assessHabit({ timestamps: ['2026-10-16T09:00'], text: '5 sessions across 4 days' })
    expect(h).toMatchObject({ status: 'stable', distinctDates: 4, basis: 'declared_text', partial: true })
    const e = assessHabit({ timestamps: ['2026-10-02T09:00', '2026-10-09T09:00', '2026-10-16T09:00'], text: 'across 2 days' })
    expect(e).toMatchObject({ distinctDates: 3, basis: 'evidence_timestamps' })
  })
})
