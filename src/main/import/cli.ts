import { execFile } from 'node:child_process'
import type { CliOutcome } from './api'
import { redactForDisplay } from './redact'

/**
 * `persome import-data` invocation. Verified against personal-model `src/persome/cli.py`
 * (`@app.command("import-data")`): `--source {obsidian,folder,notion,anything}`, `--path`,
 * `--build/--no-build` (default build). Receipt line:
 * `✓ Imported N new/changed document(s); U unchanged, S skipped.`
 * No shell: `execFile` with an argument array. PERSOME_ROOT pins the Runtime root.
 */

export interface ExecResult {
  /** Process exit code, or null when killed by a signal / failed to spawn. */
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<ExecResult>

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; signal?: string | null }) | null
        let code: number | null = 0
        if (err) code = typeof err.code === 'number' ? err.code : null
        const spawnErr = err && typeof err.code === 'string' ? `${err.code}: ${err.message}` : ''
        resolve({
          code,
          signal: err?.signal ?? null,
          stdout: String(stdout ?? ''),
          stderr: [String(stderr ?? ''), spawnErr].filter(Boolean).join('\n')
        })
      }
    )
  })

export const IMPORT_TIMEOUT_MS = 10 * 60_000
export const BUILD_TIMEOUT_MS = 45 * 60_000
const OUTPUT_MAX = 8_000

export function importArgs(stagingDir: string, build: boolean): string[] {
  return ['import-data', '--source', 'folder', '--path', stagingDir, build ? '--build' : '--no-build']
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g')

export function cleanOutput(s: string): string {
  const t = redactForDisplay(s.replace(ANSI, '').replace(/\r/g, ''))
  return t.length > OUTPUT_MAX ? '…' + t.slice(t.length - OUTPUT_MAX) : t
}

export function parseReceipt(stdout: string): CliOutcome['counts'] {
  const m = /Imported\s+(\d+)\s+new\/changed document\(s\);\s*(\d+)\s+unchanged,\s*(\d+)\s+skipped/.exec(stdout.replace(ANSI, ''))
  return m ? { imported: Number(m[1]), unchanged: Number(m[2]), skipped: Number(m[3]) } : null
}

export async function runImportCli(opts: {
  exec: ExecFn
  bin: string
  runtimeRoot: string
  stagingDir: string
  build: boolean
  now?: () => number
}): Promise<CliOutcome> {
  const now = opts.now ?? Date.now
  const args = importArgs(opts.stagingDir, opts.build)
  const started = now()
  const r = await opts.exec(opts.bin, args, {
    env: { ...process.env, PERSOME_ROOT: opts.runtimeRoot },
    timeoutMs: opts.build ? BUILD_TIMEOUT_MS : IMPORT_TIMEOUT_MS
  })
  return {
    args: args.map((a) => (a === opts.stagingDir ? '<staging>' : a)),
    exitCode: r.code,
    signal: r.signal,
    stdout: cleanOutput(r.stdout),
    stderr: cleanOutput(r.stderr),
    counts: parseReceipt(r.stdout),
    durationMs: now() - started
  }
}
