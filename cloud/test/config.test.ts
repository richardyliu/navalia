import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, normalizeOrigin } from '../src/config.ts'

test('defaults', () => {
  const c = loadConfig({})
  assert.equal(c.port, 8787)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.tokenTtlS, 30 * 24 * 3600)
  assert.equal(c.challengeTtlS, 300)
  assert.equal(c.bodyLimitBytes, 65536)
  assert.equal(c.publicOrigin, 'http://localhost:8787')
  assert.equal(c.trustProxy, false)
})

test('env overrides', () => {
  const c = loadConfig({ PORT: '9000', CLOUD_DB_PATH: '/data/x.db', CLOUD_PUBLIC_ORIGIN: 'https://cloud.example.com/', CLOUD_TOKEN_TTL_S: '120' })
  assert.equal(c.port, 9000)
  assert.equal(c.dbPath, '/data/x.db')
  assert.equal(c.publicOrigin, 'https://cloud.example.com')
  assert.equal(c.tokenTtlS, 120)
})

test('rejects bad values', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }))
  assert.throws(() => loadConfig({ PORT: '70000' }))
  assert.throws(() => loadConfig({ CLOUD_TOKEN_TTL_S: '-1' }))
  for (const o of ['cloud.example.com', 'ftp://x.example', 'https://x.example/path', 'https://u:p@x.example', 'https://x.example?q=1', 'HTTPS://X.EXAMPLE']) {
    assert.throws(() => normalizeOrigin(o), o)
  }
})
