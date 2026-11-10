import fs from 'node:fs'
import path from 'node:path'
import { tr } from '../../shared/i18n'

export class TokenError extends Error {
  readonly code = 'token_unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'TokenError'
  }
}

/**
 * Read the owner-local bearer token. The token never leaves the main process
 * and is never included in IPC payloads or logs.
 */
export function readLocalToken(root: string): string {
  const envPath = path.join(root, 'env')
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(envPath)
  } catch {
    throw new TokenError(tr(`${envPath} not found. Run persome start first.`, `没有找到 ${envPath}，请先运行 persome start`))
  }
  if (!stat.isFile()) throw new TokenError(tr("The Runtime's env is not a regular file", 'Runtime 的 env 不是普通文件'))
  if ((stat.mode & 0o077) !== 0) throw new TokenError(tr("The Runtime's env permissions are too open; they should be 0600", 'Runtime 的 env 权限过宽，应为 0600'))

  let text: string
  try {
    text = fs.readFileSync(envPath, 'utf8')
  } catch (error) {
    throw new TokenError(tr(`Cannot read ${envPath}: ${(error as Error).message}`, `无法读取 ${envPath}: ${(error as Error).message}`))
  }

  const match = text.match(/^\s*PERSOME_LOCAL_API_TOKEN\s*=\s*(.+?)\s*$/m)
  if (!match) throw new TokenError(tr('PERSOME_LOCAL_API_TOKEN is missing from env', 'env 中缺少 PERSOME_LOCAL_API_TOKEN'))
  const token = match[1].replace(/^["']|["']$/g, '')
  if (token.length < 16) throw new TokenError(tr('PERSOME_LOCAL_API_TOKEN has an unexpected length', 'PERSOME_LOCAL_API_TOKEN 长度异常'))
  return token
}

/**
 * Runtime screenshot key (PERSOME_SCREENSHOT_KEY, 64 hex = 32 bytes) from `<root>/env`.
 * Same file rules as the token (regular file, owner-only). Main process only: callers must
 * never log it or send it over IPC. Returns null when absent or malformed (Rewind then
 * reports "key unavailable" instead of guessing).
 */
export function readScreenshotKey(root: string): Buffer | null {
  const envPath = path.join(root, 'env')
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(envPath)
  } catch {
    return null
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null
  let text: string
  try {
    text = fs.readFileSync(envPath, 'utf8')
  } catch {
    return null
  }
  const match = text.match(/^\s*PERSOME_SCREENSHOT_KEY\s*=\s*(.+?)\s*$/m)
  if (!match) return null
  const hex = match[1].replace(/^["']|["']$/g, '')
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
}
