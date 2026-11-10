import { z } from 'zod'
import { HET_DEFINITION, type HetActivity, type HetPeriod, type HetSummary, type HetTaskDto } from './api'
import { isValidTimeZone } from './tz'
import type { HetService } from './service'
import type { BrokerRestEndpoint, BrokerRestResult, BrokerRestRouter } from '../broker/server'

/**
 * OG-08 / HET-05: local REST adapter over the same HetService functions the IPC uses
 * (DEVIATIONS D17 "thin REST adapter"). Mounted on the existing Broker loopback server
 * (127.0.0.1, Bearer = Connection grant token, Access-logged) — NOT a second HTTP server.
 *
 * Paths follow reference §11.1:
 *   GET  /het/summary?days=7[&timezone=]
 *   GET  /het/tasks?limit=100&include_activity=true
 *   GET  /het/period?start=&end=&timezone=&cursor=&limit=[&include_activity=]
 *   GET  /het/activity?start=&end=[&timezone=]          (response shape Lens-defined, D18)
 *   POST /het/tasks/correction  { task_id, action: accepted|rejected|not_agent }
 * Lens extensions (labelled as such):
 *   POST /het/tasks/correction/revert  { task_id }       (D17: corrections reversible)
 *   POST /het/retry  {}                                  (HET-08: re-queue failed, one tick)
 *
 * Privacy (security review F2): task DTOs are mapped before leaving Lens — `project` (a full cwd)
 * becomes its last path segment, file lists become basenames, and evidence `source.file` (an
 * absolute transcript path) becomes the transcript's basename. The Broker then PII-scrubs the
 * whole body like any MCP result. Validation runs before a grant use is consumed (F10), and
 * `/het/retry` is behind the same LLM budget gate as MCP `meta.llm` tools (F11).
 *
 * Minutes: never from the assessor; only anchors (ledger). When no task in the window
 * finished assessment, totals are reported as `null` with `measurement: "unmeasured"`
 * (「未测量」) instead of zeros that would read as a measurement.
 */

export const HET_REST_PREFIX = '/het/'

const TASK_ID = z.string().regex(/^het_[0-9a-f]{20}$/, 'invalid task_id')
const TimeZone = z.string().max(64).refine(isValidTimeZone, { message: 'unknown IANA time zone' })
const IsoTime = z.iso.datetime({ offset: true })
const IntParam = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,4}$/, 'expected an integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
const BoolParam = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const SummaryQuery = z.strictObject({ days: IntParam(1, 366).optional(), timezone: TimeZone.optional() })
const TasksQuery = z.strictObject({ limit: IntParam(1, 200).optional(), include_activity: BoolParam.optional() })
const PeriodQuery = z.strictObject({
  start: IsoTime,
  end: IsoTime,
  timezone: TimeZone.optional(),
  cursor: z.string().max(400).optional(),
  limit: IntParam(1, 200).optional(),
  include_activity: BoolParam.optional()
})
const ActivityQuery = z.strictObject({ start: IsoTime, end: IsoTime, timezone: TimeZone.optional() })
const EmptyQuery = z.strictObject({})
const CorrectionBody = z.strictObject({ task_id: TASK_ID, action: z.enum(['accepted', 'rejected', 'not_agent']) })
const RevertBody = z.strictObject({ task_id: TASK_ID })
const RetryBody = z.strictObject({}).optional()

/** Error envelope: fixed codes, messages without input echo, paths or stack traces. */
function fail(status: number, code: string, message: string): BrokerRestResult {
  return { status, body: { error: { code, message } }, errorCode: code }
}

function invalid(error: z.ZodError): BrokerRestResult {
  // Path + zod issue code only; never the offending value.
  const issues = error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
  return fail(400, 'invalid_request', issues.join('; '))
}

function queryObject(q: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [k, v] of q) {
    if (Object.prototype.hasOwnProperty.call(out, k)) return null // duplicate parameter
    out[k] = v
  }
  return out
}

/** Map a known domain error to a sanitized response; anything else → 500 without detail. */
function domainError(e: unknown): BrokerRestResult {
  const msg = e instanceof Error ? e.message : ''
  if (/^unknown task /.test(msg)) return fail(404, 'unknown_task', 'no task with that id')
  if (msg === 'invalid cursor') return fail(400, 'invalid_cursor', 'cursor is not valid')
  if (/^activity: /.test(msg)) return fail(400, 'invalid_range', msg.slice('activity: '.length).slice(0, 80))
  if (msg === 'HET ledger is closed') return fail(503, 'ledger_closed', 'HET ledger is not available')
  return fail(500, 'internal_error', 'internal error')
}

