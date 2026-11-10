// S1-R4-11: the host-binary probe used to skip (not fail) tests in restricted sandboxes.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { probe, psProbe, sandboxExecProbe, type SpawnSyncLike } from '../_support/host-probe'

const fake =
  (r: Partial<ReturnType<SpawnSyncLike>>): SpawnSyncLike =>
  () => ({ status: null, error: undefined, stderr: '', signal: null, ...r })

describe('host probe', () => {
  it('spawn error (EPERM / ENOENT) → not ok, reason names the binary and code', () => {
    const err = Object.assign(new Error('spawnSync /bin/ps EPERM'), { code: 'EPERM' })
    const r = psProbe(fake({ error: err }))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('/bin/ps')
    expect(r.reason).toContain('EPERM')
  })

  it('nested sandbox refused (exit 71) → not ok, first stderr line in the reason', () => {
    const r = sandboxExecProbe('(version 1)(allow default)', fake({ status: 71, stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n' }))
    expect(r).toEqual({ ok: false, reason: '/usr/bin/sandbox-exec: exit 71 (sandbox-exec: sandbox_apply: Operation not permitted)' })
  })

  it('signal → not ok; exit 0 → ok', () => {
    expect(probe('/x', [], fake({ signal: 'SIGKILL' })).ok).toBe(false)
    expect(probe('/x', [], fake({ status: 0 }))).toEqual({ ok: true, reason: null })
  })

  it('real probe agrees with the host (never skips when the binary works)', () => {
    if (process.env.LENS_TEST_NO_PROBE === '1') return
    const real = spawnSync('/bin/ps', ['-ww', '-p', String(process.pid), '-o', 'uid='], { encoding: 'utf8' })
    expect(psProbe().ok).toBe(real.status === 0 && !real.error)
  })
})
