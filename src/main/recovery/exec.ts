import { spawn } from 'node:child_process'
import os from 'node:os'
import { redactSecrets } from '../capture/diagnostics'
import { redactForDisplay } from '../import/redact'
import type { DoctorLine } from './api'
import { tr } from '../../shared/i18n'

/**
 * Runs a fixed `persome <subcommand>` via spawn (never a shell string), with an optional timeout
 * (SIGTERM, then SIGKILL after a grace period) and a bounded head + tail output capture that never
 * kills the child. Output is ANSI-stripped and redacted before it leaves this module.
 */

export interface CliRun {
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  durationMs: number
  /** Redacted stdout + stderr. */
  output: string
  /** True when the process could not be started at all (ENOENT/EACCES). */
  spawnFailed: boolean
}

export interface CliOptions {
  root: string
  /** 0 disables the timeout. */
  timeoutMs: number
  /** Bound on captured output (head + tail); never a reason to kill the child. */
  maxBytes: number
  knownSecrets: readonly string[]
  homeDir?: string
}

/** Whitelisted argument vectors. Nothing from the renderer is ever appended. */
export const CLI_ARGS = {
  doctor: ['doctor'],
  stop: ['stop'],
  rebuildCapturesIndex: ['rebuild-captures-index', '--merge']
} as const satisfies Record<string, readonly string[]>

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

function tildify(text: string, home: string): string {
  if (!home || home === '/') return text
  return text.split(home).join('~')
}

/** Known secrets verbatim first, then pattern rules from capture diagnostics and import redaction. */
export function redactCliOutput(text: string, knownSecrets: readonly string[], homeDir: string = os.homedir()): string {
  const clean = stripAnsi(text)
  const once = redactSecrets(clean, knownSecrets)
  return tildify(redactForDisplay(once), homeDir)
}

/**
 * OG4: bounded head + tail capture that keeps draining. The child is never killed for output
 * volume (execFile's maxBuffer did that: a `persome clean` or rebuild printing > 256 KiB was
 * SIGKILLed mid-run). Memory stays bounded at `maxBytes`; the middle is dropped and counted.
 */
const MARKER_RESERVE = 96

export class HeadTailBuffer {
  private head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private dropped = 0
  private readonly headCap: number
  private readonly tailCap: number

  constructor(maxBytes: number) {
    // Reserve room for the omission marker so text() never exceeds maxBytes.
    const cap = Math.max(0, Math.floor(maxBytes) - MARKER_RESERVE)
    this.headCap = Math.floor(cap / 2)
    this.tailCap = cap - this.headCap
  }

  push(chunk: Buffer): void {
    let rest = chunk
    if (this.headBytes < this.headCap) {
      const take = Math.min(this.headCap - this.headBytes, rest.length)
      this.head.push(rest.subarray(0, take))
      this.headBytes += take
      rest = rest.subarray(take)
    }
    if (!rest.length) return
    this.tail.push(Buffer.from(rest))
    this.tailBytes += rest.length
    while (this.tailBytes > this.tailCap && this.tail.length) {
      const over = this.tailBytes - this.tailCap
      const first = this.tail[0]
      if (first.length <= over) {
        this.tail.shift()
        this.tailBytes -= first.length
        this.dropped += first.length
      } else {
        this.tail[0] = first.subarray(over)
        this.tailBytes -= over
        this.dropped += over
      }
    }
  }

  get truncated(): boolean {
    return this.dropped > 0
  }

  get droppedBytes(): number {
    return this.dropped
  }

  /**
   * Captured text. When truncated, the head is cut back to its last newline and the tail starts
   * after its first one, so a secret split at a boundary is not left half-visible (and still
   * redactable as a whole line elsewhere).
   */
  text(): string {
    const head = Buffer.concat(this.head).toString('utf8')
    const tail = Buffer.concat(this.tail).toString('utf8')
    if (!this.truncated) return head + tail
    const h = head.lastIndexOf('\n')
    const t = tail.indexOf('\n')
    const headPart = h >= 0 ? head.slice(0, h + 1) : ''
    const tailPart = t >= 0 ? tail.slice(t + 1) : ''
    return tr(
      `${headPart}[… output too long, about ${this.dropped} bytes omitted …]\n${tailPart}`,
      `${headPart}[… 输出过长，中间省略约 ${this.dropped} 字节 …]\n${tailPart}`
    )
  }
}

/** Grace between SIGTERM and SIGKILL when a timeout fires. */
export const KILL_GRACE_MS = 5_000

export function runCli(bin: string, args: readonly string[], opts: CliOptions): Promise<CliRun> {
  const started = Date.now()
  return new Promise((resolve) => {
    const buf = new HeadTailBuffer(opts.maxBytes)
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    let graceTimer: NodeJS.Timeout | null = null
    const finish = (r: Omit<CliRun, 'durationMs'>): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      resolve({ ...r, durationMs: Date.now() - started })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, [...args], {
        env: { ...process.env, PERSOME_ROOT: opts.root, NO_COLOR: '1', TERM: 'dumb', COLUMNS: '160' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      finish({ exitCode: null, timedOut: false, truncated: false, output: tr(`Cannot start the persome command (${String(code)})`, `无法启动 persome 命令（${String(code)}）`), spawnFailed: true })
      return
    }
    // stdout and stderr share one bounded buffer in arrival order; both are always drained.
    child.stdout?.on('data', (c: Buffer) => buf.push(c))
    child.stderr?.on('data', (c: Buffer) => buf.push(c))
    if (opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        graceTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      }, opts.timeoutMs)
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      const spawnFailed = error.code === 'ENOENT' || error.code === 'EACCES'
      if (spawnFailed) {
        finish({ exitCode: null, timedOut: false, truncated: false, output: tr(`Cannot start the persome command (${String(error.code)})`, `无法启动 persome 命令（${String(error.code)}）`), spawnFailed: true })
      }
    })
    child.once('close', (code: number | null) => {
      const output = redactCliOutput(buf.text(), opts.knownSecrets, opts.homeDir).trimEnd()
      finish({ exitCode: timedOut ? null : code, timedOut, truncated: buf.truncated, output, spawnFailed: false })
    })
  })
}

/** Parse `persome doctor` lines (`✓ name detail` / `✗ …` / `⚠ …`). */
export function parseDoctorLines(output: string): DoctorLine[] {
  const lines: DoctorLine[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const mark = line[0]
    const text = line.slice(1).trim()
    if (mark === '✓') lines.push({ status: 'ok', text })
    else if (mark === '✗') lines.push({ status: 'fail', text })
    else if (mark === '⚠') lines.push({ status: 'warn', text })
    else lines.push({ status: 'info', text: line })
  }
  return lines
}
