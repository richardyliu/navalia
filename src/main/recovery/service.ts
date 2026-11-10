import os from 'node:os'
import path from 'node:path'
import type { BrokerStatus } from '../broker/api'
import type { CaptureStatusView } from '../capture/api'
import { runtimeSecretValues } from '../backup/service'
import type { LensErrorCode, StatusData } from '../../shared/types'
import { RuntimeClient, RuntimeError } from '../runtime/client'
import type { RuntimeLocation } from '../runtime/paths'
import { startRuntime as supervisorStart } from '../runtime/supervisor'
import { readLocalToken } from '../runtime/token'
import { runtimeMaintenanceLock, type MaintenanceLock } from '../runtime/maintenance-lock'
import type {
  CheckStatus,
  ConfirmChallenge,
  DestructiveActionId,
  DestructiveRunResult,
  DiagnosticsResult,
  DoctorResult,
  ManualProcedure,
  NextStep,
  RecoveryCheck,
  RecoveryReport
} from './api'
import { createConfirmGate, type ConfirmGate } from './confirm'
import { CLI_ARGS, parseDoctorLines, redactCliOutput, runCli } from './exec'
import { checkLensStore, diskFree, type DiskInfo } from './store-check'
import { tr } from '../../shared/i18n'

/**
 * OG-06 Recovery service (main only). Aggregates health from existing sources — Runtime REST on
 * 127.0.0.1 (`/health` unauthenticated, `/status` with the bearer token), the `persome doctor`
 * CLI, the in-process capture service and Broker — plus a read-only Lens Store check and disk
 * space. Lens never opens or modifies the Runtime's index.db; the only index operation is the
 * Runtime's own `rebuild-captures-index --merge`, behind a typed-phrase + nonce confirmation.
 */

export class RecoveryError extends Error {
  readonly code: LensErrorCode
  constructor(code: LensErrorCode, message: string) {
    super(message)
    this.name = 'RecoveryError'
    this.code = code
  }
}

export interface RecoveryDeps {
  locate: () => RuntimeLocation
  storeRoot: string
  captureStatus?: () => CaptureStatusView | null
  brokerStatus?: () => BrokerStatus | null
  copyToClipboard?: (text: string) => void
  appVersion?: () => string | null
  /** Defaults to the real supervisor (`persome start`, then poll /health). */
  startRuntime?: (location: RuntimeLocation) => Promise<void>
  readToken?: (root: string) => string
  /** Secret values used only to scrub output; never returned. */
  knownSecrets?: (root: string) => string[]
  statfs?: Parameters<typeof diskFree>[1]
  homeDir?: string
  now?: () => number
  confirm?: ConfirmGate
  doctorTimeoutMs?: number
  doctorMaxBytes?: number
  stopTimeoutMs?: number
  stopWaitMs?: number
  rebuildTimeoutMs?: number
  rebuildMaxBytes?: number
  /** OG5: shared Runtime maintenance mutex (default: the process-wide instance). */
  lock?: MaintenanceLock
}

export const DISK_FAIL_BYTES = 1024 ** 3
export const DISK_WARN_BYTES = 5 * 1024 ** 3

const GiB = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail'
  if (statuses.includes('warn')) return 'warn'
  if (statuses.includes('ok')) return 'ok'
  return 'unknown'
}

function healthState(v: unknown): CheckStatus {
  if (v === 'ok') return 'ok'
  if (v === 'degraded') return 'warn'
  return 'unknown'
}

const A = {
  start: {
    kind: 'action',
    action: 'start-runtime',
    get label() {
      return tr('Start Runtime', '启动 Runtime')
    }
  } as NextStep,
  restart: {
    kind: 'action',
    action: 'restart-runtime',
    get label() {
      return tr('Restart Runtime', '重启 Runtime')
    }
  } as NextStep,
  doctor: {
    kind: 'action',
    action: 'run-doctor',
    get label() {
      return tr('Run doctor', '运行 doctor')
    }
  } as NextStep,
  logs: {
    kind: 'action',
    action: 'open-logs',
    get label() {
      return tr('Open logs folder', '打开日志目录')
    }
  } as NextStep,
  capture: {
    kind: 'action',
    action: 'goto-capture',
    get label() {
      return tr('Go to Capture', '前往采集页')
    }
  } as NextStep,
  connections: {
    kind: 'action',
    action: 'goto-connections',
    get label() {
      return tr('Go to Connections', '前往 Connections')
    }
  } as NextStep,
  rebuild: {
    kind: 'action',
    action: 'rebuild-captures-index',
    get label() {
      return tr('Rebuild capture index (needs a second confirmation)', '重建采集索引（需二次确认）')
    }
  } as NextStep
}