type Measurement = 'measured' | 'unmeasured'
const measurement = (m: boolean): Measurement => (m ? 'measured' : 'unmeasured')
/** API contract for external agents: fixed, independent of the UI language (use `measurement` for logic). */
const UNMEASURED_LABEL = '未测量'

/** REST view of the summary: null minutes when nothing in the window finished assessment. */
export function restSummary(s: HetSummary, assessor: unknown): Record<string, unknown> {
  const m = s.measured
  return {
    definition: HET_DEFINITION,
    measurement: measurement(m),
    label: m ? null : UNMEASURED_LABEL,
    state: s.state,
    ledger_state: s.ledger_state ?? s.state,
    update: s.update ?? null,
    timezone: s.timezone,
    total_minutes: m ? s.total_minutes : null,
    total_minutes_tenths: m ? s.total_minutes_tenths : null,
    pending: s.pending,
    failed: s.failed,
    unsettled: s.unsettled,
    days: s.days.map((d) => ({
      date: d.date,
      minutes: m ? d.minutes : null,
      minutes_tenths: m ? d.minutes_tenths : null,
      tasks: d.tasks,
      pending: d.pending
    })),
    assessor
  }
}

export function restPeriod(p: HetPeriod): Record<string, unknown> {
  const m = p.measured
  return {
    ...p,
    tasks: p.tasks.map(restTask),
    measurement: measurement(m),
    label: m ? null : UNMEASURED_LABEL,
    total_minutes: m ? p.total_minutes : null,
    total_minutes_tenths: m ? p.total_minutes_tenths : null,
    page_minutes_tenths: m ? p.page_minutes_tenths : null
  }
}

export function restActivity(a: HetActivity): Record<string, unknown> {
  const m = a.measured
  return {
    ...a,
    shape: 'lens-defined',
    measurement: measurement(m),
    label: m ? null : UNMEASURED_LABEL,
    total_minutes: m ? a.total_minutes : null,
    total_minutes_tenths: m ? a.total_minutes_tenths : null,
    days: a.days.map((d) => ({ ...d, minutes: m ? d.minutes : null, minutes_tenths: m ? d.minutes_tenths : null }))
  }
}

/** Last path segment ('/' or '\\'), never a directory. Empty / '.' / '..' → '[path]'. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return last && last !== '.' && last !== '..' ? last : '[path]'
}

const baseNames = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(baseName) : [])

/**
 * REST view of one task: no absolute paths. `project` → project name, files → basenames,
 * evidence source → transcript basename + line (still resolvable locally, HET-10; no account name).
 */
export function restTask(t: HetTaskDto): Record<string, unknown> {
  const { evidence, ...rest } = t
  const out: Record<string, unknown> = {
    ...rest,
    project: t.project === null ? null : baseName(t.project),
    files_written: baseNames(t.files_written)
  }
  if (evidence) {
    out.evidence = evidence.map((e) => ({
      ...e,
      files: baseNames(e.files),
      source: { file: baseName(String(e.source?.file ?? '')), line: e.source?.line ?? null }
    }))
  }
  return out
}

export interface HetRestDeps {
  /** Lazy: the service may be created after the Broker. null ⇒ 503. */
  service: () => HetService | null
}

