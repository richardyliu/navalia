// S2-04 Library 技能 column: Workflow catalog merge, provenance badges, dedupe, headline parity.
// Uses temp Runtime roots and temp Lens Stores only (never ~/.persome or the real Lens Store).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { libraryOverview } from '../../src/main/library/ipc'
import { aggregateSkills, normalizedContentKey } from '../../src/main/library/skills'
import type { S1Deps } from '../../src/main/s1/deps'
import { createWorkflowService } from '../../src/main/workflows/service'
import type { Workflow } from '../../src/main/workflows/schema'
import { librarySkillsHeadline, skillBadges, skillCountChips } from '../../src/renderer/src/components/library/viewModel'
import { skillsHeadline } from '../../src/renderer/src/components/workflows/headline'
import { provenanceBadge } from '../../src/renderer/src/components/workflows/viewModel'
import type { BehaviorPatterns } from '../../src/shared/types'
import { richGraph } from './fixtures'

// Most assertions below check the Chinese UI strings; English is covered by the `English locale` block.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) if (d.startsWith(path.join(os.tmpdir(), 'lens-lib-'))) fs.rmSync(d, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lens-lib-${prefix}-`))
  tmp.push(d)
  return d
}

const RELEASE_SKILL = `---
description: 发布前检查
tags:
- pattern
status: active
created: '2026-10-01'
updated: '2026-10-20'
---

## [2026-10-06T09:00] {id: rel-0001} #pattern #observed
stage: observed

**Goal**: 发布前先跑 typecheck 和测试
**Steps**:
- 跑 typecheck
- 跑测试

## [2026-10-20T09:00] {id: rel-0002} #pattern #observed
stage: observed

**Goal**: 发布前先跑 typecheck 和测试
**Steps**:
- 跑 typecheck
- 跑测试
`

