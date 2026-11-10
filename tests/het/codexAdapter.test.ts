import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { patchPaths } from '../../src/main/het/adapters/codex'
import { readCodexSessions } from './readers'

const ROOT = join(__dirname, '..', 'fixtures', 'het', 'codex')
const C = '44444444-4444-4444-8444-444444444444'

// Fixture format is reconstructed from public knowledge of the Codex CLI rollout recorder;
// no real ~/.codex exists on the dev machine. Real-run fidelity: UNKNOWN.
describe('Codex adapter (synthetic fixtures)', () => {
  const r = readCodexSessions({ root: ROOT })

  test('parses current-format rollout into events', () => {
    expect(r.files).toBe(2)
    const evs = r.events.filter((e) => e.sessionId === C)
    expect(evs.map((e) => e.role)).toEqual([
      'system', 'user', 'assistant', 'tool_result', 'assistant', 'tool_result', 'assistant', 'assistant', 'assistant'
    ])
    expect(new Set(evs.map((e) => e.project))).toEqual(new Set(['/work/codex-proj']))
    expect(evs.every((e) => e.agent === 'codex' && !e.sidechain)).toBe(true)
  })

  test('apply_patch paths (custom tool + legacy shell form), signals', () => {
    const evs = r.events.filter((e) => e.sessionId === C)
    expect(evs.flatMap((e) => e.filesWritten).sort()).toEqual(['src/parser.ts', 'src/util.ts', 'tests/parser.extra.test.ts'])
    expect([...new Set(evs.flatMap((e) => e.signals))].sort()).toEqual(['git_commit', 'git_push', 'tool_error'])
  })

  test('reasoning never summarised; event_msg not double-counted', () => {
    expect(JSON.stringify(r.events)).not.toContain('SECRET-REASONING')
    expect(r.events.filter((e) => e.role === 'user')).toHaveLength(1)
  })

  test('drift and legacy no-timestamp items are counted warnings', () => {
    expect(r.warnings).toEqual({
      'codex_unknown_type:brand_new_top': 1,
      'codex_unknown_item:mystery_item': 1,
      codex_legacy_no_ts: 2
    })
  })

  test('patchPaths', () => {
    expect(patchPaths('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** Delete File: c.ts\n*** End Patch')).toEqual([
      'a.ts', 'b.ts', 'c.ts'
    ])
  })
})
