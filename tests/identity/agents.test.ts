import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager, ENTRY_NAME } from '../../src/main/broker/agents'
import { createGrantStore } from '../../src/main/identity/grants'
import { ensureStore, storePaths } from '../../src/main/store/paths'
import { mode, tempRoot } from './helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const URL_ = 'http://127.0.0.1:8750/mcp'

function setup(opts: { claudeJson?: unknown; cursor?: boolean; codexToml?: string | null; desktop?: boolean } = {}) {
  const home = tempRoot('home')
  const apps = tempRoot('apps')
  const store = tempRoot('store')
  roots.push(home, apps, store)
  if (opts.claudeJson !== undefined) {
    fs.writeFileSync(path.join(home, '.claude.json'), typeof opts.claudeJson === 'string' ? opts.claudeJson : JSON.stringify(opts.claudeJson, null, 2), { mode: 0o600 })
  }
  if (opts.cursor) fs.mkdirSync(path.join(home, '.cursor'))
  if (opts.codexToml !== undefined) {
    fs.mkdirSync(path.join(home, '.codex'))
    if (opts.codexToml !== null) fs.writeFileSync(path.join(home, '.codex', 'config.toml'), opts.codexToml)
  }
  if (opts.desktop) fs.mkdirSync(path.join(apps, 'Claude.app'))
  const grants = createGrantStore(ensureStore(storePaths(store)))
  const agents = createAgentManager({ env: { home, applications: apps }, grants, brokerUrl: () => URL_ })
  return { home, store, grants, agents }
}

const state = (agents: ReturnType<typeof setup>['agents'], id: Parameters<typeof agents.get>[0]) => agents.get(id).state

describe('agent detection', () => {
  test('nothing installed → not_installed for all four', () => {
    const { agents } = setup()
    expect(agents.list().map((a) => [a.id, a.state])).toEqual([
      ['claude-code', 'not_installed'],
      ['codex', 'not_installed'],
      ['claude-desktop', 'not_installed'],
      ['cursor', 'not_installed']
    ])
  })

  test('not installed → connect refuses and writes nothing', () => {
    const { agents, home, grants } = setup()
    expect(() => agents.connect('codex')).toThrow(/is not installed/)
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false)
    expect(grants.list()).toEqual([])
  })
})

describe('Claude Code (~/.claude.json)', () => {
  test('connect writes only our entry, keeps other servers/keys and the file mode; state connected; full access', () => {
    const original = { numStartups: 3, mcpServers: { persome: { type: 'stdio', command: 'persome', args: ['mcp'] } } }
    const { agents, home } = setup({ claudeJson: original })
    expect(state(agents, 'claude-code')).toBe('available')
    const v = agents.connect('claude-code')
    expect(v).toMatchObject({ state: 'connected', access: 'full' })
    const file = path.join(home, '.claude.json')
    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written.numStartups).toBe(3)
    expect(written.mcpServers.persome).toEqual(original.mcpServers.persome)
    expect(written.mcpServers[ENTRY_NAME]).toMatchObject({ type: 'http', url: URL_ })
    expect(written.mcpServers[ENTRY_NAME].headers.Authorization).toMatch(/^Bearer plg_/)
    expect(mode(file)).toBe('600')
  })

  test('mismatch: entry points elsewhere, or token revoked; repair = reconnect', () => {
    const { agents, home, grants } = setup({ claudeJson: {} })
    agents.connect('claude-code')
    grants.revokeClient('claude-code')
    expect(agents.get('claude-code')).toMatchObject({ state: 'mismatch' })
    agents.connect('claude-code')
    expect(state(agents, 'claude-code')).toBe('connected')
    const file = path.join(home, '.claude.json')
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    d.mcpServers[ENTRY_NAME].url = 'http://127.0.0.1:9999/mcp'
    fs.writeFileSync(file, JSON.stringify(d))
    expect(agents.get('claude-code').state).toBe('mismatch')
  })

  test('partial: entry without Authorization, or grant without entry, or malformed file', () => {
    const { agents, home } = setup({ claudeJson: { mcpServers: { [ENTRY_NAME]: { type: 'http', url: URL_ } } } })
    expect(state(agents, 'claude-code')).toBe('partial')
    fs.writeFileSync(path.join(home, '.claude.json'), '{}')
    agents.connect('claude-code')
    fs.writeFileSync(path.join(home, '.claude.json'), '{}')
    expect(state(agents, 'claude-code')).toBe('partial')
    fs.writeFileSync(path.join(home, '.claude.json'), '{not json')
    expect(state(agents, 'claude-code')).toBe('partial')
    expect(() => agents.connect('claude-code')).toThrow(/JSON/)
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{not json')
  })

  test('disconnect removes only our entry and revokes the grant', () => {
    const { agents, home, grants } = setup({ claudeJson: { mcpServers: { other: { command: 'x' } } } })
    agents.connect('claude-code')
    const v = agents.disconnect('claude-code')
    expect(v.state).toBe('available')
    const d = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
    expect(d.mcpServers).toEqual({ other: { command: 'x' } })
    expect(grants.list().every((g) => g.state === 'revoked')).toBe(true)
  })
})

describe('Cursor and Codex', () => {
  test('Cursor: creates ~/.cursor/mcp.json with url+headers', () => {
    const { agents, home } = setup({ cursor: true })
    expect(agents.connect('cursor').state).toBe('connected')
    const d = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(d.mcpServers[ENTRY_NAME].url).toBe(URL_)
    expect(d.mcpServers[ENTRY_NAME].type).toBeUndefined()
  })

  test('Codex: marker block appended, other TOML untouched, disconnect restores the original text', () => {
    const original = 'model = "o3"\n\n[mcp_servers.persome]\ncommand = "persome"\nargs = ["mcp"]\n'
    const { agents, home } = setup({ codexToml: original })
    expect(agents.connect('codex').state).toBe('connected')
    const file = path.join(home, '.codex', 'config.toml')
    const text = fs.readFileSync(file, 'utf8')
    expect(text.startsWith(original.trimEnd())).toBe(true)
    expect(text).toContain(`[mcp_servers.${ENTRY_NAME}]`)
    agents.connect('codex') // reconnect replaces the block, never duplicates
    expect(fs.readFileSync(file, 'utf8').split(`[mcp_servers.${ENTRY_NAME}]`)).toHaveLength(2)
    agents.disconnect('codex')
    expect(fs.readFileSync(file, 'utf8').trimEnd()).toBe(original.trimEnd())
  })

  test('Codex: a hand-written navalia table is not ours → partial, connect refuses', () => {
    const { agents } = setup({ codexToml: '[mcp_servers.navalia]\nurl = "x"\n' })
    expect(state(agents, 'codex')).toBe('partial')
    expect(() => agents.connect('codex')).toThrow()
  })
})

describe('Claude Desktop (manual setup)', () => {
  test('installed → available, no auto connect; manual config creates a grant and is copyable', () => {
    const { agents } = setup({ desktop: true })
    const a = agents.get('claude-desktop')
    expect(a).toMatchObject({ state: 'available', autoConnect: false })
    expect(() => agents.connect('claude-desktop')).toThrow(/manual setup/)
    const { json, agent } = agents.manualConfig('claude-desktop')
    expect(JSON.parse(json).mcpServers[ENTRY_NAME].url).toBe(URL_)
    expect(agent.state).toBe('partial')
    expect(agents.disconnect('claude-desktop').state).toBe('available')
  })
})
