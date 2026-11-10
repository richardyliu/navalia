import type {
  AppInfo,
  BehaviorPatterns,
  BudgetInfo,
  BuildState,
  CorrectResult,
  CaptureSearchHit,
  EvidenceResponse,
  LensResult,
  MemorySearchHit,
  ModelGraphResponse,
  NodeResponse,
  PermissionsData,
  RecentActivityResponse,
  RememberResult,
  RuntimeLocationInfo,
  SearchResponse,
  StatusData
} from './types'
import type { ConnectionsApi } from '../main/broker/api'
import type { IdentityApi, SwipeApi } from '../main/identity/api'
import type { HetApi } from '../main/het/api'
import type { CaptureApi } from '../main/capture/api'
import type { DeltaReportCounts } from '../main/runtime/deltaReport'
import type { WorkflowsApi } from '../main/workflows/api'
import type { ImportApi } from '../main/import/api'
import type { LibraryApi } from '../main/library/api'
import type { PeersApi } from '../main/peers/api'
import type { OnboardingApi } from '../main/onboarding/api'
import type { BackupApi } from '../main/backup/api'
import type { RewindApi } from '../main/rewind/api'
import type { ShellApi } from '../main/shell/api'
import type { RecoveryApi } from '../main/recovery/api'
import type { PrivacyApi } from '../main/privacy/api'
import type { AskSaveApi } from '../main/mcp/save-answer-api'
import type { ConnectorsApi } from '../main/connectors/api'
import type { ProactiveApi } from '../main/proactive/api'
import type { CloudApi } from '../main/cloud/api'
import type { PerformanceApi } from '../main/performance/api'
import type { I18nApi } from './i18n'

export interface LensApi extends IdentityApi,
    SwipeApi,
    ConnectionsApi,
    HetApi,
    CaptureApi,
    WorkflowsApi,
    ImportApi,
    LibraryApi,
    PeersApi,
    OnboardingApi,
    BackupApi,
    RewindApi,
    ShellApi,
    RecoveryApi,
    PrivacyApi,
    AskSaveApi,
    ConnectorsApi,
    ProactiveApi,
    PerformanceApi,
    I18nApi,
    CloudApi {
  runtime: {
    discover(): Promise<LensResult<RuntimeLocationInfo>>
    start(): Promise<LensResult<RuntimeLocationInfo>>
    status(): Promise<LensResult<StatusData>>
    permissions(): Promise<LensResult<PermissionsData>>
  }
  model: {
    graph(): Promise<LensResult<ModelGraphResponse>>
    evidence(ref: string, asOf?: string): Promise<LensResult<EvidenceResponse>>
    deltaReport(limit?: number): Promise<LensResult<DeltaReportCounts>>
    node(id: string): Promise<LensResult<NodeResponse>>
  }
  mcp: {
    search(query: string, topK?: number): Promise<LensResult<SearchResponse<MemorySearchHit>>>
    searchCaptures(query: string, limit?: number): Promise<LensResult<SearchResponse<CaptureSearchHit>>>
    recent(limit?: number): Promise<LensResult<RecentActivityResponse>>
    remember(content: string, tags?: string): Promise<LensResult<RememberResult>>
    correct(correction: string): Promise<LensResult<CorrectResult>>
    patterns(): Promise<LensResult<BehaviorPatterns>>
  }
  llm: {
    budget(): Promise<LensResult<BudgetInfo>>
  }
  build: {
    start(): Promise<LensResult<BuildState>>
    status(): Promise<LensResult<BuildState>>
    cancel(): Promise<LensResult<boolean>>
  }
  app: {
    info(): Promise<LensResult<AppInfo>>
    open(kind: 'root' | 'config' | 'logs' | 'viewer'): Promise<LensResult<boolean>>
    copy(text: string): Promise<LensResult<boolean>>
  }
}
