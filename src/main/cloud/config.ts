// Cloud opt-in config in the Lens Store (`cloud.json`, 0600). Default: OFF, no server.
import path from 'node:path'
import { z } from 'zod'
import { tr } from '../../shared/i18n'
import { readFileIfExists, writeFileSecure } from '../store/paths'

export interface CloudPaths {
  configFile: string
  tokenFile: string
}

export function cloudPaths(storeRoot: string): CloudPaths {
  return { configFile: path.join(storeRoot, 'cloud.json'), tokenFile: path.join(storeRoot, 'cloud-token.enc') }
}

export interface CloudConfig {
  version: 1
  enabled: boolean
  baseUrl: string | null
}

export const DEFAULT_CLOUD_CONFIG: CloudConfig = Object.freeze({ version: 1, enabled: false, baseUrl: null }) as CloudConfig

export class CloudConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudConfigError'
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

/**
 * `allowInsecureLoopback` permits `http://127.0.0.1:<port>` / `http://localhost:<port>`. Production
 * passes `!app.isPackaged` (dev builds only); every default here is false (packaged ⇒ https only).
 */
export interface CloudUrlPolicy {
  allowInsecureLoopback?: boolean
}

/**
 * Validate and normalize a server address to its origin.
 *   - `https://host[:port]` (any public host), path `/` only;
 *   - `http://127.0.0.1:<port>` / `http://localhost:<port>` (explicit port) ONLY with
 *     `policy.allowInsecureLoopback` (unpackaged dev builds / tests);
 *   - never credentials, a path, a query or a fragment.
 * Messages describe the rule, not the input (the input could contain a pasted secret).
 */
export function normalizeBaseUrl(input: string, policy: CloudUrlPolicy = {}): string {
  const raw = input.trim()
  if (!raw || raw.length > 2048) throw new CloudConfigError(tr('Server address is empty or too long', '服务器地址为空或过长'))
  if (/[\s\\]/.test(raw)) throw new CloudConfigError(tr('Server address cannot contain spaces or backslashes', '服务器地址不能包含空白或反斜杠'))
  if (raw.includes('?') || raw.includes('#')) throw new CloudConfigError(tr('Server address cannot include a query string or fragment', '服务器地址不能带查询参数或片段'))
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CloudConfigError(tr('Server address is not a valid URL', '服务器地址不是合法的 URL'))
  }
  const authority = (/^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(raw)?.[1] ?? '')
  if (url.username || url.password || authority.includes('@')) {
    throw new CloudConfigError(tr('Server address cannot include a username or password', '服务器地址不能包含用户名或密码'))
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new CloudConfigError(tr('Server address must be an origin only (no path)', '服务器地址只能是来源（不能带路径）'))
  if (url.protocol === 'https:') {
    if (!url.hostname) throw new CloudConfigError(tr('Server address is missing a host name', '服务器地址缺少主机名'))
    return url.origin
  }
  if (url.protocol === 'http:') {
    if (!policy.allowInsecureLoopback) throw new CloudConfigError(tr('Only https server addresses are allowed', '只允许 https 服务器地址'))
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new CloudConfigError(tr('Only https is allowed; http is limited to 127.0.0.1 / localhost', '只允许 https；http 仅限 127.0.0.1 / localhost'))
    if (!url.port) throw new CloudConfigError(tr('A local http address must include a port', '本机 http 地址必须写明端口'))
    return url.origin
  }
  throw new CloudConfigError(tr('Only https is allowed; http is limited to 127.0.0.1 / localhost', '只允许 https；http 仅限 127.0.0.1 / localhost'))
}

const ConfigFileSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  baseUrl: z.string().max(2048).nullable()
})

/**
 * Read `cloud.json`. Missing → default (OFF). Corrupt / invalid / non-normalized → fail closed
 * to OFF (the bad file is left in place for the user to inspect; the next write replaces it).
 * `enabled` with no server is reported as OFF.
 */
export function readCloudConfig(file: string, policy: CloudUrlPolicy = {}): CloudConfig {
  const buf = readFileIfExists(file)
  if (!buf) return { ...DEFAULT_CLOUD_CONFIG }
  let parsed: z.infer<typeof ConfigFileSchema>
  try {
    parsed = ConfigFileSchema.parse(JSON.parse(buf.toString('utf8')))
  } catch {
    return { ...DEFAULT_CLOUD_CONFIG }
  }
  let baseUrl: string | null = null
  if (parsed.baseUrl !== null) {
    try {
      baseUrl = normalizeBaseUrl(parsed.baseUrl, policy)
    } catch {
      return { ...DEFAULT_CLOUD_CONFIG }
    }
    if (baseUrl !== parsed.baseUrl) return { ...DEFAULT_CLOUD_CONFIG }
  }
  return { version: 1, enabled: parsed.enabled && baseUrl !== null, baseUrl }
}

export function writeCloudConfig(file: string, cfg: { enabled: boolean; baseUrl: string | null }, policy: CloudUrlPolicy = {}): CloudConfig {
  const baseUrl = cfg.baseUrl === null ? null : normalizeBaseUrl(cfg.baseUrl, policy)
  if (cfg.enabled && baseUrl === null) throw new CloudConfigError(tr('Enter a server address before turning on Cloud', '开启云端需要先填写服务器地址'))
  const out: CloudConfig = { version: 1, enabled: cfg.enabled, baseUrl }
  writeFileSecure(file, `${JSON.stringify(out, null, 2)}\n`)
  return out
}
