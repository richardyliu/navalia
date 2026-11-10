import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openAuditLog } from '../../src/main/broker/audit'
import { createBroker } from '../../src/main/broker/server'
import type { BrokerBackend } from '../../src/main/broker/tools'
import { createGrantStore } from '../../src/main/identity/grants'
import { ensureStore, storePaths } from '../../src/main/store/paths'
import type { EvidenceResponse } from '../../src/shared/types'
import { tempRoot } from './helpers'

export const evidenceFixture: EvidenceResponse = {
  reference: '⟨pt-001:user-preferences.md⟩',
  canonical_reference: '⟨pt-001:user-preferences.md⟩',
  kind: 'point',
  id: 'pt-001',
  status: 'active',
  label: 'QUOTE-LABEL user said: mail me at a@b.co',
  summary: 'QUOTE-SUMMARY verbatim words',
  timestamp: '2026-11-04T10:00',
  path: '/Users/alice/.persome/memory/user-preferences.md',
  metadata: { quote: 'QUOTE-META' },
  sources: [{ relation: 'derived_from', kind: 'capture', id: 'cap-1', reference: '⟨cap:1⟩', label: 'QUOTE-SRC', timestamp: null, status: null, resolvable: true }],
  context: [],
  history: []
}

export type OssHandler = (args: Record<string, unknown>) => Promise<string> | string

/** Fake OSS runtime: per-tool handlers; records every call so tests can assert what reached it. */
export function fakeBackend(
  overrides: Partial<BrokerBackend> & { oss?: Record<string, OssHandler> } = {}
): BrokerBackend & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const oss: Record<string, OssHandler> = {
    search: (a) => JSON.stringify(a.query === 'zzz-nothing' ? { query: a.query, results: [] } : { query: a.query, results: [{ id: 'm1', path: 'a.md', content: 'contact x@y.io' }] }),
    current_context: () => JSON.stringify({ app: 'Cursor', window: 'notes — /Users/alice/x.md' }),
    resolve_evidence: () => JSON.stringify(evidenceFixture),
    remember: (a) => JSON.stringify({ entry_id: 'e-new', file: 'notes.md', tags: [], echo: a.content }),
    correct_memory: () => JSON.stringify({ kind: 'supersede', applied: true, ok: true }),
    process_pending_model_work: () => JSON.stringify({ status: 'unsupported', reason: 'client_missing_sampling_with_tools', processed: 0 }),
    ...(overrides.oss ?? {})
  }
  const { oss: _ignored, ...rest } = overrides
  return {
    calls,
    card: () => null,
    ossTool: async (name, args) => {
      calls.push({ name, args })
      const h = oss[name]
      return h ? h(args) : JSON.stringify({ tool: name, ok: true })
    },
    rewindFrames: async () => ({ frames: [], next_cursor: null, scanned: 0, partial: false }),
    rewindScreenshot: async () => {
      throw new Error('no screenshot in fake backend')
    },
    budget: () => ({ enabled: true, exhausted: false }),
    ...rest
  }
}

export async function startBroker(backend: BrokerBackend = fakeBackend()) {
  const root = tempRoot('broker')
  const paths = ensureStore(storePaths(root))
  const grants = createGrantStore(paths)
  const audit = openAuditLog(paths.auditDb)
  const broker = createBroker({ grants, audit, backend, port: 0 })
  const info = await broker.start()
  return { root, paths, grants, audit, broker, ...info }
}

export async function connectClient(url: string, token: string, name = 'test-client') {
  const client = new Client({ name, version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  return client
}

export function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> }
  return r.content?.find((c) => c.type === 'text')?.text ?? ''
}
