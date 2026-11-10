import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { PrivacyActionId, PrivacyChallenge } from './api'
import { tr } from '../../shared/i18n'

/**
 * Two-step confirmation for destructive privacy actions, owned by main (same pattern as the
 * OG-06 Recovery gate and security review #9):
 *  1. `issue(action)` mints a short-lived random nonce and returns the phrase to type.
 *  2. `consume(action, nonce, phrase)` succeeds at most once. Every attempt, right or wrong,
 *     burns the nonce, so a wrong phrase, an expired nonce or a replay all need a fresh `issue`.
 * The renderer can never mint a nonce; only this in-memory table can.
 */

export const PRIVACY_CONFIRM_TTL_MS = 60_000
const MAX_OUTSTANDING = 8

/** Phrase and warning follow the active UI locale (getters). The phrase is pinned per challenge at `issue`. */
export const PRIVACY_CONFIRM_SPECS: Record<PrivacyActionId, { readonly phrase: string; readonly warning: string }> = {
  'delete-captures': {
    get phrase() {
      return tr('delete raw captures', '删除原始采集')
    },
    get warning() {
      return tr(
        'Runtime is stopped first, then Runtime itself runs `persome clean captures --yes`: this deletes every raw frame in capture-buffer (including screenshots), the capture rows in the index and the dedup receipts. Memory and the model are not affected. This cannot be undone.',
        '会先停止 Runtime，再由 Runtime 自己执行 `persome clean captures --yes`：删除 capture-buffer 里的全部原始帧（含截图）、索引中的采集行和去重回执。记忆与模型不受影响。不能撤销。'
      )
    }
  },
  'delete-timeline': {
    get phrase() {
      return tr('delete timeline', '删除时间线')
    },
    get warning() {
      return tr(
        'Runtime is stopped first, then `persome clean timeline --yes` runs: this deletes every minute block (short-window activity summaries). This cannot be undone.',
        '会先停止 Runtime，再执行 `persome clean timeline --yes`：删除全部分钟块（短窗活动摘要）。不能撤销。'
      )
    }
  },
  'delete-memory': {
    get phrase() {
      return tr('delete all memory', '删除全部记忆')
    },
    get warning() {
      return tr(
        'Runtime is stopped first, then `persome clean memory --yes` runs: this deletes every memory file, the personal model (all layers up to the root), and the Runtime export and backup folders. This cannot be undone. Export a backup first.',
        '会先停止 Runtime，再执行 `persome clean memory --yes`：删除全部记忆文件、个人模型（点线面体根）、Runtime 的导出与备份目录。不能撤销。建议先导出备份。'
      )
    }
  },
  'delete-all': {
    get phrase() {
      return tr('delete all personal data', '删除全部个人数据')
    },
    get warning() {
      return tr(
        'Runtime is stopped first, then `persome clean all --yes` runs: this deletes raw captures, timeline, memory, model, exports, backups and Runtime logs; config, env and the installed venv are kept. The Navalia Store (cards, grants, Access log, HET) is not affected. This cannot be undone. Export a backup first.',
        '会先停止 Runtime，再执行 `persome clean all --yes`：删除原始采集、时间线、记忆、模型、导出、备份和 Runtime 日志；保留 config、env 和安装的 venv。Navalia Store（卡片、授权、Access log、HET）不在此范围。不能撤销。建议先导出备份。'
      )
    }
  },
  'withdraw-all': {
    get phrase() {
      return tr('withdraw all connections', '撤回全部连接')
    },
    get warning() {
      return tr(
        'Disconnects every Agent: removes the Navalia entry from the MCP configs of Claude Code / Codex / Claude Desktop / Cursor and revokes every grant (including manual setups). The Access log is not cleared (clear it separately in Connections). You will need to grant access again in Connections.',
        '会断开所有 Agent：从 Claude Code / Codex / Claude Desktop / Cursor 的 MCP 配置里删除 Navalia 条目，并撤销全部授权（含手动配置）。Access log 不会被清空（清空在「连接」页单独操作）。之后要在「连接」里重新授权。'
      )
    }
  }
}

export class PrivacyConfirmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrivacyConfirmError'
  }
}

interface Pending {
  action: PrivacyActionId
  expiresAt: number
  /** The phrase shown when this challenge was issued (locale at issue time). */
  phrase: string
}

export function createPrivacyConfirmGate(opts: { now?: () => number; ttlMs?: number } = {}) {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? PRIVACY_CONFIRM_TTL_MS
  const pending = new Map<string, Pending>()

  function sweep(): void {
    const t = now()
    for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k)
  }

  return {
    issue(action: PrivacyActionId): PrivacyChallenge {
      const spec = PRIVACY_CONFIRM_SPECS[action]
      if (!spec) throw new PrivacyConfirmError(tr('Unknown action', '未知的操作'))
      sweep()
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

    /** Throws PrivacyConfirmError unless the nonce is live, unused, for this action, and the phrase matches. */
    consume(action: PrivacyActionId, nonce: string, phrase: string): void {
      const entry = pending.get(nonce)
      pending.delete(nonce)
      if (!entry) throw new PrivacyConfirmError(tr('This confirmation is no longer valid or was already used. Start the confirmation again.', '确认已失效或已被使用，请重新发起确认'))
      if (entry.expiresAt <= now()) throw new PrivacyConfirmError(tr('This confirmation has expired. Start the confirmation again.', '确认已过期，请重新发起确认'))
      if (entry.action !== action) throw new PrivacyConfirmError(tr('This confirmation does not match the action. Start the confirmation again.', '确认与操作不匹配，请重新发起确认'))
      const want = Buffer.from(entry.phrase, 'utf8')
      const got = Buffer.from(phrase.trim(), 'utf8')
      if (want.length !== got.length || !timingSafeEqual(want, got)) {
        throw new PrivacyConfirmError(tr('The confirmation phrase is incorrect. This confirmation is now void; start again.', '输入的确认短语不正确，本次确认已作废，请重新发起'))
      }
    },

    outstanding(): number {
      sweep()
      return pending.size
    }
  }
}

export type PrivacyConfirmGate = ReturnType<typeof createPrivacyConfirmGate>
