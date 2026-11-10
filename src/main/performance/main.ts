// S1-FULL C16 production wiring for 「表现」: real git runner, het.db path, home dir, Runtime MCP
// search and the native folder picker → service + IPC. Thin on purpose (logic in service.ts).
import type { IpcMain } from 'electron'
import { tr } from '../../shared/i18n'
import { hetRootsFromEnv } from '../het/sources'
import { systemTimeZone } from '../het/tz'
import { createGitRunner } from './git'
import { registerPerformanceIpc } from './ipc'
import { createPerformanceService, type PerformanceService } from './service'

export interface SetupPerformanceDeps {
  storeRoot: string
  hetDbFile: string
  homeDir(): string
  ossTool?(name: string, args: Record<string, unknown>): Promise<string>
  openDirectoryDialog?(opts: { title: string; createDirectory?: boolean }): Promise<string | null>
}

export function setupPerformance(ipcMain: IpcMain, deps: SetupPerformanceDeps): PerformanceService {
  const service = createPerformanceService({
    storeRoot: deps.storeRoot,
    hetDbFile: deps.hetDbFile,
    now: Date.now,
    timezone: systemTimeZone,
    homeDir: deps.homeDir,
    // Same roots the HET adapters read (src/main/het/sources.ts): Claude Code and Codex transcripts.
    transcriptRoots: () => {
      const r = hetRootsFromEnv()
      return [r.claudeRoot, r.codexRoot].filter((x): x is string => typeof x === 'string' && x.length > 0)
    },
    git: createGitRunner(),
    ossTool: deps.ossTool,
    pickDirectory: deps.openDirectoryDialog ? () => deps.openDirectoryDialog!({ title: tr('Choose a local git repo (read-only)', '选择一个本地 git 仓库（只读）') }) : undefined
  })
  registerPerformanceIpc(ipcMain, service)
  return service
}
