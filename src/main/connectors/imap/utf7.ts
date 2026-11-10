/**
 * IMAP modified UTF-7 (RFC 3501 §5.1.3) for mailbox names such as 「已发送」 or `[Gmail]/全部邮件`.
 * Printable US-ASCII except `&` is literal; `&` → `&-`; everything else is base64 (`,` instead of
 * `/`, no padding) of UTF-16BE between `&` and `-`.
 */
export function encodeMailboxName(name: string): string {
  let out = ''
  let pending: number[] = []
  const flush = (): void => {
    if (!pending.length) return
    const bytes = Buffer.alloc(pending.length * 2)
    pending.forEach((u, i) => bytes.writeUInt16BE(u, i * 2))
    out += `&${bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`
    pending = []
  }
  for (let i = 0; i < name.length; i++) {
    const u = name.charCodeAt(i)
    if (u >= 0x20 && u <= 0x7e) {
      flush()
      out += u === 0x26 ? '&-' : name[i]
    } else pending.push(u)
  }
  flush()
  return out
}
