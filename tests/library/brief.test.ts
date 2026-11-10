import { describe, expect, it } from 'vitest'
import type { HetSummary } from '../../src/main/het/api'
import { buildBrief, extractTodoLines, localDateIn, placeTimestamp, quoteLine, UNVERIFIED } from '../../src/main/library/brief'
import type { RecentActivityResponse } from '../../src/shared/types'
import { patterns } from './fixtures'

// 2026-11-05 10:00 in Asia/Shanghai (UTC+8) = 2026-11-05T02:00Z
const NOW = Date.parse('2026-11-05T02:00:00Z')
const TZ = 'Asia/Shanghai'

const recent: RecentActivityResponse = {
  count: 5,
  entries: [
    {
      id: 'ent-2',
      path: 'project-navalia.md',
      timestamp: '2026-11-05T09:30:00+08:00',
      content: '## 实现 Library 页\n- [ ] 补 Runtime 错误态的测试\nTODO：写 S1-08 log\n- [x] 已完成的事'
    },
    { id: 'ent-1', path: 'daily.md', timestamp: '2026-11-04T17:10:00Z', content: '- 和 Mira 讨论“证据链”的展示方式' },
    { id: 'ent-0', path: 'daily.md', timestamp: '2026-11-04T15:59:00Z', content: '昨天深夜（上海 23:59）的记录' },
    { id: 'ent-3', path: 'notes.md', timestamp: '2026-11-05', content: '只有日期的记录' },
    { id: 'ent-4', path: 'notes.md', timestamp: 'sometime', content: '时间格式无法解析' }
  ]
}

const het: HetSummary = {
  days: [{ date: '2026-11-05', minutes: 0, minutes_tenths: 0, tasks: 0, pending: 2 }],
  total_minutes: 0,
  total_minutes_tenths: 0,
  pending: 2,
  failed: 0,
  unsettled: 0,
  state: 'manyPending',
  timezone: TZ
}

