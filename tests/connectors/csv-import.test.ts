// C19 generic CSV connector: RFC 4180 edge cases, mapping guess / validation, redaction, service
// preview → re-map → commit (remember with csv tags, or import-data timeline), IPC validation.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCsv } from '../../src/main/connectors/csv'
import { csvItems, guessMapping, sanitizeTags, validateMapping } from '../../src/main/connectors/csv-import'
import { registerConnectorHandlers } from '../../src/main/connectors/ipc'
import { createConnectorService } from '../../src/main/connectors/service'
import type { ExecFn } from '../../src/main/import/cli'
import { grantAll } from './consent-helper'
import { rmTmp, tmpDir } from './tmp-helper'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

describe('RFC 4180 parsing', () => {
  it('quotes, doubled quotes, embedded newlines / delimiters, CRLF, BOM', () => {
    const t = parseCsv('﻿date,title,body\r\n2026-11-03,"Hello, world","line 1\r\nline ""2"""\r\n2026-11-04,Plain,"x"\r\n')
    expect(t.header).toEqual(['date', 'title', 'body'])
    expect(t.delimiter).toBe(',')
    expect(t.rows).toEqual([
      ['2026-11-03', 'Hello, world', 'line 1\r\nline "2"'],
      ['2026-11-04', 'Plain', 'x']
    ])
  })

  it('detects ; and tab delimiters from the header; tolerates a missing final newline and blank lines', () => {
    expect(parseCsv('a;b;c\n1;"2;3";4').rows).toEqual([['1', '2;3', '4']])
    expect(parseCsv('a;b\n1;2').delimiter).toBe(';')
    expect(parseCsv('a\tb\n1\t2\n\n3\t4\n').rows).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('row cap marks truncated', () => {
    const t = parseCsv(`a\n${Array.from({ length: 20 }, (_, i) => i).join('\n')}\n`, 5)
    expect(t.rows).toHaveLength(5)
    expect(t.truncated).toBe(true)
  })
})

describe('mapping', () => {
  it('guesses date / title / body / tags by header names (en + zh); falls back to every column as body', () => {
    expect(guessMapping(parseCsv('日期,标题,内容,标签\n2026-11-03,a,b,c'))).toEqual({ date: 0, title: 1, body: [2], tags: 3 })
    expect(guessMapping(parseCsv('Created At,Subject,Notes\n2026-11-03 10:00,a,b'))).toEqual({ date: 0, title: 1, body: [2], tags: null })
    // Unknown headers: a date-looking column is found by value; everything else is body.
    expect(guessMapping(parseCsv('when?,foo,bar\n2026-11-03,a,b\n2026-11-04,c,d'))).toEqual({ date: 0, title: null, body: [1, 2], tags: null })
  })

  it('validates indexes and requires a title or a body column', () => {
    expect(validateMapping({ date: null, title: null, body: [], tags: null }, 3)).toMatch(/至少/)
    expect(validateMapping({ date: 5, title: 0, body: [], tags: null }, 3)).toMatch(/超出/)
    expect(validateMapping({ date: null, title: 0, body: [1, 1], tags: null }, 3)).toMatch(/重复/)
    expect(validateMapping({ date: 0, title: 1, body: [2], tags: null }, 3)).toBeNull()
  })

  it('tags: split, normalised, unsafe / secret-looking values dropped, capped', () => {
    expect(sanitizeTags('Work, 项目 A；urgent|work, a/b, sk-ant-api03-ABCDEFGHIJKLMNOP')).toEqual(['work', '项目-a', 'urgent'])
  })

  it('items: only mapped columns are written, every value redacted, identity independent of the file name', () => {
    const t = parseCsv('date,title,body,secret_col\n2026-11-03,Plan Brindle,"call alice@example.test re token ghp_abcdefghijklmnopqrstuvwxyz0123456789",UNMAPPED_VALUE\n')
    const a = csvItems(t, { date: 0, title: 1, body: [2], tags: null }, 'a.csv')
    const b = csvItems(t, { date: 0, title: 1, body: [2], tags: null }, 'renamed.csv')
    expect(a.items[0].key).toBe(b.items[0].key)
    const text = a.items[0].text
    expect(text).toContain('CSV 记录：Plan Brindle')
    expect(text).toContain('时间：2026-11-03')
    expect(text).not.toContain('alice@example.test')
    expect(text).not.toContain('ghp_abcdef')
    expect(text).not.toContain('UNMAPPED_VALUE')
    expect(a.items[0].redactions).toBeGreaterThan(0)
  })
})

function setup(exec?: ExecFn) {
  const storeRoot = tmpDir('csv-store')
  const remembered: Array<{ content: string; tags: string }> = []
  const svc = grantAll(
    createConnectorService({
      storeRoot,
      runtimeRoot: () => storeRoot,
      persomeBin: () => '/opt/fake/persome',
      ossTool: async (_n, a) => {
        remembered.push(a as { content: string; tags: string })
        return JSON.stringify({ entry_id: `e-${remembered.length}` })
      },
      postRuntime: async () => ({}),
      exec
    })
  )
  return { svc, storeRoot, remembered }
}

const CSV = 'Date;Title;Notes;Tags;Private\n2026-11-03;Kickoff Vantrel;"first ""draft""\nsecond line";work, q4;DO-NOT-WRITE-1\n2026-11-05;Retro;went fine;work;DO-NOT-WRITE-2\n;;;;DO-NOT-WRITE-3\n'

describe('CSV connector service', () => {
  it('preview guesses a mapping; re-map changes items; commit → remember with connector:csv + csv-tag:*; re-import unchanged', async () => {
    const { svc, storeRoot, remembered } = setup()
    const f = path.join(storeRoot, 'notes.csv')
    fs.writeFileSync(f, CSV)
    const p = await svc.previewFile('csv', f)
    expect(p.csv?.mapping).toEqual({ date: 0, title: 1, body: [2], tags: 3 })
    expect(p.csv?.delimiter).toBe(';')
    expect(p.items).toHaveLength(2)
    expect(p.warnings.join()).toMatch(/1 行在所选列里没有内容/)
    expect(JSON.stringify(p.items)).not.toContain('DO-NOT-WRITE')
    expect(p.items[0].text).toContain('first "draft"\nsecond line')
    expect(p.items[0].text).toContain('标签：work、q4')
    // Re-map: no body column, title only → different keys / texts; old preview is gone.
    const p2 = svc.csvMap(p.previewId!, { date: 0, title: 1, body: [], tags: null })
    expect(p2.items[0].text).not.toContain('second line')
    await expect(svc.commit(p.previewId!, [p.items[0].key], {})).rejects.toThrow(/过期/)
    expect(() => svc.csvMap(p2.previewId!, { date: 9, title: 1, body: [], tags: null })).toThrow(/超出/)
    const p3 = svc.csvMap(p2.previewId!, { date: 0, title: 1, body: [2], tags: 3 })
    expect(p3.items.map((i) => i.key)).toEqual(p.items.map((i) => i.key))
    const r = await svc.commit(p3.previewId!, p3.items.map((i) => i.key), {})
    expect(r).toMatchObject({ kind: 'csv', target: 'memory', written: 2 })
    expect(remembered.map((x) => x.tags)).toEqual(['lens-connector,connector:csv,csv-tag:work,csv-tag:q4', 'lens-connector,connector:csv,csv-tag:work'])
    const again = await svc.previewFile('csv', f)
    expect(again.items.every((i) => i.state === 'unchanged')).toBe(true)
    rmTmp(storeRoot)
  })

  it('timeline target: import-data --no-build from <source>/csv; ledger counts timeline docs', async () => {
    const calls: Array<{ args: string[]; files: string[] }> = []
    const exec: ExecFn = async (_f, args) => {
      const p = args[args.indexOf('--path') + 1]
      calls.push({ args, files: fs.readdirSync(path.join(p, 'csv')).sort() })
      return { code: 0, signal: null, stdout: '✓ Imported 2 new/changed document(s); 0 unchanged, 0 skipped.', stderr: '' }
    }
    const { svc, storeRoot, remembered } = setup(exec)
    const f = path.join(storeRoot, 'n.csv')
    fs.writeFileSync(f, CSV)
    const p = await svc.previewFile('csv', f)
    const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), { target: 'timeline' })
    expect(r).toMatchObject({ target: 'timeline', written: 2 })
    expect(calls[0].args.slice(-1)).toEqual(['--no-build'])
    expect(calls[0].files).toEqual(p.items.map((i) => `${i.key}.md`).sort())
    expect(remembered).toHaveLength(0)
    expect(svc.ledger().connectors).toEqual([expect.objectContaining({ kind: 'csv', timelineDocs: 2, memoryEntries: 0 })])
    rmTmp(storeRoot)
  })

  it('IPC: csv-map validates the mapping shape; keys for rows are accepted by commit', async () => {
    const { svc, storeRoot } = setup()
    const f = path.join(storeRoot, 'n.csv')
    fs.writeFileSync(f, CSV)
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<any>>()
    registerConnectorHandlers({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, svc, async () => f, async () => true)
    const p = await handlers.get('lens:connectors:pick')!({}, { kind: 'csv' })
    expect(p.ok).toBe(true)
    expect(JSON.stringify(p.data)).not.toContain(storeRoot)
    expect((await handlers.get('lens:connectors:csv-map')!({}, { previewId: p.data.previewId, mapping: { date: -1, title: 1, body: [], tags: null } })).ok).toBe(false)
    expect((await handlers.get('lens:connectors:csv-map')!({}, { previewId: p.data.previewId, mapping: { date: 0, title: 1, body: [], tags: null, extra: 1 } })).ok).toBe(false)
    const m = await handlers.get('lens:connectors:csv-map')!({}, { previewId: p.data.previewId, mapping: { date: 0, title: 1, body: [2], tags: 3 } })
    expect(m.ok).toBe(true)
    const c = await handlers.get('lens:connectors:commit')!({}, { previewId: m.data.previewId, keys: m.data.items.map((i: { key: string }) => i.key), opts: {}, confirm: true })
    expect(c).toMatchObject({ ok: true, data: { written: 2 } })
    rmTmp(storeRoot)
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('mapping errors default to English', () => {
    expect(validateMapping({ date: null, title: null, body: [], tags: null }, 3)).toBe('Choose at least a title column or one body column.')
    expect(validateMapping({ date: null, title: 0, body: [1, 1], tags: null }, 3)).toMatch(/chosen twice/)
  })
})
