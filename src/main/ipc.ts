import fs from 'node:fs'
import path from 'node:path'
import { app, clipboard, ipcMain, shell } from 'electron'
import { z } from 'zod'
import type {
  AppInfo,
  BehaviorPatterns,
  BudgetInfo,
  BuildState,
  CaptureSearchHit,
  CorrectResult,
  MemorySearchHit,
  RecentActivityResponse,
  LensError,
  RuntimeLocationInfo
} from '../shared/types'
import { locate } from './runtime/paths'
import { TokenError, readLocalToken } from './runtime/token'
import { evidenceAsOfError, RuntimeClient, RuntimeError, isValidEvidenceAsOf } from './runtime/client'
import { openOfficialViewer, startRuntime } from './runtime/supervisor'
import { runtimeMaintenanceLock } from './runtime/maintenance-lock'
import { PersomeMcp } from './mcp/client'
import { buildStatus, cancelBuild, startBuild } from './build'
import { readDeltaReport } from './runtime/deltaReport'
import { createRememberHandler, refuseRemember, registerRememberIpc, type RememberDeps } from './mcp/remember'
import { tr } from '../shared/i18n'
import { ipcRunner } from './ipc-result'

const EvidenceArgs = z.object({
  ref: z.string().min(1).max(1024),
  // S1-03: ISO date or ISO datetime only; '' means "now" (unchanged behaviour).
  asOf: z
    .string()
    .max(64)
    .refine((value) => value === '' || isValidEvidenceAsOf(value), { error: () => evidenceAsOfError() })
    .optional()
})

const DeltaReportArgs = z
  .object({ limit: z.number().int().min(1).max(100).optional() })
  .strict()
  .optional()

const NodeArgs = z.object({
  id: z.string().min(1).max(512)
})

const OpenArgs = z.enum(['root', 'config', 'logs', 'viewer'])

const CopyArgs = z.object({
  text: z.string().max(20_000)
})

const SearchArgs = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(50).optional()
})

const CaptureSearchArgs = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional()
})

const RecentArgs = z.object({
  limit: z.number().int().min(1).max(100).optional()
})

const CorrectArgs = z.object({
  correction: z.string().min(1).max(20_000)
})

