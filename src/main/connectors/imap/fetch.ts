import type { Duplex } from 'node:stream'
import type { ImapCredentials } from './credentials'
import { ImapError, ImapSession } from './protocol'
import { connectImapTls, type TlsTarget } from './tls'
import { tr } from '../../../shared/i18n'

/**
 * C19 one read-only IMAP run: TLS connect → greeting → CAPABILITY → LOGIN → CAPABILITY → [ID] → EXAMINE <mailbox> →
 * UID SEARCH SINCE <today − sinceDays> → newest `maxMessages` UIDs → sizes → BODY.PEEK[] for each
 * message under `maxMessageBytes` until `maxTotalBytes` → LOGOUT. Returns raw RFC 822 bytes; the
 * caller parses them with the same .eml parser as local files. Nothing is written anywhere here.
 */

export const IMAP_LIMITS = {
  maxMessagesCap: 500,
  maxSinceDays: 365,
  maxMessageBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  timeoutMs: 30_000
} as const

export interface ImapFetchRequest {
  sinceDays: number
  maxMessages: number
  maxMessageBytes?: number
  maxTotalBytes?: number
  timeoutMs?: number
  now?: () => number
}

export interface ImapFetchResult {
  messages: Array<{ uid: number; raw: Buffer }>
  found: number
  skippedTooLarge: number
  skippedBudget: number
  warnings: string[]
  /** Commands sent (arguments masked) — evidence that only read-only commands were used. */
  commands: string[]
}

/** Transport factory: production = implicit TLS; tests inject an in-memory duplex or a TLS target with a test CA. */
export type ImapTransport = (t: TlsTarget) => Promise<Duplex>

export async function fetchImapMessages(cred: ImapCredentials, req: ImapFetchRequest, transport: ImapTransport = connectImapTls, ca?: string | Buffer): Promise<ImapFetchResult> {
  const timeoutMs = req.timeoutMs ?? IMAP_LIMITS.timeoutMs
  const maxMessageBytes = Math.min(req.maxMessageBytes ?? IMAP_LIMITS.maxMessageBytes, IMAP_LIMITS.maxMessageBytes)
  const maxTotalBytes = Math.min(req.maxTotalBytes ?? IMAP_LIMITS.maxTotalBytes, IMAP_LIMITS.maxTotalBytes)
  const maxMessages = Math.max(1, Math.min(Math.floor(req.maxMessages), IMAP_LIMITS.maxMessagesCap))
  const sinceDays = Math.max(1, Math.min(Math.floor(req.sinceDays), IMAP_LIMITS.maxSinceDays))
  const now = req.now ?? Date.now
  const secrets = [cred.password, cred.user].filter((s) => s.length > 0)

  let sock: Duplex
  try {
    sock = await transport({ host: cred.host, port: cred.port, timeoutMs, ...(ca ? { ca } : {}) })
  } catch (e) {
    if (e instanceof ImapError) throw e
    throw new ImapError('tls', tr('TLS connection failed.', 'TLS 连接失败。'))
  }
  // Literal cap a little above the message cap: the size check below skips big messages before
  // they are requested; this guards against a server that lies about RFC822.SIZE.
  const s = new ImapSession(sock, { timeoutMs, maxLiteralBytes: maxMessageBytes + 64 * 1024, secrets })
  try {
    const g = await s.greeting()
    if (g !== 'PREAUTH') {
      const caps = await s.capability()
      if (caps.has('LOGINDISABLED')) throw new ImapError('auth', tr('The server disables LOGIN (it needs OAuth or another method); Navalia supports app-password sign-in only.', '服务器禁止 LOGIN（需要 OAuth 或其他认证方式）；Navalia 只支持应用专用密码登录。'))
      await s.login(cred.user, cred.password)
      // Capabilities may change after login; ask again only to learn whether ID is supported.
      if (caps.has('ID') || (await s.capability()).has('ID')) await s.id()
    }
    const box = await s.examine(cred.mailbox)
    const warnings: string[] = []
    if (!box.readOnlyCode) warnings.push(tr('The server did not confirm read-only mode; Navalia sends only read-only commands (EXAMINE / FETCH BODY.PEEK) and never changes the mailbox.', '服务器没有明确回复只读状态；Navalia 只发送只读命令（EXAMINE / FETCH BODY.PEEK），不会修改邮箱。'))
    const uids = await s.uidSearchSince(new Date(now() - sinceDays * 86_400_000))
    const chosen = uids.slice(-maxMessages)
    if (uids.length > chosen.length) warnings.push(tr(`${uids.length} messages in the last ${sinceDays} days; only the newest ${chosen.length} were read`, `最近 ${sinceDays} 天共有 ${uids.length} 封，只读取最新的 ${chosen.length} 封`))
    const sizes = chosen.length ? await s.uidFetchSizes(chosen) : new Map<number, number>()
    const messages: ImapFetchResult['messages'] = []
    let total = 0
    let skippedTooLarge = 0
    let skippedBudget = 0
    // Newest first so the budget keeps the most recent mail.
    for (const uid of [...chosen].reverse()) {
      const size = sizes.get(uid)
      if (size === undefined || size > maxMessageBytes) {
        skippedTooLarge++
        continue
      }
      if (total + size > maxTotalBytes) {
        skippedBudget++
        continue
      }
      const raw = await s.uidFetchBody(uid)
      if (!raw) continue
      if (raw.length > maxMessageBytes) {
        skippedTooLarge++
        continue
      }
      total += raw.length
      messages.push({ uid, raw })
    }
    if (skippedTooLarge) warnings.push(
        tr(
          `Skipped ${skippedTooLarge} messages over the per-message limit (${Math.round(maxMessageBytes / 1024 / 1024)} MB) or without size info`,
          `${skippedTooLarge} 封邮件超过单封上限（${Math.round(maxMessageBytes / 1024 / 1024)} MB）或没有大小信息，已跳过`
        )
      )
    if (skippedBudget) warnings.push(
        tr(
          `Hit the total read limit for this run (${Math.round(maxTotalBytes / 1024 / 1024)} MB); ${skippedBudget} older messages were not read`,
          `本次读取总量达到上限（${Math.round(maxTotalBytes / 1024 / 1024)} MB），${skippedBudget} 封较早的邮件未读取`
        )
      )
    await s.logout()
    return { messages: messages.reverse(), found: uids.length, skippedTooLarge, skippedBudget, warnings, commands: [...s.sentVerbs] }
  } catch (e) {
    sock.destroy()
    if (e instanceof ImapError) throw new ImapError(e.code, s.scrub(e.message))
    throw new ImapError('protocol', s.scrub(e instanceof Error ? e.message : String(e)))
  }
}
