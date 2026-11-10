import { describe, expect, it } from 'vitest'
import type { CliOutcome, ImportRun } from '../../src/main/import/api'
import {
  autoBuildNotice,
  BUILD_AFTER_IMPORT_DEFAULT,
  buildAfterImportWarning,
  cancelBuildAfter,
  cliView,
  commitThenMaybeBuild,
  confirmBuildAfter,
  toggleBuildAfter,
  type ImportCommitApi
} from '../../src/renderer/src/pages/importView'
import { setLocale } from '../../src/shared/i18n'

const cli = (exitCode: number, stderr = ''): CliOutcome => ({
  args: ['import-data', '--source', 'folder', '--path', '<staging>', '--build'],
  exitCode,
  signal: null,
  stdout: '',
  stderr,
  counts: null,
  durationMs: 1000
})

const run = (status: ImportRun['status'], extra: Partial<ImportRun> = {}): ImportRun => ({
  runId: 'imp-20261105T090000-abcdef',
  createdAt: '2026-11-05T09:00:00.000Z',
  status,
  documents: [{ key: 'claude-code:x', source: 'claude-code', file: 'claude-code/x.md', bytes: 10, messages: 2, redactions: 0, droppedBlocks: 0 }],
  skippedAlreadyImported: [],
  totals: { documents: 1, messages: 2, bytes: 10, redactions: 0, droppedBlocks: 0 },
  importCli: null,
  buildCli: null,
  ...extra
})

function fakeApi(commitStatus: ImportRun['status'], build: 'ok' | 'fail' | 'throw' = 'ok') {
  const calls: string[] = []
  const api: ImportCommitApi = {
    async commit(id) {
      calls.push(`commit:${id}`)
      return run(commitStatus, { importCli: cli(commitStatus === 'imported' ? 0 : 2) })
    },
    async build(id, confirm) {
      calls.push(`build:${id}:${confirm}`)
      if (build === 'throw') throw new Error('没有找到 persome 命令行工具')
      return run(build === 'ok' ? 'built' : 'build_failed', { buildCli: cli(build === 'ok' ? 0 : 1, 'LLM provider error: rate limited') })
    }
  }
  return { api, calls }
}

describe('S2-10 导入后构建 toggle state', () => {
  it('defaults OFF', () => {
    expect(BUILD_AFTER_IMPORT_DEFAULT).toEqual({ enabled: false, confirming: false })
  })

  it('turning ON needs a second confirmation; cancel keeps it OFF; OFF is immediate', () => {
    const asked = toggleBuildAfter(BUILD_AFTER_IMPORT_DEFAULT, true)
    expect(asked).toEqual({ enabled: false, confirming: true })
    expect(cancelBuildAfter()).toEqual({ enabled: false, confirming: false })
    const on = confirmBuildAfter(asked)
    expect(on).toEqual({ enabled: true, confirming: false })
    expect(toggleBuildAfter(on, true)).toBe(on)
    expect(toggleBuildAfter(on, false)).toEqual({ enabled: false, confirming: false })
    // Confirm without a pending question does nothing.
    expect(confirmBuildAfter(BUILD_AFTER_IMPORT_DEFAULT)).toEqual(BUILD_AFTER_IMPORT_DEFAULT)
  })

  it('the warning mentions the Runtime LLM and cost', () => {
    expect(buildAfterImportWarning()).toMatch(/LLM/)
    expect(buildAfterImportWarning()).toMatch(/cost money/)
    // S1-R4-06 (X5): names the Runtime LLM budget and says failures show exit code + stderr.
    expect(buildAfterImportWarning()).toMatch(/budget.*agent_funding/)
    expect(buildAfterImportWarning()).toMatch(/exit code and error output/)
    setLocale('zh')
    try {
      expect(buildAfterImportWarning()).toMatch(/费用/)
      expect(buildAfterImportWarning()).toMatch(/预算.*agent_funding/)
      expect(buildAfterImportWarning()).toMatch(/退出码和错误输出/)
    } finally {
      setLocale('en')
    }
  })

  it('S1-R4-06: the toggle is not persisted — every fresh state starts OFF even after it was ON', () => {
    const on = confirmBuildAfter(toggleBuildAfter(BUILD_AFTER_IMPORT_DEFAULT, true))
    expect(on.enabled).toBe(true)
    // The default object is never mutated by toggling.
    expect(BUILD_AFTER_IMPORT_DEFAULT).toEqual({ enabled: false, confirming: false })
  })
})

