/**
 * Renderer-facing API fragment for Connections + Access log (merged into src/shared/api.ts).
 * No tokens, token hashes, or agent config contents ever appear here.
 */
import type { LensResult } from '../../shared/types'
import type { GrantView } from '../identity/grants-schema'

export type AuditOutcome = 'ok' | 'denied' | 'unauthorized' | 'error'

export interface AccessLogRow {
  id: number
  ts: string
  day: string
  grantId: string | null
  client: string
  /** Broker tool name (original column: capability). */
  capability: string
  itemIds: string[]
  itemCount: number
  responseChars: number
  outcome: AuditOutcome
  httpStatus: number
  errorCode: string | null
  durationMs: number
}

/**
 * Previews of one row, fetched only when the user expands it (original: previews are seen on
 * expand only; list and summaries carry safe fields only).
 */
export interface AccessLogPreview {
  id: number
  argumentsPreview: string
  resultPreview: string
}

export interface AccessLogDay {
  day: string
  client: string
  reads: number
  responseChars: number
}

export const AGENT_IDS = ['claude-code', 'codex', 'claude-desktop', 'cursor'] as const
export type AgentId = (typeof AGENT_IDS)[number]

/** Original states (connected / not installed / mismatch / partial) plus `available` = installed, not connected. */
export type AgentState = 'connected' | 'not_installed' | 'mismatch' | 'partial' | 'available'

export interface AgentView {
  id: AgentId
  name: string
  state: AgentState
  /** Why the state was chosen, for the row tooltip. */
  detail: string
  configPath: string
  /** False when Lens cannot write this client's config automatically (manual setup only). */
  autoConnect: boolean
  /** Original access model: always "full" unless a Lens extension scoped grant is used. */
  access: 'full' | 'scoped'
  grant: GrantView | null
}

export interface BrokerStatus {
  url: string
  running: boolean
  error: string | null
}

export interface ConnectionsOverview {
  broker: BrokerStatus
  agents: AgentView[]
}

export interface ConnectResult {
  agent: AgentView
  /** Original behaviour: the client must be restarted to pick up the new MCP config. */
  restartRequired: true
}

export const CLEAR_LOG_CONFIRM = 'CLEAR_ACCESS_LOG' as const

export interface ConnectionsApi {
  connections: {
    list(): Promise<LensResult<ConnectionsOverview>>
    connect(agent: AgentId): Promise<LensResult<ConnectResult>>
    disconnect(agent: AgentId): Promise<LensResult<AgentView>>
    /** Copies a ready-to-paste MCP JSON (with a fresh token) to the clipboard from main. */
    copyManualConfig(agent: AgentId): Promise<LensResult<AgentView>>
    /** Lens extension. */
    revokeGrant(grantId: string): Promise<LensResult<GrantView>>
    /** Lens extension: extend an active grant's expiry. */
    renewGrant(grantId: string, ttlSeconds: number | null): Promise<LensResult<GrantView>>
  }
  accessLog: {
    list(options?: { days?: number; includeFailures?: boolean }): Promise<LensResult<AccessLogRow[]>>
    daily(days?: number): Promise<LensResult<AccessLogDay[]>>
    /** Previews of one row; call only when the row is expanded. Null if the row no longer exists. */
    preview(id: number): Promise<LensResult<AccessLogPreview | null>>
    clear(confirm: typeof CLEAR_LOG_CONFIRM): Promise<LensResult<{ removed: number }>>
  }
}

export const CONNECTIONS_CHANNELS = {
  list: 'lens:connections:list',
  connect: 'lens:connections:connect',
  disconnect: 'lens:connections:disconnect',
  copyManual: 'lens:connections:copy-manual',
  revoke: 'lens:connections:revoke',
  renew: 'lens:connections:renew',
  logList: 'lens:accesslog:list',
  logDaily: 'lens:accesslog:daily',
  logPreview: 'lens:accesslog:preview',
  logClear: 'lens:accesslog:clear'
} as const
