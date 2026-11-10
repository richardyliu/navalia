// S1-R4-11 test hermeticity: some tests shell out to host binaries (`/bin/ps`, `/usr/bin/sandbox-exec`)
// directly or through the upstream Runtime CLI. In a restricted sandbox (nested sandbox-exec, denied
// process-info) these fail with EPERM / "Operation not permitted" / exit 71 — an environment limit,
// not a Lens bug. Probe once per process, and let tests skip with the reason printed. When the binary
// works, nothing is skipped and assertions are unchanged.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

export interface ProbeResult {
  ok: boolean
  /** Null when ok; otherwise one line saying what failed (shown in the skip message). */
  reason: string | null
}

export type SpawnSyncLike = (cmd: string, args: string[], opts: { encoding: 'utf8'; timeout: number }) => Pick<SpawnSyncReturns<string>, 'status' | 'error' | 'stderr' | 'signal'>

const cache = new Map<string, ProbeResult>()

/** Run `cmd args` once (memoized by command line). ok = spawned, exit 0, no signal. */
export function probe(cmd: string, args: string[], spawn: SpawnSyncLike = spawnSync as unknown as SpawnSyncLike): ProbeResult {
  // Escape hatch to see the raw failure instead of a skip: LENS_TEST_NO_PROBE=1 npx vitest run …
  if (process.env.LENS_TEST_NO_PROBE === '1' && spawn === (spawnSync as unknown)) return { ok: true, reason: null }
  const key = JSON.stringify([cmd, args])
  const hit = spawn === (spawnSync as unknown) ? cache.get(key) : undefined
  if (hit) return hit
  let result: ProbeResult
  try {
    const r = spawn(cmd, args, { encoding: 'utf8', timeout: 15_000 })
    if (r.error) result = { ok: false, reason: `${cmd}: ${(r.error as NodeJS.ErrnoException).code ?? ''} ${r.error.message}`.trim() }
    else if (r.signal) result = { ok: false, reason: `${cmd}: killed by ${r.signal}` }
    else if (r.status !== 0) result = { ok: false, reason: `${cmd}: exit ${r.status}${r.stderr ? ` (${String(r.stderr).trim().split('\n')[0].slice(0, 200)})` : ''}` }
    else result = { ok: true, reason: null }
  } catch (error) {
    result = { ok: false, reason: `${cmd}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (spawn === (spawnSync as unknown)) cache.set(key, result)
  return result
}

/** `/bin/ps` can list processes (what og02_cap_readonly.py `ps` and the Runtime's runtime_pid.py do). */
export function psProbe(spawn?: SpawnSyncLike): ProbeResult {
  return probe('/bin/ps', ['-ww', '-p', String(process.pid), '-o', 'uid='], spawn)
}

/**
 * `sandbox-exec` can apply `profile` (fails with "sandbox_apply: Operation not permitted" when the test
 * process is already inside a sandbox that forbids nesting). Deliberately does NOT require `/bin/ps`
 * inside the profile: the upstream Runtime tolerates a denied ps (measured 2026-11-05: the real-upstream
 * suites pass while `sandbox-exec … /bin/ps` exits 71), so requiring it would skip passing tests.
 */
export function sandboxExecProbe(profile: string, spawn?: SpawnSyncLike): ProbeResult {
  return probe('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], spawn)
}

const warned = new Set<string>()
/** Print the skip reason once per label (vitest shows it under the file). */
export function warnSkip(label: string, r: ProbeResult): void {
  if (r.ok || warned.has(label)) return
  warned.add(label)
  console.warn(`[hermetic] skipping ${label}: ${r.reason}`)
}
