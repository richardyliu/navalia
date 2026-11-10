/**
 * Broker tool catalog (pure: no Node imports, renderer-safe).
 *
 * Full access (original Connections semantics, ref §9.4 / §11.2) = every tool below:
 * the 22 OSS runtime tools under their exact names (Runtime schema 2026-11-05.3 added owner_aliases), the 3 product Rewind tools (shapes are
 * Lens-defined, only the names are known), and 4 Lens extensions.
 * Write tools are reachable under full access by explicit user decision (2026-11-04).
 * Scopes are a Lens extension (DEVIATIONS D1) and only restrict scoped grants.
 */
import type { Scope } from '../identity/grants-schema'

export type ToolOrigin = 'oss' | 'product' | 'extension'

export interface ToolMeta {
  name: string
  origin: ToolOrigin
  /** Changes runtime state (memory write / correction / model work). */
  write: boolean
  /** May spend LLM budget: gated by the agent-funding budget, fails closed. */
  llm: boolean
  /** Returns an image that cannot be PII-scrubbed. */
  image: boolean
  /** Lens extension: scopes that allow this tool for a scoped grant. */
  scopes: Scope[]
}

const oss = (name: string, scopes: Scope[], extra: Partial<ToolMeta> = {}): ToolMeta => ({
  name,
  origin: 'oss',
  write: false,
  llm: false,
  image: false,
  scopes,
  ...extra
})

export const TOOL_CATALOG: ToolMeta[] = [
  // OSS runtime tools (exact names). Read tools default to model:search.
  oss('search', ['model:search']),
  oss('search_captures', ['model:search']),
  oss('read_receipt', ['evidence:read']),
  oss('resolve_evidence', ['evidence:read']),
  oss('verify_fact', ['model:search']),
  oss('current_context', ['now:read']),
  oss('recent_activity', ['now:read']),
  oss('related_events', ['model:search']),
  oss('behavior_patterns', ['model:search']),
  oss('get_model_snapshot', ['model:search']),
  oss('entity_graph', ['model:search']),
  oss('attention_trajectory', ['now:read']),
  oss('read_recent_capture', ['now:read']),
  oss('get_schema', ['model:search']),
  oss('list_memories', ['model:search']),
  oss('read_memory', ['model:search']),
  oss('query_health_metrics', ['model:search']),
  oss('get_pending_model_work', ['model:search']),
  // Runtime 2026-11-05.3: read-only list of owner-alias candidates, including pending and rejected
  // names that may belong to OTHER people. model:search only: identity:read is a public-tier scope
  // (DESIGN §4.3) and must not reach it (security review F1). Rows carry on-screen evidence quotes:
  // tools.ts keeps only allowlisted row fields for scoped grants without evidence:read (Lens extension).
  oss('owner_aliases', ['model:search']),
  oss('remember', ['model:jot'], { write: true }),
  // OSS correct_memory plans the update with an LLM (writer/correct.py call_llm "update_memory").
  oss('correct_memory', ['model:correct'], { write: true, llm: true }),
  // OSS process_pending_model_work runs model work via MCP Sampling from the client.
  oss('process_pending_model_work', ['model:ask'], { write: true, llm: true }),
  // Product Rewind tools: names from the product, shapes Lens-defined.
  { name: 'search_rewind', origin: 'product', write: false, llm: false, image: false, scopes: ['rewind:read'] },
  { name: 'rewind_frames', origin: 'product', write: false, llm: false, image: false, scopes: ['rewind:read'] },
  { name: 'view_rewind_screenshot', origin: 'product', write: false, llm: false, image: true, scopes: ['rewind:read'] },
  // Lens extensions.
  { name: 'card_get', origin: 'extension', write: false, llm: false, image: false, scopes: ['card:read', 'identity:read'] },
  { name: 'usage_report', origin: 'extension', write: false, llm: false, image: false, scopes: ['reports:read'] },
  // S1-06 Lens extensions: read-only Workflows (Lens Store + Runtime skill files). No dedicated
  // scope exists; they derive from the Personal Model, so scoped grants need model:search.
  { name: 'get_workflow', origin: 'extension', write: false, llm: false, image: false, scopes: ['model:search'] },
  { name: 'search_workflows', origin: 'extension', write: false, llm: false, image: false, scopes: ['model:search'] }
]

export const OSS_TOOL_NAMES = TOOL_CATALOG.filter((t) => t.origin === 'oss').map((t) => t.name)

export function toolMeta(name: string): ToolMeta | undefined {
  return TOOL_CATALOG.find((t) => t.name === name)
}
