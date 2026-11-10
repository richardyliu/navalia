import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startHarness, errorCode } from './helpers.ts'
import { VERSION } from '../src/version.ts'

test('GET /health returns ok + semver version matching package.json', async () => {
  const h = await startHarness()
  try {
    const r = await fetch(h.base + '/health')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /^application\/json/)
    assert.equal(r.headers.get('cache-control'), 'no-store')
    const j = (await r.json()) as { ok: boolean; version: string }
    assert.equal(j.ok, true)
    assert.match(j.version, /^\d+\.\d+\.\d+$/)
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    assert.equal(j.version, pkg.version)
    assert.equal(VERSION, pkg.version)
  } finally {
    await h.close()
  }
})

test('unknown route and wrong method -> 404 not_found envelope', async () => {
  const h = await startHarness()
  try {
    for (const [method, path] of [['GET', '/nope'], ['POST', '/health'], ['GET', '/v1/auth/verify'], ['GET', '/v1/account']]) {
      const r = await fetch(h.base + path, { method })
      assert.equal(r.status, 404, `${method} ${path}`)
      assert.equal(await errorCode(r), 'not_found')
    }
  } finally {
    await h.close()
  }
})
