import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { HET_MIGRATIONS, migrateHet } from '../../src/main/het/schema'

const HET_SCHEMA_VERSION = HET_MIGRATIONS[HET_MIGRATIONS.length - 1].version

describe('het.db schema draft', () => {
  test('migrates in-memory and is idempotent', () => {
    const db = new DatabaseSync(':memory:')
    expect(migrateHet(db)).toBe(HET_SCHEMA_VERSION)
    expect(migrateHet(db)).toBe(HET_SCHEMA_VERSION)
    const names = (db.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map(
      (r) => r.name
    )
    for (const t of ['het_tasks', 'het_events', 'het_anchors', 'agent_calls', 'het_evidence']) expect(names).toContain(t)
  })

  test('constraints: minutes only when assessed; corrections limited to three', () => {
    const db = new DatabaseSync(':memory:')
    migrateHet(db)
    db.prepare("insert into het_anchors values (1, 'coding', 'per 200 lines/PR', 45, 0, 'default')").run()
    let n = 0
    const ins = (status: string, minutes: number | null, correction: string | null, anchor: number | null = 1, kind = 'coding'): void => {
      db.prepare(
        `insert into het_tasks (id, agent, start_ms, end_ms, status, kind, minutes_tenths, anchor_version, correction, fingerprint, session_ids, stats, created_ms, updated_ms)
         values (?, 'claude-code', 0, 1, ?, ?, ?, ?, ?, 'fp', '[]', '{}', 0, 0)`
      ).run(`t${n++}`, status, kind, minutes, anchor, correction)
    }
    expect(() => ins('needs_assessment', 10, null)).toThrow() // pending rows carry no minutes
    expect(() => ins('assessed', 10, null, null)).toThrow() // minutes must come from an anchor version
    expect(() => ins('assessed', 10, null, 2)).toThrow() // unknown anchor version (FK)
    expect(() => ins('assessed', 10, null, 1, 'writing')).toThrow() // anchor row must match kind
    expect(() => ins('assessed', 10, 'accepted')).not.toThrow()
    expect(() => ins('assessed', 10, 'override')).toThrow()
    expect(() => ins('needs_assessment', null, 'not_agent', null, 'unassessed')).not.toThrow()
  })
})
