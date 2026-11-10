import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from './helpers.ts'
import { migrate, openDb } from '../src/db.ts'
import { MIGRATIONS } from '../src/migrations.ts'

const tmp = makeTempDir

test('migrations are idempotent on reopen and data survives', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'sub', 'cloud.db')
    const db1 = openDb(p)
    const v1 = db1.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
    assert.equal(v1.length, MIGRATIONS.length)
    db1.prepare('INSERT INTO accounts (id, public_key, created_at) VALUES (?, ?, ?)').run('f'.repeat(64), 'k', 1)
    db1.close()

    const db2 = openDb(p)
    assert.deepEqual(db2.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all(), v1)
    assert.equal((db2.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n, 1)
    assert.deepEqual(migrate(db2, MIGRATIONS), [])
    db2.close()

    if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600)
  } finally {
    removeTempDir(dir)
  }
})

test('new migrations apply incrementally; failed migration rolls back', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'cloud.db')
    openDb(p).close()
    const next = [...MIGRATIONS, { version: 999, name: 'add_t', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT;' }]
    const db = openDb(p, next)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 999').get() as { n: number }).n, 1)
    assert.throws(() => migrate(db, [...next, { version: 1000, name: 'bad', sql: 'CREATE TABLE u (id INTEGER); THIS IS NOT SQL;' }]))
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'u'").get() as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 1000').get() as { n: number }).n, 0)
    db.close()
    // a build that does not know v999 refuses to open (no silent downgrade)
    assert.throws(() => openDb(p), /refusing to downgrade/)
  } finally {
    removeTempDir(dir)
  }
})

test('duplicate versions are rejected', () => {
  const db = openDb(':memory:', [])
  assert.throws(() => migrate(db, [MIGRATIONS[0], { ...MIGRATIONS[0] }]), /duplicate/)
  db.close()
})
