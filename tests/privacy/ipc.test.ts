import { describe, expect, test } from 'vitest'
import { PRIVACY_CHANNELS } from '../../src/main/privacy/api'
import { DeleteArgs, IssueArgs, WithdrawArgs, registerPrivacyHandlers, toPrivacyError } from '../../src/main/privacy/ipc'
import { PrivacyError, type PrivacyService } from '../../src/main/privacy/service'

const NONCE = 'ab'.repeat(16)

describe('privacy IPC schemas (zod, strict)', () => {
  test('issue accepts only known actions', () => {
    expect(IssueArgs.safeParse({ action: 'delete-captures' }).success).toBe(true)
    expect(IssueArgs.safeParse({ action: 'rm -rf' }).success).toBe(false)
    expect(IssueArgs.safeParse({ action: 'withdraw-all', extra: 1 }).success).toBe(false)
  })

  test('delete requires target enum, 32-hex nonce, bounded phrase, boolean backupFirst; no paths', () => {
    expect(DeleteArgs.safeParse({ target: 'captures', nonce: NONCE, phrase: 'x', backupFirst: false }).success).toBe(true)
    expect(DeleteArgs.safeParse({ target: 'index.db', nonce: NONCE, phrase: 'x', backupFirst: false }).success).toBe(false)
    expect(DeleteArgs.safeParse({ target: 'captures', nonce: 'zz', phrase: 'x', backupFirst: false }).success).toBe(false)
    expect(DeleteArgs.safeParse({ target: 'captures', nonce: NONCE, phrase: 'x'.repeat(201), backupFirst: false }).success).toBe(false)
    expect(DeleteArgs.safeParse({ target: 'captures', nonce: NONCE, phrase: 'x', backupFirst: false, path: '/tmp' }).success).toBe(false)
    expect(DeleteArgs.safeParse({ target: 'captures', nonce: NONCE, phrase: 'x' }).success).toBe(false)
    expect(WithdrawArgs.safeParse({ nonce: NONCE, phrase: 'x' }).success).toBe(true)
    expect(WithdrawArgs.safeParse({ nonce: NONCE }).success).toBe(false)
  })
})

describe('privacy IPC handlers return LensResult with sanitized errors', () => {
  function harness(service: Partial<PrivacyService>) {
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
    registerPrivacyHandlers({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, service as PrivacyService, (s) =>
      s.replace(/sekret-token/g, '[redacted]')
    )
    return (ch: string, raw?: unknown) => handlers.get(ch)!(null, raw) as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  }

  test('all five channels registered; bad args → ok:false without calling the service', async () => {
    let called = 0
    const call = harness({ deleteRun: async () => (called++, null as never), retention: () => null as never })
    expect(Object.values(PRIVACY_CHANNELS)).toHaveLength(5)
    const r = await call(PRIVACY_CHANNELS.deleteRun, { target: 'all', nonce: 'nope', phrase: 'x', backupFirst: true })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/Invalid arguments/)
    expect(called).toBe(0)
    expect((await call(PRIVACY_CHANNELS.retention, { anything: 1 })).ok).toBe(false)
  })

  test('service errors are scrubbed and capped', async () => {
    const call = harness({
      withdrawRun: async () => {
        throw new Error(`boom sekret-token ${'y'.repeat(2000)}`)
      },
      deleteRun: async () => {
        throw new PrivacyError('timeout', 'stop failed sekret-token')
      }
    })
    const w = await call(PRIVACY_CHANNELS.withdrawRun, { nonce: NONCE, phrase: 'x' })
    expect(w.ok).toBe(false)
    expect(w.error?.message).not.toContain('sekret-token')
    expect(w.error!.message.length).toBeLessThanOrEqual(500)
    const d = await call(PRIVACY_CHANNELS.deleteRun, { target: 'captures', nonce: NONCE, phrase: 'x', backupFirst: false })
    expect(d.error).toEqual({ code: 'timeout', message: 'stop failed [redacted]' })
  })

  test('OG3: delete / withdraw pass the invoking sender to the service (dialog parent)', async () => {
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
    const got: unknown[] = []
    registerPrivacyHandlers(
      { handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never,
      {
        deleteRun: async (...a: unknown[]) => (got.push(a[4]), null as never),
        withdrawRun: async (...a: unknown[]) => (got.push(a[2]), null as never)
      } as unknown as PrivacyService,
      (s) => s
    )
    const sender = { id: 3 }
    await handlers.get(PRIVACY_CHANNELS.deleteRun)!({ sender }, { target: 'captures', nonce: NONCE, phrase: 'x', backupFirst: false })
    await handlers.get(PRIVACY_CHANNELS.withdrawRun)!({ sender }, { nonce: NONCE, phrase: 'x' })
    expect(got).toEqual([sender, sender])
  })

  test('toPrivacyError never leaks a stack', () => {
    const e = new Error('plain')
    expect(toPrivacyError(e, (s) => s)).toEqual({ code: 'unknown', message: 'plain' })
  })
})
