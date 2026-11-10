// S1-R3-09 「把回答保存到记忆」 — channel names and types shared by main, preload and renderer.
// No node imports: the renderer imports this file.
import type { LensResult } from '../../shared/types'

export const ASK_SAVE_CHANNELS = {
  preview: 'lens:ask:save-preview',
  save: 'lens:ask:save-confirm',
  discard: 'lens:ask:save-discard'
} as const

/** Same ceiling as `lens:mcp:remember` (src/main/ipc.ts RememberArgs). */
export const ASK_SAVE_MAX_CHARS = 20_000

/** Fixed tags; the Runtime additionally force-tags every `remember` entry `source:agent-run`. */
export const ASK_SAVE_TAGS = ['ask-answer', 'external-agent'] as const

/** First line of every saved entry, so the memory says where the text came from. */
export const ASK_SAVE_HEADER = '[外部 Agent 的回答；用户在 Navalia「问」页确认保存；Navalia 未核实内容]'

export const ASK_SAVE_AGENTS = ['claude-code', 'codex', 'cursor', 'other'] as const
export type AskSaveAgent = (typeof ASK_SAVE_AGENTS)[number]

export interface AskSavePreview {
  /** Single-use handle for `save`; 32 hex chars, valid 10 minutes. */
  token: string
  /** Exactly what `remember` will receive (header + redacted text). */
  content: string
  /** Comma-joined into the `tags` argument of `remember`. */
  tags: string[]
  /** Number of redaction markers introduced. */
  redactions: number
  /** True when the input looked like an env / credential dump and was dropped (cannot be saved). */
  dropped: boolean
  chars: number
  expiresAt: string
}

export type AskSaveOutcome =
  | { saved: true; entryId: string; file: string; tags: string[] }
  | { saved: false; reason: 'cancelled' }

export interface AskSaveApi {
  askSave: {
    preview(text: string, agent?: AskSaveAgent): Promise<LensResult<AskSavePreview>>
    /** Main shows a native confirm dialog; nothing is written unless the user confirms there. */
    save(token: string): Promise<LensResult<AskSaveOutcome>>
    discard(token: string): Promise<LensResult<boolean>>
  }
}
