import type {
  ApiEnvelope,
  EvidenceResponse,
  HealthData,
  LensErrorCode,
  ModelGraphResponse,
  NodeResponse,
  PermissionsData,
  StatusData
} from '../../shared/types'
import {
  OwnerAliasListSchema,
  OwnerAliasStateSchema,
  type OwnerAliasList,
  type OwnerAliasListStatus,
  type OwnerAliasState
} from './owner-aliases'
import {
  isOwnerDeleteNotFound,
  notFoundResult,
  OWNER_DELETE_MAX_IDS,
  parseOwnerDeleteResult,
  type ImportDeleteBy,
  type OwnerDeleteResult,
  type TimelineDeleteBy
} from './owner-delete'
import { tr } from '../../shared/i18n'

export class RuntimeError extends Error {
  readonly code: LensErrorCode
  readonly status?: number
  /** Runtime's own short error code from a 4xx `{"detail": "<code>"}` body (e.g. `unusable_alias`), if any. */
  readonly detail?: string

  constructor(code: LensErrorCode, message: string, status?: number, detail?: string) {
    super(message)
    this.name = 'RuntimeError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

interface RequestOptions {
  auth?: boolean
  timeoutMs?: number
  method?: 'GET' | 'POST'
  /** JSON request body (POST only). */
  body?: unknown
}

/** A Runtime `detail` is forwarded only when it is a short machine code (never free text). */
const DETAIL_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/

async function detailCode(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { detail?: unknown }
    return typeof payload?.detail === 'string' && DETAIL_CODE_RE.test(payload.detail) ? payload.detail : undefined
  } catch {
    return undefined
  }
}

// --- evidence asOf (S1-03) ---------------------------------------------------------------
// Runtime `GET /model/evidence` declares `as_of: datetime` (FastAPI/pydantic 2). pydantic also
// accepts `20260301` (parsed as a Unix epoch → 1970) and space-separated datetimes, so Lens only
// forwards ISO date or ISO datetime. Mirror: src/renderer/src/components/evidence/asOf.ts.
const EVIDENCE_AS_OF_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/

export function evidenceAsOfError(): string {
  return tr(
    'asOf is not a valid time: only an ISO date (2026-03-01) or ISO datetime (2026-03-01T10:00, 2026-03-01T10:00:00+08:00) is accepted',
    'asOf 不是合法的时间：只接受 ISO 日期（2026-03-01）或 ISO 日期时间（2026-03-01T10:00、2026-03-01T10:00:00+08:00）'
  )
}

export function isValidEvidenceAsOf(value: string): boolean {
  const match = EVIDENCE_AS_OF_RE.exec(value)
  if (!match) return false
  const [, y, mo, d, h, mi, s, tzh, tzm] = match
  const year = Number(y)
  const probe = new Date(Date.UTC(year, Number(mo) - 1, Number(d)))
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d)) {
    return false
  }
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59))) return false
  if (tzh !== undefined && (Number(tzh) > 23 || Number(tzm) > 59)) return false
  return true
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { success?: unknown }).success === 'boolean' &&
    'data' in (value as object)
  )
}

