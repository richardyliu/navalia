import { describe, expect, it } from 'vitest'
import {
  aggregateLibrary,
  columnForKind,
  entityFromFileName,
  libraryHeadline,
  normName,
  slugName,
  parseEntityGraph
} from '../../src/main/library/aggregate'
import { emptyGraph, graph, patterns, point, richGraph } from './fixtures'

const agg = (g: Parameters<typeof aggregateLibrary>[0]['graph'], p: Parameters<typeof aggregateLibrary>[0]['patterns']) =>
  aggregateLibrary({ graph: g, catalog: null, patterns: p })

describe('library aggregate', () => {
  it('empty graph → empty columns and zero counts', () => {
    const o = agg(emptyGraph, null)
    expect(o.counts).toEqual({ people: 0, projects: 0, unclassified: 0, skills: 0 })
    expect(o.people).toEqual([])
    expect(libraryHeadline(o.counts)).toBe('Organized 0 projects and 0 people')
    expect(o.skillsError).toBeNull()
  })

  it('tolerates a graph with missing arrays', () => {
    const o = aggregateLibrary({ generated_at: 'x', model: {} as never }, { skills: undefined } as never)
    expect(o.counts.people + o.counts.projects + o.counts.unclassified + o.counts.skills).toBe(0)
  })

  it('classifies only on Runtime-provided fields', () => {
    const o = agg(richGraph, patterns)
    expect(o.projects.map((e) => e.name)).toEqual(['Navalia'])
    expect(o.people.map((e) => e.name).sort()).toEqual(['Dana', 'Mira'])
    // org file, event endpoint, endpoint with no kind → 未分类, with the raw kind kept
    const un = o.unclassified.map((e) => [e.name, e.rawKind]).sort()
    expect(un).toEqual([
      ['Launch Party', 'event'],
      ['Mystery', null],
      ['acme', 'org']
    ])
    // non-entity file (user-preferences.md), superseded Point, `self`, point-id endpoints: not entries
    const all = [...o.people, ...o.projects, ...o.unclassified].map((e) => e.name)
    expect(all).not.toContain('bob')
    expect(all).not.toContain('self')
    expect(all).not.toContain('pt-004')
    expect(all).not.toContain('preferences')
    expect(libraryHeadline(o.counts)).toBe('Organized 1 projects and 2 people')
  })

  it('merges point files and relation endpoints by normalized name and keeps evidence', () => {
    const o = agg(richGraph, patterns)
    const lens = o.projects[0]
    expect(lens.source).toBe('both')
    expect(lens.points.map((p) => p.id)).toEqual(['pt-005', 'pt-002'])
    expect(lens.evidenceRef).toBe('⟨pt-005:project-navalia.md⟩')
    expect(lens.relations[0]).toMatchObject({ predicate: 'works_on', other: 'Mira', direction: 'in', receipt: '⟨occ:o1⟩' })
    const mira = o.people.find((e) => e.name === 'Mira')!
    expect(mira.relations[0].quote).toBe('“Mira 负责 Lens 的用户研究”')
    const dana = o.people.find((e) => e.name === 'Dana')!
    expect(dana.points).toEqual([])
    expect(dana.evidenceRef).toBeNull()
    expect(dana.relations.map((r) => r.other).sort()).toEqual(['Launch Party', 'Mystery', 'self'])
  })

  it('uses the identity Point (tag `entity`) as display name', () => {
    const g = graph([
      point('p1', 'person-mira-chen.md', 'Mira Chen', '2026-11-01T00:00:00Z', { tags: 'entity' }),
      point('p2', 'person-mira-chen.md', '在 Acme 负责用户研究', '2026-11-02T00:00:00Z', { tags: ['fact'] })
    ])
    const o = agg(g, null)
    expect(o.people.map((e) => [e.name, e.points.length])).toEqual([['Mira Chen', 2]])
  })

  it('maps skills from behavior_patterns', () => {
    const o = agg(richGraph, patterns)
    expect(o.skills).toEqual([
      {
        id: 'rt-release',
        title: '发布前先跑 typecheck',
        summary: '',
        origin: 'observed',
        edited: false,
        path: 'skills/release.md',
        updated: '2026-11-03',
        evidenceRef: 'ent-77',
        evidenceCount: 1,
        evidenceDates: [null],
        evidenceOrigins: ['local'],
        sameContentAs: null
      }
    ])
  })

  it('helpers', () => {
    expect(normName('  Ｍｉｒａ   Chen ')).toBe('mira chen')
    expect(entityFromFileName('person-.md')).toBeNull()
    expect(entityFromFileName('project-x.md')).toEqual({ name: 'x', kind: 'project' })
    expect(slugName('Mira Chen')).toBe('mira-chen')
    expect(slugName('  张 三！')).toBe('张-三')
    expect(slugName('!!!')).toBe('unknown')
    expect(columnForKind('artifact')).toBe('unclassified')
    expect(columnForKind(undefined)).toBe('unclassified')
  })

  it('parses entity_graph hits and honest misses', () => {
    const hit = parseEntityGraph(
      JSON.stringify({
        resolved: 'Mira',
        layer: 'exact',
        as_of: null,
        edges: [{ src: 'Mira', dst: 'Persome', predicate: 'works_at', label: null, observations: 3, valid_from: '2026-01-01', valid_to: null, status: 'active' }],
        neighbors: ['Persome'],
        chain_to_user: 'USER →knows→ Mira'
      })
    )
    expect(hit).toMatchObject({ resolved: 'Mira', neighbors: ['Persome'], chainToUser: 'USER →knows→ Mira' })
    const miss = parseEntityGraph(JSON.stringify({ resolved: null, layer: 'none', note: 'no guess was made' }))
    expect(miss).toEqual({ resolved: null, layer: 'none', note: 'no guess was made' })
    expect(() => parseEntityGraph('not json')).toThrow(/valid JSON/)
  })
})
