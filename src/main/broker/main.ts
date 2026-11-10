import type { IpcMain } from 'electron'
import type { SignedCard } from '../identity/card-schema'
import { createGrantStore } from '../identity/grants'
import type { StorePaths } from '../store/paths'
import { createAgentManager, defaultAgentEnv, type AgentEnv } from './agents'
import type { BrokerStatus } from './api'
import { openAuditLog } from './audit'
import { OSS_TOOL_NAMES } from './catalog'
import { createRewindReader } from './rewind'
import { registerConnectionsIpc } from './ipc'
import { BROKER_HOST, BROKER_PATH, BROKER_PORT, createBroker, type BrokerRestRouter } from './server'
import { createWorkflowService } from '../workflows/service'

export interface BrokerPlaneDeps {
  paths: StorePaths
  /** Latest signed card (identity service `latest()`). */
  latestCard: () => SignedCard | null
  /** One OSS runtime MCP tool call through main's PersomeMcp (stdio). No retries. */
  ossTool: (name: string, args: Record<string, unknown>) => Promise<string>
  /** Runtime root (capture-buffer lives here) — `locate().root`. */
  runtimeRoot: () => string
  /** Runtime PERSOME_SCREENSHOT_KEY (32 bytes) or null. Main only; never logged or sent over IPC. */
  screenshotKey: () => Buffer | null
  /** Agent-funding budget (ipc.ts readBudget). */
  budget: () => { enabled: boolean; exhausted: boolean }
  copyToClipboard: (text: string) => void
  agentEnv?: AgentEnv
  port?: number
  /** OG-08: REST routes mounted on the Broker (e.g. HET `/het/*`), same auth + Access log. */
  rest?: BrokerRestRouter[]
}

/** Wire grants + audit + Broker + Connections IPC. Broker start failures are reported, not thrown. */
export function setupBrokerPlane(ipcMain: Pick<IpcMain, 'handle'>, deps: BrokerPlaneDeps) {
  const grants = createGrantStore(deps.paths)
  const rewind = createRewindReader({ root: deps.runtimeRoot, screenshotKey: deps.screenshotKey })
  const audit = openAuditLog(deps.paths.auditDb)
  // S1-06: read-only Workflow reader (Lens Store + Runtime skill files; never calls MCP).
  const workflows = createWorkflowService({ storeRoot: deps.paths.root, runtimeRoot: deps.runtimeRoot })
  const port = deps.port ?? BROKER_PORT
  const status: BrokerStatus = { url: `http://${BROKER_HOST}:${port}${BROKER_PATH}`, running: false, error: null }
  const broker = createBroker({
    grants,
    audit,
    port,
    rest: deps.rest,
    backend: {
      card: deps.latestCard,
      ossTool: (name, args) => {
        if (!OSS_TOOL_NAMES.includes(name)) return Promise.reject(new Error(`not an OSS tool: ${name}`))
        return deps.ossTool(name, args)
      },
      rewindFrames: (q) => rewind.frames(q),
      rewindScreenshot: (stem) => rewind.screenshot(stem),
      budget: deps.budget,
      workflows: { list: () => workflows.catalogSync(), get: (id) => workflows.getSync(id) }
    }
  })
  const agents = createAgentManager({ env: deps.agentEnv ?? defaultAgentEnv(), grants, brokerUrl: () => status.url })
  registerConnectionsIpc(ipcMain, { agents, grants, audit, brokerStatus: () => ({ ...status }), copyToClipboard: deps.copyToClipboard })

  const started = broker
    .start()
    .then((info) => {
      status.url = info.url
      status.running = true
    })
    .catch((error: unknown) => {
      status.error = error instanceof Error ? error.message : String(error)
    })

  return {
    started,
    status: () => ({ ...status }),
    async stop() {
      await broker.stop()
      audit.close()
    }
  }
}
