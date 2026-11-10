import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readDeltaReport, trimDeltaReport, type ExecFn } from '../../src/main/runtime/deltaReport'

const report = {
  aggregate: { rows: 3, sessions: 2, heads: { facts: 4 }, dropped_by_gates: 5 },
  recent: [{ session_id: 's1', created_at: '2026-11-04T10:00:00', status: 'shadow', dropped: 2, payload: '{"facts":["SECRET memory text"]}' }]
}

describe('S1-01 delta-report counts', () => {
  it('keeps only counters and drops row payloads', () => {
    const trimmed = trimDeltaReport(report)
    expect(trimmed.aggregate).toEqual({ rows: 3, sessions: 2, dropped_by_gates: 5 })
    expect(trimmed.recent).toEqual([{ session_id: 's1', created_at: '2026-11-04T10:00:00', status: 'shadow', dropped: 2 }])
    expect(JSON.stringify(trimmed)).not.toContain('SECRET')
  })

  it('rejects output without dropped_by_gates instead of reporting 0', () => {
    expect(() => trimDeltaReport({ aggregate: { rows: 1 } })).toThrow(/dropped_by_gates/)
    expect(() => trimDeltaReport(null)).toThrow()
  })

  it('invokes the CLI with exact args and PERSOME_ROOT, then removes the temp file', async () => {
    let seen: { file: string; args: string[]; root?: string } | null = null
    const exec: ExecFn = async (file, args, options) => {
      seen = { file, args, root: options.env.PERSOME_ROOT }
      fs.writeFileSync(args[args.indexOf('--json-out') + 1], JSON.stringify(report))
    }
    const out = await readDeltaReport('/bin/persome', '/tmp/root', 20, exec)
    expect(out.aggregate.dropped_by_gates).toBe(5)
    expect(seen!.file).toBe('/bin/persome')
    expect(seen!.args.slice(0, 3)).toEqual(['delta-report', '--limit', '20'])
    expect(seen!.root).toBe('/tmp/root')
    const tmp = seen!.args[seen!.args.indexOf('--json-out') + 1]
    expect(fs.existsSync(tmp)).toBe(false)
  })

  it('surfaces a CLI failure and still cleans up', async () => {
    let tmp = ''
    const exec: ExecFn = async (_f, args) => {
      tmp = args[args.indexOf('--json-out') + 1]
      throw new Error('exit 1')
    }
    await expect(readDeltaReport('/bin/persome', '/tmp/root', 5, exec)).rejects.toThrow(/exit 1/)
    expect(fs.existsSync(tmp)).toBe(false)
  })

  it('fails clearly when persome is not installed', async () => {
    await expect(readDeltaReport(null, '/tmp/root', 5)).rejects.toThrow(/persome/)
  })
})

describe('S1-01 delta-report security fixes', () => {
  it('sweeps stale report dirs but keeps fresh ones and foreign names', async () => {
    const os = await import('node:os')
    const path = await import('node:path')
    const { sweepStaleDeltaDirs } = await import('../../src/main/runtime/deltaReport')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'))
    const stale = path.join(root, 'lens-delta-old'); fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, 'report.json'), '{"payload":"x"}')
    const fresh = path.join(root, 'lens-delta-new'); fs.mkdirSync(fresh)
    const other = path.join(root, 'other-old'); fs.mkdirSync(other)
    const old = new Date(Date.now() - 60 * 60_000); fs.utimesSync(stale, old, old); fs.utimesSync(other, old, old)
    expect(sweepStaleDeltaDirs(root)).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
    if (root.startsWith(path.join(os.tmpdir(), 'sweep-test-'))) fs.rmSync(root, { recursive: true, force: true })
  })

  it('never forwards the raw error (command line / secrets) to the renderer', async () => {
    const exec: ExecFn = async () => {
      throw new Error('Command failed: /bin/persome delta-report --json-out /tmp/x\napi_key=sk-ant-FAKE0123456789abcdefghijklmnop')
    }
    const err = await readDeltaReport('/bin/persome', '/tmp/root', 5, exec).catch((e: Error) => e)
    expect(err.message).not.toContain('sk-ant-FAKE0123456789abcdefghijklmnop')
    expect(err.message).toMatch(/Reading drop counts failed/)
  })
})