export class RuntimeClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(port: number, token: string) {
    this.baseUrl = `http://127.0.0.1:${port}`
    this.token = token
  }

  health(): Promise<HealthData> {
    return this.request<HealthData>('/health', { auth: false, timeoutMs: 2000 })
  }

  status(): Promise<StatusData> {
    return this.request<StatusData>('/status')
  }

  permissions(): Promise<PermissionsData> {
    return this.request<PermissionsData>('/permissions')
  }

  modelGraph(): Promise<ModelGraphResponse> {
    return this.request<ModelGraphResponse>('/model/graph', { timeoutMs: 15000 })
  }

  /** Runtime's server-side scrubbed card projection (`GET /model/share-card`). Shape is runtime-defined. */
  shareCard(): Promise<unknown> {
    return this.request<unknown>('/model/share-card', { timeoutMs: 15000 })
  }

  evidence(ref: string, asOf?: string): Promise<EvidenceResponse> {
    const params = new URLSearchParams({ ref })
    if (asOf) {
      if (!isValidEvidenceAsOf(asOf)) {
        return Promise.reject(new RuntimeError('unknown', evidenceAsOfError()))
      }
      params.set('as_of', asOf)
    }
    return this.request<EvidenceResponse>(`/model/evidence?${params.toString()}`, { timeoutMs: 15000 })
  }

  node(id: string): Promise<NodeResponse> {
    const params = new URLSearchParams({ id })
    return this.request<NodeResponse>(`/model/node?${params.toString()}`, { timeoutMs: 15000 })
  }

  /** Runtime 2026-11-05.3 `GET /owner-aliases` (owner review list, newest evidence first). */
  async ownerAliases(status: OwnerAliasListStatus = 'pending'): Promise<OwnerAliasList> {
    const params = new URLSearchParams({ status })
    return this.validated(await this.request<unknown>(`/owner-aliases?${params.toString()}`, { timeoutMs: 15000 }), OwnerAliasListSchema)
  }

  /** `POST /owner-aliases/confirm`: the owner says the alias is theirs; it then resolves to `self`. */
  async confirmOwnerAlias(alias: string, note?: string): Promise<OwnerAliasState> {
    const body = note ? { alias, note } : { alias }
    return this.validated(await this.request<unknown>('/owner-aliases/confirm', { method: 'POST', body, timeoutMs: 15000 }), OwnerAliasStateSchema)
  }

  /** `POST /owner-aliases/reject`: the owner says it is not theirs; screen evidence will not re-propose it. */
  async rejectOwnerAlias(alias: string): Promise<OwnerAliasState> {
    return this.validated(await this.request<unknown>('/owner-aliases/reject', { method: 'POST', body: { alias }, timeoutMs: 15000 }), OwnerAliasStateSchema)
  }

  /** R10 `POST /imports/delete`: imported documents (+ their staged sessions / timeline blocks). */
  deleteImports(by: ImportDeleteBy, ids: string[]): Promise<OwnerDeleteResult> {
    return this.ownerDelete('/imports/delete', 'import', ids, { by, ids })
  }

  /** R10 `POST /memory/entries/delete`: erase agent-written (`source:agent-run`) memory entries. */
  deleteMemoryEntries(entryIds: string[]): Promise<OwnerDeleteResult> {
    return this.ownerDelete('/memory/entries/delete', 'memory_entry', entryIds, { entry_ids: entryIds })
  }

  /** R10 `POST /timeline/delete`: timeline blocks by id, or the blocks of one imported source. */
  deleteTimeline(by: TimelineDeleteBy, ids: string[]): Promise<OwnerDeleteResult> {
    return this.ownerDelete('/timeline/delete', 'timeline', ids, { by, ids })
  }

  /**
   * Shared R10 delete call. A Runtime 404 whose body is `{detail:{error:"not_found"}}` means none of
   * the ids exist (returned as an all-`missing` result); any other 404/405 means the Runtime has no
   * such route (older than R10) → RuntimeError('not_found', …, detail 'endpoint_missing').
   */
  private async ownerDelete(pathname: string, kind: OwnerDeleteResult['kind'], ids: string[], fields: Record<string, unknown>): Promise<OwnerDeleteResult> {
    if (!ids.length || ids.length > OWNER_DELETE_MAX_IDS) throw new RuntimeError('unknown', tr(`You can delete 1–${OWNER_DELETE_MAX_IDS} items at a time`, `一次只能删除 1–${OWNER_DELETE_MAX_IDS} 条`))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema_version: 1, ...fields }),
        signal: controller.signal
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new RuntimeError('timeout', tr('Runtime request timed out', '请求 Runtime 超时'))
      throw new RuntimeError('unreachable', tr('Cannot reach the Runtime (127.0.0.1). Start persome first.', '连不上 Runtime（127.0.0.1），请先启动 persome'))
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403) {
      throw new RuntimeError('unauthorized', tr('Local token is invalid. Run persome start again.', '本地 token 无效，请重新运行 persome start'), response.status)
    }
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (response.status === 404 || response.status === 405) {
      if (response.status === 404 && isOwnerDeleteNotFound(body)) return notFoundResult(kind, ids)
      throw new RuntimeError('not_found', tr("This Runtime can't delete single entries yet (needs R10 or newer)", 'Runtime 还不支持按条删除（需要 R10 或更新的 Runtime）'), response.status, 'endpoint_missing')
    }
    if (!response.ok) {
      const d = (body as { detail?: unknown } | null)?.detail
      const detail = typeof d === 'string' && DETAIL_CODE_RE.test(d) ? d : undefined
      throw new RuntimeError('server', tr(`Runtime returned ${response.status}${detail ? ` (${detail})` : ''}`, `Runtime 返回 ${response.status}${detail ? `（${detail}）` : ''}`), response.status, detail)
    }
    const parsed = parseOwnerDeleteResult(body)
    if (!parsed) throw new RuntimeError('schema', tr('Runtime returned data in an unexpected format', 'Runtime 返回的数据格式与预期不符'))
    return parsed
  }

  private validated<T>(payload: unknown, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new RuntimeError('schema', tr('Runtime returned data in an unexpected format', 'Runtime 返回的数据格式与预期不符'))
    return parsed.data
  }

  private async request<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    const { auth = true, timeoutMs = 5000, method = 'GET' } = options
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (auth) headers.Authorization = `Bearer ${this.token}`
      if (options.body !== undefined) headers['Content-Type'] = 'application/json'

      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      })

      if (response.status === 401 || response.status === 403) {
        throw new RuntimeError('unauthorized', tr('Local token is invalid. Run persome start again.', '本地 token 无效，请重新运行 persome start'), response.status)
      }
      if (response.status === 404) {
        throw new RuntimeError('not_found', tr(`Runtime has no such endpoint: ${pathname}`, `Runtime 没有这个接口：${pathname}`), 404)
      }
      if (!response.ok) {
        const detail = response.status >= 400 && response.status < 500 ? await detailCode(response) : undefined
        throw new RuntimeError('server', tr(`Runtime returned ${response.status}${detail ? ` (${detail})` : ''}`, `Runtime 返回 ${response.status}${detail ? `（${detail}）` : ''}`), response.status, detail)
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new RuntimeError('schema', tr('Runtime did not return valid JSON', 'Runtime 返回的不是合法 JSON'))
      }
      if (isEnvelope(payload)) return payload.data as T
      return payload as T
    } catch (error) {
      if (error instanceof RuntimeError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RuntimeError('timeout', tr('Runtime request timed out', '请求 Runtime 超时'))
      }
      const message = error instanceof Error ? error.message : String(error)
      if (/ECONNREFUSED|fetch failed|connect/i.test(message)) {
        throw new RuntimeError('unreachable', tr('Cannot reach the Runtime (127.0.0.1). Start persome first.', '连不上 Runtime（127.0.0.1），请先启动 persome'))
      }
      throw new RuntimeError('unknown', message)
    } finally {
      clearTimeout(timer)
    }
  }
}