export function createHetRestRouter(deps: HetRestDeps): BrokerRestRouter {
  const svc = (): HetService => {
    const s = deps.service()
    if (!s) throw new Error('HET ledger is closed')
    return s
  }
  const guard = async (fn: () => BrokerRestResult | Promise<BrokerRestResult>): Promise<BrokerRestResult> => {
    try {
      return await fn()
    } catch (e) {
      return domainError(e)
    }
  }
  const ok = (body: unknown, itemIds: string[] = [], count = itemIds.length): BrokerRestResult => ({ status: 200, body, itemIds, count })
  type Valid<T> = { ok: true; value: T } | { ok: false; result: BrokerRestResult }
  const parseQuery = <T>(schema: z.ZodType<T>, query: URLSearchParams): Valid<T> => {
    const q = schema.safeParse(queryObject(query))
    return q.success ? { ok: true, value: q.data } : { ok: false, result: invalid(q.error) }
  }
  /** POST: empty query + body schema. */
  const parsePost = <T>(schema: z.ZodType<T>, query: URLSearchParams, body: unknown): Valid<T> => {
    const q = EmptyQuery.safeParse(queryObject(query))
    if (!q.success) return { ok: false, result: invalid(q.error) }
    const b = schema.safeParse(body)
    return b.success ? { ok: true, value: b.data } : { ok: false, result: invalid(b.error) }
  }
  // Typed per endpoint; stored type-erased (the router passes back exactly what `validate` produced).
  const ep = <T>(e: BrokerRestEndpoint<T>): BrokerRestEndpoint<unknown> => e as unknown as BrokerRestEndpoint<unknown>
  /** Opaque Lens tokens the PII scrubber must not mangle (validated against a strict charset by the Broker). */
  const OPAQUE = ['id', 'task_id', 'event_id', 'next_cursor']

  const endpoints: Record<string, BrokerRestEndpoint<unknown>> = {
    'GET /het/summary': ep({
      capability: 'het_summary',
      write: false,
      scopes: ['reports:read'],
      opaqueKeys: OPAQUE,
      validate: ({ query }) => parseQuery(SummaryQuery, query),
      run: (q) =>
        guard(() => {
          const s = svc()
          const sum = s.summary(q.days ?? 7, q.timezone)
          return ok(restSummary(sum, s.status().assessor), [], sum.days.reduce((a, d) => a + d.tasks, 0))
        })
    }),
    'GET /het/tasks': ep({
      capability: 'het_tasks',
      write: false,
      scopes: ['reports:read'],
      opaqueKeys: OPAQUE,
      validate: ({ query }) => parseQuery(TasksQuery, query),
      run: (q) =>
        guard(() => {
          const tasks = svc().tasks(q.limit ?? 100, q.include_activity ?? false)
          return ok({ definition: HET_DEFINITION, tasks: tasks.map(restTask), limit: q.limit ?? 100 }, tasks.map((t) => t.id))
        })
    }),
    'GET /het/period': ep({
      capability: 'het_period',
      write: false,
      scopes: ['reports:read'],
      opaqueKeys: OPAQUE,
      validate: ({ query }) => {
        const v = parseQuery(PeriodQuery, query)
        if (v.ok && !(Date.parse(v.value.end) > Date.parse(v.value.start))) return { ok: false, result: fail(400, 'invalid_range', 'end must be after start') }
        return v
      },
      run: (q) =>
        guard(() => {
          const p = svc().period(Date.parse(q.start), Date.parse(q.end), q.cursor ?? null, q.limit, q.include_activity ?? false, q.timezone)
          return ok(restPeriod(p), p.tasks.map((t) => t.id))
        })
    }),
    'GET /het/activity': ep({
      capability: 'het_activity',
      write: false,
      scopes: ['reports:read'],
      opaqueKeys: OPAQUE,
      validate: ({ query }) => parseQuery(ActivityQuery, query),
      run: (q) =>
        guard(() => {
          const a = svc().activity(Date.parse(q.start), Date.parse(q.end), q.timezone)
          return ok(restActivity(a), a.markers.map((m) => m.id), a.markers_total)
        })
    }),
    'POST /het/tasks/correction': ep({
      capability: 'het_correction',
      write: true,
      scopes: [],
      opaqueKeys: OPAQUE,
      validate: ({ query, body }) => parsePost(CorrectionBody, query, body),
      run: (b) =>
        guard(() => {
          const r = svc().correct(b.task_id, b.action)
          return ok({ task_id: b.task_id, action: b.action, ...r, minutes: r.minutes_tenths === null ? null : r.minutes_tenths / 10 }, [b.task_id], 1)
        })
    }),
    'POST /het/tasks/correction/revert': ep({
      capability: 'het_correction_revert',
      write: true,
      scopes: [],
      opaqueKeys: OPAQUE,
      validate: ({ query, body }) => parsePost(RevertBody, query, body),
      run: (b) =>
        guard(() => {
          const r = svc().revertCorrection(b.task_id)
          return ok({ task_id: b.task_id, extension: true, ...r, minutes: r.minutes_tenths === null ? null : r.minutes_tenths / 10 }, [b.task_id], 1)
        })
    }),
    'POST /het/retry': ep({
      capability: 'het_retry',
      write: true,
      scopes: [],
      // Runs one tick that may call the assessor: same agent-budget gate as MCP `meta.llm` tools.
      llm: true,
      opaqueKeys: OPAQUE,
      validate: ({ query, body }) => parsePost(RetryBody, query, body),
      run: () =>
        guard(async () => {
          const s = svc()
          const r = await s.retry()
          return ok({ extension: true, requeued: r.requeued, update: s.update(), assessor: s.status().assessor }, [], r.requeued)
        })
    })
  }
  const paths = new Set(Object.keys(endpoints).map((k) => k.split(' ')[1]))

  return {
    prefix: HET_REST_PREFIX,
    resolve(method, pathname) {
      const hit = endpoints[`${method} ${pathname}`]
      if (hit) return hit
      if (paths.has(pathname)) return { status: 405, code: 'method_not_allowed' }
      return { status: 404, code: 'not_found' }
    }
  }
}
