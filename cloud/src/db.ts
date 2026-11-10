import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS, type Migration } from './migrations.ts'

export type Db = DatabaseSync

/**
 * Opens (creating if needed) the SQLite file with 0600 permissions, enables
 * foreign keys + WAL, and applies pending migrations. Safe to call repeatedly
 * on the same file: already-applied versions are skipped.
 */
export function openDb(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // Create the file ourselves so it never exists with umask-default perms.
    // SQLite creates -wal/-shm with the same mode as the main file.
    closeSync(openSync(path, 'a', 0o600))
    chmodSync(path, 0o600)
  }
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db, migrations)
  return db
}

export function migrate(db: Db, migrations: readonly Migration[]): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT`)
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].version === sorted[i - 1].version) throw new Error(`duplicate migration version ${sorted[i].version}`)
  }
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  )
  const known = new Set(sorted.map((m) => m.version))
  for (const v of applied) {
    if (!known.has(v)) throw new Error(`database has migration ${v} unknown to this build (refusing to downgrade)`)
  }
  const ran: number[] = []
  for (const m of sorted) {
    if (applied.has(m.version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    ran.push(m.version)
  }
  return ran
}

/** Run `f` inside BEGIN IMMEDIATE … COMMIT; ROLLBACK and rethrow on any error. */
export function tx<T>(db: Db, f: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = f()
    db.exec('COMMIT')
    return r
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
