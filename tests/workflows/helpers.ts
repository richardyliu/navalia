import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FIXTURE_RUNTIME = path.join(__dirname, 'fixtures', 'runtime')

/** A temp dir that is removed by the returned cleanup. Never the real ~/.persome or Lens Store. */
export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lens-wf-${prefix}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Copy the synthetic Runtime fixture so a test can mutate it. */
export function runtimeCopy(): { root: string; cleanup: () => void } {
  const t = tempDir('rt')
  fs.cpSync(FIXTURE_RUNTIME, t.dir, { recursive: true })
  return { root: t.dir, cleanup: t.cleanup }
}

export function readFixture(rel: string): string {
  return fs.readFileSync(path.join(FIXTURE_RUNTIME, rel), 'utf8')
}

export const PATTERNS_JSON = JSON.stringify({
  root: null,
  faces: [],
  skills: [
    {
      path: 'skills/skill-weekly-report.md',
      description: 'Friday afternoon weekly status report for the demo project',
      updated: '2026-10-16',
      entry_id: 'wr-0004',
      observed_at: '2026-10-16T15:12',
      playbook: 'stage: observed\n\n**Pattern**: duplicate of the file version'
    },
    {
      path: 'skills/skill-mcp-only.md',
      description: 'Only known through behavior_patterns',
      updated: '2026-10-30',
      entry_id: 'mo-0001',
      observed_at: '2026-10-30T11:00',
      playbook: 'stage: observed\n\n**Pattern**: Reviews pull requests before lunch.\n**Steps**: 1. Open review queue. 2. Leave comments.\n**Evidence**: 4 sessions across 3 days; receipts `⟨ev-0500:event-2026-10-30.md⟩`'
    }
  ],
  rendered: ''
})
