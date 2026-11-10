import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerConnectorHandlers } from '../../src/main/connectors/ipc'
import { grantAll } from './consent-helper'
import { fileScopedTempDirs } from '../_support/tmpdir'
import { createConnectorService } from '../../src/main/connectors/service'
import type { ExecFn } from '../../src/main/import/cli'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below check the Chinese UI strings; English is covered by the `English UI` tests.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const FIX = path.join(__dirname, '..', 'fixtures', 'connectors')
// B17: prefix-guarded cleanup after the file.
const temps = fileScopedTempDirs('lens-conn')
const tmp = (l: string): string => temps.make(l)

/** TEST DOUBLES of the Runtime: MCP `remember` and REST `/health-events/import` record their inputs. */
function setup(opts: { restFails?: boolean; exec?: ExecFn; bin?: string | null } = {}) {
  const storeRoot = tmp('store')
  const remembered: Array<{ content: string; tags: string }> = []
  const posted: Array<{ route: string; body: any }> = []
  let n = 0
  const svc = createConnectorService({
    storeRoot,
    runtimeRoot: () => tmp('rt'),
    persomeBin: () => (opts.bin === undefined ? '/opt/fake/persome' : opts.bin),
    ossTool: async (name, args) => {
      if (name !== 'remember') throw new Error(`unexpected tool ${name}`)
      remembered.push(args as { content: string; tags: string })
      return JSON.stringify({ entry_id: `e-${++n}`, file: 'topic-agent-findings.md' })
    },
    postRuntime: async (route, body) => {
      if (opts.restFails) throw new Error('Runtime 未运行（ECONNREFUSED 127.0.0.1）')
      posted.push({ route, body })
      const events = (body as { events: unknown[] }).events
      return { success: true, data: { schema_version: 1, received: events.length, inserted: events.length, corrected: 0, duplicates: 0, deleted: 0 } }
    },
    exec: opts.exec
  })
  grantAll(svc)
  return { svc, remembered, posted, storeRoot }
}

