import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExecFn } from '../../src/main/import/cli'
import { fileStem, renderSession } from '../../src/main/import/markdown'
import { createImportService } from '../../src/main/import/service'
import { loadSession, scanTranscripts } from '../../src/main/import/transcripts'
import { CLAUDE_KEY, CODEX_KEY, FIXTURE_HOME, listAll, tempDir } from './helpers'

/** S1-R3-06: tool call summary toggle, stable source key, continuation (no duplicate) re-import. */

const CLAUDE_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const CLAUDE_REL = '.claude/projects/-work-secret-app/aaaaaaaa-1111-4111-8111-111111111111.jsonl'

function copyHome(): string {
  const home = tempDir('home')
  cpSync(FIXTURE_HOME, home, { recursive: true })
  return home
}

function claudeLine(ts: string, type: 'user' | 'assistant', content: unknown): string {
  return (
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/work/secret-app',
      sessionId: CLAUDE_ID,
      version: '2.0.0',
      type,
      uuid: `${type}-${ts}`,
      timestamp: ts,
      message: { role: type, content }
    }) + '\n'
  )
}

function setup(home: string) {
  const storeRoot = tempDir('store')
  const runtimeRoot = tempDir('runtime')
  const calls: Array<{ args: string[]; files: string[]; contents: Record<string, string> }> = []
  const exec: ExecFn = async (_file, args) => {
    const p = args[args.indexOf('--path') + 1]
    const files = listAll(p).filter((f) => f.endsWith('.md'))
    const contents: Record<string, string> = {}
    for (const f of files) contents[f] = readFileSync(join(p, f), 'utf8')
    calls.push({ args, files, contents })
    return { code: 0, signal: null, stdout: `✓ Imported ${files.length} new/changed document(s); 0 unchanged, 0 skipped.\n`, stderr: '' }
  }
  const svc = createImportService({ storeRoot, runtimeRoot: () => runtimeRoot, homeDir: () => home, persomeBin: () => '/opt/fake/persome', exec })
  return { svc, calls, storeRoot }
}

describe('tool call summary toggle (C20: default on)', () => {
  it('off: no tool name / command / path; on: name + command first line + paths, never tool output', async () => {
    const r = await scanTranscripts(FIXTURE_HOME)
    const claude = (await loadSession(CLAUDE_KEY, r.sessions.find((s) => s.key === CLAUDE_KEY)!.files))!
    const codex = (await loadSession(CODEX_KEY, r.sessions.find((s) => s.key === CODEX_KEY)!.files))!

    const off =
      renderSession(claude, FIXTURE_HOME, { includeTools: false }).documents[0].content +
      renderSession(codex, FIXTURE_HOME, { includeTools: false }).documents[0].content
    expect(off).not.toMatch(/工具：/)
    expect(off).not.toContain('cat README.md')
    expect(off).toContain('- 工具调用摘要：未包含')

    const on =
      renderSession(claude, FIXTURE_HOME, { includeTools: true }).documents[0].content +
      renderSession(codex, FIXTURE_HOME, { includeTools: true }).documents[0].content
    expect(on).toContain('- 工具：Bash · 命令：`env`')
    expect(on).toContain('- 工具：shell · 命令：`cat README.md`')
    expect(on).toContain('- 工具调用摘要：已包含')
    // Tool OUTPUT never appears (fixture markers live only in tool_result / function_call_output).
    for (const marker of ['TOOL_RESULT_MARKER', 'FUNCTION_OUTPUT_MARKER', 'REASONING_MARKER', 'PRIVATE THOUGHT', 'OPENAI_API_KEY']) {
      expect(on).not.toContain(marker)
    }
  })

  it('on: commands are redacted, first line only, and paths are home-relative', () => {
    const home = '/Users/alice'
    const session = {
      key: 'claude-code:x',
      source: 'claude-code' as const,
      sessionId: 'x',
      project: null,
      title: null,
      files: [],
      startTs: 1,
      endTs: 2,
      messages: [
        {
          role: 'assistant' as const,
          ts: 1,
          text: '',
          tools: ['Bash', 'Write'],
          toolCalls: [
            { name: 'Bash', command: 'curl -H "Authorization: Bearer sk-ant-api03-ABCDEFGHIJKLMNOP" https://x.test\ncat <<EOF\nPRIVATE BODY\nEOF', paths: [] },
            { name: 'Write', command: null, paths: ['/Users/alice/work/app/src/a.ts'] }
          ]
        }
      ]
    }
    const md = renderSession(session, home, { includeTools: true }).documents[0].content
    expect(md).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOP')
    expect(md).not.toContain('PRIVATE BODY')
    expect(md).toContain('- 工具：Write · 路径：~/work/app/src/a.ts')
    expect(md).toContain('…')
  })

  it('prepare passes the toggle through and records it on the run', async () => {
    const { svc } = setup(FIXTURE_HOME)
    await svc.scan()
    const dflt = await svc.prepare([CODEX_KEY])
    expect(dflt.includeTools).toBe(true)
    await svc.discard(dflt.runId)
    const off = await svc.prepare([CODEX_KEY], { includeTools: false })
    expect(off.includeTools).toBe(false)
    const offMd = readFileSync(join(svc.paths.stagingDir(off.runId), off.documents[0].file), 'utf8')
    expect(offMd).not.toContain('cat README.md')
    await svc.discard(off.runId)
    const on = await svc.prepare([CODEX_KEY], { includeTools: true })
    expect(on.includeTools).toBe(true)
    expect(readFileSync(join(svc.paths.stagingDir(on.runId), on.documents[0].file), 'utf8')).toContain('命令：`cat README.md`')
  })
})

