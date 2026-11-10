import { z } from 'zod'
import type { AgentSignal } from './types'

/**
 * Assessor: ONE bounded LLM judgement per settled task. Fail closed.
 *
 * The verdict carries no minutes. A response with a `minutes` (or any unknown) key,
 * malformed JSON, or evidence refs that do not resolve is `invalid` → task stays
 * `needs_assessment`. The decision rule lives here and in the tick; tests replace only
 * the transport.
 *
 * ── Production transport (X3, DECISIONS-ROUND4 R4-1: option C, implemented) ──────────
 * The OSS runtime routes "subscription" LLM calls through `[agent_funding]` in
 * $PERSOME_ROOT/config.toml (enabled/client/executable/model/daily_call_limit/
 * timeout_seconds/max_parallel_calls), implemented by
 * `persome.writer.agent_cli.complete(config, messages, tools, max_tokens)`. Before each
 * call it reserves one unit in `$PERSOME_ROOT/.agent-funding-usage.json` under an
 * fcntl lock on `.agent-funding-usage.lock` and raises AgentFundingBudgetExceeded at the
 * cap. The runtime exposes NO REST/MCP completion endpoint.
 *
 * Options considered:
 *  A. New runtime endpoint (`POST /llm/complete`): needs an upstream change. Not available.
 *  B. Lens spawns `claude -p ...` itself: Node cannot take the runtime's fcntl lock →
 *     racy double-spend of the shared daily budget. Rejected (and forbidden by R4-1).
 *  C. (IMPLEMENTED in agentFundingTransport.ts) Lens main runs the runtime's own
 *     interpreter `<root>/venv/bin/python -I -B -c <fixed script>` with `PERSOME_ROOT`
 *     set and {messages, max_tokens} on stdin. The script calls `agent_cli.complete(
 *     cfg.agent_funding, messages=…, tools=None, max_tokens=…)`, so the call takes the SAME
 *     lock, the SAME daily_call_limit and the same client flags. Exceptions map:
 *     AgentFundingBudgetExceeded → quota, AgentFundingUnavailable (not enabled, executable
 *     missing, client exited non-zero) → budget_unavailable, AgentFundingTimeout → offline,
 *     anything else → error. Missing venv python → budget_unavailable without any spawn
 *     (never falls back to `claude`).
 *
 * Main injects that transport plus a budget probe (`readBudget()`: enabled && !exhausted).
 * The user switch `assessorEnabled` stays default false; HET's perTick / perDay caps apply
 * on top of the runtime's daily_call_limit. HET never uses the cloud chat endpoint.
 * Tests use fake exec / fake transports only; `disabledTransport` remains the default
 * when nothing is injected.
 */

export const VerdictSchema = z.strictObject({
  kind: z.enum(['research', 'writing', 'coding', 'review', 'ops', 'meeting']),
  size: z.enum(['xs', 's', 'm', 'l', 'xl']),
  complexity: z.enum(['low', 'medium', 'high']),
  agent_share: z.number().min(0).max(1),
  adoption: z.enum(['strong', 'weak', 'unknown']),
  evidence: z.array(z.string().max(80)).max(10)
})
export type Verdict = z.infer<typeof VerdictSchema>

export type TransportOutcome = 'ok' | 'quota' | 'offline' | 'budget_unavailable' | 'error'
export interface TransportResponse {
  outcome: TransportOutcome
  text?: string
  /** X3: provenance reported by the transport (Runtime `[agent_funding]` client / model). */
  client?: string | null
  model?: string | null
}
export interface AssessorRequest {
  taskId: string
  prompt: string
}
export interface AssessorTransport {
  readonly name: string
  complete(req: AssessorRequest): Promise<TransportResponse>
}

export const disabledTransport: AssessorTransport = {
  name: 'disabled',
  async complete() {
    return { outcome: 'budget_unavailable' }
  }
}

export interface AssessorEvidence {
  eventId: string
  ts: number
  role: string
  toolNames: string[]
  filesWritten: string[]
  signals: AgentSignal[]
  summary: string
}

export interface AssessorTaskView {
  id: string
  agent: string
  project: string | null
  title: string | null
  start: number
  end: number
  stats: Record<string, number>
  filesWritten: string[]
  signals: AgentSignal[]
}

const INSTRUCTIONS = [
  'You classify one completed AI-agent work session. Output ONLY a JSON object with exactly these keys:',
  'kind (research|writing|coding|review|ops|meeting), size (xs|s|m|l|xl: amount of output relative to one anchor unit),',
  'complexity (low|medium|high), agent_share (0..1: fraction of the output produced by the agent),',
  'adoption (strong: the output was committed/edited-in/sent; weak: only indirect use; unknown: no evidence),',
  'evidence (array of refs proving adoption, each "event:<id>" or "signal:<name>" taken from the input).',
  'Do NOT output minutes or durations. Do not add keys.'
].join(' ')