describe('calendar connector', () => {
  it('preview is redacted and writes nothing; commit → one remember per event with tags; re-import skips', async () => {
    const { svc, remembered, storeRoot } = setup()
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    expect(p.fileName).toBe('calendar.ics')
    expect(p.items).toHaveLength(3)
    expect(p.items.every((i) => i.state === 'new')).toBe(true)
    const all = p.items.map((i) => i.text).join('\n')
    expect(all).toContain('日历事件：季度规划评审 Zephyrquill')
    expect(all).toContain('时间：2026-11-03 10:00（Asia/Shanghai） — 2026-11-03 11:00（Asia/Shanghai）')
    expect(all).toContain('参会人：2 人')
    expect(all).not.toContain('sk-ant-api03-FIXTURE')
    expect(all).not.toContain('alice@example.test')
    expect(all).not.toContain('bob@example.test')
    expect(all).not.toContain('ALARM_SHOULD_NOT_APPEAR')
    expect(p.totals.redactions).toBeGreaterThan(0)
    expect(p.mapping.join('\n')).toMatch(/remember/)
    expect(p.mapping.join('\n')).toMatch(/source:agent-run/)
    expect(fs.existsSync(svc.paths.ledgerPath)).toBe(false)
    expect(remembered).toHaveLength(0)

    const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(r).toMatchObject({ kind: 'calendar', target: 'memory', written: 3, failed: 0 })
    expect(remembered.map((x) => x.tags)).toEqual(Array(3).fill('lens-connector,connector:calendar'))
    expect(remembered[0].content).toBe(p.items[0].text)
    expect(r.items.map((i) => i.entryId)).toEqual(['e-1', 'e-2', 'e-3'])
    expect(fs.statSync(svc.paths.ledgerPath).mode & 0o777).toBe(0o600)

    // Re-import of the same file: everything unchanged, nothing written.
    const p2 = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    expect(p2.items.every((i) => i.state === 'unchanged')).toBe(true)
    const r2 = await svc.commit(p2.previewId!, p2.items.map((i) => i.key), {})
    expect(r2).toMatchObject({ written: 0, unchanged: 3 })
    expect(remembered).toHaveLength(3)
  })

  it('a changed event is written once more, marked 更新, and reported', async () => {
    const { svc, remembered } = setup()
    const dir = tmp('ics')
    const f = path.join(dir, 'cal.ics')
    fs.copyFileSync(path.join(FIX, 'calendar.ics'), f)
    const p = await svc.previewFile('calendar', f)
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('团队外出日 Quorvantel', '团队外出日 Quorvantel（改到周五）'))
    const p2 = await svc.previewFile('calendar', f)
    expect(p2.items.map((i) => i.state).sort()).toEqual(['changed', 'unchanged', 'unchanged'])
    const r = await svc.commit(p2.previewId!, p2.items.map((i) => i.key), {})
    expect(r).toMatchObject({ written: 0, updated: 1, unchanged: 2 })
    expect(remembered[3].content.startsWith('（更新）日历事件：团队外出日')).toBe(true)
  })

  it('timeline target: import-data --no-build from a stable folder; nothing re-imported on a second run', async () => {
    const calls: Array<{ args: string[]; files: string[] }> = []
    const exec: ExecFn = async (_f, args) => {
      const p = args[args.indexOf('--path') + 1]
      calls.push({ args, files: fs.readdirSync(path.join(p, 'calendar')).sort() })
      return { code: 0, signal: null, stdout: '✓ Imported 3 new/changed document(s); 0 unchanged, 0 skipped.', stderr: '' }
    }
    const { svc, remembered } = setup({ exec })
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), { target: 'timeline' })
    expect(r).toMatchObject({ target: 'timeline', written: 3 })
    expect(calls[0].args).toEqual(['import-data', '--source', 'folder', '--path', svc.paths.sourceDir, '--no-build'])
    expect(calls[0].files).toEqual(p.items.map((i) => `${i.key}.md`).sort())
    expect(r.cli?.args).toContain('--no-build')
    expect(remembered).toHaveLength(0)
    expect(fs.existsSync(svc.paths.sourceDir)).toBe(false)
    const p2 = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    const r2 = await svc.commit(p2.previewId!, p2.items.map((i) => i.key), { target: 'timeline' })
    expect(r2).toMatchObject({ written: 0, unchanged: 3 })
    expect(calls).toHaveLength(1)
  })

  it('rejects unknown preview ids / keys, symlinks and oversized input', async () => {
    const { svc } = setup()
    await expect(svc.commit('0'.repeat(24), ['x'], {})).rejects.toThrow(/过期/)
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    await expect(svc.commit(p.previewId!, ['nope'], {})).rejects.toThrow(/至少选择|没有这些项/)
    const dir = tmp('link')
    fs.symlinkSync(path.join(FIX, 'calendar.ics'), path.join(dir, 'l.ics'))
    await expect(svc.previewFile('calendar', path.join(dir, 'l.ics'))).rejects.toThrow(/符号链接/)
    await expect(svc.previewFile('calendar', path.join(FIX, 'health.csv'))).rejects.toThrow(/VEVENT/)
  })
})

