// S2-08 今天「下一步」: only explicit unfinished items + learned habits verbatim, every item 未核实
// with a source; deterministic; time-zone day boundaries; dedupe; never Performance.
import { describe, expect, it } from 'vitest'
import { buildBrief, nextStepKey, previousDate, UNVERIFIED } from '../../src/main/library/brief'
import type { BehaviorPatterns, MemorySearchHit, RecentActivityResponse } from '../../src/shared/types'

const TZ = 'Asia/Shanghai'
// 2026-11-05 10:00 Shanghai
const NOW = Date.parse('2026-11-05T02:00:00Z')

function recent(entries: MemorySearchHit[]): RecentActivityResponse {
  return { count: entries.length, entries }
}

const HABITS: BehaviorPatterns = {
  root: null,
  faces: [
    { signature: '上午先清理沟通，再进入深度工作。', observations: 6, confidence: 0.64 },
    { signature: '重视证据链：结论必须能回到原文和来源。', observations: 14, confidence: 0.86 },
    { signature: '偏好本地优先工具。', observations: 9, confidence: 0.78 },
    { signature: '第四个习惯不进前三。', observations: 1, confidence: 0.2 },
    { signature: '  ', observations: 50, confidence: 1 }
  ],
  skills: [],
  rendered: ''
}

const ENTRIES: MemorySearchHit[] = [
  { id: 'e-today', path: 'daily.md', timestamp: '2026-11-05T09:30:00+08:00', content: '- [ ] 补测试\nTODO: 写 S2-08 log\n待办：给 lead 发 wiring' },
  { id: 'e-yest', path: 'daily.md', timestamp: '2026-11-04T21:00:00+08:00', content: '- [ ] 修 Library 布局\n- [ ] 补测试。' },
  { id: 'e-old', path: 'daily.md', timestamp: '2026-11-03T10:00:00+08:00', content: '- [ ] 三天前的事' },
  { id: 'e-undated', path: 'notes.md', timestamp: 'sometime', content: '- [ ] 时间未知的事' }
]

