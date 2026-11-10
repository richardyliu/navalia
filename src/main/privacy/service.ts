import os from 'node:os'
import path from 'node:path'
import type { LensErrorCode } from '../../shared/types'
import type { AgentManager } from '../broker/agents'
import type { GrantStore } from '../identity/grants'
import { RuntimeClient } from '../runtime/client'
import type { RuntimeLocation } from '../runtime/paths'
import { startRuntime as supervisorStart } from '../runtime/supervisor'
import { runtimeMaintenanceLock, type MaintenanceLock } from '../runtime/maintenance-lock'
import { redactCliOutput, runCli, type CliOptions, type CliRun } from '../recovery/exec'
import {
  deleteAction,
  type DeleteRunResult,
  type DeleteTarget,
  type PrivacyActionId,
  type PrivacyChallenge,
  type RetentionView,
  type UpdateCheckResult,
  type WithdrawResult
} from './api'
import { createPrivacyConfirmGate, type PrivacyConfirmGate } from './confirm'
import { readRetention } from './retention'
import { checkForUpdates } from './updates'
import { tr } from '../../shared/i18n'

/**
 * OG-09 Settings / Privacy service (main only).
 *  - Retention: read-only from the Runtime config (see retention.ts).
 *  - Delete: the Runtime's own `persome clean <target> --yes` (Lens never opens index.db or
 *    deletes Runtime files itself), behind a main-issued nonce + typed phrase, with an optional
 *    backup through the existing S2-02 backup service first. The Runtime refuses to clean while
 *    its daemon runs, so a running Runtime is stopped first and restarted afterwards.
 *  - Withdraw: disconnect every agent and revoke every grant. The Access log is not touched.
 *  - Updates: BLOCKED per OG-D4, no network (updates.ts).
 */

export class PrivacyError extends Error {
  readonly code: LensErrorCode
  constructor(code: LensErrorCode, message: string) {
    super(message)
    this.name = 'PrivacyError'
    this.code = code
  }
}

/** Whitelisted argument vectors. Nothing from the renderer is ever appended. */
export const CLEAN_ARGS: Record<DeleteTarget, readonly string[]> = {
  captures: ['clean', 'captures', '--yes'],
  timeline: ['clean', 'timeline', '--yes'],
  memory: ['clean', 'memory', '--yes'],
  all: ['clean', 'all', '--yes']
}
const STOP_ARGS = ['stop'] as const

export interface BackupOutcome {
  cancelled: boolean
  /** Absolute backup directory, or null when cancelled. */
  path: string | null
  files: number
}

export interface PrivacyDeps {
  locate: () => RuntimeLocation
  grants: GrantStore
  agents: AgentManager
  appVersion: () => string | null
  /** S2-02 backup: pick a directory and export. Absent → backup-first is refused. */
  backup?: () => Promise<BackupOutcome>
  /** Secret values used only to scrub output; never returned. */
  knownSecrets?: (root: string) => string[]
  homeDir?: string
  confirm?: PrivacyConfirmGate
  /**
   * OG3: main-process native confirmation shown after the typed phrase is accepted. `sender` is
   * the invoking WebContents (opaque here; main wiring parents the dialog to its window). Absent →
   * every delete / withdraw is refused (fail closed): the renderer alone must never complete it.
   */
  confirmDialog?: (action: PrivacyActionId, sender: unknown) => Promise<boolean>
  /** OG5: shared Runtime maintenance mutex (default: the process-wide instance). */
  lock?: MaintenanceLock
  /** Test seams. */
  exec?: (bin: string, args: readonly string[], opts: CliOptions) => Promise<CliRun>
  isUp?: (port: number) => Promise<boolean>
  startRuntime?: (location: RuntimeLocation) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  stopTimeoutMs?: number
  stopWaitMs?: number
  cleanTimeoutMs?: number
}

async function defaultIsUp(port: number): Promise<boolean> {
  try {
    await new RuntimeClient(port, '').health()
    return true
  } catch {
    return false
  }
}

