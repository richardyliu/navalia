import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GrantStore } from '../identity/grants'
import type { AgentId, AgentState, AgentView } from './api'
import { tr } from '../../shared/i18n'

/** Name of the entry Navalia owns inside each agent's MCP config. Nothing else is ever touched. */
export const ENTRY_NAME = 'navalia'
const TOML_BEGIN = '# >>> navalia (managed by Navalia) >>>'
const TOML_END = '# <<< navalia <<<'
/**
 * Entry written before the rename (Persome Lens). Still ours: read as a fallback, replaced on
 * connect, removed on disconnect, so an existing connection keeps working and never orphans.
 */
export const LEGACY_ENTRY_NAME = 'persome-lens'
const LEGACY_TOML_BEGIN = '# >>> persome-lens (managed by Persome Lens) >>>'
const LEGACY_TOML_END = '# <<< persome-lens <<<'
/** Entries written under earlier app names (Grapple, then Persome Lens), newest first. */
const OLD_ENTRIES = [
  { name: 'grapple', begin: '# >>> grapple (managed by Grapple) >>>', end: '# <<< grapple <<<' },
  { name: LEGACY_ENTRY_NAME, begin: LEGACY_TOML_BEGIN, end: LEGACY_TOML_END }
] as const
export const OLD_ENTRY_NAMES: readonly string[] = OLD_ENTRIES.map((e) => e.name)

export interface AgentEnv {
  /** HOME used to find agent configs. Tests and screenshot runs point this at a temp copy. */
  home: string
  /** Where .app bundles are looked up. */
  applications: string
}

export function defaultAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  return {
    home: env.LENS_AGENT_HOME?.trim() || os.homedir(),
    applications: env.LENS_AGENT_APPS?.trim() || '/Applications'
  }
}

interface AgentSpec {
  id: AgentId
  name: string
  kind: 'json' | 'toml' | 'manual'
  configPath(env: AgentEnv): string
  installed(env: AgentEnv): boolean
}

const exists = (p: string) => fs.existsSync(p)

export const AGENTS: AgentSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'json',
    configPath: (e) => path.join(e.home, '.claude.json'),
    installed: (e) => exists(path.join(e.home, '.claude.json')) || exists(path.join(e.home, '.claude'))
  },
  {
    id: 'codex',
    name: 'Codex',
    kind: 'toml',
    configPath: (e) => path.join(e.home, '.codex', 'config.toml'),
    installed: (e) => exists(path.join(e.home, '.codex'))
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    // Its config file only launches stdio servers; a remote HTTP server must be added by hand.
    kind: 'manual',
    configPath: (e) => path.join(e.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    installed: (e) => exists(path.join(e.home, 'Library', 'Application Support', 'Claude')) || exists(path.join(e.applications, 'Claude.app'))
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'json',
    configPath: (e) => path.join(e.home, '.cursor', 'mcp.json'),
    installed: (e) => exists(path.join(e.home, '.cursor')) || exists(path.join(e.applications, 'Cursor.app'))
  }
]

interface Entry {
  url: string | null
  token: string | null
}

type ReadResult = { ok: true; entry: Entry | null } | { ok: false; error: string }

function writePreservingMode(file: string, text: string): void {
  let mode = 0o600
  try {
    mode = fs.statSync(file).mode & 0o777
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, text, { mode, flag: 'wx' })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

function bearerOf(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' && typeof v === 'string' && v.startsWith('Bearer ')) return v.slice(7).trim()
  }
  return null
}

// ---- JSON configs (Claude Code ~/.claude.json, Cursor ~/.cursor/mcp.json) ----

function readJson(file: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { ok: true, data: {} }
  }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: tr('Config file top level is not an object', '配置文件顶层不是对象') }
    return { ok: true, data }
  } catch {
    return { ok: false, error: tr('Config file is not valid JSON', '配置文件不是合法 JSON') }
  }
}

function jsonEntry(spec: AgentSpec, url: string, token: string): Record<string, unknown> {
  const headers = { Authorization: `Bearer ${token}` }
  return spec.id === 'claude-code' ? { type: 'http', url, headers } : { url, headers }
}