const fileType = (p: string): string => {
  const b = p.split('/').pop() ?? ''
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i).toLowerCase().slice(0, 12) : '(none)'
}
const fileTypes = (ps: string[]): string[] => [...new Set(ps.map(fileType))].sort()

/**
 * Deterministic, size-bounded prompt. Evidence is trimmed from the end to fit.
 *
 * Security policy P1: unless `includeContent` (setting `sendSummariesToAssessor`, default
 * false) is set, the prompt carries only ids, enums, counts, tool names, signals and file
 * *types* — no summaries, titles, project paths or file paths.
 */
export function buildAssessorPrompt(
  task: AssessorTaskView,
  evidence: AssessorEvidence[],
  maxChars: number,
  includeContent = false
): string {
  const head = {
    task: {
      id: task.id,
      agent: task.agent,
      ...(includeContent ? { project: task.project, title: task.title } : {}),
      duration_min: Math.round((task.end - task.start) / 60_000),
      stats: task.stats,
      ...(includeContent ? { files_written: task.filesWritten.slice(0, 20) } : { file_types_written: fileTypes(task.filesWritten) }),
      signals: task.signals
    }
  }
  let ev = evidence.map((e) => ({
    id: e.eventId,
    role: e.role,
    tools: e.toolNames.slice(0, 5),
    ...(includeContent ? { files: e.filesWritten.slice(0, 5), summary: e.summary } : { file_types: fileTypes(e.filesWritten) }),
    signals: e.signals
  }))
  for (;;) {
    const prompt = `${INSTRUCTIONS}\nINPUT:\n${JSON.stringify({ ...head, events: ev })}`
    if (prompt.length <= maxChars || ev.length === 0) return prompt.slice(0, maxChars)
    ev = ev.slice(0, Math.max(0, Math.floor(ev.length * 0.75)))
  }
}

export type AssessOutcome = TransportOutcome | 'invalid'
export interface AssessResult {
  outcome: AssessOutcome
  verdict?: Verdict
  reason?: string
  inputChars: number
  outputChars: number
  client?: string | null
  model?: string | null
}

/** Parse + validate model text against the task's own evidence. Pure. */
export function parseVerdict(
  text: string,
  allowedEventIds: ReadonlySet<string>,
  taskSignals: readonly string[]
): { ok: true; verdict: Verdict } | { ok: false; reason: string } {
  let t = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)
  if (fence) t = fence[1]
  let obj: unknown
  try {
    obj = JSON.parse(t)
  } catch {
    return { ok: false, reason: 'not_json' }
  }
  if (typeof obj === 'object' && obj !== null && 'minutes' in obj) return { ok: false, reason: 'minutes_forbidden' }
  const r = VerdictSchema.safeParse(obj)
  if (!r.success) return { ok: false, reason: 'schema' }
  const v = r.data
  for (const ref of v.evidence) {
    const [type, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]
    if (type === 'event' && allowedEventIds.has(id)) continue
    if (type === 'signal' && taskSignals.includes(id)) continue
    return { ok: false, reason: 'unresolved_evidence' }
  }
  if (v.adoption !== 'unknown' && v.evidence.length === 0) return { ok: false, reason: 'adoption_without_evidence' }
  return { ok: true, verdict: v }
}

/** One transport call. Never retries; never throws. */
export async function assessOne(
  task: AssessorTaskView,
  evidence: AssessorEvidence[],
  transport: AssessorTransport,
  maxInputChars: number,
  includeContent = false
): Promise<AssessResult> {
  const prompt = buildAssessorPrompt(task, evidence, maxInputChars, includeContent)
  let res: TransportResponse
  try {
    res = await transport.complete({ taskId: task.id, prompt })
  } catch {
    return { outcome: 'error', reason: 'transport_threw', inputChars: prompt.length, outputChars: 0 }
  }
  const outputChars = res.text?.length ?? 0
  const prov = { client: res.client ?? null, model: res.model ?? null }
  if (res.outcome !== 'ok') return { outcome: res.outcome, inputChars: prompt.length, outputChars, ...prov }
  const parsed = parseVerdict(res.text ?? '', new Set(evidence.map((e) => e.eventId)), task.signals)
  if (!parsed.ok) return { outcome: 'invalid', reason: parsed.reason, inputChars: prompt.length, outputChars, ...prov }
  return { outcome: 'ok', verdict: parsed.verdict, inputChars: prompt.length, outputChars, ...prov }
}
