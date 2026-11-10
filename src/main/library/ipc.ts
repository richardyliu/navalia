import { tr } from '../../shared/i18n'
import fs from 'node:fs/promises'
import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { BehaviorPatterns, LensError } from '../../shared/types'
import type { WorkflowCatalog } from '../workflows/api'
import { createWorkflowService } from '../workflows/service'
import { RuntimeError } from '../runtime/client'
import { TokenError } from '../runtime/token'
import type { S1Deps } from '../s1/deps'
import { redactForDisplay } from '../import/redact'
import { aggregateLibrary, parseEntityGraph } from './aggregate'
import {
  LIBRARY_CHANNELS,
  type ExportBriefResult,
  type LibraryEntityGraph,
  type LibraryOverview,
  type LibrarySectionError
} from './api'
import { ipcRunner } from '../ipc-result'

const NoArgs = z.undefined()
const EntityArgs = z.strictObject({ name: z.string().trim().min(1).max(512) })
const ExportArgs = z.strictObject({
  markdown: z.string().min(1).max(200_000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
})

/** Messages go to the renderer: home-dir paths (`/Users/<name>`) and secrets are redacted (S2-SEC L4). */
export function toLensError(error: unknown): LensError {
  const e = rawLensError(error)
  return { ...e, message: redactForDisplay(e.message) }
}

function rawLensError(error: unknown): LensError {
  if (error instanceof RuntimeError) return { code: error.code, message: error.message }
  if (error instanceof TokenError) return { code: 'token_unavailable', message: error.message }
  if (error instanceof z.ZodError) {
    return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  }
  if (error instanceof Error) return { code: 'unknown', message: error.message }
  return { code: 'unknown', message: String(error) }
}

const run = ipcRunner(toLensError)

/**
 * Overview = three independent sections, each failing on its own (S2-04):
 * - Runtime `/model/graph` → 人 / 项目 / 画像 (graphError);
 * - Lens Workflow catalog (`createWorkflowService(...).catalog()`: Runtime skill files + Lens Store
 *   + behavior_patterns) → 技能 (workflowError);
 * - behavior_patterns → also used to add skills the catalog lacks (skillsError).
 * behavior_patterns is called once and shared with the catalog.
 */
export async function libraryOverview(deps: Pick<S1Deps, 'runtime' | 'ossTool' | 'storeRoot' | 'runtimeRoot'>): Promise<LibraryOverview> {
  let patternsCall: Promise<string> | null = null
  const ossTool = (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name !== 'behavior_patterns') return deps.ossTool(name, args)
    patternsCall ??= deps.ossTool('behavior_patterns', {})
    return patternsCall
  }

  async function section<T>(fn: () => T | Promise<T>): Promise<{ value: T | null; error: LibrarySectionError | null }> {
    try {
      return { value: await fn(), error: null }
    } catch (error) {
      return { value: null, error: toLensError(error) }
    }
  }
  const [g, p, c] = await Promise.all([
    section(() => deps.runtime().modelGraph()),
    section(async () => JSON.parse(await ossTool('behavior_patterns', {})) as BehaviorPatterns),
    section<WorkflowCatalog>(() => createWorkflowService({ storeRoot: deps.storeRoot, runtimeRoot: deps.runtimeRoot, ossTool }).catalog())
  ])
  return aggregateLibrary({
    graph: g.value,
    graphError: g.error,
    catalog: c.value,
    workflowError: c.error,
    patterns: p.value,
    skillsError: p.error
  })
}

export async function libraryEntity(deps: Pick<S1Deps, 'ossTool'>, raw: unknown): Promise<LibraryEntityGraph> {
  const args = EntityArgs.parse(raw)
  // Read-only MCP tool; depth 1, no shadow (unproven) edges.
  return parseEntityGraph(await deps.ossTool('entity_graph', { name: args.name, depth: 1 }))
}

export async function exportBrief(deps: Pick<S1Deps, 'saveDialog'>, raw: unknown): Promise<ExportBriefResult> {
  const args = ExportArgs.parse(raw)
  const target = await deps.saveDialog({
    title: tr("Export today's brief", '导出今日 brief'),
    defaultPath: `persome-brief-${args.date}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (!target) return { path: null, bytes: 0 }
  const body = args.markdown.endsWith('\n') ? args.markdown : `${args.markdown}\n`
  await fs.writeFile(target, body, { encoding: 'utf8', mode: 0o600 })
  return { path: target, bytes: Buffer.byteLength(body, 'utf8') }
}

/** Register the S1 library IPC channels (`lens:library:*`). Every payload is zod-validated. */
export function registerLibraryIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: S1Deps): void {
  ipcMain.handle(LIBRARY_CHANNELS.overview, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return libraryOverview(deps)
    })
  )
  ipcMain.handle(LIBRARY_CHANNELS.entity, (_e, raw: unknown) => run(() => libraryEntity(deps, raw)))
  ipcMain.handle(LIBRARY_CHANNELS.exportBrief, (_e, raw: unknown) => run(() => exportBrief(deps, raw)))
}