export function createPrivacyService(deps: PrivacyDeps) {
  const confirm = deps.confirm ?? createPrivacyConfirmGate()
  const exec = deps.exec ?? runCli
  const isUp = deps.isUp ?? defaultIsUp
  const start = deps.startRuntime ?? supervisorStart
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const home = deps.homeDir ?? os.homedir()
  const stopTimeoutMs = deps.stopTimeoutMs ?? 30_000
  const stopWaitMs = deps.stopWaitMs ?? 15_000
  // OG4: output volume never kills the clean (runCli keeps draining). The timeout is generous and
  // only exists so a hung CLI cannot hold the shared lock and keep the Runtime stopped forever;
  // runCli sends SIGTERM first so the CLI can exit cleanly.
  const cleanTimeoutMs = deps.cleanTimeoutMs ?? 60 * 60_000
  const lock = deps.lock ?? runtimeMaintenanceLock

  const secrets = (root: string): string[] => {
    try {
      return deps.knownSecrets?.(root) ?? []
    } catch {
      return []
    }
  }
  const scrub = (text: string, root: string): string => redactCliOutput(text, secrets(root), home)

  function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return lock.run(name, fn, (holder) => new PrivacyError('unknown', tr(`"${holder}" is in progress. Try again later.`, `正在执行「${holder}」，请稍后再试`)))
  }

  /** OG3: the typed phrase alone is renderer-completable; a main-owned dialog must also say yes. */
  async function nativeConfirmed(action: PrivacyActionId, sender: unknown, refusal: { en: string; zh: string }): Promise<void> {
    if (!deps.confirmDialog) throw new PrivacyError('unknown', tr(`Cannot show the confirmation dialog. ${refusal.en}`, `无法显示确认对话框，${refusal.zh}`))
    let yes = false
    try {
      yes = await deps.confirmDialog(action, sender)
    } catch {
      yes = false
    }
    if (!yes) throw new PrivacyError('unknown', tr(`Cancelled in the confirmation dialog. ${refusal.en}`, `已在确认对话框中取消，${refusal.zh}`))
  }

  function requireBin(): RuntimeLocation & { bin: string } {
    const loc = deps.locate()
    if (!loc.bin) throw new PrivacyError('runtime_missing', tr('The persome command was not found. Install the open-source Runtime first.', '没有找到 persome 命令，请先安装开源 Runtime'))
    return loc as RuntimeLocation & { bin: string }
  }

  function cliOpts(root: string, timeoutMs: number): CliOptions {
    return { root, timeoutMs, maxBytes: 256 * 1024, knownSecrets: secrets(root), homeDir: home }
  }

  async function stopRuntime(loc: RuntimeLocation & { bin: string }): Promise<void> {
    const run = await exec(loc.bin, STOP_ARGS, cliOpts(loc.root, stopTimeoutMs))
    if (run.spawnFailed) throw new PrivacyError('runtime_missing', run.output)
    const deadline = now() + stopWaitMs
    while (await isUp(loc.port)) {
      if (now() >= deadline) throw new PrivacyError('timeout', tr(`Runtime is still running after persome stop (127.0.0.1:${loc.port}). No data was deleted.`, `persome stop 之后 Runtime 仍在运行（127.0.0.1:${loc.port}），未删除任何数据`))
      await sleep(250)
    }
  }

  return {
    retention(): RetentionView {
      return readRetention(deps.locate().root, home)
    },

    updateCheck(): UpdateCheckResult {
      return checkForUpdates(deps.appVersion)
    },

    confirmIssue(action: PrivacyActionId): PrivacyChallenge {
      return confirm.issue(action)
    },

    async deleteRun(target: DeleteTarget, nonce: string, phrase: string, backupFirst: boolean, sender?: unknown): Promise<DeleteRunResult> {
      // Consume first (burns the nonce) so a busy / missing-bin failure cannot be retried with it.
      confirm.consume(deleteAction(target), nonce, phrase)
      await nativeConfirmed(deleteAction(target), sender, { en: 'No data was deleted.', zh: '未删除任何数据' })
      return exclusive(tr('Delete data', '删除数据'), async () => {
        const loc = requireBin()
        let backup: DeleteRunResult['backup'] = null
        if (backupFirst) {
          if (!deps.backup) throw new PrivacyError('unknown', tr('Backing up first is not supported in this environment. No data was deleted.', '当前环境不支持先备份，未删除任何数据'))
          const r = await deps.backup()
          if (r.cancelled || !r.path) throw new PrivacyError('unknown', tr('Backup was cancelled. No data was deleted.', '备份已取消，未删除任何数据'))
          backup = { name: path.basename(r.path), files: r.files }
        }
        const wasRunning = await isUp(loc.port)
        if (wasRunning) await stopRuntime(loc)
        const run = await exec(loc.bin, CLEAN_ARGS[target], cliOpts(loc.root, cleanTimeoutMs))
        if (run.spawnFailed) throw new PrivacyError('runtime_missing', run.output)
        let runtimeRestarted = false
        let note = ''
        if (wasRunning) {
          try {
            await start(loc)
            runtimeRestarted = true
          } catch (error) {
            note = tr(
              `\n[Restarting Runtime after deletion failed: ${scrub(error instanceof Error ? error.message : String(error), loc.root)}]`,
              `\n[删除后重新启动 Runtime 失败：${scrub(error instanceof Error ? error.message : String(error), loc.root)}]`
            )
          }
        }
        return {
          target,
          ok: run.exitCode === 0 && !run.timedOut,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          truncated: run.truncated,
          output: `${run.output}${run.timedOut ? tr('\n[Deletion timed out and was stopped]', '\n[删除超时，已终止]') : ''}${note}`,
          backup,
          runtimeRestarted
        }
      })
    },

    async withdrawRun(nonce: string, phrase: string, sender?: unknown): Promise<WithdrawResult> {
      confirm.consume('withdraw-all', nonce, phrase)
      await nativeConfirmed('withdraw-all', sender, { en: 'No connection was withdrawn.', zh: '未撤回任何连接' })
      return exclusive(tr('Withdraw connections', '撤回连接'), async () => {
        const before = deps.grants.list().filter((g) => !g.revokedAt).length
        const agentsDisconnected: string[] = []
        const warnings: string[] = []
        for (const agent of deps.agents.list()) {
          if (agent.state === 'not_installed' && !agent.grant) continue
          const hadEntry = agent.state === 'connected' || agent.state === 'partial' || agent.state === 'mismatch'
          try {
            deps.agents.disconnect(agent.id)
            if (hadEntry) agentsDisconnected.push(agent.name)
          } catch (error) {
            warnings.push(`${agent.name}：${error instanceof Error ? error.message : String(error)}`)
            deps.grants.revokeClient(agent.id)
          }
        }
        // Manual configs and any other client: revoke every grant not yet revoked.
        for (const g of deps.grants.list()) if (!g.revokedAt) deps.grants.revoke(g.id)
        const after = deps.grants.list()
        return {
          agentsDisconnected,
          grantsRevoked: before - after.filter((g) => !g.revokedAt).length,
          activeAfter: after.filter((g) => g.state === 'active').length,
          accessLogTouched: false,
          warnings: warnings.map((w) => redactCliOutput(w, [], home))
        }
      })
    }
  }
}

export type PrivacyService = ReturnType<typeof createPrivacyService>