describe('daily brief', () => {
  it('snapshot of the template', () => {
    const b = buildBrief({ now: NOW, timezone: TZ, recent, patterns, het })
    expect(b.date).toBe('2026-11-05')
    expect(b.markdown).toMatchSnapshot()
  })

  it('has the three sections, quotes, checkboxes and 未核实 on inferred lines', () => {
    const { markdown, counts } = buildBrief({ now: NOW, timezone: TZ, recent, patterns, het })
    const idx = ['## 今天做了什么', '## 下一步', '## 待核对'].map((h) => markdown.indexOf(h))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(markdown).toContain('“和 Mira 讨论“证据链”的展示方式”')
    expect(markdown).toContain('- [ ] “补 Runtime 错误态的测试”（未核实；来源 今天 09:30 `project-navalia.md` ⟨ent-2⟩）')
    expect(markdown).toContain('- [ ] “写 S1-08 log”（未核实；来源 今天 09:30 `project-navalia.md` ⟨ent-2⟩）')
    expect(markdown).not.toContain('已完成的事”')
    expect(counts).toMatchObject({ done: 3, todo: 2, recentTotal: 5, recentToday: 3 })
    const section = (h: string, next: string) => markdown.slice(markdown.indexOf(h), markdown.indexOf(next))
    for (const line of section('## 今天做了什么', '## 下一步').split('\n').filter((l) => l.startsWith('- ') && l.includes('：“'))) {
      expect(line).toContain(UNVERIFIED)
    }
    for (const line of section('## 下一步', '## 待核对').split('\n').filter((l) => l.startsWith('- '))) {
      expect(line).toContain(UNVERIFIED)
    }
    expect(markdown).toContain('未调用 LLM')
  })

  it('下一步 never invents: no unfinished items → explicit no-item line', () => {
    const { markdown } = buildBrief({
      now: NOW,
      timezone: TZ,
      recent: { count: 1, entries: [{ id: 'e', path: 'a.md', timestamp: '2026-11-05T01:00:00Z', content: '- [x] done' }] },
      patterns: null,
      het: null
    })
    expect(markdown).toContain('- 今天和昨天的记录里没有标为未完成的事项，因此不列待办。')
    expect(markdown).not.toContain('- [ ] “')
  })

  it('empty data', () => {
    const b = buildBrief({ now: NOW, timezone: TZ, recent: { count: 0, entries: [] }, patterns: null, het: null })
    expect(b.counts).toEqual({ done: 0, todo: 0, review: 0, recentTotal: 0, recentToday: 0 })
    expect(b.markdown).toContain('- 今天还没有记录到活动。')
    expect(b.markdown).toContain('- 没有需要核对的条目。')
    expect(b.markdown).toContain('- AI 协作时间（HET）：不可用')
    expect(b.markdown).toMatchSnapshot()
  })

  it('source errors are shown, not hidden', () => {
    const { markdown } = buildBrief({
      now: NOW,
      timezone: TZ,
      recent: null,
      recentError: '连不上 Runtime',
      patterns: null,
      patternsError: 'mcp 退出',
      het: null,
      hetError: 'het.db 打不开'
    })
    expect(markdown).toContain('- 最近活动读取失败：连不上 Runtime')
    expect(markdown).toContain('- 行为模式读取失败：mcp 退出')
    expect(markdown).toContain('HET）：读取失败：het.db 打不开')
    expect(markdown).toContain('- recent_activity：读取失败')
  })

  it('HET zero state is honest; counted minutes are labelled as an estimate', () => {
    const zero = buildBrief({ now: NOW, timezone: TZ, recent: null, patterns: null, het: { ...het, pending: 0, state: 'notStarted', days: [] } })
    expect(zero.markdown).toContain('今天 0 分钟，0 个已评估任务（状态 notStarted')
    const some = buildBrief({
      now: NOW,
      timezone: TZ,
      recent: null,
      patterns: null,
      het: { ...het, state: 'ready', pending: 0, days: [{ date: '2026-11-05', minutes: 42, minutes_tenths: 420, tasks: 3, pending: 0 }] }
    })
    expect(some.markdown).toContain(`今天约 42 分钟，3 个已评估任务（状态 ready；HET 是估算，${UNVERIFIED}）`)
  })

  describe('timezone handling', () => {
    it('day boundary follows the given IANA zone', () => {
      // 2026-11-04T16:30Z is 11-05 00:30 in Shanghai but 11-04 08:30 in Los Angeles
      const t = Date.parse('2026-11-04T16:30:00Z')
      expect(localDateIn(t, 'Asia/Shanghai')).toBe('2026-11-05')
      expect(localDateIn(t, 'America/Los_Angeles')).toBe('2026-11-04')
    })

    it('same data, different zone → different "today"', () => {
      const la = buildBrief({ now: NOW, timezone: 'America/Los_Angeles', recent, patterns: null, het: null })
      // NOW = 2026-11-04 18:00 in LA
      expect(la.date).toBe('2026-11-04')
      // ent-1 (17:10Z = 09:10 LA) and ent-0 (15:59Z = 07:59 LA) are LA-today; ent-2 is 01:30Z = 11-04 17:30 LA
      expect(la.counts.recentToday).toBe(3)
      expect(la.markdown).toContain('07:59 · `daily.md`')
      const sh = buildBrief({ now: NOW, timezone: TZ, recent, patterns: null, het: null })
      expect(sh.markdown).not.toContain('昨天深夜')
      expect(sh.markdown).toContain('01:10 · `daily.md`')
    })

    it('naive timestamps are wall-clock in the zone; unparseable ones go to 待核对', () => {
      expect(placeTimestamp('2026-11-05T09:30', TZ)).toMatchObject({ date: '2026-11-05', time: '09:30' })
      expect(placeTimestamp('2026-11-05', TZ)).toMatchObject({ date: '2026-11-05', time: null })
      expect(placeTimestamp('2026-11-05T23:30:00Z', TZ)).toMatchObject({ date: '2026-11-06', time: '07:30' })
      expect(placeTimestamp('sometime', TZ)).toBeNull()
      expect(placeTimestamp(undefined, TZ)).toBeNull()
      const { markdown } = buildBrief({ now: NOW, timezone: TZ, recent, patterns: null, het: null })
      expect(markdown).toContain('- [ ] 时间未知，无法判断是否属于今天：`notes.md`：“时间格式无法解析” ⟨ent-4⟩')
      expect(markdown).toContain('--:-- · `notes.md`：“只有日期的记录”')
    })

    it('unknown zone throws (IPC/renderer must validate)', () => {
      expect(() => localDateIn(NOW, 'Mars/Olympus')).toThrow(RangeError)
    })

    it('DST: America/New_York fall-back day still buckets correctly', () => {
      // 2026-11-01 is the US fall-back day; 04:30Z = 00:30 EDT, 05:30Z = 01:30 EDT, 06:30Z = 01:30 EST
      for (const iso of ['2026-11-01T04:30:00Z', '2026-11-01T06:30:00Z', '2026-11-02T04:59:00Z']) {
        expect(localDateIn(Date.parse(iso), 'America/New_York')).toBe('2026-11-01')
      }
      expect(localDateIn(Date.parse('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02')
    })
  })

  it('helpers', () => {
    expect(quoteLine('\n\n## 标题\n正文')).toBe('标题')
    expect(quoteLine('- [ ] 待办 一')).toBe('待办 一')
    expect(quoteLine('x'.repeat(300)).length).toBe(160)
    // S2-08: only the three explicit markers; FIXME / next step / prose “todo” are not markers.
    expect(
      extractTodoLines({ id: 'i', path: 'p', content: 'next step: ship\nFIXME: bug\n普通行\ntodo: lower\nTODO：全角冒号\n* [ ] 星号框\n待办: 半角' }).map((t) => t.quote)
    ).toEqual(['全角冒号', '星号框', '半角'])
  })
})