const json = {
  read(file: string): ReadResult {
    const r = readJson(file)
    if (!r.ok) return r
    const servers = r.data.mcpServers as Record<string, unknown> | undefined
    const found = servers && typeof servers === 'object' ? [ENTRY_NAME, ...OLD_ENTRY_NAMES].map((n) => servers[n]).find((v) => v !== undefined) : undefined
    const e = found as Record<string, unknown> | undefined
    if (!e) return { ok: true, entry: null }
    return { ok: true, entry: { url: typeof e.url === 'string' ? e.url : null, token: bearerOf(e.headers) } }
  },
  write(spec: AgentSpec, file: string, url: string, token: string): void {
    const r = readJson(file)
    if (!r.ok) throw new Error(tr(`${file}: ${r.error}; not overwriting`, `${file}: ${r.error}，不会覆盖`))
    const servers = (r.data.mcpServers && typeof r.data.mcpServers === 'object' ? r.data.mcpServers : {}) as Record<string, unknown>
    const rest = Object.fromEntries(Object.entries(servers).filter(([k]) => !OLD_ENTRY_NAMES.includes(k)))
    r.data.mcpServers = { ...rest, [ENTRY_NAME]: jsonEntry(spec, url, token) }
    writePreservingMode(file, `${JSON.stringify(r.data, null, 2)}\n`)
  },
  remove(file: string): boolean {
    const r = readJson(file)
    if (!r.ok) throw new Error(tr(`${file}: ${r.error}; not modifying`, `${file}: ${r.error}，不会修改`))
    const servers = r.data.mcpServers as Record<string, unknown> | undefined
    const ours = [ENTRY_NAME, ...OLD_ENTRY_NAMES]
    if (!servers || typeof servers !== 'object' || !ours.some((n) => n in servers)) return false
    for (const n of ours) delete servers[n]
    writePreservingMode(file, `${JSON.stringify(r.data, null, 2)}\n`)
    return true
  }
}

// ---- TOML (Codex ~/.codex/config.toml): a marker-delimited block, no TOML rewriting ----

function tomlParts(text: string, begin = TOML_BEGIN, end = TOML_END): { before: string; block: string | null; after: string } {
  const b = text.indexOf(begin)
  const e = text.indexOf(end)
  if (b < 0 || e < b) return { before: text, block: null, after: '' }
  return { before: text.slice(0, b), block: text.slice(b, e + end.length), after: text.slice(e + end.length) }
}

/** Text with every pre-rename managed block (if any) cut out. */
function withoutLegacyBlock(text: string): string {
  for (const old of OLD_ENTRIES) {
    const { before, block, after } = tomlParts(text, old.begin, old.end)
    if (block) text = `${before.replace(/\s*$/, '\n')}${after.replace(/^\n+/, '')}`.replace(/^\n$/, '')
  }
  return text
}

const tableRe = (name: string): RegExp => new RegExp(`^\\s*\\[mcp_servers\\.(?:"${name}"|${name})\\]`, 'm')
const tomlTableRe = tableRe(ENTRY_NAME)

const toml = {
  read(file: string): ReadResult {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return { ok: true, entry: null }
    }
    let { before, block, after } = tomlParts(text)
    if (!block) {
      if (tomlTableRe.test(text)) return { ok: false, error: tr('A navalia entry exists that Navalia does not manage', '已有一个不是 Navalia 管理的 navalia 条目') }
      const old = OLD_ENTRIES.find((o) => tomlParts(text, o.begin, o.end).block)
      if (!old) return { ok: true, entry: null }
      ;({ before, block, after } = tomlParts(text, old.begin, old.end))
      if (!block) return { ok: true, entry: null }
      if (tableRe(old.name).test(before + after)) return { ok: false, error: tr(`Duplicate ${old.name} entries`, `存在重复的 ${old.name} 条目`) }
    } else if (tomlTableRe.test(before + after)) return { ok: false, error: tr('Duplicate navalia entries', '存在重复的 navalia 条目') }
    const url = block.match(/^\s*url\s*=\s*"([^"]*)"/m)?.[1] ?? null
    const auth = block.match(/Authorization\s*=\s*"Bearer ([^"]+)"/)?.[1] ?? null
    return { ok: true, entry: { url, token: auth } }
  },
  write(_spec: AgentSpec, file: string, url: string, token: string): void {
    const r = toml.read(file)
    if (!r.ok) throw new Error(tr(`${file}: ${r.error}; not overwriting`, `${file}: ${r.error}，不会覆盖`))
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      text = ''
    }
    const { before, after } = tomlParts(withoutLegacyBlock(text))
    const block = [
      TOML_BEGIN,
      `[mcp_servers.${ENTRY_NAME}]`,
      `url = "${url}"`,
      `http_headers = { Authorization = "Bearer ${token}" }`,
      TOML_END
    ].join('\n')
    const head = before.replace(/\s*$/, '')
    writePreservingMode(file, `${head ? `${head}\n\n` : ''}${block}${after.replace(/^\n?/, '\n')}`)
  },
  remove(file: string): boolean {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return false
    }
    const stripped = withoutLegacyBlock(text)
    const { before, block, after } = tomlParts(stripped)
    if (!block) {
      if (stripped === text) return false
      writePreservingMode(file, stripped)
      return true
    }
    writePreservingMode(file, `${before.replace(/\s*$/, '\n')}${after.replace(/^\n+/, '')}`.replace(/^\n$/, ''))
    return true
  }
}

