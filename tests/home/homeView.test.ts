// OG-01 Home dashboard: pure view-model tests + static wiring checks. No IPC, no real
// ~/.persome / ~/.claude / ~/.codex / Lens Store: every input is an in-memory fixture.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import type { AccessLogDay, ConnectionsOverview } from '../../src/main/broker/api'
import type { HetSummary } from '../../src/main/het/api'
import { buildBrief } from '../../src/main/library/brief'
import type { PeerList, PeerSummary } from '../../src/main/peers/api'
import type { WorkflowCatalog } from '../../src/main/workflows/api'
import type { ModelSnapshot, Point, RecentActivityResponse } from '../../src/shared/types'
import {
  accessSummary,
  actionItems,
  connectionsSummary,
  heatLevel,
  heatmapView,
  hetCardView,
  peersSummary,
  RECENT_LIMIT,
  recentItems,
  recentPoints,
  skillsSummary
} from '../../src/renderer/src/components/home/homeView'

const TZ = 'Asia/Shanghai'
// 2026-11-05 10:00 Shanghai
const NOW = Date.parse('2026-11-05T02:00:00Z')
const TODAY = '2026-11-05'

function het(partial: Partial<HetSummary>): HetSummary {
  return {
    days: [],
    total_minutes: 0,
    total_minutes_tenths: 0,
    pending: 0,
    failed: 0,
    unsettled: 0,
    state: 'ready',
    timezone: TZ,
    ...partial
  }
}

describe('HET card', () => {
  it('says 未测量 (no minutes) when nothing has been assessed', () => {
    const v = hetCardView(het({ state: 'notStarted' }), TODAY)
    expect(v.kind).toBe('unmeasured')
    expect(v).not.toHaveProperty('todayTenths')
    expect(v).not.toHaveProperty('windowTenths')
  })

  it('explains pending / failed instead of showing 0 minutes', () => {
    const pending = hetCardView(
      het({ state: 'manyPending', pending: 3, days: [{ date: TODAY, minutes: 0, minutes_tenths: 0, tasks: 0, pending: 3 }] }),
      TODAY
    )
    expect(pending).toMatchObject({ kind: 'unmeasured', reason: '3 tasks awaiting assessment', pending: 3 })
    const failed = hetCardView(het({ state: 'manyFailed', failed: 2 }), TODAY)
    expect(failed).toMatchObject({ kind: 'unmeasured', reason: '2 task assessments failed' })
    setLocale('zh')
    try {
      expect(hetCardView(het({ state: 'manyFailed', failed: 2 }), TODAY)).toMatchObject({ reason: '2 个任务评估失败' })
    } finally {
      setLocale('en')
    }
  })

  it('shows measured minutes only from counted tasks; today without tasks stays null', () => {
    const s = het({
      days: [
        { date: '2026-11-04', minutes: 12, minutes_tenths: 125, tasks: 2, pending: 0 },
        { date: TODAY, minutes: 0, minutes_tenths: 0, tasks: 0, pending: 1 }
      ],
      total_minutes: 12,
      total_minutes_tenths: 125,
      pending: 1
    })
    const v = hetCardView(s, TODAY)
    expect(v).toMatchObject({ kind: 'measured', todayTenths: null, windowTenths: 125, windowTasks: 2, pending: 1 })
  })

  it('reports today minutes when today has counted tasks', () => {
    const v = hetCardView(
      het({ days: [{ date: TODAY, minutes: 30, minutes_tenths: 304, tasks: 1, pending: 0 }], total_minutes_tenths: 304 }),
      TODAY
    )
    expect(v).toMatchObject({ kind: 'measured', todayTenths: 304, todayTasks: 1 })
  })
})

const recent: RecentActivityResponse = {
  count: 6,
  entries: [
    { id: 'a', path: 'p.md', timestamp: '2026-11-05T09:30:00+08:00', content: '- [ ] 写 OG-01 测试\n其他' },
    { id: 'b', path: 'p.md', timestamp: '2026-11-05T01:15:00Z', content: '上海 09:15 的记录' },
    { id: 'c', path: 'd.md', timestamp: '2026-11-03T22:00', content: '本地墙钟时间' },
    { id: 'd', path: 'd.md', timestamp: '2026-11-04', content: '只有日期' },
    { id: 'e', path: 'd.md', timestamp: '2026-10-01T10:00:00Z', content: '太早' },
    { id: 'f', path: 'd.md', timestamp: 'sometime', content: '时间无法解析' }
  ]
}

