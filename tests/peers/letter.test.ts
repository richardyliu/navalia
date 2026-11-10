import { describe, expect, it } from 'vitest'
import { addDays, buildLetter, letterWindow, placeTimestamp, type LetterInput } from '../../src/main/peers/letter'
import type { MemorySearchHit } from '../../src/shared/types'

const FP = 'a'.repeat(64)
const NOW = Date.parse('2026-11-05T02:00:00Z') // Shanghai 11-05 10:00, LA 11-04 19:00

const hit = (id: string, timestamp: string | undefined, content: string, path = 'project-navalia.md'): MemorySearchHit => ({ id, path, timestamp, content })

const recent: MemorySearchHit[] = [
  hit('e-1', '2026-11-04T09:30:00+08:00', '## 给 Peers 页面写了验签测试\n细节略'),
  hit('e-2', '2026-11-01T14:00', '- [ ] 整理知识图谱的可视化方案'),
  hit('e-3', '2026-10-20T10:00:00Z', '很久以前的事'),
  hit('e-4', undefined, '没有时间的记录'),
  hit('e-5', '2026-10-29T15:00:00Z', '边界：上海是 10-29 23:00，洛杉矶是 10-29 08:00')
]
// S1-FULL C11: the letter lists signed shared moments (filtered by the caller); never keyword overlap.
const experiences = [{ momentId: '11111111-1111-4111-8111-111111111111', title: '一起去爬了香山', start: '2026-11-01', end: '2026-11-01', friend: 'Alice' }]

function input(over: Partial<LetterInput> = {}): LetterInput {
  return {
    now: NOW,
    timezone: 'Asia/Shanghai',
    peer: { fingerprint: FP, displayName: 'Alice', cardId: `card_${'b'.repeat(32)}`, cardIssuedAt: '2026-11-01T09:00:00.000Z' },
    recent,
    experiences,
    ...over
  }
}

describe('weekly letter draft', () => {
  it('matches the snapshot (deterministic template, quoted lines, user-filled sections)', () => {
    const d = buildLetter(input())
    expect(d.range).toEqual({ start: '2026-10-30', end: '2026-11-05' })
    expect(d.counts).toEqual({ inWindow: 2, recentTotal: 5, undated: 1, experiences: 1 })
    expect(d.suggestedFileName).toBe('persome-letter-2026-11-05-aaaaaaaa.md')
    expect(d.markdown).toMatchSnapshot()
    expect(buildLetter(input()).markdown).toBe(d.markdown)
  })

  it('every inferred line carries 未核实 and nothing is sent/LLM-generated', () => {
    const { markdown } = buildLetter(input())
    const quoted = markdown.split('\n').filter((l) => l.startsWith('- ') && l.includes('“'))
    expect(quoted.length).toBeGreaterThan(0)
    for (const l of quoted) expect(l).toContain('未核实')
    expect(markdown).toContain('未调用 LLM，不会发送到任何地方')
    for (const s of ['## 我想说的', '## 想问你的', '## 下周打算']) expect(markdown).toContain(s)
  })

  it('empty data yields honest empty sections, no invented content', () => {
    const d = buildLetter(input({ recent: [], experiences: [], peer: { ...input().peer, displayName: null } }))
    expect(d.counts).toEqual({ inWindow: 0, recentTotal: 0, undated: 0, experiences: 0 })
    expect(d.markdown).toContain('# 每周信 · 致 朋友（aaaaaaaa）')
    expect(d.markdown).toContain('- 这 7 天没有记录到活动。')
    expect(d.markdown).toContain('- 这 7 天没有双方签名确认、并且允许写进周信的共同经历。')
    expect(d.markdown).not.toContain('“')
    expect(d.markdown).toMatchSnapshot()
  })

  it('reports read failures instead of guessing', () => {
    const d = buildLetter(input({ recent: null, recentError: 'runtime down', experiences: null, experiencesError: 'moments unreadable' }))
    expect(d.markdown).toContain('- 最近活动读取失败：runtime down')
    expect(d.markdown).toContain('- 来源 recent_activity：读取失败')
    expect(d.markdown).toContain('- 读取本机共同经历失败：moments unreadable')
  })

  it('C11: lists the signed moment (friend audience omits the name), moments outside the window are dropped', () => {
    const d = buildLetter(input({ experiences: [...experiences, { ...experiences[0], momentId: '22222222-2222-4222-8222-222222222222', title: '很久以前', start: '2026-09-01', end: '2026-09-02' }] }))
    const section = d.markdown.split('## 这周和你的共同经历')[1].split('\n## ')[0]
    expect(section).toContain('- 2026-11-01 · 「一起去爬了香山」（双方签名确认）')
    expect(section).not.toContain('很久以前')
    expect(d.markdown).not.toContain('共同话题')
    expect(d.markdown).not.toContain('和你的卡片有关的')
    const b = buildLetter(input({ audience: 'broadcast' }))
    expect(b.markdown).toContain('## 这周和朋友的共同经历')
    expect(b.markdown).toContain('「一起去爬了香山」 · 和 Alice（双方签名确认）')
  })

  it('the 7-day window follows the injected timezone', () => {
    expect(letterWindow(NOW, 'Asia/Shanghai')).toEqual({ start: '2026-10-30', end: '2026-11-05' })
    expect(letterWindow(NOW, 'America/Los_Angeles')).toEqual({ start: '2026-10-29', end: '2026-11-04' })
    const sh = buildLetter(input())
    const la = buildLetter(input({ timezone: 'America/Los_Angeles' }))
    expect(sh.markdown).not.toContain('e-5')
    expect(la.markdown).toContain('⟨e-5⟩')
    expect(la.markdown).toContain('- 10-29 08:00 ·')
    // Offset timestamps are converted; naive ones are wall-clock in the chosen zone.
    expect(placeTimestamp('2026-11-04T09:30:00+08:00', 'America/Los_Angeles')).toMatchObject({ date: '2026-11-03', time: '17:30' })
    expect(placeTimestamp('2026-11-01T14:00', 'America/Los_Angeles')).toMatchObject({ date: '2026-11-01', time: '14:00' })
    expect(placeTimestamp('garbage', 'UTC')).toBeNull()
  })

  it('date arithmetic is DST-safe', () => {
    expect(addDays('2026-11-05', -6)).toBe('2026-10-30')
    expect(addDays('2026-03-10', -6)).toBe('2026-03-04')
    expect(letterWindow(Date.parse('2026-11-02T12:00:00Z'), 'America/New_York')).toEqual({ start: '2026-10-27', end: '2026-11-02' })
  })
})
