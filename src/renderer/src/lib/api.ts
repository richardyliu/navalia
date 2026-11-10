import type {
  AppInfo,
  BehaviorPatterns,
  BudgetInfo,
  BuildState,
  CorrectResult,
  CaptureSearchHit,
  EvidenceResponse,
  LensErrorCode,
  LensResult,
  MemorySearchHit,
  RememberResult,
  ModelGraphResponse,
  NodeResponse,
  PermissionsData,
  RecentActivityResponse,
  RuntimeLocationInfo,
  SearchResponse,
  StatusData
} from '../../../shared/types'

export class ApiError extends Error {
  readonly code: LensErrorCode

  constructor(message: string, code: LensErrorCode) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** Unwrap a LensResult: the data, or throw ApiError (message is already safe for display). */
export async function unwrap<T>(promise: Promise<LensResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new ApiError(result.error.message, result.error.code)
  return result.data
}

export const api = {
  discover: (): Promise<RuntimeLocationInfo> => unwrap(window.lens.runtime.discover()),
  startRuntime: (): Promise<RuntimeLocationInfo> => unwrap(window.lens.runtime.start()),
  status: (): Promise<StatusData> => unwrap(window.lens.runtime.status()),
  permissions: (): Promise<PermissionsData> => unwrap(window.lens.runtime.permissions()),
  graph: (): Promise<ModelGraphResponse> => unwrap(window.lens.model.graph()),
  evidence: (ref: string, asOf?: string): Promise<EvidenceResponse> =>
    unwrap(window.lens.model.evidence(ref, asOf)),
  node: (id: string): Promise<NodeResponse> => unwrap(window.lens.model.node(id)),
  deltaReport: (limit?: number): Promise<unknown> => unwrap(window.lens.model.deltaReport(limit)),
  search: (query: string, topK?: number): Promise<SearchResponse<MemorySearchHit>> =>
    unwrap(window.lens.mcp.search(query, topK)),
  searchCaptures: (query: string, limit?: number): Promise<SearchResponse<CaptureSearchHit>> =>
    unwrap(window.lens.mcp.searchCaptures(query, limit)),
  recent: (limit?: number): Promise<RecentActivityResponse> => unwrap(window.lens.mcp.recent(limit)),
  remember: (content: string, tags?: string): Promise<RememberResult> =>
    unwrap(window.lens.mcp.remember(content, tags)),
  correct: (correction: string): Promise<CorrectResult> => unwrap(window.lens.mcp.correct(correction)),
  patterns: (): Promise<BehaviorPatterns> => unwrap(window.lens.mcp.patterns()),
  buildStart: (): Promise<BuildState> => unwrap(window.lens.build.start()),
  buildStatus: (): Promise<BuildState> => unwrap(window.lens.build.status()),
  buildCancel: (): Promise<boolean> => unwrap(window.lens.build.cancel()),
  budget: (): Promise<BudgetInfo> => unwrap(window.lens.llm.budget()),
  info: (): Promise<AppInfo> => unwrap(window.lens.app.info()),
  open: (kind: 'root' | 'config' | 'logs' | 'viewer'): Promise<boolean> =>
    unwrap(window.lens.app.open(kind)),
  copy: (text: string): Promise<boolean> => unwrap(window.lens.app.copy(text))
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