const IO = { json, toml }

export interface AgentManager {
  list(): AgentView[]
  get(id: AgentId): AgentView
  connect(id: AgentId): AgentView
  disconnect(id: AgentId): AgentView
  /** Fresh grant + paste-ready JSON for manual setup. The caller puts it on the clipboard (main only). */
  manualConfig(id: AgentId): { agent: AgentView; json: string }
}

export function createAgentManager(opts: { env: AgentEnv; grants: GrantStore; brokerUrl: () => string }): AgentManager {
  const { env, grants } = opts

  function spec(id: AgentId): AgentSpec {
    const s = AGENTS.find((a) => a.id === id)
    if (!s) throw new Error(`unknown agent ${id}`)
    return s
  }

  function view(s: AgentSpec): AgentView {
    const configPath = s.configPath(env)
    const grant = grants.activeFor(s.id)
    const base = { id: s.id, name: s.name, configPath, autoConnect: s.kind !== 'manual', grant, access: grant?.access.mode ?? 'full' } as const
    const at = (state: AgentState, detail: string): AgentView => ({ ...base, state, detail })

    if (!s.installed(env)) return at('not_installed', tr('Client not found on this Mac', '没有在本机找到这个客户端'))
    if (s.kind === 'manual') {
      return grant && grant.state === 'active'
        ? at('partial', tr('Manual config generated; Navalia cannot confirm the client loaded it', '已生成手动配置；Navalia 无法确认客户端是否已加载'))
        : at('available', tr('Manual setup: copy the MCP JSON and paste it into the client', '需要手动配置：复制 MCP JSON 后粘贴到客户端'))
    }
    const read = IO[s.kind].read(configPath)
    if (!read.ok) return at('partial', read.error)
    const entry = read.entry
    if (!entry) {
      return grant && grant.state === 'active' ? at('partial', tr('Navalia has a grant, but the client config has no entry', 'Navalia 有授权，但客户端配置里没有条目')) : at('available', tr('Not connected', '未连接'))
    }
    if (entry.url !== opts.brokerUrl()) return at('mismatch', tr(`Config points to ${entry.url ?? '(no url)'}, not this Mac's Broker`, `配置指向 ${entry.url ?? '（无 url）'}，不是本机 Broker`))
    if (!entry.token) return at('partial', tr('Config is missing the Authorization header', '配置里缺少 Authorization 头'))
    if (!grants.matches(s.id, entry.token)) return at('mismatch', tr('Token is no longer valid (revoked, expired or replaced)', 'token 已失效（撤销、过期或被替换）'))
    return at('connected', tr('Config and token match', '配置与 token 匹配'))
  }

  return {
    list: () => AGENTS.map(view),
    get: (id) => view(spec(id)),

    connect(id) {
      const s = spec(id)
      if (s.kind === 'manual') throw new Error(tr(`${s.name} needs manual setup`, `${s.name} 需要手动配置`))
      if (!s.installed(env)) throw new Error(tr(`${s.name} is not installed`, `${s.name} 没有安装`))
      const read = IO[s.kind].read(s.configPath(env))
      if (!read.ok) throw new Error(read.error)
      const { grant, token } = grants.create({ client: s.id, label: s.name })
      try {
        IO[s.kind].write(s, s.configPath(env), opts.brokerUrl(), token)
      } catch (error) {
        grants.revoke(grant.id)
        throw error
      }
      return view(s)
    },

    disconnect(id) {
      const s = spec(id)
      if (s.kind !== 'manual' && s.installed(env)) IO[s.kind].remove(s.configPath(env))
      grants.revokeClient(s.id)
      return view(s)
    },

    manualConfig(id) {
      const s = spec(id)
      const { token } = grants.create({ client: s.id, label: s.name })
      const snippet = { mcpServers: { [ENTRY_NAME]: { type: 'http', url: opts.brokerUrl(), headers: { Authorization: `Bearer ${token}` } } } }
      return { agent: view(s), json: JSON.stringify(snippet, null, 2) }
    }
  }
}
