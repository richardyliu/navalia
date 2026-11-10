import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/main/broker/agents'
import { CLEAR_LOG_CONFIRM, CONNECTIONS_CHANNELS } from '../../src/main/broker/api'
import { openAuditLog, TYPING_CHARS_PER_MINUTE } from '../../src/main/broker/audit'
import { registerConnectionsIpc } from '../../src/main/broker/ipc'
import { connectClient, startBroker, textOf } from './broker-helpers'
import { mode, tempRoot } from './helpers'
import path from 'node:path'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

type Handler = (event: unknown, arg?: unknown) => unknown

describe('T-ID-08 Access log (steps 4–6, literal)', () => {
  test('read logged incl. empty result → clear → log empty, connection still connected, agent can still read', async () => {
    // Step 1: connect a local agent (temp HOME copy, never the real one).
    const b = await startBroker()
    const home = tempRoot('t-id-08-home')
    fs.writeFileSync(path.join(home, '.claude.json'), '{}', { mode: 0o600 })
    cleanups.push(() => fs.rmSync(b.root, { recursive: true, force: true }), () => fs.rmSync(home, { recursive: true, force: true }))
    cleanups.push(() => b.audit.close(), () => b.broker.stop())
    const agents = createAgentManager({ env: { home, applications: home }, grants: b.grants, brokerUrl: () => b.url })
    const handlers = new Map<string, Handler>()
    registerConnectionsIpc({ handle: (c: string, f: Handler) => void handlers.set(c, f) } as never, {
      agents,
      grants: b.grants,
      audit: b.audit,
      brokerStatus: () => ({ url: b.url, running: true, error: null }),
      copyToClipboard: () => undefined
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ipc = (ch: string, arg?: unknown) => Promise.resolve(handlers.get(ch)!({}, arg)) as Promise<any>
    expect((await ipc(CONNECTIONS_CHANNELS.connect, { agent: 'claude-code' })).data.agent.state).toBe('connected')
    const token = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['navalia'].headers.Authorization.slice(7)

    // Step 2: the agent calls search once, with an empty result.
    const client = await connectClient(b.url, token, 'claude-code')
    cleanups.push(() => client.close())
    await client.callTool({ name: 'search', arguments: { query: 'zzz-nothing' } })

    // Steps 3–4: open the Access log → client, capability, items, count, response chars; empty result has a row.
    const rows = (await ipc(CONNECTIONS_CHANNELS.logList)).data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ client: 'claude-code', capability: 'search', itemIds: [], itemCount: 0, outcome: 'ok' })
    expect(rows[0].responseChars).toBeGreaterThan(0)

    // Step 5: clear the log.
    expect((await ipc(CONNECTIONS_CHANNELS.logClear, { confirm: 'nope' })).ok).toBe(false)
    expect((await ipc(CONNECTIONS_CHANNELS.logClear, { confirm: CLEAR_LOG_CONFIRM })).data).toEqual({ removed: 1 })

    // Step 6: log empty; connection still connected; agent can still read (and that read is logged again).
    expect((await ipc(CONNECTIONS_CHANNELS.logList)).data).toEqual([])
    const after = (await ipc(CONNECTIONS_CHANNELS.list)).data.agents.find((a: { id: string }) => a.id === 'claude-code')
    expect(after.state).toBe('connected')
    const again = await client.callTool({ name: 'card_get', arguments: {} })
    expect(again.isError).toBeFalsy()
    expect(textOf(again)).toContain('No Personal Card')
    expect((await ipc(CONNECTIONS_CHANNELS.logList)).data).toHaveLength(1)
  })
})