describe('S2-10 commitThenMaybeBuild', () => {
  const ON = { enabled: true, confirming: false }

  it('default (OFF): commit only, never builds', async () => {
    const { api, calls } = fakeApi('imported')
    const o = await commitThenMaybeBuild(api, 'imp-20261105T090000-abcdef', BUILD_AFTER_IMPORT_DEFAULT)
    expect(calls).toEqual(['commit:imp-20261105T090000-abcdef'])
    expect(o).toMatchObject({ buildAttempted: false, buildError: null, run: { status: 'imported' } })
    expect(autoBuildNotice(o)).toBeNull()
  })

  it('pending confirmation (not yet confirmed) does not build', async () => {
    const { api, calls } = fakeApi('imported')
    await commitThenMaybeBuild(api, 'imp-20261105T090000-abcdef', { enabled: false, confirming: true })
    expect(calls).toHaveLength(1)
  })

  it('ON: builds with confirm=true only after a successful commit', async () => {
    const { api, calls } = fakeApi('imported')
    const o = await commitThenMaybeBuild(api, 'imp-20261105T090000-abcdef', ON)
    expect(calls).toEqual(['commit:imp-20261105T090000-abcdef', 'build:imp-20261105T090000-abcdef:true'])
    expect(o.run.status).toBe('built')
    expect(autoBuildNotice(o)).toMatch(/model build ran/)
  })

  it('ON but commit failed: no build', async () => {
    const { api, calls } = fakeApi('import_failed')
    const o = await commitThenMaybeBuild(api, 'imp-20261105T090000-abcdef', ON)
    expect(calls).toHaveLength(1)
    expect(o.run.status).toBe('import_failed')
    expect(o.buildAttempted).toBe(false)
  })

  it('ON and commit throws: the error propagates and no build runs', async () => {
    const calls: string[] = []
    const api: ImportCommitApi = {
      commit: async () => {
        calls.push('commit')
        throw new Error('另一个导入操作正在进行')
      },
      build: async () => {
        calls.push('build')
        return run('built')
      }
    }
    await expect(commitThenMaybeBuild(api, 'imp-20261105T090000-abcdef', ON)).rejects.toThrow(/正在进行/)
    expect(calls).toEqual(['commit'])
  })

  it('build exit ≠ 0 is surfaced with exit code + stderr', async () => {
    const { api } = fakeApi('imported', 'fail')
    const o = await commitThenMaybeBuild(api, 'imp-20261105T090000-abcdef', ON)
    expect(o.run.status).toBe('build_failed')
    expect(autoBuildNotice(o)).toMatch(/automatic build failed/)
    const v = cliView('build', o.run.buildCli!, 1)
    expect(v.ok).toBe(false)
    expect(v.lines.join('\n')).toContain('Exit code: 1')
    expect(o.run.buildCli!.stderr).toContain('rate limited')
  })

  it('build call throwing keeps the imported run and reports the error', async () => {
    const { api } = fakeApi('imported', 'throw')
    const o = await commitThenMaybeBuild(api, 'imp-20261105T090000-abcdef', ON)
    expect(o.run.status).toBe('imported')
    expect(o.buildError).toMatch(/persome/)
    expect(autoBuildNotice(o)).toMatch(/automatic build did not start/)
  })
})
