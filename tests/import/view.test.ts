import { describe, expect, it } from 'vitest'
import { formatBytes } from '../../src/renderer/src/lib/format'
import type { CliOutcome, ImportRun, ImportSessionPreview } from '../../src/main/import/api'
import {
  actions,
  cliView,
  filterSessions,
  formatRange,
  runTotalsLine,
  selectionSummary,
  toggleAllVisible,
  toggleKey
} from '../../src/renderer/src/pages/importView'

const s = (key: string, over: Partial<ImportSessionPreview> = {}): ImportSessionPreview => ({
  key,
  source: key.startsWith('codex') ? 'codex' : 'claude-code',
  sessionId: key.split(':')[1],
  project: '~/work/demo',
  title: 'Demo',
  messageCount: 3,
  startTs: null,
  endTs: null,
  files: [],
  importState: 'new',
  ...over
})
const run = (over: Partial<ImportRun> = {}): ImportRun => ({
  runId: 'imp-20251001T000000-abcdef',
  createdAt: '',
  status: 'staged',
  documents: [{ key: 'codex:a', source: 'codex', file: 'codex/a.md', bytes: 2048, messages: 2, redactions: 1, droppedBlocks: 0 }],
  skippedAlreadyImported: [],
  totals: { documents: 1, messages: 2, bytes: 2048, redactions: 1, droppedBlocks: 0 },
  importCli: null,
  buildCli: null,
  ...over
})
const outcome = (over: Partial<CliOutcome> = {}): CliOutcome => ({
  args: ['import-data', '--source', 'folder', '--path', '<staging>', '--no-build'],
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  counts: { imported: 1, unchanged: 0, skipped: 0 },
  durationMs: 1500,
  ...over
})

describe('import view-model', () => {
  const list = [s('codex:a'), s('claude-code:b', { title: 'Login', importState: 'imported' }), s('claude-code:c', { project: '~/x' })]

  it('filters by source, query and imported state', () => {
    expect(filterSessions(list, { source: 'codex', query: '', hideImported: false }).map((x) => x.key)).toEqual(['codex:a'])
    expect(filterSessions(list, { source: 'all', query: 'login', hideImported: false }).map((x) => x.key)).toEqual(['claude-code:b'])
    expect(filterSessions(list, { source: 'all', query: '', hideImported: true }).map((x) => x.key)).toEqual(['codex:a', 'claude-code:c'])
  })

  it('selection toggles; select-all skips already imported rows', () => {
    expect([...toggleKey(new Set(['a']), 'a')]).toEqual([])
    const all = toggleAllVisible(new Set(), list)
    expect([...all].sort()).toEqual(['claude-code:c', 'codex:a'])
    expect([...toggleAllVisible(all, list)]).toEqual([])
    expect(selectionSummary(list, all)).toBe('2 sessions selected, 6 messages')
    expect(selectionSummary(list, new Set())).toBe('No sessions selected')
  })

  it('step gating: prepare → commit (needs CLI) → build', () => {
    expect(actions(0, null, true, false).canPrepare).toBe(false)
    expect(actions(1, null, true, false).canPrepare).toBe(true)
    expect(actions(1, run(), true, false)).toMatchObject({ canCommit: true, canBuild: false, canDiscard: true })
    expect(actions(1, run(), false, false)).toMatchObject({ canCommit: false, commitHint: expect.stringContaining('only a dry run') })
    expect(actions(1, run({ documents: [] }), true, false)).toMatchObject({ canCommit: false, commitHint: expect.stringContaining('imported before') })
    expect(actions(1, run({ status: 'imported' }), true, false)).toMatchObject({ canCommit: false, canBuild: true, canDiscard: false })
    expect(actions(1, run({ status: 'import_failed' }), true, false).canCommit).toBe(true)
    expect(actions(1, run(), true, true).canCommit).toBe(false)
  })

  it('cliView reports real exit codes and receipt mismatches', () => {
    expect(cliView('import', outcome(), 1)).toMatchObject({ ok: true, title: 'Import succeeded' })
    const fail = cliView('import', outcome({ exitCode: 2, counts: null }), 1)
    expect(fail.ok).toBe(false)
    expect(fail.lines.join('\n')).toContain('Exit code: 2')
    const short = cliView('import', outcome({ counts: { imported: 0, unchanged: 0, skipped: 1 } }), 1)
    expect(short.lines.join('\n')).toContain('Runtime accepted only 0')
    expect(cliView('import', outcome({ counts: null }), 1).lines.join('\n')).toContain('the exit code is authoritative')
    expect(cliView('build', outcome({ exitCode: null, signal: 'SIGTERM' }), 1)).toMatchObject({ ok: false, title: 'Model build failed' })
  })

  it('formatting helpers', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatRange(null, null)).toBe('—')
    const t = new Date(2025, 9, 1, 9, 0).getTime()
    expect(formatRange(t, t + 3600_000)).toBe('2025-10-01 09:00 – 10:00')
    expect(runTotalsLine(run({ skippedAlreadyImported: ['x'] }))).toContain('1 unchanged sessions skipped')
  })
})

import { INCLUDE_TOOLS_DEFAULT, noteLines } from '../../src/renderer/src/pages/importView'

describe('S1-R3-06 import view', () => {
  it('tool summary is on by default (C20); notes render one line each', () => {
    expect(INCLUDE_TOOLS_DEFAULT).toBe(true)
    const base = { runId: 'imp-20250101T000000-abcdef', createdAt: '', status: 'staged' as const, documents: [], skippedAlreadyImported: [], totals: { documents: 0, messages: 0, bytes: 0, redactions: 0, droppedBlocks: 0 }, importCli: null, buildCli: null }
    expect(noteLines(base)).toEqual([])
    const lines = noteLines({ ...base, includeTools: false, notes: [{ key: 'codex:x', kind: 'continued', detail: '只导入第 3–4 条（前 2 条已导入）' }] })
    expect(lines).toEqual(['Continued import · codex:x: 只导入第 3–4 条（前 2 条已导入）', 'Tool call summary: not included'])
  })
})