function runtimeRoot(): string {
  const root = tempDir('rt')
  fs.mkdirSync(path.join(root, 'memory', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(root, 'memory', 'skills', 'skill-release.md'), RELEASE_SKILL)
  return root
}

const PATTERNS: BehaviorPatterns = {
  root: null,
  faces: [],
  skills: [
    // Same path as the skill file → id rt-release → already in the catalog.
    { path: 'skills/skill-release.md', description: '发布前检查', updated: '2026-10-20', entry_id: 'rel-0002', observed_at: '2026-10-20T09:00', playbook: '**Goal**: 发布前先跑 typecheck 和测试' },
    // Only known through behavior_patterns.
    { path: 'skills/skill-inbox.md', description: '清理收件箱', updated: '2026-11-02', entry_id: 'ib-1', observed_at: '2026-11-02T08:00', playbook: '**Goal**: 早上先清理收件箱' }
  ],
  rendered: ''
}

function importedJson(id: string, title: string, goal: string): string {
  const w = {
    schema_version: 1,
    id,
    version: 1,
    title,
    goal,
    context: '',
    inputs: [],
    tools: [],
    steps: [],
    artifacts: [],
    rules: [],
    problems: [],
    evidence: [{ ref: 'x-1', kind: 'entry', timestamp: '2026-09-01T10:00', origin: 'local' }],
    evidence_note: '',
    tags: [],
    provenance: { kind: 'observed' },
    source: { type: 'lens_store' },
    created_at: null,
    updated_at: '2026-09-01T10:00'
  }
  return JSON.stringify({ format: 'navalia.workflow', format_version: 1, exported_at: '2026-09-02T00:00:00Z', workflows: [w] })
}

function deps(over: Partial<S1Deps> = {}, patterns: BehaviorPatterns = PATTERNS): S1Deps & { calls: string[] } {
  const calls: string[] = []
  const root = runtimeRoot()
  return {
    calls,
    storeRoot: tempDir('store'),
    runtimeRoot: () => root,
    persomeBin: () => null,
    runtime: () => ({ modelGraph: async () => richGraph }) as never,
    ossTool: async (name: string) => {
      calls.push(name)
      if (name === 'behavior_patterns') return JSON.stringify(patterns)
      throw new Error(`unexpected tool ${name}`)
    },
    homeDir: () => '/nonexistent',
    saveDialog: async () => null,
    openDialog: async () => null,
    ...over
  } as S1Deps & { calls: string[] }
}

const NOW = () => new Date('2026-11-05T00:00:00Z')

describe('library skills (S2-04)', () => {
  it('merges observed files, behavior_patterns, imported, shared and edited Workflows with badges and per-source counts', async () => {
    const d = deps()
    const service = createWorkflowService({ storeRoot: d.storeRoot, runtimeRoot: d.runtimeRoot, ossTool: d.ossTool, now: NOW })
    // Imported JSON (relabelled imported, new imp-… id).
    const imp = await service.importJson(importedJson('weekly', '周报', '每周五写周报'), 'weekly.json')
    expect(imp.imported).toBe(1)
    // A `.navaliaskill` import lands in the store with provenance `shared` (shr-… id).
    const sharedSrc = JSON.parse(importedJson('demo', '别人的复盘流程', '每次上线后复盘')).workflows[0] as Workflow
    const shared = service.store.importShared(sharedSrc, {
      fileName: 'demo.navaliaskill',
      sharedAt: '2026-10-30T00:00:00Z',
      signerFingerprint: 'a'.repeat(64),
      packageHash: 'b'.repeat(64),
      chain: []
    })
    expect(shared.outcome).toBe('imported')
    // Manual edit of the observed Workflow → user_edited, origin stays observed.
    const observed = (await service.get('rt-release'))!.workflow
    await service.save('rt-release', observed.version, {
      title: observed.title,
      goal: '发布前先跑 typecheck、测试和 lint',
      context: observed.context,
      inputs: observed.inputs,
      tools: observed.tools,
      steps: observed.steps,
      artifacts: observed.artifacts,
      rules: observed.rules,
      problems: observed.problems,
      tags: observed.tags
    })

    d.calls.length = 0
    const o = await libraryOverview(d)
    expect(d.calls).toEqual(['behavior_patterns']) // one call, shared with the catalog
    const byId = new Map(o.skills.map((s) => [s.id, s]))
    expect([...byId.keys()].sort()).toEqual([imp.items[0].id, 'rt-inbox', 'rt-release', shared.id].sort())
    expect(byId.get('rt-release')).toMatchObject({ origin: 'observed', edited: true, summary: '发布前先跑 typecheck、测试和 lint' })
    expect(byId.get('rt-inbox')).toMatchObject({ origin: 'observed', edited: false, evidenceRef: 'ib-1' })
    expect(byId.get(imp.items[0].id)).toMatchObject({ origin: 'imported', edited: false })
    expect(byId.get(shared.id)).toMatchObject({ origin: 'shared', title: '别人的复盘流程' })
    expect(shared.id.startsWith('shr-')).toBe(true)
    expect(o.skillCounts).toEqual({ observed: 2, imported: 1, shared: 1, extracted: 0, edited: 1, dedupedPatterns: 2 })
    expect(skillBadges(byId.get('rt-release')!)).toEqual(['来自观察', '手动编辑'])
    expect(skillBadges(byId.get(shared.id)!)).toEqual(['别人分享'])
    expect(skillBadges(byId.get(imp.items[0].id)!)).toEqual(['导入'])
    expect(skillCountChips(o.skillCounts)).toEqual([
      { label: '来自观察', count: 2 },
      { label: '导入', count: 1 },
      { label: '别人分享', count: 1 },
      { label: '手动编辑', count: 1 }
    ])
    expect(o.workflowError).toBeNull()
    expect(o.skillsError).toBeNull()
    expect(o.counts.skills).toBe(4)
  })

  it('headline: Library and Playbook compute the same N / M for the same input', async () => {
    const d = deps()
    const service = createWorkflowService({ storeRoot: d.storeRoot, runtimeRoot: d.runtimeRoot, ossTool: d.ossTool, now: NOW })
    await service.importJson(importedJson('weekly', '周报', '每周五写周报'), 'weekly.json')
    const catalog = await service.catalog() // what Playbook's WorkflowPanel feeds skillsHeadline
    const playbook = skillsHeadline(catalog.workflows)
    const library = librarySkillsHeadline((await libraryOverview(d)).skills)
    expect(library).toEqual(playbook)
    // rel-0001 (2026-W41), rel-0002 (W43), ib-1 (W45), imported x-1 (2026-09-01, W36)
    expect(playbook).toEqual({ n: 3, m: 4, text: '3 个技能文件，4 周的判断。' })
  })

  it('dedupes behavior_patterns skills against the catalog by rt-<stem> id and by normalized content', () => {
    const svc = createWorkflowService({ storeRoot: tempDir('store'), runtimeRoot: () => runtimeRoot(), now: NOW })
    // Catalog without behavior_patterns (files + store only), so the Library has to merge them.
    const catalog = { workflows: svc.catalogSync(), sources: { runtimeFiles: 'ok', behaviorPatterns: 'skipped', store: 0 } }
    const patterns: BehaviorPatterns = {
      root: null,
      faces: [],
      rendered: '',
      skills: [
        // id mapping: legacy top-level path with the same stem → rt-release
        { path: 'skill-release.md', description: 'x', playbook: '**Goal**: something else' },
        // content twin of rt-release under another stem (whitespace / case / width differ)
        { path: 'skills/skill-release-copy.md', description: '发布前检查', playbook: '**Goal**:  发布前先跑 TYPECHECK 和测试 \n**Steps**:\n- 跑 typecheck\n- 跑测试' },
        // genuinely new
        { path: 'skills/skill-inbox.md', description: '清理收件箱', playbook: '**Goal**: 早上先清理收件箱', entry_id: 'ib-1' },
        // repeated new one (same id) → kept once
        { path: 'skills/skill-inbox.md', description: '清理收件箱', playbook: '**Goal**: 早上先清理收件箱', entry_id: 'ib-1' }
      ]
    }
    const r = aggregateSkills(catalog, patterns)
    expect(r.skills.map((s) => s.id)).toEqual(['rt-release', 'rt-inbox'])
    expect(r.skillCounts.dedupedPatterns).toBe(3)
  })

  it('foreign copies equal to an observed Workflow are kept (N parity) and marked sameContentAs', () => {
    const svc = createWorkflowService({ storeRoot: tempDir('store'), runtimeRoot: () => runtimeRoot(), now: NOW })
    const observed = svc.catalogSync()[0]
    const twin: Workflow = { ...observed, id: 'imp-0123456789ab', provenance: { ...observed.provenance, kind: 'imported' } }
    const r = aggregateSkills({ workflows: [observed, twin], sources: { runtimeFiles: 'ok', behaviorPatterns: 'skipped', store: 1 } }, null)
    expect(r.skills.map((s) => [s.id, s.origin, s.sameContentAs])).toEqual([
      ['rt-release', 'observed', null],
      ['imp-0123456789ab', 'imported', 'rt-release']
    ])
  })

  it('bare titles are not treated as the same content', () => {
    const base = { title: 'X', goal: '', context: '', steps: [], rules: [], inputs: [], tools: [], artifacts: [], problems: [] }
    expect(normalizedContentKey(base)).toBeNull()
    expect(normalizedContentKey({ ...base, goal: ' Ａ  b ' })).toBe(normalizedContentKey({ ...base, goal: 'a B' }))
  })

  it('empty: no Runtime skills, empty store, no playbooks', async () => {
    const d = deps({ runtimeRoot: () => tempDir('empty-rt') }, { root: null, faces: [], skills: [], rendered: '' })
    const o = await libraryOverview(d)
    expect(o.skills).toEqual([])
    expect(o.skillCounts).toEqual({ observed: 0, imported: 0, shared: 0, extracted: 0, edited: 0, dedupedPatterns: 0 })
    expect(librarySkillsHeadline(o.skills).text).toBe('0 个技能文件，— 周的判断。')
    expect(o.workflowError).toBeNull()
  })

  it('errors are per section: catalog failure keeps behavior_patterns skills and people; graph failure keeps skills', async () => {
    const catalogDown = await libraryOverview(
      deps({
        runtimeRoot: () => {
          throw new Error('Runtime root 不可读')
        }
      })
    )
    expect(catalogDown.workflowError).toEqual({ code: 'unknown', message: 'Runtime root 不可读' })
    expect(catalogDown.skills.map((s) => s.id).sort()).toEqual(['rt-inbox', 'rt-release'])
    expect(catalogDown.counts.people).toBe(2)
    expect(catalogDown.graphError).toBeNull()

    const graphDown = await libraryOverview(
      deps({
        runtime: () => ({
          modelGraph: async () => {
            throw new Error('连不上 Runtime')
          }
        }) as never
      })
    )
    expect(graphDown.graphError).toEqual({ code: 'unknown', message: '连不上 Runtime' })
    expect(graphDown.portrait).toBeNull()
    expect(graphDown.people).toEqual([])
    expect(graphDown.skills.length).toBe(2)

    const patternsDown = await libraryOverview(
      deps({
        ossTool: async () => {
          throw new Error('mcp 退出')
        }
      })
    )
    expect(patternsDown.skillsError).toEqual({ code: 'unknown', message: 'mcp 退出' })
    // The catalog still reads the Runtime skill files.
    expect(patternsDown.skills.map((s) => s.id)).toEqual(['rt-release'])
    expect(patternsDown.workflowError).toBeNull()
  })
})

// S2-SEC M2: an external-agent extraction is never shown as 来自观察, and its evidence keeps its origin.
describe('library skills: external extractions (S2-SEC M2)', () => {
  const EXTRACTION = JSON.stringify({ title: '外部抽取的流程', goal: '把周报按里程碑分组', evidence: [{ kind: 'quote', ref: '“按里程碑分组”', timestamp: '2026-09-01' }] })

  for (const as of ['user_edited', 'imported'] as const) {
    it(`saved as ${as}: Library origin is extracted (外部抽取, same as Playbook), counted separately, evidence origin imported`, async () => {
      const d = deps()
      const service = createWorkflowService({ storeRoot: d.storeRoot, runtimeRoot: d.runtimeRoot, ossTool: d.ossTool, now: NOW })
      const saved = await service.saveExtracted(EXTRACTION, as, 'Claude Code')
      const o = await libraryOverview(d)
      const row = o.skills.find((s) => s.title === '外部抽取的流程')!
      expect(row).toMatchObject({ origin: 'extracted', edited: false, evidenceDates: ['2026-09-01'], evidenceOrigins: ['imported'] })
      expect(skillBadges(row)).toEqual(['外部抽取'])
      const pb = provenanceBadge((await service.catalog()).workflows.find((w) => w.title === '外部抽取的流程')!)
      expect(skillBadges(row)[0]).toBe(pb.label)
      expect(o.skillCounts).toMatchObject({ observed: 2, extracted: 1 })
      expect(skillCountChips(o.skillCounts)).toContainEqual({ label: '外部抽取', count: 1 })
      expect(saved).toBeTruthy()
    })
  }

  it('headline parity with Playbook still holds with an extraction in the catalog (D30: carried-in dates count on both pages)', async () => {
    const d = deps()
    const service = createWorkflowService({ storeRoot: d.storeRoot, runtimeRoot: d.runtimeRoot, ossTool: d.ossTool, now: NOW })
    await service.saveExtracted(EXTRACTION, 'user_edited', 'Codex')
    const playbook = skillsHeadline((await service.catalog()).workflows)
    expect(librarySkillsHeadline((await libraryOverview(d)).skills)).toEqual(playbook)
  })
})

describe('English locale', () => {
  beforeEach(() => setLocale('en'))
  it('badges, counts and the headline are English by default', () => {
    expect(skillBadges({ origin: 'observed', edited: true })).toEqual(['Observed', 'Edited'])
    expect(skillBadges({ origin: 'extracted', edited: false })).toEqual(['Externally extracted'])
    expect(skillCountChips({ observed: 1, imported: 0, shared: 0, extracted: 0, edited: 1 } as never)).toContainEqual({ label: 'Edited', count: 1 })
    expect(librarySkillsHeadline([]).text).toBe('0 skill files. — weeks of judgment.')
  })
})
