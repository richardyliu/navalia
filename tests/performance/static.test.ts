// S1-FULL C16 static guarantees + view helpers:
// - owner-only: no Broker / Card / letter / skillshare / cloud / HET REST file references 「表现」;
//   the performance module imports none of them and no network API.
// - no completion math: no percent / ratio / ETA computation anywhere in the 「表现」 sources.
// - git only through execFile with shell:false.
// - the view says 「未知 / 未接入」 for unknown, never 0.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COUNT_KINDS, unknownLabel } from '../../src/main/performance/api'
import { setLocale } from '../../src/shared/i18n'
import { countCells, formatCount, groupByDay, matchedByText, parseList, rowFacts, targetText, toInput } from '../../src/renderer/src/pages/performanceView'

const ROOT = path.resolve(__dirname, '../..')

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [abs]
  return fs.readdirSync(abs).flatMap((n) => files(path.join(rel, n)))
}

const PERF_SOURCES = [
  'src/main/performance',
  'src/preload/performance.ts',
  'src/renderer/src/pages/Performance.tsx',
  'src/renderer/src/pages/performanceView.ts',
  'src/renderer/src/components/performance'
]
const perfFiles = (): string[] => PERF_SOURCES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f))
const read = (f: string): string => fs.readFileSync(f, 'utf8')