describe('previews are gated in main (audit finding)', () => {
  test('list/daily IPC payloads carry no preview fields; preview IPC returns one row on demand', async () => {
    const root = tempRoot('preview')
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const log = openAuditLog(path.join(root, 'audit.db'))
    cleanups.push(() => log.close())
    log.record({ grantId: 'grt_0000000000000001', client: 'claude-code', capability: 'search', argsSha256: 'h', argsPreview: '{"query":"ARGS-SECRET-PREVIEW"}', itemIds: [], itemCount: 0, responseChars: 10, resultPreview: 'RESULT-SECRET-PREVIEW', outcome: 'ok', httpStatus: 200, errorCode: null, durationMs: 3 })
    const handlers = new Map<string, Handler>()
    registerConnectionsIpc({ handle: (c: string, f: Handler) => void handlers.set(c, f) } as never, {
      agents: { list: () => [] } as never,
      grants: {} as never,
      audit: log,
      brokerStatus: () => ({ url: '', running: false, error: null }),
      copyToClipboard: () => undefined
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ipc = (ch: string, arg?: unknown) => Promise.resolve(handlers.get(ch)!({}, arg)) as Promise<any>
    const list = await ipc(CONNECTIONS_CHANNELS.logList, { includeFailures: true })
    const daily = await ipc(CONNECTIONS_CHANNELS.logDaily)
    for (const payload of [JSON.stringify(list), JSON.stringify(daily)]) {
      expect(payload).not.toMatch(/argumentsPreview|resultPreview|args_preview|result_preview/)
      expect(payload).not.toContain('SECRET-PREVIEW')
    }
    expect(Object.keys(list.data[0]).sort()).toEqual(['capability', 'client', 'day', 'durationMs', 'errorCode', 'grantId', 'httpStatus', 'id', 'itemCount', 'itemIds', 'outcome', 'responseChars', 'ts'])
    const p = await ipc(CONNECTIONS_CHANNELS.logPreview, { id: list.data[0].id })
    expect(p.data).toEqual({ id: list.data[0].id, argumentsPreview: '{"query":"ARGS-SECRET-PREVIEW"}', resultPreview: 'RESULT-SECRET-PREVIEW' })
    expect((await ipc(CONNECTIONS_CHANNELS.logPreview, { id: 999 })).data).toBeNull()
    for (const bad of [undefined, {}, { id: 0 }, { id: 1.5 }, { id: '1' }, { id: 1, extra: true }]) {
      expect((await ipc(CONNECTIONS_CHANNELS.logPreview, bad)).ok).toBe(false)
    }
  })
})

describe('audit.db', () => {
  test('0600, 30-day per-day by agent, safe-field daily view, usage, typing-time constant', () => {
    const root = tempRoot('audit')
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    let t = new Date(2026, 10, 4, 12)
    const log = openAuditLog(path.join(root, 'audit.db'), () => new Date(t))
    cleanups.push(() => log.close())
    expect(mode(path.join(root, 'audit.db'))).toBe('600')
    const row = (client: string, chars: number, outcome: 'ok' | 'denied' = 'ok') =>
      log.record({ grantId: null, client, capability: 'card_get', argsSha256: 'x', argsPreview: '{"secret":"PREVIEW"}', itemIds: [], itemCount: 0, responseChars: chars, resultPreview: 'RESULT', outcome, httpStatus: outcome === 'ok' ? 200 : 403, errorCode: null, durationMs: 1 })
    row('claude-code', 300)
    row('codex', 600)
    row('codex', 0, 'denied')
    t = new Date(2026, 10, 3, 9)
    row('claude-code', 30)
    t = new Date(2026, 9, 1, 9) // > 30 days earlier
    row('claude-code', 999)
    t = new Date(2026, 10, 4, 13)
    const daily = log.daily(30)
    expect(daily).toEqual([
      { day: '2026-11-03', client: 'claude-code', reads: 1, responseChars: 30 },
      { day: '2026-11-04', client: 'claude-code', reads: 1, responseChars: 300 },
      { day: '2026-11-04', client: 'codex', reads: 1, responseChars: 600 }
    ])
    expect(JSON.stringify(daily)).not.toMatch(/PREVIEW|RESULT/)
    expect(log.list()).toHaveLength(3)
    expect(log.list({ includeFailures: true })).toHaveLength(4)
    expect(log.usage('claude-code')).toEqual({ reads: 2, responseChars: 330, byCapability: { card_get: 2 } })
    expect(TYPING_CHARS_PER_MINUTE).toBe(300)
    expect(log.clear()).toBe(5)
    expect(log.list({ includeFailures: true, days: 30 })).toEqual([])
  })
})
