import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { asOfLabel, toDateTimeLocalValue, validateAsOf } from '../../src/renderer/src/components/evidence/asOf'
import { evidenceAsOfError, RuntimeClient, isValidEvidenceAsOf } from '../../src/main/runtime/client'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  clipboard: { writeText: () => undefined },
  shell: { openPath: async () => '', openExternal: async () => undefined },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

const VALID = [
  '2026-03-01',
  '2026-03-01T10:00',
  '2026-03-01T10:00:59',
  '2026-03-01T10:00:00.123456',
  '2026-03-01T10:00:00Z',
  '2026-03-01T10:00:00+08:00',
  '2026-03-01T23:59-05:30',
  '2024-02-29'
]
const INVALID = [
  '20260301', // pydantic would read this as a Unix epoch (1970-08-23)
  '1700000000',
  '2026-03-01 10:00', // pydantic accepts the space; Lens does not
  '2026/03/01',
  '2026-13-01',
  '2026-02-30',
  '2025-02-29',
  '2026-03-01T24:00',
  '2026-03-01T10:60',
  '2026-03-01T10:00:00+24:00',
  '2026-03-01T10:00:00.1234567',
  'yesterday',
  '2026-3-1',
  ' 2026-03-01T'
]

describe('S1-03 asOf validation (renderer view-model)', () => {
  test.each(VALID)('accepts %s', (value) => {
    const check = validateAsOf(value)
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.value).toBe(value)
  })

  test.each(INVALID)('rejects %s with a readable error (English by default, Chinese in zh)', (value) => {
    const check = validateAsOf(value)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.error).toMatch(/^(Invalid time format|No such date|No such time|Invalid time zone offset)/)
    setLocale('zh')
    try {
      const zh = validateAsOf(value)
      if (!zh.ok) expect(zh.error).toMatch(/[一-鿿]/)
    } finally {
      setLocale('en')
    }
  })

  test('empty means "now" (no as_of sent)', () => {
    expect(validateAsOf('')).toEqual({ ok: true, value: undefined, kind: null })
    expect(validateAsOf('   ')).toEqual({ ok: true, value: undefined, kind: null })
    expect(validateAsOf(undefined)).toEqual({ ok: true, value: undefined, kind: null })
  })

  test('main and renderer accept exactly the same strings', () => {
    for (const value of [...VALID, ...INVALID]) {
      const renderer = validateAsOf(value)
      expect(isValidEvidenceAsOf(value), value).toBe(
        renderer.ok && renderer.value === value
      )
    }
  })

  test('labels say which time the evidence is as of (English)', () => {
    expect(asOfLabel(undefined)).toBe('As of: now (latest state)')
    expect(asOfLabel('2026-03-01')).toContain('As of 2026-03-01 00:00')
    expect(asOfLabel('2026-03-01T10:30')).toBe('As of 2026-03-01 10:30 (local time zone)')
    expect(asOfLabel('bogus')).toBe('As of: invalid time, request not sent')
  })

  test('labels say which time the evidence is as of (zh)', () => {
    setLocale('zh')
    expect(asOfLabel(undefined)).toBe('截至：现在（最新状态）')
    expect(asOfLabel('2026-03-01')).toContain('截至 2026-03-01 00:00')
    expect(asOfLabel('2026-03-01T10:30')).toBe('截至 2026-03-01 10:30（本机时区）')
    expect(asOfLabel('2026-03-01T10:30:00Z')).toBe('截至 2026-03-01T10:30:00Z')
    expect(asOfLabel('bogus')).toBe('截至：时间不合法，未发送请求')
    expect(toDateTimeLocalValue('2026-03-01')).toBe('2026-03-01T00:00')
    expect(toDateTimeLocalValue('2026-03-01T10:30:15')).toBe('2026-03-01T10:30')
    expect(toDateTimeLocalValue('2026-03-01T10:30:00Z')).toBe('')
    setLocale('en')
  })
})

describe('S1-03 asOf passes through IPC → RuntimeClient → REST', () => {
  const seen: string[] = []
  let server: http.Server
  let root: string
  const savedRoot = process.env.PERSOME_ROOT
  const TOKEN = 'test-token-0123456789abcdef'

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      seen.push(request.url ?? '')
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          reference: url.searchParams.get('ref'),
          kind: 'point',
          id: 'x',
          status: 'active',
          label: 'x',
          metadata: { echoed_as_of: url.searchParams.get('as_of') },
          sources: [],
          context: [],
          history: []
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    root = mkdtempSync(join(tmpdir(), 'lens-evidence-asof-'))
    writeFileSync(join(root, 'config.toml'), `[mcp]\nport = ${port}\n`)
    writeFileSync(join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${TOKEN}\n`)
    chmodSync(join(root, 'env'), 0o600)
    process.env.PERSOME_ROOT = root
    const { registerIpc } = await import('../../src/main/ipc')
    registerIpc()
  })

  afterAll(async () => {
    if (savedRoot === undefined) delete process.env.PERSOME_ROOT
    else process.env.PERSOME_ROOT = savedRoot
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (root && root.startsWith(join(tmpdir(), 'lens-evidence-asof-'))) rmSync(root, { recursive: true, force: true })
  })

  const invoke = (args: unknown) =>
    handlers.get('lens:model:evidence')!({}, args) as Promise<
      { ok: true; data: { metadata: { echoed_as_of: string | null } } } | { ok: false; error: { message: string } }
    >

  test('ISO date and datetime reach /model/evidence as as_of verbatim', async () => {
    for (const asOf of ['2026-03-01', '2026-03-01T10:00:00+08:00']) {
      seen.length = 0
      const result = await invoke({ ref: '⟨pt-1:a.md⟩', asOf })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.metadata.echoed_as_of).toBe(asOf)
      expect(seen).toHaveLength(1)
      const url = new URL(seen[0], 'http://127.0.0.1')
      expect(url.pathname).toBe('/model/evidence')
      expect(url.searchParams.get('as_of')).toBe(asOf)
      expect(url.searchParams.get('ref')).toBe('⟨pt-1:a.md⟩')
    }
  })

  test('no asOf / empty asOf → no as_of param (unchanged behaviour)', async () => {
    for (const args of [{ ref: 'pt-1' }, { ref: 'pt-1', asOf: '' }]) {
      seen.length = 0
      const result = await invoke(args)
      expect(result.ok).toBe(true)
      expect(new URL(seen[0], 'http://127.0.0.1').searchParams.has('as_of')).toBe(false)
    }
  })

  test.each(['20260301', '2026-02-30', '2026-03-01 10:00', 'yesterday'])(
    'invalid asOf %s is rejected in main with a readable error and never sent',
    async (asOf) => {
      seen.length = 0
      const result = await invoke({ ref: 'pt-1', asOf })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid arguments')
        expect(result.error.message).toContain(evidenceAsOfError())
      }
      expect(seen).toHaveLength(0)
    }
  )

  test('RuntimeClient itself refuses an invalid asOf without a request', async () => {
    seen.length = 0
    const port = (server.address() as AddressInfo).port
    const client = new RuntimeClient(port, TOKEN)
    await expect(client.evidence('pt-1', '20260301')).rejects.toThrow(evidenceAsOfError())
    expect(seen).toHaveLength(0)
    const ok = await client.evidence('pt-1', '2026-03-01T10:00')
    expect((ok.metadata as { echoed_as_of: string }).echoed_as_of).toBe('2026-03-01T10:00')
  })
})
