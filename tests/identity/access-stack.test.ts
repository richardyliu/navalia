import { describe, expect, test } from 'vitest'
import { stackDays, typingMinutes } from '../../src/renderer/src/components/connections/stack'

describe('Access log 30-day stacked view', () => {
  test('30 consecutive local days ending today, zero-filled, stacked by client', () => {
    const today = new Date(2026, 10, 4, 15)
    const { stacks, clients, max } = stackDays(
      [
        { day: '2026-11-04', client: 'codex', reads: 2, responseChars: 10 },
        { day: '2026-11-04', client: 'claude-code', reads: 3, responseChars: 10 },
        { day: '2026-10-06', client: 'claude-code', reads: 1, responseChars: 1 },
        { day: '2026-10-05', client: 'claude-code', reads: 9, responseChars: 1 }
      ],
      today
    )
    expect(stacks).toHaveLength(30)
    expect(stacks[0].day).toBe('2026-10-06')
    expect(stacks[29]).toEqual({ day: '2026-11-04', total: 5, segments: [{ client: 'claude-code', reads: 3 }, { client: 'codex', reads: 2 }] })
    expect(stacks[0].total).toBe(1)
    expect(stacks.slice(1, 29).every((s) => s.total === 0)).toBe(true)
    expect(clients).toEqual(['claude-code', 'codex'])
    expect(max).toBe(5)
  })
  test('typing time = chars / 300 per minute', () => {
    expect(typingMinutes(600)).toBe(2)
    expect(typingMinutes(4146)).toBe(13.8)
  })
})