describe('Heatmap', () => {
  it('places timestamps on a 7×24 local grid and accounts for every entry', () => {
    const h = heatmapView(recent, NOW, TZ, 7)
    expect(h.rows.map((r) => r.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', TODAY])
    const today = h.rows[6]
    expect(today.hours[9]).toBe(2)
    expect(today.total).toBe(2)
    expect(h.rows[4].hours[22]).toBe(1)
    expect(h).toMatchObject({ placed: 3, dateOnly: 1, outside: 1, undated: 1, sampled: 6, truncated: false, max: 2 })
    expect(h.placed + h.dateOnly + h.outside + h.undated).toBe(h.sampled)
  })

  it('is empty (not fabricated) when there are no entries', () => {
    const h = heatmapView({ count: 0, entries: [] }, NOW, TZ)
    expect(h.placed).toBe(0)
    expect(h.max).toBe(0)
    expect(h.rows.every((r) => r.hours.every((n) => n === 0))).toBe(true)
  })

  it('flags truncation when the Runtime returned the full limit', () => {
    const entries = Array.from({ length: RECENT_LIMIT }, (_, i) => ({ id: `x${i}`, path: 'p.md', timestamp: '2026-11-05T08:00:00+08:00', content: 'x' }))
    expect(heatmapView({ count: RECENT_LIMIT, entries }, NOW, TZ).truncated).toBe(true)
  })

  it('heatLevel buckets relative to max', () => {
    expect(heatLevel(0, 10)).toBe(0)
    expect(heatLevel(1, 10)).toBe(1)
    expect(heatLevel(3, 10)).toBe(2)
    expect(heatLevel(6, 10)).toBe(3)
    expect(heatLevel(10, 10)).toBe(4)
    expect(heatLevel(5, 0)).toBe(0)
  })
})

describe('Recent / Actions', () => {
  it('recentItems: newest first, undated last', () => {
    const items = recentItems(recent, TZ, 10)
    expect(items.map((i) => i.entry.id)).toEqual(['a', 'b', 'd', 'c', 'e', 'f'])
    expect(items[0]).toMatchObject({ date: TODAY, time: '09:30' })
    expect(items.at(-1)).toMatchObject({ date: null, time: null })
  })

  it('actionItems = open todo items from the Today brief, never habits', () => {
    const brief = buildBrief({
      now: NOW,
      timezone: TZ,
      recent,
      het: null,
      patterns: { root: null, faces: [{ signature: '每天先写测试', observations: 5, confidence: 0.9 }], skills: [], rendered: '' }
    })
    expect(brief.nextSteps.some((n) => n.kind === 'habit')).toBe(true)
    const actions = actionItems(brief)
    expect(actions.map((a) => a.text)).toEqual(['写 OG-01 测试'])
    expect(actions.every((a) => a.kind === 'todo')).toBe(true)
  })
})

function point(id: string, extra: Partial<Point>): Point {
  return { id, content: id, layer: 'point', status: 'active', is_latest: true, file_name: 'f.md', tags: [], confidence: null, conflicted: false, receipt: `r-${id}`, ...extra }
}

describe('Memories', () => {
  it('recentPoints: latest only, newest first, undated last', () => {
    const model = {
      points: [
        point('old', { occurred_at: '2026-01-01T00:00:00Z' }),
        point('new', { occurred_at: '2026-11-01T00:00:00Z' }),
        point('created', { created_at: '2026-06-01T00:00:00Z' }),
        point('none', {}),
        point('superseded', { occurred_at: '2026-12-01T00:00:00Z', is_latest: false })
      ]
    } as unknown as ModelSnapshot
    expect(recentPoints(model, 10).map((p) => p.point.id)).toEqual(['new', 'created', 'old', 'none'])
    expect(recentPoints(model, 2)).toHaveLength(2)
  })
})

describe('Agents / Connections / Agent reads', () => {
  const overview = {
    broker: { url: 'http://127.0.0.1:8750/mcp', running: true, error: null },
    agents: [
      { id: 'claude-code', name: 'Claude Code', state: 'connected' },
      { id: 'codex', name: 'Codex', state: 'mismatch' },
      { id: 'claude-desktop', name: 'Claude Desktop', state: 'not_installed' },
      { id: 'cursor', name: 'Cursor', state: 'available' }
    ]
  } as unknown as ConnectionsOverview

  it('connectionsSummary counts states and lists attention items', () => {
    const s = connectionsSummary(overview)
    expect(s.counts).toEqual({ connected: 1, available: 1, not_installed: 1, mismatch: 1, partial: 0 })
    expect(s.connected).toEqual(['Claude Code'])
    expect(s.attention).toEqual(['Codex'])
    expect(s.brokerRunning).toBe(true)
  })

  it('accessSummary aggregates reads per client and the recent window', () => {
    const rows: AccessLogDay[] = [
      { day: '2026-10-10', client: 'codex', reads: 4, responseChars: 400 },
      { day: '2026-11-04', client: 'claude-code', reads: 3, responseChars: 900 },
      { day: TODAY, client: 'claude-code', reads: 2, responseChars: 100 }
    ]
    const s = accessSummary(rows, 30, '2026-10-30')
    expect(s).toMatchObject({ reads: 9, responseChars: 1400, recentReads: 5, activeDays: 3, lastDay: TODAY })
    expect(s.byClient).toEqual([
      { client: 'claude-code', reads: 5, responseChars: 1000 },
      { client: 'codex', reads: 4, responseChars: 400 }
    ])
    expect(accessSummary([], 30, '2026-10-30')).toMatchObject({ reads: 0, lastDay: null, byClient: [] })
  })
})

describe('Skills / Peers', () => {
  it('skillsSummary counts Workflows by provenance and keeps Playbook count separate', () => {
    const catalog = {
      workflows: [{ provenance: { kind: 'observed' } }, { provenance: { kind: 'observed' } }, { provenance: { kind: 'shared' } }],
      sources: { runtimeFiles: 'ok', behaviorPatterns: 'runtime offline', store: 1 }
    } as unknown as WorkflowCatalog
    const s = skillsSummary(catalog, 4)
    expect(s).toMatchObject({ workflows: 3, playbooks: 4, byKind: { observed: 2, imported: 0, user_edited: 0, shared: 1 } })
    expect(s.sourceIssues).toEqual(['behavior_patterns: runtime offline'])
    expect(skillsSummary({ workflows: [], sources: { runtimeFiles: 'missing', behaviorPatterns: 'skipped', store: 0 } }, null)).toMatchObject({
      workflows: 0,
      playbooks: null,
      sourceIssues: []
    })
  })

  it('peersSummary counts local friends only', () => {
    const p = (fp: string, name: string | null, at: string, verification: PeerSummary['verification'] = 'valid') =>
      ({ fingerprint: fp, displayName: name, importedAt: at, updatedAt: at, verification }) as PeerSummary
    const list: PeerList = { peers: [p('aaaaaaaaaaaaaaaa', 'Ann', '2026-11-01T00:00:00Z'), p('bbbbbbbbbbbbbbbb', null, '2026-11-03T00:00:00Z', 'old_key')], unreadable: 1 }
    expect(peersSummary(list)).toEqual({ count: 2, oldKey: 1, unreadable: 1, latest: { name: 'bbbbbbbbbbbb', importedAt: '2026-11-03T00:00:00Z' } })
    expect(peersSummary({ peers: [], unreadable: 0 })).toEqual({ count: 0, oldKey: 0, unreadable: 0, latest: null })
  })
})

describe('Home wiring (static)', () => {
  const root = join(__dirname, '..', '..', 'src', 'renderer', 'src')
  const home = readFileSync(join(root, 'pages', 'Home.tsx'), 'utf8')
  const view = readFileSync(join(root, 'components', 'home', 'homeView.ts'), 'utf8')
  const app = readFileSync(join(root, 'App.tsx'), 'utf8')
  const nav = readFileSync(join(root, 'lib', 'nav.ts'), 'utf8')
  const navData = readFileSync(join(root, 'lib', 'navigation.tsx'), 'utf8')

  it('renders every OG Home card with a deep link to its owning page', () => {
    const cards = [...home.matchAll(/id="([a-z-]+)"\s+title=(?:"[^"]+"|\{[^}]+\})\s+target="([a-z]+)"/g)].map((m) => [m[1], m[2]])
    expect(Object.fromEntries(cards)).toEqual({
      today: 'today',
      het: 'het',
      'ai-counts': 'het',
      actions: 'today',
      memories: 'model',
      agents: 'connections',
      connections: 'connections',
      'agent-reads': 'connections',
      skills: 'playbook',
      peers: 'peers',
      recent: 'search',
      heatmap: 'search'
    })
    // "Actions" is not a Performance score.
    expect(home).not.toMatch(/Performance/)
    expect(home).toContain('未测量')
  })

  it('home is the default landing page and Overview stays reachable', () => {
    expect(nav).toMatch(/\|\s*'home'/)
    expect(app).toMatch(/let lastNav: \{ page: Page; params: NavParams \} = \{ page: 'home'/)
    expect(navData).toContain("{ id: 'home'")
    expect(navData).toContain("{ id: 'overview'")
    expect(app).toContain("page === 'overview' ? <Overview />")
    expect(app).toContain("page === 'home' ? <Home />")
  })

  it('makes no network or LLM calls of its own', () => {
    for (const src of [home, view]) {
      expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|https?:\/\/(?!127\.0\.0\.1)|llm\.|anthropic|openai/i)
      expect(src).not.toMatch(/from 'node:|require\(/)
    }
  })
})
