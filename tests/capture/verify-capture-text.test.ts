import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../scripts/verify-capture-text.sh')
const PREFIX = 'lens-captext-'
const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0

const dirs: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    if (path.basename(d).startsWith(PREFIX) && path.resolve(d) !== path.resolve(os.tmpdir())) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }
})

const SECRET_TITLE = 'SECRET-TITLE-do-not-print'
const SECRET_URL = 'https://secret.example/do-not-print'
const SECRET_TEXT = 'SECRET-VISIBLE-TEXT-do-not-print'

const SCHEMA = `
CREATE TABLE captures (id TEXT, timestamp TEXT, app_name TEXT, bundle_id TEXT, window_title TEXT,
  focused_role TEXT, focused_value TEXT, visible_text TEXT, url TEXT);
CREATE TABLE timeline_blocks (id TEXT PRIMARY KEY, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT '', entries TEXT NOT NULL DEFAULT '', apps_used TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '', normalization_status TEXT NOT NULL DEFAULT 'legacy');
`

function sql(db: string, script: string): void {
  const r = spawnSync('sqlite3', [db], { input: script, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}

function cap(i: number, ts: string, text: string | null, fv: string | null): string {
  const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`)
  return `INSERT INTO captures VALUES ('c${i}','${ts}','Safari','com.apple.Safari','${SECRET_TITLE}','AXTextArea',${q(fv)},${q(text)},'${SECRET_URL}');`
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), TZ: 'UTC', ...env }
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe.skipIf(!hasSqlite)('scripts/verify-capture-text.sh (P0-1)', () => {
  it('counts per local day, exits 2 when the latest day has captures but no text, prints counts only', () => {
    const dir = tmp()
    const db = path.join(dir, 'index.db')
    const rows = [
      cap(1, '2026-11-04T10:00:00.000000+00:00', SECRET_TEXT, SECRET_TEXT),
      cap(2, '2026-11-04T11:00:00.000000+00:00', SECRET_TEXT, null),
      cap(3, '2026-11-05T09:00:00.000000+00:00', '   ', ''),
      cap(4, '2026-11-05T09:30:00.000000+00:00', SECRET_TEXT, null),
      cap(5, '2026-11-06T08:00:00.000000+00:00', null, null),
      cap(6, '2026-11-06T09:00:00.000000+00:00', '', null),
      // Outside the 3-day window.
      cap(7, '2026-11-01T09:00:00.000000+00:00', SECRET_TEXT, null)
    ]
    const blocks = [
      `INSERT INTO timeline_blocks (id,start_time,end_time,normalization_status) VALUES ('b1','2026-11-05T01:00:00-00:00','2026-11-05T01:01:00-00:00','llm');`,
      `INSERT INTO timeline_blocks (id,start_time,end_time,normalization_status) VALUES ('b2','2026-11-05T01:01:00-00:00','2026-11-05T01:02:00-00:00','llm_failed');`,
      `INSERT INTO timeline_blocks (id,start_time,end_time,normalization_status) VALUES ('b3','2026-11-06T01:00:00-00:00','2026-11-06T01:01:00-00:00','metadata_only');`,
      `INSERT INTO timeline_blocks (id,start_time,end_time,normalization_status) VALUES ('b4','2026-11-06T01:01:00-00:00','2026-11-06T01:02:00-00:00','metadata_only');`
    ]
    sql(db, SCHEMA + rows.join('\n') + blocks.join('\n'))
    const before = fs.readFileSync(db)

    const r = run(['--db', db, '--today', '2026-11-06'])
    expect(r.code).toBe(2)
    expect(r.out).toContain('timezone: UTC')
    expect(r.out).toContain('2026-11-04 | 2 | 2 | 1')
    expect(r.out).toContain('2026-11-05 | 2 | 1 | 0')
    expect(r.out).toContain('2026-11-06 | 2 | 0 | 0')
    expect(r.out).toContain('2026-11-05 | llm | 1')
    expect(r.out).toContain('2026-11-05 | llm_failed | 1')
    expect(r.out).toContain('2026-11-06 | metadata_only | 2')
    expect(r.out).toContain('2026-11-04 | (none) | 0')
    expect(r.out).toContain('VERDICT: NO_TEXT')
    for (const secret of [SECRET_TITLE, SECRET_URL, SECRET_TEXT, 'Safari']) expect(r.out + r.err).not.toContain(secret)
    // Read-only: the db is untouched.
    expect(fs.readFileSync(db).equals(before)).toBe(true)
  })

  it('local dates follow TZ (a UTC early-morning capture belongs to the previous Los Angeles day)', () => {
    const dir = tmp()
    const db = path.join(dir, 'index.db')
    sql(db, SCHEMA + cap(1, '2026-11-06T05:00:00.000000+00:00', SECRET_TEXT, null))
    const r = run(['--db', db, '--today', '2026-11-06'], { TZ: 'America/Los_Angeles' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('2026-11-05 | 1 | 1 | 0')
    expect(r.out).toContain('2026-11-06 | 0 | 0 | 0')
    expect(r.out).toContain('VERDICT: OK')
  })

  it('exit 0 when the latest day has text', () => {
    const dir = tmp()
    const db = path.join(dir, 'index.db')
    sql(db, SCHEMA + cap(1, '2026-11-06T10:00:00+00:00', SECRET_TEXT, null))
    const r = run(['--db', db, '--today', '2026-11-06'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('2026-11-06 | 1 | 1 | 0')
  })

  it('empty tables → 空态, exit 0', () => {
    const dir = tmp()
    const db = path.join(dir, 'index.db')
    sql(db, SCHEMA)
    const r = run(['--db', db, '--today', '2026-11-06'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('2026-11-06 | 0 | 0 | 0')
    expect(r.out).toContain('空态: no timeline_blocks in window')
  })

  it('db without the tables → 空态, exit 0', () => {
    const dir = tmp()
    const db = path.join(dir, 'index.db')
    sql(db, 'CREATE TABLE other (x INTEGER);')
    const r = run(['--db', db, '--today', '2026-11-06'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('空态: no captures table')
    expect(r.out).toContain('空态: no timeline_blocks table')
  })

  it('missing db via PERSOME_ROOT → 空态, exit 0, nothing created', () => {
    const dir = tmp()
    const r = run(['--today', '2026-11-06'], { PERSOME_ROOT: dir })
    expect(r.code).toBe(0)
    expect(r.out).toContain('空态: index.db not found')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('rejects a malformed --today (no SQL reaches sqlite)', () => {
    const dir = tmp()
    const r = run(['--db', path.join(dir, 'x.db'), '--today', "2026-11-06'; DROP TABLE captures;--"])
    expect(r.code).toBe(1)
  })
})
