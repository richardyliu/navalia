import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConfirmChallenge, DestructiveActionId } from './api'
import { tr } from '../../shared/i18n'

/**
 * Two-step confirmation for destructive recovery actions, owned by main:
 *  1. `issue(action)` returns a short-lived random nonce plus the phrase the user must type.
 *  2. `consume(action, nonce, phrase)` succeeds once. Any attempt (right or wrong) burns the
 *     nonce, so a wrong phrase, an expired nonce, or a replay all require a fresh `issue`.
 * The renderer can never mint a nonce; only main's in-memory table can.
 */

export const CONFIRM_TTL_MS = 60_000
const MAX_OUTSTANDING = 8

/** Phrase and warning follow the active UI locale (getters). The phrase is pinned per challenge at `issue`. */
export const CONFIRM_SPECS: Record<DestructiveActionId, { readonly phrase: string; readonly warning: string }> = {
  'rebuild-captures-index': {
    get phrase() {
      return tr('rebuild capture index', '重建采集索引')
    },
    get warning() {
      return tr(
        'Runtime is stopped first, then Runtime itself runs `persome rebuild-captures-index --merge` (one transaction; merge mode deletes no old rows) and is started again afterwards. Capture and search are unavailable meanwhile. Navalia never opens or modifies index.db directly.',
        '会先停止 Runtime，再由 Runtime 自己执行 `persome rebuild-captures-index --merge`（单事务，合并模式不删除旧行），完成后重新启动 Runtime。期间采集与检索不可用。Navalia 不会直接打开或修改 index.db。'
      )
    }
  }
}

export class ConfirmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfirmError'
  }
}

interface Pending {
  action: DestructiveActionId
  expiresAt: number
  /** The phrase shown when this challenge was issued (locale at issue time). */
  phrase: string
}

export function createConfirmGate(opts: { now?: () => number; ttlMs?: number } = {}) {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? CONFIRM_TTL_MS
  const pending = new Map<string, Pending>()

  function sweep(): void {
    const t = now()
    for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k)
  }

  return {
    issue(action: DestructiveActionId): ConfirmChallenge {
      const spec = CONFIRM_SPECS[action]
      if (!spec) throw new ConfirmError(tr('Unknown action', '未知的操作'))
      sweep()
      // Bound the table: the oldest outstanding challenge is dropped first.
      while (pending.size >= MAX_OUTSTANDING) {
        const first = pending.keys().next().value as string
        pending.delete(first)
      }
      const nonce = randomBytes(16).toString('hex')
      const expiresAt = now() + ttl
      const phrase = spec.phrase
      pending.set(nonce, { action, expiresAt, phrase })
      return { action, nonce, phrase, expiresAt: new Date(expiresAt).toISOString(), warning: spec.warning }
    },

    /** Throws ConfirmError unless the nonce is live, unused, for this action, and the phrase matches. */
    consume(action: DestructiveActionId, nonce: string, phrase: string): void {
      const entry = pending.get(nonce)
      pending.delete(nonce)
      if (!entry) throw new ConfirmError(tr('This confirmation is no longer valid or was already used. Start the confirmation again.', '确认已失效或已被使用，请重新发起确认'))
      if (entry.expiresAt <= now()) throw new ConfirmError(tr('This confirmation has expired. Start the confirmation again.', '确认已过期，请重新发起确认'))
      if (entry.action !== action) throw new ConfirmError(tr('This confirmation does not match the action. Start the confirmation again.', '确认与操作不匹配，请重新发起确认'))
      const want = Buffer.from(entry.phrase, 'utf8')
      const got = Buffer.from(phrase.trim(), 'utf8')
      if (want.length !== got.length || !timingSafeEqual(want, got)) {
        throw new ConfirmError(tr('The confirmation phrase is incorrect. This confirmation is now void; start again.', '输入的确认短语不正确，本次确认已作废，请重新发起'))
      }
    },

    outstanding(): number {
      sweep()
      return pending.size
    }
  }
}

export type ConfirmGate = ReturnType<typeof createConfirmGate>