describe('owner-only', () => {
  it('Broker, Card (identity), letters (peers), skillshare, cloud and HET REST never reference 「表现」', () => {
    const scoped = ['src/main/broker', 'src/main/identity', 'src/main/peers', 'src/main/skillshare', 'src/main/cloud', 'src/main/het/rest.ts', 'src/main/het/weekly.ts', 'src/main/mcp']
      .flatMap(files)
      .filter((f) => /\.(ts|tsx|json)$/.test(f))
    expect(scoped.length).toBeGreaterThan(20)
    const banned = /performance\/|PERFORMANCE_CHANNELS|lens:performance|createPerformanceService|projects\.json|lastWeekSample/
    for (const f of scoped) expect(banned.test(read(f)), path.relative(ROOT, f)).toBe(false)
  })

  it('the performance module imports no Broker / cloud / identity / peers code and no network API', () => {
    const all = perfFiles()
    expect(all.length).toBeGreaterThanOrEqual(12)
    const banned = [
      /from\s+['"][^'"]*\/(broker|cloud|identity|peers|skillshare)\//,
      /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bnet\.request\b|\bsendBeacon\b/,
      /anthropic|openai|het\/assessor/i
    ]
    for (const f of all) for (const re of banned) expect(re.test(read(f)), `${path.relative(ROOT, f)} ~ ${re}`).toBe(false)
  })

  it('the HET count functions stay HET-only (performance does its own read-only queries)', () => {
    for (const f of perfFiles()) expect(/\bhetWeekCounts\b|\bhetFilteredTasks\b/.test(read(f)), path.relative(ROOT, f)).toBe(false)
  })

  it('performance never writes het.db: no write SQL, read-only open only', () => {
    for (const f of files('src/main/performance')) {
      const src = read(f)
      expect(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\s/.test(src.replace(/\/\/.*$/gm, '')), path.relative(ROOT, f)).toBe(false)
      if (/new DatabaseSync\(/.test(src)) expect(src).toMatch(/new DatabaseSync\(file, \{ readOnly: true \}\)/)
    }
  })

  it('git runs only via execFile with shell:false', () => {
    const users = files('src/main/performance').filter((f) => /child_process/.test(read(f)))
    expect(users.map((f) => path.relative(ROOT, f))).toEqual(['src/main/performance/git.ts'])
    const git = read(path.join(ROOT, 'src/main/performance/git.ts'))
    expect(git).toMatch(/shell: false/)
    expect(git).not.toMatch(/\bexec\(|execSync|spawn\(|'push'|'fetch'|'pull'|'clone'|'commit'/)
  })
})

describe('no completion math', () => {
  it('no percent / ratio / ETA computation in the 「表现」 sources', () => {
    const banned = [/\*\s*100\b/, /\/\s*100\b/, /toFixed\(/, /percent/i, /progress/i, /completion/i, /\beta\b/i, /predict/i, /forecast/i, /\bratio\b/i, /\bscore\b/i, /%`|'%'|"%"/]
    for (const f of perfFiles()) {
      const src = read(f)
      for (const re of banned) expect(re.test(src), `${path.relative(ROOT, f)} ~ ${re}`).toBe(false)
    }
  })

  it('milestone done is only written by setMilestoneDone', () => {
    const store = read(path.join(ROOT, 'src/main/performance/store.ts'))
    // saveProject copies the stored value (prev?.done ?? false); setMilestoneDone sets the tick.
    expect(store.match(/\bdone:\s+(?!z\.|boolean)/g)?.length).toBe(1)
    expect(store).toMatch(/\{ \.\.\.x, done, doneAt: done \? t : null \}/)
    expect(store).toMatch(/done: prev\?\.done \?\? false/)
  })
})

describe('view helpers', () => {
  it('unknown is 「未知 / 未接入」, 0 is 0', () => {
    expect(formatCount(null)).toBe('Unknown / not connected')
    expect(formatCount(null)).toBe(unknownLabel())
    expect(formatCount(0)).toBe('0')
    const cells = countCells({ accepted: 2, rejected: 0, not_agent: null, transcript_commit: 1, git_commit: null })
    expect(cells.map((c) => c.kind)).toEqual([...COUNT_KINDS])
    expect(cells.find((c) => c.kind === 'git_commit')).toMatchObject({ value: unknownLabel(), known: false })
    expect(cells.find((c) => c.kind === 'rejected')).toMatchObject({ value: '0', known: true })
    for (const c of cells) expect(c.definition.length).toBeGreaterThan(10)
  })

  it('row facts list the evidence; parse / group / labels', () => {
    const row = {
      kind: 'transcript_commit' as const,
      id: 'ev1',
      at: '2026-11-03T00:00:00.000Z',
      day: '2026-11-03',
      atSource: 'event_time' as const,
      agent: 'claude-code',
      taskId: 't1',
      sessionIds: ['s1'],
      project: '/w',
      evidence: { file: '~/a.jsonl', line: 4 },
      commit: { hash: null, hashSource: null, repo: null, subject: null }
    }
    const facts = rowFacts(row)
    expect(Object.fromEntries(facts)).toMatchObject({ Sessions: 's1', 'Session log': '~/a.jsonl:4', 'Commit hash': 'No hash shown in the session' })
    expect(parseList('a, b\nb，c\n\n')).toEqual(['a', 'b', 'c'])
    expect(groupByDay([{ day: '2026-11-01' }, { day: '2026-11-03' }, { day: '2026-11-01' }] as never).map((g) => [g.day, g.items.length])).toEqual([
      ['2026-11-03', 1],
      ['2026-11-01', 2]
    ])
    expect(matchedByText('keyword:x')).toBe('Keyword "x"')
    expect(targetText(null)).toBe('No target date')
    setLocale('zh')
    try {
      expect(Object.fromEntries(rowFacts(row))).toMatchObject({ 会话: 's1', 会话记录: '~/a.jsonl:4', 提交哈希: '会话里没有显示哈希' })
      expect(matchedByText('keyword:x')).toBe('关键词「x」')
      expect(targetText(null)).toBe('没有目标日期')
      expect(formatCount(null)).toBe('未知 / 未接入')
    } finally {
      setLocale('en')
    }
    const inp = toInput({
      id: 'abcd1234',
      title: 't',
      goal: '',
      milestones: [{ id: 'm1m1', title: 'a', targetDate: null, note: '', done: true, doneAt: 'x' }],
      match: { keywords: [], paths: [], repoIds: [] },
      createdAt: '',
      updatedAt: ''
    })
    expect(Object.keys(inp.milestones[0]).sort()).toEqual(['id', 'note', 'targetDate', 'title'])
  })
})