describe('下一步 (S2-08)', () => {
  it('lists explicit unfinished items (today, then yesterday) and top-3 habits verbatim, each 未核实 with a source', () => {
    const b = buildBrief({ now: NOW, timezone: TZ, recent: recent(ENTRIES), patterns: HABITS, het: null })
    expect(b.nextSteps.map((n) => [n.kind, n.day, n.text])).toEqual([
      ['todo', 'today', '补测试'],
      ['todo', 'today', '写 S2-08 log'],
      ['todo', 'today', '给 lead 发 wiring'],
      ['todo', 'yesterday', '修 Library 布局'],
      ['habit', null, '重视证据链：结论必须能回到原文和来源。'],
      ['habit', null, '偏好本地优先工具。'],
      ['habit', null, '上午先清理沟通，再进入深度工作。']
    ])
    for (const n of b.nextSteps) {
      expect(n.label).toBe(UNVERIFIED)
      expect(n.source).toBeTruthy()
    }
    expect(b.nextSteps[0].source).toEqual({ kind: 'record', ref: 'e-today', path: 'daily.md', date: '2026-11-05', time: '09:30', line: '- [ ] 补测试' })
    expect(b.nextSteps[3].source).toMatchObject({ kind: 'record', ref: 'e-yest', date: '2026-11-04', time: '21:00' })
    expect(b.nextSteps[4].source).toEqual({ kind: 'habit', observations: 14, confidence: 0.86 })
    // markdown (copy / export) carries the same block
    expect(b.markdown).toContain('## 下一步')
    expect(b.markdown).toContain('- [ ] “修 Library 布局”（未核实；来源 昨天 21:00 `daily.md` ⟨e-yest⟩）')
    expect(b.markdown).toContain('- 已学到的习惯：“偏好本地优先工具。”（未核实；来源 behavior_patterns，观察 9 次，置信 78%）')
    expect(b.markdown).not.toContain('三天前的事')
    expect(b.markdown).not.toContain('第四个习惯')
    expect(b.counts.todo).toBe(4)
  })

  it('is deterministic: same input → identical output, independent of input order', () => {
    const input = { now: NOW, timezone: TZ, recent: recent(ENTRIES), patterns: HABITS, het: null }
    const a = buildBrief(input)
    const b = buildBrief(structuredClone(input))
    expect(b).toEqual(a)
    const shuffled = buildBrief({ ...input, recent: recent([...ENTRIES].reverse()), patterns: { ...HABITS, faces: [...HABITS.faces].reverse() } })
    expect(shuffled.nextSteps).toEqual(a.nextSteps)
  })

  it('empty: no records and no habits → empty list and an explicit line', () => {
    const b = buildBrief({ now: NOW, timezone: TZ, recent: recent([]), patterns: null, het: null })
    expect(b.nextSteps).toEqual([])
    expect(b.markdown).toContain('- 今天和昨天的记录里没有标为未完成的事项，因此不列待办。')
    const failed = buildBrief({ now: NOW, timezone: TZ, recent: null, recentError: 'down', patterns: null, het: null })
    expect(failed.nextSteps).toEqual([])
    expect(failed.markdown).toContain('- 最近活动读取失败，无法列出未完成事项。')
  })

  describe('time-zone day boundaries', () => {
    const nearMidnight: MemorySearchHit[] = [
      // 2026-11-04T15:59Z = Shanghai 11-04 23:59 (yesterday) ; LA 11-04 07:59
      { id: 'a', path: 'x.md', timestamp: '2026-11-04T15:59:00Z', content: '- [ ] 23:59 的事' },
      // 2026-11-04T16:01Z = Shanghai 11-05 00:01 (today) ; LA 11-04 08:01
      { id: 'b', path: 'x.md', timestamp: '2026-11-04T16:01:00Z', content: '- [ ] 00:01 的事' },
      // 2026-11-03T15:59Z = Shanghai 11-03 23:59 (two days ago → out) ; LA 11-03 07:59 (yesterday for LA)
      { id: 'c', path: 'x.md', timestamp: '2026-11-03T15:59:00Z', content: '- [ ] 前天深夜的事' }
    ]

    it('Asia/Shanghai: 00:01 is today, 23:59 is yesterday, 23:59 two days ago is out', () => {
      const b = buildBrief({ now: NOW, timezone: TZ, recent: recent(nearMidnight), patterns: null, het: null })
      expect(b.nextSteps.map((n) => [n.text, n.day])).toEqual([
        ['00:01 的事', 'today'],
        ['23:59 的事', 'yesterday']
      ])
    })

    it('America/Los_Angeles: same records bucket on the LA calendar', () => {
      // NOW = 2026-11-04 18:00 PST in LA → today 11-04, yesterday 11-03
      const b = buildBrief({ now: NOW, timezone: 'America/Los_Angeles', recent: recent(nearMidnight), patterns: null, het: null })
      expect(b.date).toBe('2026-11-04')
      expect(b.nextSteps.map((n) => [n.text, n.day, n.source.kind === 'record' ? n.source.time : null])).toEqual([
        ['23:59 的事', 'today', '07:59'],
        ['00:01 的事', 'today', '08:01'],
        ['前天深夜的事', 'yesterday', '07:59']
      ])
    })

    it('previousDate crosses month / year / leap boundaries', () => {
      expect(previousDate('2026-03-01')).toBe('2026-02-28')
      expect(previousDate('2028-03-01')).toBe('2028-02-29')
      expect(previousDate('2027-01-01')).toBe('2026-12-31')
    })
  })

  it('dedupes by normalized text and drops items checked off later', () => {
    const b = buildBrief({
      now: NOW,
      timezone: TZ,
      recent: recent([
        { id: 'y', path: 'd.md', timestamp: '2026-11-04T09:00:00+08:00', content: '- [ ] 发 PR\n- [ ] 写周报' },
        { id: 't1', path: 'd.md', timestamp: '2026-11-05T08:00:00+08:00', content: '- [ ]  发  ＰＲ 。\nTODO: 写周报' },
        { id: 't2', path: 'd.md', timestamp: '2026-11-05T09:00:00+08:00', content: '- [x] 写周报' }
      ]),
      patterns: null,
      het: null
    })
    // 发 PR appears once (today's occurrence wins); 写周报 was checked off at 09:00 today.
    expect(b.nextSteps.map((n) => [n.text, n.day, n.source.kind === 'record' ? n.source.ref : null])).toEqual([['发 ＰＲ 。', 'today', 't1']])
    expect(nextStepKey('  发  ＰＲ 。')).toBe(nextStepKey('发 PR'))
  })

  it('no fabrication: no item without a source; undated / unmarked / done lines produce nothing', () => {
    const b = buildBrief({
      now: NOW,
      timezone: TZ,
      recent: recent([
        { id: '', path: 'p.md', timestamp: '2026-11-05T09:00:00+08:00', content: '- [ ] 没有 id 的记录' },
        { id: 'u', path: 'p.md', timestamp: 'sometime', content: '- [ ] 时间未知' },
        { id: 'p', path: 'p.md', timestamp: '2026-11-05T09:00:00+08:00', content: '明天应该写测试\n- [x] 已完成\n- 普通列表' }
      ]),
      patterns: { root: null, faces: [], skills: [], rendered: '' },
      het: null
    })
    expect(b.nextSteps).toEqual([])
    const section = b.markdown.slice(b.markdown.indexOf('## 下一步'), b.markdown.indexOf('## 待核对'))
    expect(section).not.toContain('明天应该写测试')
    expect(section).not.toContain('没有 id 的记录')
  })

  it('is not a Performance score', () => {
    const b = buildBrief({ now: NOW, timezone: TZ, recent: recent(ENTRIES), patterns: HABITS, het: null })
    expect(b.markdown).not.toMatch(/Performance|绩效|效率/i)
  })
})
