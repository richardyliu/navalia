import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseClaudeLine } from '../../src/main/het/adapters/claudeCode'
import { readClaudeProjects } from './readers'
import { pinSessionProject, projectKeyFromCwd, shortSummary } from '../../src/main/het/adapters/common'

const ROOT = join(__dirname, '..', 'fixtures', 'het', 'claude')
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'

describe('Claude Code adapter (synthetic fixtures)', () => {
  const r = readClaudeProjects({ root: ROOT })

  test('walks main + subagent files and counts lines', () => {
    expect(r.files).toBe(4)
    expect(r.agent).toBe('claude-code')
    // S1 main 15 user/assistant/pr-link with ts + S1 sub 2 + S2 3 + S3 2
    expect(r.events).toHaveLength(15 + 2 + 3 + 2)
  })

  test('unknown shapes are counted warnings, not crashes', () => {
    expect(r.warnings).toEqual({
      'unknown_type:brand-new-type': 1,
      'unknown_block:mystery_block': 1,
      'missing_timestamp:user': 1,
      json_parse: 1
    })
  })

  test('roles: human prompt vs tool_result vs injected command', () => {
    const s1 = r.events.filter((e) => e.sessionId === S1 && !e.sidechain)
    expect(s1.map((e) => e.role)).toEqual([
      'user', 'assistant', 'tool_result', 'assistant', 'tool_result', 'assistant', 'tool_result',
      'assistant', 'tool_result', 'assistant', 'system',
      'system', 'user', 'assistant', 'assistant'
    ])
  })

  test('tool names, touched files, signals', () => {
    const all = r.events.filter((e) => e.sessionId === S1)
    expect(all.flatMap((e) => e.filesWritten).sort()).toEqual([
      '/work/demo-app/README.md',
      '/work/demo-app/src/export.ts',
      '/work/demo-app/tests/export.test.ts'
    ])
    expect(all.flatMap((e) => e.filesRead)).toEqual(['/work/demo-app/src/export.ts', '/work/demo-app/src/export.ts'])
    expect(all.flatMap((e) => e.toolNames)).toContain('Bash')
    const sig = new Set(all.flatMap((e) => e.signals))
    expect([...sig].sort()).toEqual(['git_commit', 'pr_link', 'tool_error'])
  })

  test('sidechain events keep parent sessionId and are flagged', () => {
    const side = r.events.filter((e) => e.sidechain)
    expect(side).toHaveLength(2)
    expect(side.every((e) => e.sessionId === S1)).toBe(true)
  })

  test('summaries: short, redacted, never contain thinking', () => {
    for (const e of r.events) expect(e.summary.length).toBeLessThanOrEqual(200)
    const text = JSON.stringify(r.events)
    expect(text).not.toContain('SECRET-THOUGHT')
    expect(text).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV')
    expect(text).toContain('[redacted]')
  })

  test('titles: custom-title wins over ai-title', () => {
    expect(r.sessionTitles[S1]).toBe('Add dry-run flag to export')
    expect(r.sessionTitles[S2]).toBe('Changelog')
  })

  test('worktree cwd collapses onto parent project', () => {
    const s2 = r.events.filter((e) => e.sessionId === S2)
    expect(new Set(s2.map((e) => e.project))).toEqual(new Set(['/work/demo-app']))
    expect(projectKeyFromCwd('/a/b/.claude/worktrees/x')).toBe('/a/b')
    expect(projectKeyFromCwd(null)).toBeNull()
  })

  test('session project pinned to launch cwd; raw cwd kept', () => {
    const e = (ts: number, cwd: string, sidechain = false) => ({
      agent: 'claude-code', sessionId: 's', ts, cwd, project: projectKeyFromCwd(cwd), sidechain
    })
    const out = pinSessionProject([e(5, '/repo/sub'), e(1, '/elsewhere', true), e(2, '/repo'), e(9, '/other-repo')])
    expect(out.map((x) => x.project)).toEqual(['/repo', '/repo', '/repo', '/repo'])
    expect(out.map((x) => x.cwd)).toEqual(['/repo/sub', '/elsewhere', '/repo', '/other-repo'])
  })

  test('missing root yields empty result', () => {
    const empty = readClaudeProjects({ root: join(ROOT, 'does-not-exist') })
    expect(empty.files).toBe(0)
    expect(empty.events).toHaveLength(0)
  })

  test('single-line parser tolerates garbage', () => {
    const ctx = { file: 'x', line: 1, titles: {}, customTitles: new Set<string>(), warnings: {} as Record<string, number> }
    expect(parseClaudeLine('[]', ctx)).toBeNull()
    expect(parseClaudeLine('{"foo":1}', ctx)).toBeNull()
    expect(parseClaudeLine('{"type":"assistant","sessionId":"s","timestamp":"2025-01-01T00:00:00Z"}', ctx)).toBeNull()
    expect(ctx.warnings).toEqual({ non_object_line: 1, missing_type: 1, 'missing_message:assistant': 1 })
  })

  test('shortSummary keeps paths, redacts tokens, truncates', () => {
    expect(shortSummary('see /Users/someone/Documents/GitHub/some-long-project-name/src/file.ts')).toContain(
      '/src/file.ts'
    )
    expect(shortSummary('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
    expect(shortSummary('ab '.repeat(300))).toHaveLength(200)
  })
})