export function createRecoveryService(deps: RecoveryDeps) {
  const now = deps.now ?? Date.now
  const home = deps.homeDir ?? os.homedir()
  const readToken = deps.readToken ?? readLocalToken
  const secretsFor = deps.knownSecrets ?? runtimeSecretValues
  const start = deps.startRuntime ?? supervisorStart
  const confirm = deps.confirm ?? createConfirmGate({ now })
  const doctorTimeoutMs = deps.doctorTimeoutMs ?? 60_000
  const doctorMaxBytes = deps.doctorMaxBytes ?? 256 * 1024
  const stopTimeoutMs = deps.stopTimeoutMs ?? 30_000
  const stopWaitMs = deps.stopWaitMs ?? 15_000
  // OG4: generous on purpose. Output volume never kills the child any more (runCli keeps draining);
  // only a genuinely hung rebuild is stopped, so it cannot hold the shared lock (and keep the
  // Runtime down) forever. The Runtime rebuilds in one transaction, so a kill rolls back.
  const rebuildTimeoutMs = deps.rebuildTimeoutMs ?? 60 * 60_000
  const rebuildMaxBytes = deps.rebuildMaxBytes ?? 256 * 1024
  const lock = deps.lock ?? runtimeMaintenanceLock
  let lastDoctor: DoctorResult | null = null

  const tild = (p: string): string => (home && home !== '/' && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p)

  function secrets(root: string): string[] {
    const out = new Set<string>()
    try {
      for (const s of secretsFor(root)) out.add(s)
    } catch {
      // ignore
    }
    try {
      out.add(readToken(root))
    } catch {
      // ignore
    }
    return [...out]
  }

  function scrub(text: string, root: string): string {
    return redactCliOutput(text, secrets(root), home)
  }

  function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return lock.run(name, fn, (holder) => new RecoveryError('unknown', tr(`"${holder}" is in progress. Wait for it to finish.`, `正在执行「${holder}」，请等它完成`)))
  }

  function manualProcedures(loc: RuntimeLocation): ManualProcedure[] {
    const root = tild(loc.root)
    const store = tild(deps.storeRoot)
    return [
      {
        id: 'full-index-rebuild',
        title: tr('Full capture index rebuild (exact mode)', '完整重建采集索引（精确模式）'),
        why: tr('Navalia only offers merge mode (--merge, deletes no old rows). Exact mode deletes index rows whose JSON is no longer on disk; it is lossy, so run it by hand.', 'Navalia 只提供合并模式（--merge，不删除旧行）。精确模式会删除磁盘上已没有对应 JSON 的索引行，属于有损操作，需手动执行。'),
        steps: ['persome stop', 'persome rebuild-captures-index', 'persome start', 'persome doctor']
      },
      {
        id: 'clear-capture-buffer',
        title: tr('Clear the capture buffer (capture-buffer)', '清空采集缓冲（capture-buffer）'),
        why: tr('Runtime offers no safe interface to clear the buffer, and Navalia will not delete capture data for you.', 'Runtime 没有提供清空缓冲的安全接口，Navalia 不会替你删除采集数据。'),
        steps: [
          tr('Pause capture on the Navalia Capture page, then run in a terminal: persome stop', '在 Navalia 采集页暂停采集，然后在终端执行：persome stop'),
          tr(`Back up first: cp -R "${root}/capture-buffer" "${root}/capture-buffer.bak"`, `先备份：cp -R "${root}/capture-buffer" "${root}/capture-buffer.bak"`),
          tr(`Move to Trash (recoverable): mv "${root}/capture-buffer" ~/.Trash/capture-buffer-$(date +%Y%m%d%H%M%S)`, `移到废纸篓（可恢复）：mv "${root}/capture-buffer" ~/.Trash/capture-buffer-$(date +%Y%m%d%H%M%S)`),
          tr('persome rebuild-captures-index   # exact mode, drops index rows with no JSON left', 'persome rebuild-captures-index   # 精确模式，清掉已无 JSON 的索引行'),
          'persome start',
          'persome doctor'
        ]
      },
      {
        id: 'reset-lens-store',
        title: tr('Reset the Navalia Store', '重置 Navalia Store'),
        why: tr('Navalia has no "reset the whole Navalia Store" interface; doing so loses the identity key, cards, connection grants, Access log and HET ledger.', 'Navalia 没有“重置整个 Navalia Store”的接口；这会丢失身份密钥、卡片、连接授权、Access log 与 HET 账本。'),
        steps: [
          tr('First export a full backup in Settings → Backup', '先在「设置 → 备份」导出一次完整备份'),
          tr('Quit Navalia (menu bar → Quit)', '退出 Navalia（菜单栏 → 退出）'),
          tr(`Move to Trash (recoverable): mv "${store}" ~/.Trash/navalia-store-$(date +%Y%m%d%H%M%S)`, `移到废纸篓（可恢复）：mv "${store}" ~/.Trash/navalia-store-$(date +%Y%m%d%H%M%S)`),
          tr('Reopen Navalia (it creates a new empty Navalia Store and a new identity)', '重新打开 Navalia（会创建新的空 Navalia Store 与新身份）'),
          tr('To restore data: Settings → Backup → Restore; then reconnect Agents in Connections', '如需恢复数据：设置 → 备份 → 恢复；并在 Connections 重新连接 Agent')
        ]
      }
    ]
  }

  async function health(): Promise<RecoveryReport> {
    const loc = deps.locate()
    const checks: RecoveryCheck[] = []
    const push = (c: RecoveryCheck): void => {
      checks.push(c)
    }
    const startOrManual: NextStep[] = loc.bin
      ? [A.start]
      : [{ kind: 'manual', title: tr('Install the persome command first', '先安装 persome 命令'), steps: [tr('Install the open-source Runtime (personal-model)', '安装开源 Runtime（personal-model）'), tr('Or set the PERSOME_BIN environment variable to the persome executable, then reopen Navalia', '或设置环境变量 PERSOME_BIN 指向 persome 可执行文件后重开 Navalia')] }]

    push(
      loc.bin
        ? { id: 'runtime_bin', label: tr('persome command', 'persome 命令'), status: 'ok', detail: tild(loc.bin), next: [] }
        : {
            id: 'runtime_bin',
            label: tr('persome command', 'persome 命令'),
            status: 'fail',
            detail: tr('persome was not found in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin', '没有在 ~/.local/bin、/opt/homebrew/bin、/usr/local/bin 找到 persome'),
            next: startOrManual
          }
    )
    push(
      loc.rootExists
        ? { id: 'runtime_root', label: tr('Runtime data root', 'Runtime 数据根'), status: 'ok', detail: tild(loc.root), next: [] }
        : { id: 'runtime_root', label: tr('Runtime data root', 'Runtime 数据根'), status: 'fail', detail: tr(`${tild(loc.root)} does not exist`, `${tild(loc.root)} 不存在`), next: startOrManual }
    )

    let token: string | null = null
    try {
      token = readToken(loc.root)
      push({ id: 'token', label: tr('Local token', '本地 token'), status: 'ok', detail: tr('Readable (not shown)', '可读取（不显示）'), next: [] })
    } catch (error) {
      const msg = scrub(error instanceof Error ? error.message : String(error), loc.root)
      const next: NextStep[] = /权限过宽|permissions are too open/.test(msg)
        ? [{ kind: 'manual', title: tr('Tighten env permissions', '收紧 env 权限'), steps: [`chmod 600 "${tild(loc.envPath)}"`], command: `chmod 600 "${tild(loc.envPath)}"` }]
        : [loc.bin ? A.restart : startOrManual[0], A.doctor]
      push({ id: 'token', label: tr('Local token', '本地 token'), status: 'fail', detail: msg, next })
    }

    const anon = new RuntimeClient(loc.port, '')
    let healthData: Record<string, unknown> | null = null
    try {
      healthData = (await anon.health()) as Record<string, unknown>
      push({ id: 'runtime_reachable', label: tr('Runtime connection', 'Runtime 连接'), status: 'ok', detail: tr(`127.0.0.1:${loc.port} reachable`, `127.0.0.1:${loc.port} 可达`), next: [] })
    } catch (error) {
      const msg = error instanceof RuntimeError ? error.message : tr('Connection failed', '连接失败')
      push({
        id: 'runtime_reachable',
        label: tr('Runtime connection', 'Runtime 连接'),
        status: 'fail',
        detail: `127.0.0.1:${loc.port}：${scrub(msg, loc.root)}`,
        next: [...startOrManual, A.doctor, A.logs]
      })
    }

    let version: string | null = null
    let status: StatusData | null = null
    if (!healthData) {
      const skipped = tr('Runtime is not running; cannot check', 'Runtime 未运行，无法检查')
      push({ id: 'runtime_version', label: tr('Runtime version', 'Runtime 版本'), status: 'unknown', detail: skipped, next: startOrManual })
      push({ id: 'index', label: tr('Index health', '索引健康'), status: 'unknown', detail: skipped, next: startOrManual })
      push({ id: 'capture_pipeline', label: tr('Runtime capture pipeline', 'Runtime 采集流水线'), status: 'unknown', detail: skipped, next: startOrManual })
    } else {
      if (token) {
        try {
          status = await new RuntimeClient(loc.port, token).status()
          version = typeof status.version === 'string' ? status.version.slice(0, 64) : null
          push({ id: 'runtime_version', label: tr('Runtime version', 'Runtime 版本'), status: 'ok', detail: version ?? tr('unknown', '未知'), next: [] })
        } catch (error) {
          const unauthorized = error instanceof RuntimeError && error.code === 'unauthorized'
          push({
            id: 'runtime_version',
            label: tr('Runtime version', 'Runtime 版本'),
            status: 'fail',
            detail: unauthorized ? tr('The token does not match the running Runtime (401)', 'token 与正在运行的 Runtime 不匹配（401）') : scrub(error instanceof Error ? error.message : String(error), loc.root),
            next: unauthorized ? [A.restart] : [A.doctor, A.logs]
          })
        }
      } else {
        push({ id: 'runtime_version', label: tr('Runtime version', 'Runtime 版本'), status: 'unknown', detail: tr('No token, cannot read /status', '缺少 token，无法读取 /status'), next: [A.restart] })
      }

      const ih = status?.index_health
      const reportIndex = ih && typeof ih.index === 'object' && ih.index ? ih.index.status : typeof ih?.index === 'string' ? ih.index : undefined
      const idxState = healthState(healthData.index)
      const idxDetail = [`/health: ${String(healthData.index ?? 'unknown')}`, reportIndex ? `/status: ${String(reportIndex).slice(0, 40)}` : null]
        .filter(Boolean)
        .join(tr('; ', '；'))
      push({
        id: 'index',
        label: tr('Index health', '索引健康'),
        status: idxState,
        detail: idxDetail,
        next: idxState === 'ok' ? [] : [A.doctor, A.rebuild, A.logs]
      })
      const capState = healthState(healthData.capture_pipeline)
      push({
        id: 'capture_pipeline',
        label: tr('Runtime capture pipeline', 'Runtime 采集流水线'),
        status: capState,
        detail: `/health: ${String(healthData.capture_pipeline ?? 'unknown')}`,
        next: capState === 'ok' ? [] : [A.capture, A.doctor, A.logs]
      })
    }

    // Lens capture plane (in-process).
    let cap: CaptureStatusView | null = null
    try {
      cap = deps.captureStatus?.() ?? null
    } catch {
      cap = null
    }
    if (!cap) {
      push({ id: 'capture_plane', label: tr('Navalia capture', 'Navalia 采集'), status: 'unknown', detail: tr('Capture service status unavailable', '采集服务状态不可用'), next: [A.capture] })
    } else if (cap.started && !cap.degraded) {
      push({ id: 'capture_plane', label: tr('Navalia capture', 'Navalia 采集'), status: 'ok', detail: cap.pause.paused ? tr('Running (paused)', '运行中（已暂停）') : tr('Running', '运行中'), next: [] })
    } else {
      const perms = !cap.permissions.accessibility || !cap.permissions.screenRecording ? tr('; missing system permissions', '；缺少系统权限') : ''
      const why = cap.started ? tr(`Degraded: ${cap.degraded}`, `降级：${cap.degraded}`) : tr(`Not running: ${cap.reason ?? 'unknown reason'}`, `未运行：${cap.reason ?? '原因未知'}`)
      push({ id: 'capture_plane', label: tr('Navalia capture', 'Navalia 采集'), status: 'warn', detail: scrub(`${why}${perms}`, loc.root).slice(0, 300), next: [A.capture] })
    }

    // Broker (in-process, 127.0.0.1:8750).
    let broker: BrokerStatus | null = null
    try {
      broker = deps.brokerStatus?.() ?? null
    } catch {
      broker = null
    }
    if (!broker) {
      push({ id: 'broker', label: 'MCP Broker', status: 'unknown', detail: tr('Broker status unavailable', 'Broker 状态不可用'), next: [A.connections] })
    } else if (broker.running) {
      push({ id: 'broker', label: 'MCP Broker', status: 'ok', detail: broker.url, next: [] })
    } else if (broker.error) {
      push({
        id: 'broker',
        label: 'MCP Broker',
        status: 'fail',
        detail: scrub(broker.error, loc.root).slice(0, 300),
        next: [
          {
            kind: 'manual',
            title: tr('Free the Broker port, then reopen Navalia', '释放 Broker 端口后重开 Navalia'),
            steps: [tr('lsof -nP -iTCP:8750 -sTCP:LISTEN   # see which process holds 8750', 'lsof -nP -iTCP:8750 -sTCP:LISTEN   # 查看占用 8750 的进程'), tr('Stop that process (or quit the other Navalia instance)', '结束占用进程（或退出另一个 Navalia 实例）'), tr('Quit and reopen Navalia', '退出并重新打开 Navalia')],
            command: 'lsof -nP -iTCP:8750 -sTCP:LISTEN'
          },
          A.connections
        ]
      })
    } else {
      push({ id: 'broker', label: 'MCP Broker', status: 'unknown', detail: tr('Starting', '启动中'), next: [] })
    }

    // Lens Store (read-only).
    const store = checkLensStore(deps.storeRoot)
    const storeFail = store.findings.some((f) => f.level === 'fail')
    const storeStatus: CheckStatus = storeFail ? 'fail' : store.findings.length ? 'warn' : 'ok'
    push({
      id: 'lens_store',
      label: tr('Navalia Store integrity', 'Navalia Store 完整性'),
      status: storeStatus,
      detail: store.findings.length ? store.findings.map((f) => f.message).join(tr('; ', '；')) : tr(`Checked ${store.checkedFiles} files, no problems found`, `已检查 ${store.checkedFiles} 个文件，未发现问题`),
      next:
        storeStatus === 'ok'
          ? []
          : storeFail
            ? [{ kind: 'manual', title: tr('Restore from a backup or reset the Navalia Store', '从备份恢复或重置 Navalia Store'), steps: [tr('Settings → Backup → Restore (from the latest backup)', '设置 → 备份 → 恢复（从最近一次备份）'), tr('No backup: see "Manual steps · Reset the Navalia Store" below', '没有备份时：见下方「需手动执行 · 重置 Navalia Store」')] }]
            : [{ kind: 'manual', title: tr('Tighten permissions', '收紧权限'), steps: [`chmod 700 "${tild(deps.storeRoot)}"`, `chmod 600 "${tild(deps.storeRoot)}"/*.json "${tild(deps.storeRoot)}"/*.db`], command: `chmod 700 "${tild(deps.storeRoot)}"` }]
    })

    // Disk space.
    const disks: Array<{ label: string; info: DiskInfo | null }> = [
      { label: 'Runtime', info: diskFree(loc.root, deps.statfs) },
      { label: 'Navalia Store', info: diskFree(deps.storeRoot, deps.statfs) }
    ]
    const known = disks.filter((d) => d.info)
    if (!known.length) {
      push({ id: 'disk', label: tr('Disk space', '磁盘空间'), status: 'unknown', detail: tr('Cannot read disk information', '无法读取磁盘信息'), next: [] })
    } else {
      const minFree = Math.min(...known.map((d) => d.info!.freeBytes))
      const diskStatus: CheckStatus = minFree < DISK_FAIL_BYTES ? 'fail' : minFree < DISK_WARN_BYTES ? 'warn' : 'ok'
      push({
        id: 'disk',
        label: tr('Disk space', '磁盘空间'),
        status: diskStatus,
        detail: known.map((d) => tr(`${d.label} ${GiB(d.info!.freeBytes)} free`, `${d.label} 可用 ${GiB(d.info!.freeBytes)}`)).join(tr('; ', '；')),
        next:
          diskStatus === 'ok'
            ? []
            : [{ kind: 'manual', title: tr('Free up disk space', '释放磁盘空间'), steps: [tr('Clear large files from Downloads, Trash and so on; keep at least 5 GB free', '清理下载 / 废纸篓等大文件，至少保留 5 GB 可用'), tr('Then restart Runtime', '然后重启 Runtime')] }, A.restart]
      })
    }

    return {
      generatedAt: new Date(now()).toISOString(),
      overall: worst(checks.map((c) => c.status)),
      runtime: { root: tild(loc.root), port: loc.port, binFound: Boolean(loc.bin), version },
      checks,
      manual: manualProcedures(loc)
    }
  }

  async function waitForDown(port: number): Promise<boolean> {
    const client = new RuntimeClient(port, '')
    const deadline = now() + stopWaitMs
    for (;;) {
      try {
        await client.health()
      } catch {
        return true
      }
      if (now() >= deadline) return false
      await sleep(250)
    }
  }

  async function stopRuntime(loc: RuntimeLocation & { bin: string }): Promise<void> {
    const run = await runCli(loc.bin, CLI_ARGS.stop, { root: loc.root, timeoutMs: stopTimeoutMs, maxBytes: 64 * 1024, knownSecrets: secrets(loc.root), homeDir: home })
    if (run.spawnFailed) throw new RecoveryError('runtime_missing', run.output)
    if (!(await waitForDown(loc.port))) {
      throw new RecoveryError('timeout', tr(
        `Runtime is still running after persome stop (127.0.0.1:${loc.port})${run.output ? `: ${run.output.slice(-300)}` : ''}`,
        `persome stop 之后 Runtime 仍在运行（127.0.0.1:${loc.port}）${run.output ? `：${run.output.slice(-300)}` : ''}`
      ))
    }
  }

  function requireBin(): RuntimeLocation & { bin: string } {
    const loc = deps.locate()
    if (!loc.bin) throw new RecoveryError('runtime_missing', tr('The persome command was not found. Install the open-source Runtime first.', '没有找到 persome 命令，请先安装开源 Runtime'))
    return loc as RuntimeLocation & { bin: string }
  }

  return {
    health,

    async startRuntime(): Promise<RecoveryReport> {
      await exclusive(tr('Start Runtime', '启动 Runtime'), async () => {
        await start(requireBin())
      })
      return health()
    },

    async restartRuntime(): Promise<RecoveryReport> {
      await exclusive(tr('Restart Runtime', '重启 Runtime'), async () => {
        const loc = requireBin()
        await stopRuntime(loc)
        await start(loc)
      })
      return health()
    },

    doctor(): Promise<DoctorResult> {
      return exclusive(tr('Run doctor', '运行 doctor'), async () => {
        const loc = requireBin()
        const run = await runCli(loc.bin, CLI_ARGS.doctor, {
          root: loc.root,
          timeoutMs: doctorTimeoutMs,
          maxBytes: doctorMaxBytes,
          knownSecrets: secrets(loc.root),
          homeDir: home
        })
        if (run.spawnFailed) throw new RecoveryError('runtime_missing', run.output)
        const lines = parseDoctorLines(run.output)
        const result: DoctorResult = {
          ran: true,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          truncated: run.truncated,
          durationMs: run.durationMs,
          output: run.timedOut ? tr(
                `${run.output}\n[doctor timed out (${Math.round(doctorTimeoutMs / 1000)} s) and was stopped]`,
                `${run.output}\n[doctor 超时（${Math.round(doctorTimeoutMs / 1000)} 秒），已终止]`
              ).trim() : run.output,
          lines,
          summary: {
            ok: lines.filter((l) => l.status === 'ok').length,
            fail: lines.filter((l) => l.status === 'fail').length,
            warn: lines.filter((l) => l.status === 'warn').length
          }
        }
        lastDoctor = result
        return result
      })
    },

    async diagnostics(copy: boolean): Promise<DiagnosticsResult> {
      const report = await health()
      const loc = deps.locate()
      const lines = [
        tr('Navalia recovery diagnostics', 'Navalia 恢复诊断'),
        tr(`Generated: ${report.generatedAt}`, `生成时间: ${report.generatedAt}`),
        tr(
          `Navalia: ${deps.appVersion?.() ?? 'unknown'}  Platform: ${process.platform} ${process.arch}`,
          `Navalia: ${deps.appVersion?.() ?? '未知'}  平台: ${process.platform} ${process.arch}`
        ),
        tr(
          `Runtime root: ${report.runtime.root}  port: ${report.runtime.port}  persome: ${report.runtime.binFound ? 'found' : 'missing'}  version: ${report.runtime.version ?? 'unknown'}`,
          `Runtime root: ${report.runtime.root}  port: ${report.runtime.port}  persome: ${report.runtime.binFound ? '已找到' : '缺失'}  版本: ${report.runtime.version ?? '未知'}`
        ),
        tr(`Overall: ${report.overall}`, `总体: ${report.overall}`),
        ...report.checks.map((c) => `[${c.status}] ${c.label}: ${c.detail}`),
        lastDoctor
          ? tr(
              `doctor (last run): exit code ${lastDoctor.exitCode ?? 'none'}${lastDoctor.timedOut ? ' timed out' : ''}; ✓${lastDoctor.summary.ok} ✗${lastDoctor.summary.fail} ⚠${lastDoctor.summary.warn}`,
              `doctor（上次）: 退出码 ${lastDoctor.exitCode ?? '无'}${lastDoctor.timedOut ? ' 超时' : ''}；✓${lastDoctor.summary.ok} ✗${lastDoctor.summary.fail} ⚠${lastDoctor.summary.warn}`
            )
          : tr('doctor: not run this session', 'doctor: 本次未运行'),
        ...(lastDoctor ? lastDoctor.lines.filter((l) => l.status === 'fail' || l.status === 'warn').map((l) => `  ${l.status === 'fail' ? '✗' : '⚠'} ${l.text}`) : [])
      ]
      const text = scrub(lines.join('\n'), loc.root)
      let copied = false
      if (copy && deps.copyToClipboard) {
        deps.copyToClipboard(text)
        copied = true
      }
      return { text, copied }
    },

    confirmIssue(action: DestructiveActionId): ConfirmChallenge {
      return confirm.issue(action)
    },

    async confirmRun(action: DestructiveActionId, nonce: string, phrase: string): Promise<DestructiveRunResult> {
      // Consume first (burns the nonce) so a busy/missing-bin failure cannot be retried with it.
      confirm.consume(action, nonce, phrase)
      return exclusive(tr('Rebuild capture index', '重建采集索引'), async () => {
        const loc = requireBin()
        await stopRuntime(loc)
        const run = await runCli(loc.bin, CLI_ARGS.rebuildCapturesIndex, {
          root: loc.root,
          timeoutMs: rebuildTimeoutMs,
          maxBytes: rebuildMaxBytes,
          knownSecrets: secrets(loc.root),
          homeDir: home
        })
        let runtimeRestarted = false
        let restartNote = ''
        try {
          await start(loc)
          runtimeRestarted = true
        } catch (error) {
          restartNote = tr(
            `\n[Restarting Runtime after the rebuild failed: ${scrub(error instanceof Error ? error.message : String(error), loc.root)}]`,
            `\n[重建后重新启动 Runtime 失败：${scrub(error instanceof Error ? error.message : String(error), loc.root)}]`
          )
        }
        return {
          action,
          ok: run.exitCode === 0 && !run.timedOut,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          truncated: run.truncated,
          output: `${run.output}${run.timedOut ? tr('\n[Rebuild timed out and was stopped; the Runtime transaction rolls back the unfinished rebuild]', '\n[重建超时，已终止；Runtime 的单事务会回滚未完成的重建]') : ''}${restartNote}`,
          runtimeRestarted
        }
      })
    }
  }
}

export type RecoveryService = ReturnType<typeof createRecoveryService>