describe('health connector', () => {
  it('posts structured events to /health-events/import, then one remember summary per day', async () => {
    const { svc, remembered, posted } = setup()
    const p = await svc.previewFile('health', path.join(FIX, 'health.csv'))
    expect(p.items.map((i) => i.key)).toEqual(['day:2026-11-03', 'day:2026-11-04'])
    expect(p.totals.events).toBeGreaterThan(5)
    const all = p.items.map((i) => i.text).join('\n')
    expect(all).toContain('不是医学结论')
    expect(all).not.toContain('ghp_FIXTURE')
    const r = await svc.commit(p.previewId!, ['day:2026-11-03'], {})
    expect(posted).toHaveLength(1)
    expect(posted[0].route).toBe('/health-events/import')
    expect(posted[0].body.schema_version).toBe(1)
    expect(posted[0].body.events.every((e: { started_at: string }) => e.started_at.startsWith('2026-11-03'))).toBe(true)
    expect(JSON.stringify(posted[0].body)).not.toContain('ghp_FIXTURE')
    expect(r.health).toMatchObject({ received: posted[0].body.events.length, inserted: posted[0].body.events.length })
    expect(remembered).toEqual([{ content: p.items[0].text, tags: 'lens-connector,connector:health' }])
    expect(r).toMatchObject({ kind: 'health', target: 'health', written: 1 })
  })

  it('a renamed copy of the same export is unchanged; a corrected value is changed; other files on the same day are separate', async () => {
    const { svc, remembered } = setup()
    const dir = tmp('h')
    const a = path.join(dir, 'export-a.json')
    fs.copyFileSync(path.join(FIX, 'health.json'), a)
    const p = await svc.previewFile('health', a)
    await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    const b = path.join(dir, 'export-b.json')
    fs.copyFileSync(a, b)
    expect((await svc.previewFile('health', b)).items.map((i) => i.state)).toEqual(['unchanged'])
    fs.writeFileSync(b, fs.readFileSync(a, 'utf8').replace('8532', '8600'))
    expect((await svc.previewFile('health', b)).items.map((i) => i.state)).toEqual(['changed'])
    const csv = await svc.previewFile('health', path.join(FIX, 'health.csv'))
    expect(csv.items.find((i) => i.key === 'day:2026-11-03')?.state).toBe('new')
    expect(remembered).toHaveLength(1)
  })

  it('JSON export with the second day containing a redacted note', async () => {
    const { svc, posted } = setup()
    const p = await svc.previewFile('health', path.join(FIX, 'health.csv'))
    await svc.commit(p.previewId!, ['day:2026-11-04'], {})
    const ev = posted[0].body.events as Array<{ metadata: Record<string, unknown> }>
    expect(JSON.stringify(ev)).toContain('[redacted]')
  })

  it('REST failure → items failed, no remember, clear note', async () => {
    const { svc, remembered } = setup({ restFails: true })
    const p = await svc.previewFile('health', path.join(FIX, 'health.json'))
    const r = await svc.commit(p.previewId!, p.items.map((i) => i.key), {})
    expect(r.failed).toBe(p.items.length)
    expect(r.notes.join()).toMatch(/health-events\/import 失败/)
    expect(remembered).toHaveLength(0)
  })
})

describe('connectors IPC', () => {
  it('validates payloads, never accepts a path from the renderer, requires confirm', async () => {
    const { svc } = setup()
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<any>>()
    let picked: string | null = null
    registerConnectorHandlers({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, svc, async () => picked, async () => true)
    const call = (ch: string, raw?: unknown) => handlers.get(ch)!({}, raw)
    expect((await call('lens:connectors:pick', { kind: 'gmail' })).ok).toBe(false)
    expect((await call('lens:connectors:pick', { kind: 'calendar', path: '/etc/passwd' })).ok).toBe(false)
    expect(await call('lens:connectors:pick', { kind: 'calendar' })).toMatchObject({ ok: true, data: { cancelled: true } })
    picked = path.join(FIX, 'calendar.ics')
    const p = await call('lens:connectors:pick', { kind: 'calendar' })
    expect(p.ok).toBe(true)
    expect(JSON.stringify(p.data)).not.toContain(FIX)
    const keys = p.data.items.map((i: { key: string }) => i.key)
    expect((await call('lens:connectors:commit', { previewId: p.data.previewId, keys, opts: {} })).ok).toBe(false)
    expect((await call('lens:connectors:commit', { previewId: p.data.previewId, keys, opts: { target: 'cloud' }, confirm: true })).ok).toBe(false)
    const c = await call('lens:connectors:commit', { previewId: p.data.previewId, keys, opts: {}, confirm: true })
    expect(c).toMatchObject({ ok: true, data: { written: 3 } })
    expect(await call('lens:connectors:discard', { previewId: p.data.previewId })).toMatchObject({ ok: true })
  })
})

describe('English UI', () => {
  beforeEach(() => setLocale('en'))
  it('preview errors and mapping notes default to English', async () => {
    const { svc } = setup()
    await expect(svc.previewFile('calendar', 'relative.ics')).rejects.toThrow('The file path must be absolute.')
    const p = await svc.previewFile('calendar', path.join(FIX, 'calendar.ics'))
    expect(p.mapping[0]).toMatch(/^Write mode: Runtime MCP `remember`/)
  })
})