function toLensError(error: unknown): LensError {
  if (error instanceof RuntimeError) return { code: error.code, message: error.message }
  if (error instanceof TokenError) return { code: 'token_unavailable', message: error.message }
  if (error instanceof z.ZodError) {
    return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((issue) => issue.message).join('; ')}`, `参数不合法：${error.issues.map((issue) => issue.message).join('; ')}`) }
  }
  if (error instanceof Error) return { code: 'unknown', message: error.message }
  return { code: 'unknown', message: String(error) }
}

const run = ipcRunner(toLensError)

async function withClient<T>(fn: (client: RuntimeClient) => Promise<T>): Promise<T> {
  const location = locate()
  const token = readLocalToken(location.root)
  return fn(new RuntimeClient(location.port, token))
}

let mcp: PersomeMcp | null = null

function getMcp(): PersomeMcp {
  const location = locate()
  if (!location.bin) throw new Error(tr('persome command not found; cannot start MCP', '没有找到 persome 命令，无法启动 MCP'))
  if (!mcp || mcp.key !== `${location.bin}|${location.root}`) {
    mcp?.close()
    mcp = new PersomeMcp(location.bin, location.root)
  }
  return mcp
}

export function closeMcp(): void {
  mcp?.close()
  mcp = null
}

/** S1-R3-09: Runtime MCP tool call for main-side services (ask save-answer). Same client as lens:mcp:*. */
export function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  return getMcp().callTool(name, args)
}

function parseAgentConfig(configPath: string): { enabled: boolean; client: string; limit: number } {
  try {
    const text = fs.readFileSync(configPath, 'utf8')
    let inSection = false
    const result = { enabled: false, client: '', limit: 0 }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('[')) {
        inSection = trimmed === '[agent_funding]'
        continue
      }
      if (!inSection || !trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/)
      if (!match) continue
      const key = match[1]
      const raw = match[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
      if (key === 'enabled') result.enabled = raw === 'true'
      if (key === 'client') result.client = raw
      if (key === 'daily_call_limit') result.limit = Number(raw) || 0
    }
    return result
  } catch {
    return { enabled: false, client: '', limit: 0 }
  }
}

function localDate(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function readBudget(): BudgetInfo {
  const location = locate()
  const config = parseAgentConfig(location.configPath)
  const date = localDate()
  let used = 0
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(location.root, '.agent-funding-usage.json'), 'utf8')) as {
      date?: string
      used?: number
    }
    if (raw.date === date && typeof raw.used === 'number') used = Math.max(0, raw.used)
  } catch {
    used = 0
  }
  const reset = new Date()
  reset.setHours(24, 0, 0, 0)
  const limit = config.limit
  return {
    enabled: config.enabled,
    client: config.client,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exhausted: config.enabled && limit > 0 && used >= limit,
    date,
    resetAt: reset.toISOString()
  }
}

function locationInfo(): RuntimeLocationInfo {
  const location = locate()
  let tokenPresent = false
  try {
    readLocalToken(location.root)
    tokenPresent = true
  } catch {
    tokenPresent = false
  }
  return { ...location, tokenPresent }
}

export interface RegisterIpcOptions {
  /** S1-R3-SEC M2: main-owned native confirm for lens:mcp:remember. Absent ⇒ remember always refuses. */
  confirmRemember?: RememberDeps['confirm']
  /** Secret values scrubbed verbatim before stripSecrets (Runtime token + env secrets). */
  knownSecrets?: () => string[]
}

export function registerIpc(opts: RegisterIpcOptions = {}): void {
  ipcMain.handle('lens:runtime:discover', () => run(() => locationInfo()))

  ipcMain.handle('lens:runtime:start', () =>
    run(async () => {
      const location = locate()
      // OG5: never start the Runtime while a delete / rebuild / restart holds the shared lock.
      await runtimeMaintenanceLock.run(tr('Start Runtime', '启动 Runtime'), () => startRuntime(location))
      return locationInfo()
    })
  )

  ipcMain.handle('lens:status', () => run(() => withClient((client) => client.status())))

  ipcMain.handle('lens:permissions', () => run(() => withClient((client) => client.permissions())))

  ipcMain.handle('lens:model:graph', () => run(() => withClient((client) => client.modelGraph())))

  ipcMain.handle('lens:model:evidence', (_event, raw: unknown) =>
    run(async () => {
      const args = EvidenceArgs.parse(raw)
      return withClient((client) => client.evidence(args.ref, args.asOf))
    })
  )

  // S1-01: Runtime gate-drop counters (global, not per evidence item). Read-only CLI, counts only.
  ipcMain.handle('lens:model:delta-report', (_event, raw: unknown) =>
    run(async () => {
      const args = DeltaReportArgs.parse(raw)
      const location = locate()
      return readDeltaReport(location.bin ?? null, location.root, args?.limit ?? 20)
    })
  )

  ipcMain.handle('lens:model:node', (_event, raw: unknown) =>
    run(async () => {
      const args = NodeArgs.parse(raw)
      return withClient((client) => client.node(args.id))
    })
  )

  ipcMain.handle('lens:app:info', () =>
    run<AppInfo>(() => ({
      ...locationInfo(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      chromeVersion: process.versions.chrome ?? '',
      nodeVersion: process.versions.node,
      platform: `${process.platform} ${process.arch}`
    }))
  )

  ipcMain.handle('lens:app:open', (_event, raw: unknown) =>
    run(async () => {
      const kind = OpenArgs.parse(raw)
      const location = locate()
      if (kind === 'viewer') {
        openOfficialViewer(location)
        return true
      }
      if (kind === 'config') {
        shell.showItemInFolder(location.configPath)
        return true
      }
      const target = kind === 'logs' ? `${location.root}/logs` : location.root
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
      return true
    })
  )

  ipcMain.handle('lens:llm:budget', () => run(() => readBudget()))

  ipcMain.handle('lens:model:build-start', () =>
    run<BuildState>(() => {
      const location = locate()
      if (!location.bin) throw new Error(tr('persome command not found', '没有找到 persome 命令'))
      return startBuild(location.bin, location.root)
    })
  )

  ipcMain.handle('lens:model:build-status', () => run<BuildState>(() => buildStatus()))

  ipcMain.handle('lens:model:build-cancel', () => run(() => cancelBuild()))

  ipcMain.handle('lens:mcp:search', (_event, raw: unknown) =>
    run(async () => {
      const args = SearchArgs.parse(raw)
      const text = await getMcp().callTool('search', { query: args.query, top_k: args.topK ?? 8 })
      const payload = JSON.parse(text) as { query?: string; results?: MemorySearchHit[] }
      return { query: payload.query ?? args.query, results: payload.results ?? [] }
    })
  )

  ipcMain.handle('lens:mcp:captures', (_event, raw: unknown) =>
    run(async () => {
      const args = CaptureSearchArgs.parse(raw)
      const text = await getMcp().callTool('search_captures', { query: args.query, limit: args.limit ?? 10 })
      const payload = JSON.parse(text) as { query?: string; results?: CaptureSearchHit[] }
      return { query: payload.query ?? args.query, results: payload.results ?? [] }
    })
  )

  ipcMain.handle('lens:mcp:recent', (_event, raw: unknown) =>
    run(async () => {
      const args = RecentArgs.parse(raw)
      const text = await getMcp().callTool('recent_activity', { limit: args.limit ?? 20 })
      return JSON.parse(text) as RecentActivityResponse
    })
  )

  // S1-R3-SEC M2: redacted in main + main-owned native confirm (main window and Quick Box).
  registerRememberIpc(
    ipcMain,
    opts.confirmRemember
      ? createRememberHandler({ callTool: callMcpTool, confirm: opts.confirmRemember, knownSecrets: opts.knownSecrets })
      : refuseRemember
  )

  ipcMain.handle('lens:mcp:correct', (_event, raw: unknown) =>
    run(async () => {
      const args = CorrectArgs.parse(raw)
      const text = await getMcp().callTool('correct_memory', { correction: args.correction })
      return JSON.parse(text) as CorrectResult
    })
  )

  ipcMain.handle('lens:mcp:patterns', () =>
    run<BehaviorPatterns>(async () => {
      const text = await getMcp().callTool('behavior_patterns', {})
      return JSON.parse(text) as BehaviorPatterns
    })
  )

  ipcMain.handle('lens:app:copy', (_event, raw: unknown) =>
    run(() => {
      const args = CopyArgs.parse(raw)
      clipboard.writeText(args.text)
      return true
    })
  )
}