describe('stable source key + continuation re-import', () => {
  it('every CLI call uses the same --path; the folder is emptied after each call', async () => {
    const { svc, calls } = setup(FIXTURE_HOME)
    await svc.scan()
    await svc.commit((await svc.prepare([CLAUDE_KEY])).runId)
    await svc.commit((await svc.prepare([CODEX_KEY])).runId)
    expect(calls.map((c) => c.args[c.args.indexOf('--path') + 1])).toEqual([svc.paths.sourceDir, svc.paths.sourceDir])
    expect(calls[0].files).toEqual([`claude-code/${fileStem(CLAUDE_ID)}.md`])
    // only the current run's files are present for each call
    expect(calls[1].files).toEqual([`codex/${fileStem('bbbbbbbb-2222-4222-8222-222222222222')}.md`])
    expect(existsSync(svc.paths.sourceDir)).toBe(false)
  })

  it('a grown session stages only the new messages under a new relative name; nothing is imported twice', async () => {
    const home = copyHome()
    const { svc, calls } = setup(home)
    await svc.scan()
    await svc.commit((await svc.prepare([CLAUDE_KEY])).runId)
    const first = calls[0].contents[`claude-code/${fileStem(CLAUDE_ID)}.md`]
    expect(first).toContain('Please fix login')

    appendFileSync(join(home, CLAUDE_REL), claudeLine('2025-10-01T09:05:00.000Z', 'user', 'NEW QUESTION about the session timeout'))
    appendFileSync(join(home, CLAUDE_REL), claudeLine('2025-10-01T09:05:10.000Z', 'assistant', [{ type: 'text', text: 'NEW ANSWER: raise it to 30 minutes' }]))

    const scan = await svc.scan()
    expect(scan.sessions.find((s) => s.key === CLAUDE_KEY)?.importState).toBe('changed')
    const run = await svc.prepare([CLAUDE_KEY])
    expect(run.documents).toHaveLength(1)
    expect(run.documents[0].file).toMatch(new RegExp(`^claude-code/${fileStem(CLAUDE_ID)}\\.from-\\d+\\.md$`))
    expect(run.notes?.map((n) => n.kind)).toEqual(['continued'])
    const delta = readFileSync(join(svc.paths.stagingDir(run.runId), run.documents[0].file), 'utf8')
    expect(delta).toContain('NEW QUESTION')
    expect(delta).toContain('NEW ANSWER')
    expect(delta).not.toContain('Please fix login')
    expect(delta).toMatch(/本文档：第 \d+–\d+ 条消息（续/)
    await svc.commit(run.runId)
    expect(calls[1].files).toEqual([run.documents[0].file])

    // Every message text reached the CLI exactly once across both runs.
    const all = calls.flatMap((c) => Object.values(c.contents)).join('\n')
    for (const t of ['Please fix login', 'NEW QUESTION', 'NEW ANSWER']) expect(all.split(t).length - 1).toBe(1)

    // Nothing new → skipped, no CLI call.
    expect((await svc.scan()).sessions.find((s) => s.key === CLAUDE_KEY)?.importState).toBe('imported')
    const again = await svc.prepare([CLAUDE_KEY])
    expect(again.documents).toEqual([])
    expect(again.skippedAlreadyImported).toEqual([CLAUDE_KEY])
  })

  it('a rewritten imported prefix is re-imported in full under the same key and reported', async () => {
    const home = copyHome()
    const { svc } = setup(home)
    await svc.scan()
    await svc.commit((await svc.prepare([CLAUDE_KEY])).runId)
    const p = join(home, CLAUDE_REL)
    writeFileSync(p, readFileSync(p, 'utf8').replace('Looking at the auth module.', 'Looking at the session module.'))
    await svc.scan()
    const run = await svc.prepare([CLAUDE_KEY])
    expect(run.documents.map((d) => d.file)).toEqual([`claude-code/${fileStem(CLAUDE_ID)}.md`])
    expect(run.notes?.[0].kind).toBe('rewritten')
  })

  it('a pre-S1-R3-06 ledger entry (no prefix hash) still skips identical content', async () => {
    const { svc } = setup(FIXTURE_HOME)
    await svc.scan()
    await svc.commit((await svc.prepare([CODEX_KEY])).runId)
    const ledger = JSON.parse(readFileSync(svc.paths.ledgerPath, 'utf8'))
    for (const e of Object.values(ledger.entries) as Array<Record<string, unknown>>) {
      delete e.imported
      delete e.prefixSha
      delete e.lastSha
    }
    writeFileSync(svc.paths.ledgerPath, JSON.stringify(ledger))
    const again = await svc.prepare([CODEX_KEY])
    expect(again.skippedAlreadyImported).toEqual([CODEX_KEY])
  })
})
