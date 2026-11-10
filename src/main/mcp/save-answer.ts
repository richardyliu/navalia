// S1-R3-09 「把回答保存到记忆」 (main side).
//
// Flow: renderer sends pasted text → `preview` redacts it here in main and parks it under a
// random single-use token → renderer shows the exact content → `save(token)` asks the user in a
// main-owned native dialog (Cancel default) → only on "保存" does main call the Runtime MCP tool
// `remember`. The save channel carries a token only, so a renderer cannot write arbitrary content
// or skip the dialog. No LLM, no network beyond the local MCP stdio process.
// Note (S1-R3-SEC M2): this token flow is not the only write path. `lens:mcp:remember`
// (RememberDialog, Quick Box) takes renderer text directly; since S1-R3-SEC it is redacted in main
// (mcp/remember.ts) and also needs a main-owned native confirm before MCP `remember`.
import { randomBytes } from 'node:crypto'
import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError, LensResult } from '../../shared/types'
import { redactForDisplay, stripSecrets } from '../import/redact'
import { scrubKnownSecrets } from './known-secrets'
import { McpError } from './client'
import {
  ASK_SAVE_AGENTS,
  ASK_SAVE_CHANNELS,
  ASK_SAVE_HEADER,
  ASK_SAVE_MAX_CHARS,
  ASK_SAVE_TAGS,
  type AskSaveOutcome,
  type AskSavePreview
} from './save-answer-api'
import { tr } from '../../shared/i18n'

const TTL_MS = 10 * 60_000
const MAX_PENDING = 8
const EXCERPT_CHARS = 400

export interface AskSaveConfirmSummary {
  excerpt: string
  chars: number
  redactions: number
}

export interface AskSaveDeps {
  /** Runtime MCP tool call (src/main/ipc.ts getMcp().callTool). */
  callTool(name: string, args: Record<string, unknown>): Promise<string>
  /** Main-owned native confirmation. Must default to cancel. */
  confirm(summary: AskSaveConfirmSummary, sender: unknown): Promise<boolean>
  /** Secrets scrubbed verbatim before the heuristics (e.g. the Runtime local token). */
  knownSecrets?(): string[]
  now?(): number
  randomToken?(): string
}

export class AskSaveError extends Error {
  constructor(
    readonly code: LensError['code'],
    message: string
  ) {
    super(message)
    this.name = 'AskSaveError'
  }
}

interface Pending {
  content: string
  tags: string[]
  dropped: boolean
  redactions: number
  expires: number
  busy: boolean
}

export interface AskSaveService {
  preview(input: { text: string; agent?: (typeof ASK_SAVE_AGENTS)[number] }): AskSavePreview
  save(token: string, sender: unknown): Promise<AskSaveOutcome>
  discard(token: string): boolean
}

const RememberResponse = z.object({
  entry_id: z.string().min(1),
  file: z.string(),
  tags: z.array(z.string()).optional()
})

