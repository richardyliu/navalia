// S1-R3-SEC M2: `lens:mcp:remember` (main-window RememberDialog and Quick Box). The renderer text is
// redacted in main (known Runtime secrets verbatim, then import/redact.ts `stripSecrets`), env /
// credential dumps are refused, and a main-owned native confirm (Cancel default) showing the
// redacted text must be accepted before MCP `remember` is called. No LLM.
import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensResult, RememberResult } from '../../shared/types'
import { redactForDisplay, stripSecrets } from '../import/redact'
import { scrubKnownSecrets } from './known-secrets'
import { tr } from '../../shared/i18n'

export const REMEMBER_CHANNEL = 'lens:mcp:remember'
const EXCERPT_CHARS = 400

const RememberArgs = z.object({
  content: z.string().min(1).max(20_000),
  tags: z.string().max(4096).optional()
})

export interface RememberConfirmSummary {
  /** Redacted text, truncated to 400 chars (+ …). */
  excerpt: string
  chars: number
  redactions: number
  tags: string
}

export interface RememberDeps {
  callTool(name: string, args: Record<string, unknown>): Promise<string>
  /** Main-owned native confirmation; must default to cancel. */
  confirm(summary: RememberConfirmSummary, sender: unknown): Promise<boolean>
  knownSecrets?(): string[]
}

export type RememberHandler = (raw: unknown, sender: unknown) => Promise<RememberResult>

function redact(text: string, known: string[]): { text: string; redactions: number; dropped: boolean } {
  const k = scrubKnownSecrets(text, known)
  const s = stripSecrets(k.text)
  return { text: s.text, redactions: s.redactions + k.count, dropped: s.dropped }
}

export function createRememberHandler(deps: RememberDeps): RememberHandler {
  return async (raw, sender) => {
    const args = RememberArgs.parse(raw)
    const known = deps.knownSecrets?.() ?? []
    const body = redact(args.content.trim(), known)
    if (body.dropped || !body.text.trim()) throw new Error(tr('Content looks like environment variables / credential output; it was dropped and cannot be saved to memory', '内容疑似环境变量 / 凭据输出，已整体省略，不能写入记忆'))
    const tags = args.tags ? redact(args.tags, known) : { text: '', redactions: 0, dropped: false }
    if (tags.dropped) throw new Error(tr('Tags look like credentials; cannot save to memory', '标签疑似凭据，不能写入记忆'))
    const content = body.text
    const ok = await deps.confirm(
      {
        excerpt: content.length > EXCERPT_CHARS ? `${content.slice(0, EXCERPT_CHARS)}…` : content,
        chars: content.length,
        redactions: body.redactions + tags.redactions,
        tags: tags.text
      },
      sender
    )
    if (!ok) throw new Error(tr('Cancelled; nothing saved to memory', '已取消，未写入记忆'))
    const text = await deps.callTool('remember', { content, tags: tags.text })
    return JSON.parse(text) as RememberResult
  }
}

/** Fail-closed default when main did not wire a confirm (never writes). */
export const refuseRemember: RememberHandler = async () => {
  throw new Error(tr('Saving to memory needs confirmation from the main process, which is unavailable right now', '写入记忆需要主进程确认，当前不可用'))
}

export function registerRememberIpc(ipcMain: Pick<IpcMain, 'handle'>, handler: RememberHandler): void {
  ipcMain.handle(REMEMBER_CHANNEL, async (event, raw: unknown): Promise<LensResult<RememberResult>> => {
    try {
      return { ok: true, data: await handler(raw, (event as { sender?: unknown } | undefined)?.sender ?? null) }
    } catch (error) {
      if (error instanceof z.ZodError) return { ok: false, error: { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) } }
      return { ok: false, error: { code: 'unknown', message: redactForDisplay(error instanceof Error ? error.message : String(error)).slice(0, 500) } }
    }
  })
}
