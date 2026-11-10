import { describe, expect, it, vi } from 'vitest'

const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: (e: null, out: string, err: string) => void) => {
    calls.push({ file, args, opts })
    cb(null, '', '')
  }
}))

describe('backup uses the shared execFile wrapper', () => {
  it('passes shell:false, a timeout, maxBuffer and PERSOME_ROOT', async () => {
    const { defaultExec } = await import('../../src/main/import/cli')
    const { MODEL_EXPORT_TIMEOUT_MS } = await import('../../src/main/backup/service')
    await defaultExec('/opt/persome', ['model', 'export', '--out', '/x/model-snapshot.json'], {
      env: { PERSOME_ROOT: '/rt' },
      timeoutMs: MODEL_EXPORT_TIMEOUT_MS
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].opts).toMatchObject({ shell: false, timeout: MODEL_EXPORT_TIMEOUT_MS, env: { PERSOME_ROOT: '/rt' } })
    expect(calls[0].opts.maxBuffer).toBeGreaterThan(0)
  })
})
