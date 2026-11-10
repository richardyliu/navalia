// C23: onboarding 资料库 preview. Counts come from the existing library service read
// (`libraryOverview`) over fake deps: temp Runtime root + temp Lens Store, fake Runtime client,
// fake MCP tool. Never ~/.persome, never the real Lens Store, no network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aggregateLibrary } from '../../src/main/library/aggregate'
import { libraryOverview } from '../../src/main/library/ipc'
import type { S1Deps } from '../../src/main/s1/deps'
import type { BehaviorPatterns, ModelGraphResponse } from '../../src/shared/types'
import {
  PREVIEW_SAMPLE_LIMIT,
  libraryPreview,
  libraryPreviewEmpty,
  libraryPreviewLoading,
  libraryPreviewReady,
  runtimeOfflineHeadline
} from '../../src/renderer/src/components/onboarding/flow'
import { emptyGraph, graph, point, richGraph } from '../library/fixtures'

const PREFIX = 'lens-c23-'
const tmp: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const d of tmp.splice(0)) {
    // Guard: only delete mkdtemp dirs this file created (basename prefix + under os.tmpdir()).
    if (path.basename(d).startsWith(PREFIX) && path.dirname(d) === fs.realpathSync(os.tmpdir())) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }
})
function tempDir(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${tag}-`)))
  tmp.push(d)
  return d
}

const SKILL = `---
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
`

const PATTERNS: BehaviorPatterns = { root: null, faces: [], skills: [], rendered: '' }

function fakeDeps(opts: { graph?: ModelGraphResponse | Error; withSkill?: boolean } = {}): S1Deps & { calls: string[] } {
  const calls: string[] = []
  const rt = tempDir('rt')
  if (opts.withSkill !== false) {
    fs.mkdirSync(path.join(rt, 'memory', 'skills'), { recursive: true })
    fs.writeFileSync(path.join(rt, 'memory', 'skills', 'skill-release.md'), SKILL)
  }
  const g = opts.graph ?? richGraph
  return {
    calls,
    storeRoot: tempDir('store'),
    runtimeRoot: () => rt,
    persomeBin: () => null,
    runtime: () =>
      ({
        modelGraph: async () => {
          calls.push('modelGraph')
          if (g instanceof Error) throw g
          return g
        }
      }) as never,
    ossTool: async (name: string) => {
      calls.push(name)
      if (name === 'behavior_patterns') return JSON.stringify(PATTERNS)
      throw new Error(`unexpected tool ${name}`)
    },
    homeDir: () => '/nonexistent',
    saveDialog: async () => null,
    openDialog: async () => null
  } as S1Deps & { calls: string[] }
}

describe('onboarding 资料库 preview (C23)', () => {
  it('shows real counts and real sample titles from the library service read, with no network', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network is not allowed in this test')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const d = fakeDeps()
    const overview = await libraryOverview(d)
    const p = libraryPreview(overview, null)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(d.calls.sort()).toEqual(['behavior_patterns', 'modelGraph'])
    expect(p.state).toBe('ready')
    expect(p.headline).toBe(libraryPreviewReady())
    const byKey = Object.fromEntries(p.rows.map((r) => [r.key, r]))
    expect(byKey.projects.count).toBe(overview.projects.length)
    expect(byKey.people.count).toBe(overview.people.length)
    expect(byKey.skills.count).toBe(overview.skills.length)
    expect(byKey.memories.count).toBe(overview.portrait?.counts.points ?? null)
    expect(byKey.projects.count).toBeGreaterThan(0)
    expect(byKey.skills.count).toBe(1)
    // Every sample is a real name / title from the overview — nothing invented.
    expect(byKey.projects.samples.every((s) => overview.projects.some((e) => e.name === s))).toBe(true)
    expect(byKey.people.samples.every((s) => overview.people.some((e) => e.name === s))).toBe(true)
    expect(byKey.skills.samples).toEqual(overview.skills.map((s) => s.title).slice(0, PREVIEW_SAMPLE_LIMIT))
    expect(byKey.memories.samples).toEqual([])
  })

  it('caps samples at the limit and truncates long titles', () => {
    const names = Array.from({ length: 6 }, (_, i) => `project-p${i}${'x'.repeat(i === 0 ? 60 : 0)}.md`)
    const g = graph(names.map((f, i) => point(`pt-${i}`, f, '内容', '2026-11-01T00:00:00Z')))
    const p = libraryPreview(aggregateLibrary({ graph: g, catalog: null, patterns: null }), null)
    const projects = p.rows.find((r) => r.key === 'projects')!
    expect(projects.count).toBe(6)
    expect(projects.samples).toHaveLength(PREVIEW_SAMPLE_LIMIT)
    expect(projects.samples.every((s) => s.length <= 40)).toBe(true)
  })

  it('honest empty state: zero everywhere, no samples, no fake rows', async () => {
    const overview = await libraryOverview(fakeDeps({ graph: emptyGraph, withSkill: false }))
    const p = libraryPreview(overview, null)
    expect(p.state).toBe('empty')
    expect(p.headline).toBe(libraryPreviewEmpty())
    expect(p.headline).toContain('No sample data')
    expect(p.rows.map((r) => [r.key, r.count, r.samples.length, r.note])).toEqual([
      ['projects', 0, 0, 'None yet'],
      ['people', 0, 0, 'None yet'],
      ['skills', 0, 0, 'None yet'],
      ['memories', 0, 0, 'None yet']
    ])
  })

  it('an unreadable model graph shows 读不到 (null), never 0, and is not called empty', async () => {
    const overview = await libraryOverview(fakeDeps({ graph: new Error('boom'), withSkill: false }))
    expect(overview.graphError).not.toBeNull()
    const p = libraryPreview(overview, null)
    const byKey = Object.fromEntries(p.rows.map((r) => [r.key, r]))
    expect(byKey.projects.count).toBeNull()
    expect(byKey.people.count).toBeNull()
    expect(byKey.memories.count).toBeNull()
    expect(byKey.projects.note).toContain("Couldn't read the model")
    expect(p.state).toBe('error')
    expect(p.headline).not.toBe(libraryPreviewEmpty())
  })

  it('graph unreadable but skills readable: skills count is still shown', async () => {
    const overview = await libraryOverview(fakeDeps({ graph: new Error('boom') }))
    const p = libraryPreview(overview, null)
    expect(p.state).toBe('ready')
    expect(p.rows.find((r) => r.key === 'skills')!.count).toBe(1)
    expect(p.rows.find((r) => r.key === 'projects')!.count).toBeNull()
  })

  it('offline / error / loading carry no numbers at all', () => {
    for (const code of ['unreachable', 'timeout', 'runtime_missing', 'token_unavailable', null]) {
      const p = libraryPreview(null, { code, message: 'x' })
      expect(p.state).toBe('offline')
      expect(p.headline.startsWith(runtimeOfflineHeadline())).toBe(true)
      expect(p.rows).toEqual([])
    }
    const e = libraryPreview(null, { code: 'schema', message: '坏数据' })
    expect(e).toMatchObject({ state: 'error', rows: [] })
    expect(e.headline).not.toMatch(/\d/)
    expect(libraryPreview(undefined, undefined)).toMatchObject({ state: 'loading', headline: libraryPreviewLoading(), rows: [] })
  })
})

describe('onboarding preview: static guarantees', () => {
  const root = path.join(__dirname, '..', '..')
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

  it('flow.ts / Onboarding.tsx do no network and no writes of their own', () => {
    for (const rel of ['src/renderer/src/components/onboarding/flow.ts', 'src/renderer/src/pages/Onboarding.tsx']) {
      const src = read(rel)
      expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|from 'node:(https?|net)'/)
    }
    // The preview uses only the existing read-only library IPC.
    const page = read('src/renderer/src/pages/Onboarding.tsx')
    expect(page).toContain('window.lens.library.overview()')
    expect(page).not.toMatch(/window\.lens\.library\.(exportBrief|entity)\(/)
  })

  it('the preview lives on the skippable import step', () => {
    const page = read('src/renderer/src/pages/Onboarding.tsx')
    expect(page).toMatch(/enabled: active && \(step === 'import' \|\| step === 'done'\)/)
    const importBlock = page.slice(page.indexOf("step === 'import' ?"), page.indexOf("step === 'done' ?"))
    expect(importBlock).toContain('onboarding-library-preview')
  })
})