export function createAskSaveService(deps: AskSaveDeps): AskSaveService {
  const now = deps.now ?? Date.now
  const newToken = deps.randomToken ?? (() => randomBytes(16).toString('hex'))
  const pending = new Map<string, Pending>()

  function sweep(): void {
    const t = now()
    for (const [k, v] of pending) if (v.expires < t && !v.busy) pending.delete(k)
  }

  function live(token: string): Pending {
    sweep()
    const p = pending.get(token)
    if (!p) throw new AskSaveError('not_found', tr('The preview has expired (over 10 minutes old, already saved or discarded). Preview again.', '预览已失效（超过 10 分钟、已保存或已丢弃），请重新预览'))
    return p
  }

  return {
    preview({ text, agent }) {
      const trimmed = text.trim()
      if (!trimmed) throw new AskSaveError('unknown', tr('Content is empty', '内容为空'))
      if (trimmed.length > ASK_SAVE_MAX_CHARS) throw new AskSaveError('unknown', tr(`Content too long (${trimmed.length} chars, limit ${ASK_SAVE_MAX_CHARS})`, `内容过长（${trimmed.length} 字，上限 ${ASK_SAVE_MAX_CHARS}）`))
      const scrubbed = scrubKnownSecrets(trimmed, deps.knownSecrets?.() ?? [])
      const known = scrubbed.count
      const stripped = stripSecrets(scrubbed.text)
      const content = stripped.dropped ? stripped.text : `${ASK_SAVE_HEADER}\n\n${stripped.text}`
      const tags = [...ASK_SAVE_TAGS, ...(agent ? [`agent-${agent}`] : [])]
      sweep()
      while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value as string
        pending.delete(oldest)
      }
      const token = newToken()
      const expires = now() + TTL_MS
      const redactions = stripped.redactions + known
      pending.set(token, { content, tags, dropped: stripped.dropped, redactions, expires, busy: false })
      return {
        token,
        content,
        tags,
        redactions,
        dropped: stripped.dropped,
        chars: content.length,
        expiresAt: new Date(expires).toISOString()
      }
    },

    async save(token, sender) {
      const p = live(token)
      if (p.dropped) throw new AskSaveError('unknown', tr('Content looks like environment variables / credential output; it was dropped and cannot be saved', '内容疑似环境变量 / 凭据输出，已整体省略，不能保存'))
      if (p.busy) throw new AskSaveError('unknown', tr('This answer is being saved; please wait', '这条回答正在保存，请稍候'))
      p.busy = true
      try {
        const ok = await deps.confirm(
          { excerpt: p.content.length > EXCERPT_CHARS ? `${p.content.slice(0, EXCERPT_CHARS)}…` : p.content, chars: p.content.length, redactions: p.redactions },
          sender
        )
        if (!ok) return { saved: false, reason: 'cancelled' }
        const raw = await deps.callTool('remember', { content: p.content, tags: p.tags.join(',') })
        let parsed: z.infer<typeof RememberResponse>
        try {
          parsed = RememberResponse.parse(JSON.parse(raw))
        } catch {
          throw new AskSaveError('schema', tr("Can't parse the Runtime remember response, so it's unclear whether it was saved. Check in Search before retrying.", 'Runtime remember 的返回无法解析，无法确认是否已写入；请在「搜索」里查一下再决定是否重试'))
        }
        pending.delete(token)
        return { saved: true, entryId: parsed.entry_id, file: parsed.file, tags: parsed.tags ?? [] }
      } finally {
        p.busy = false
      }
    },

    discard(token) {
      return pending.delete(token)
    }
  }
}

const Token = z.string().regex(/^[0-9a-f]{32}$/)
const PreviewArgs = z.strictObject({
  text: z.string().max(ASK_SAVE_MAX_CHARS + 4096),
  agent: z.enum(ASK_SAVE_AGENTS).optional()
})
const TokenArgs = z.strictObject({ token: Token })

export function toAskSaveError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  if (error instanceof AskSaveError) return { code: error.code, message: redactForDisplay(error.message) }
  if (error instanceof McpError) return { code: 'unreachable', message: redactForDisplay(tr(`Persome MCP call failed: ${error.message}`, `Persome MCP 调用失败：${error.message}`)).slice(0, 500) }
  return { code: 'unknown', message: redactForDisplay(error instanceof Error ? error.message : String(error)).slice(0, 500) }
}

async function run<T>(fn: () => T | Promise<T>): Promise<LensResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: toAskSaveError(error) }
  }
}

export function registerAskSaveIpc(ipcMain: Pick<IpcMain, 'handle'>, service: AskSaveService): void {
  ipcMain.handle(ASK_SAVE_CHANNELS.preview, (_e, raw: unknown) => run(() => service.preview(PreviewArgs.parse(raw))))
  ipcMain.handle(ASK_SAVE_CHANNELS.save, (e, raw: unknown) =>
    run(() => service.save(TokenArgs.parse(raw).token, (e as { sender?: unknown } | undefined)?.sender ?? null))
  )
  ipcMain.handle(ASK_SAVE_CHANNELS.discard, (_e, raw: unknown) => run(() => service.discard(TokenArgs.parse(raw).token)))
}
