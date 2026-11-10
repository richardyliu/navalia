import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

test('node:sqlite is available', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('create table t (x integer)')
  db.prepare('insert into t values (?)').run(1)
  expect(db.prepare('select count(*) as c from t').get()).toEqual({ c: 1 })
})
