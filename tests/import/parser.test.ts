import { beforeAll, describe, expect, it } from 'vitest'
import {
  displayPath,
  loadSession,
  mergeAssistantRuns,
  scanTranscripts,
  type ScanOutput,
  type TranscriptSession
} from '../../src/main/import/transcripts'
import { fileStem, renderSession, MAX_DOC_BYTES } from '../../src/main/import/markdown'
import { CLAUDE_KEY, CODEX_KEY, FIXTURE_HOME, listAll } from './helpers'

describe('import transcript parser (fixtures)', () => {
  let r: ScanOutput
  let claude: TranscriptSession
  let codex: TranscriptSession
  beforeAll(async () => {
    r = await scanTranscripts(FIXTURE_HOME)
    claude = (await loadSession(CLAUDE_KEY, r.sessions.find((s) => s.key === CLAUDE_KEY)!.files))!
    codex = (await loadSession(CODEX_KEY, r.sessions.find((s) => s.key === CODEX_KEY)!.files))!
  })

  it('discovers one Claude Code and one Codex session, roots present, summary only', () => {
    expect(r.sessions.map((s) => s.key).sort()).toEqual([CLAUDE_KEY, CODEX_KEY].sort())
    expect(r.roots).toEqual({ claudeCode: true, codex: true })
    expect(r.capped).toBeNull()
    const c = r.sessions.find((s) => s.key === CLAUDE_KEY)!
    expect([c.title, c.project, c.messageCount, c.startTs, c.endTs]).toEqual([
      'Fix login flow',
      '/work/secret-app',
      5,
      Date.parse('2025-10-01T09:00:00.000Z'),
      Date.parse('2025-10-01T09:02:00.000Z')
    ])
    expect(r.sessions.find((s) => s.key === CODEX_KEY)!.messageCount).toBe(2)
    // scan retains no message text (only counts / ts / title / file refs)
    const json = JSON.stringify(r)
    for (const text of ['Please fix login', 'Looking at the auth module', 'Add a README section', 'Added a Setup section']) {
      expect(json).not.toContain(text)
    }
  })

  it('Claude Code: title, project, time range, main-thread human/assistant messages only', () => {
    expect(claude.title).toBe('Fix login flow')
    expect(claude.project).toBe('/work/secret-app')
    expect(claude.startTs).toBe(Date.parse('2025-10-01T09:00:00.000Z'))
    expect(claude.endTs).toBe(Date.parse('2025-10-01T09:02:00.000Z'))
    // user, assistant(text+Bash merged), user(.env), assistant, user — meta + tool_result dropped
    expect(claude.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(claude.messages[1].tools).toEqual(['Bash'])
    // the subagent file is not listed as a session file
    expect(claude.files.every((f) => !f.includes('subagents'))).toBe(true)
    const all = claude.messages.map((m) => m.text).join('\n')
    expect(all).not.toContain('SIDECHAIN_MARKER')
    expect(all).not.toContain('PRIVATE THOUGHT')
    expect(all).not.toContain('TOOL_RESULT_MARKER')
    expect(all).not.toContain('injected context')
  })

  it('Codex: session_meta id/cwd, harness context + reasoning + tool output dropped', () => {
    expect(codex.project).toBe('/work/codex-proj')
    expect(codex.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Add a README section about setup.'],
      ['assistant', 'Added a Setup section.']
    ])
    expect(codex.messages[1].tools).toEqual(['shell'])
    const all = JSON.stringify(codex.messages)
    expect(all).not.toContain('REASONING_MARKER')
    expect(all).not.toContain('FUNCTION_OUTPUT_MARKER')
    expect(all).not.toContain('environment_context')
  })

  it('loadSession returns null for a key not present in the given files', async () => {
    expect(await loadSession('claude-code:nope', codex.files)).toBeNull()
  })

  it('missing home → no sessions, roots false', async () => {
    const none = await scanTranscripts('/nonexistent-lens-import-home')
    expect(none.sessions).toEqual([])
    expect(none.roots).toEqual({ claudeCode: false, codex: false })
  })

  it('reading does not modify the fixture tree', async () => {
    const before = listAll(FIXTURE_HOME)
    await scanTranscripts(FIXTURE_HOME)
    expect(listAll(FIXTURE_HOME)).toEqual(before)
  })

  it('renders Markdown with header, role sections and no secrets', () => {
    const doc = renderSession(claude, FIXTURE_HOME, { includeTools: false })
    expect(doc.documents).toHaveLength(1)
    expect(doc.documents[0].file).toBe(`claude-code/${fileStem('aaaaaaaa-1111-4111-8111-111111111111')}.md`)
    const md = doc.documents[0].content
    // C20: YAML front matter (dedupe key) precedes the heading.
    expect(md).toMatch(/^---\nlens_import: 1\n[\s\S]*?\n---\n# Claude Code 会话：Fix login flow/)
    expect(md).toContain('- 项目：/work/secret-app')
    expect(md).toContain('## 用户 · 2025-10-01T09:00:00.000Z')
    expect(md).not.toContain('工具：Bash')
    expect(md).toContain('- 工具调用摘要：未包含')
    expect(doc.redactions).toBeGreaterThanOrEqual(8)
  })

  it('splits oversized sessions into parts below the Runtime 2 MiB limit', () => {
    const big = 'x '.repeat(200_000)
    const s = { ...codex, messages: Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, ts: i, text: big, tools: [] })) }
    const doc = renderSession(s, FIXTURE_HOME)
    expect(doc.documents.length).toBeGreaterThan(1)
    for (const d of doc.documents) expect(Buffer.byteLength(d.content)).toBeLessThanOrEqual(MAX_DOC_BYTES)
    expect(doc.documents[1].file).toBe(`codex/${fileStem('bbbbbbbb-2222-4222-8222-222222222222')}.part-2.md`)
    expect(doc.documents.reduce((a, d) => a + d.messages, 0)).toBe(10)
  })

  it('mergeAssistantRuns merges consecutive assistant entries only', () => {
    const m = mergeAssistantRuns([
      { role: 'assistant', ts: 1, text: 'a', tools: [] },
      { role: 'assistant', ts: 2, text: '', tools: ['Read'] },
      { role: 'user', ts: 3, text: 'u', tools: [] },
      { role: 'assistant', ts: 4, text: 'b', tools: [] }
    ])
    expect(m.map((x) => [x.role, x.text, x.tools])).toEqual([
      ['assistant', 'a', ['Read']],
      ['user', 'u', []],
      ['assistant', 'b', []]
    ])
  })

  it('displayPath renders home-relative paths', () => {
    expect(displayPath('/Users/alice/work/x', '/Users/alice')).toBe('~/work/x')
    expect(displayPath('/work/x', '/Users/alice')).toBe('/work/x')
    expect(displayPath(null, '/Users/alice')).toBeNull()
  })
})
