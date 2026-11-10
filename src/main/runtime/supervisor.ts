import { spawn } from 'node:child_process'
import type { RuntimeLocation } from './paths'
import { RuntimeClient, RuntimeError } from './client'
import { tr } from '../../shared/i18n'

const START_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForHealth(port: number, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  const client = new RuntimeClient(port, '')
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      await client.health()
      return
    } catch (error) {
      lastError = error
      await sleep(POLL_INTERVAL_MS)
    }
  }
  const message = lastError instanceof Error ? lastError.message : 'unknown'
  throw new RuntimeError('timeout', tr(
      `Runtime was not ready within ${Math.round(timeoutMs / 1000)} s (${message})`,
      `Runtime 在 ${Math.round(timeoutMs / 1000)} 秒内没有就绪（${message}）`
    ))
}

/**
 * Start the runtime as a detached background process and wait until its
 * unauthenticated health endpoint answers. Never starts capture by itself:
 * the daemon's own policy decides what to do once it is up.
 */
export async function startRuntime(location: RuntimeLocation): Promise<void> {
  if (!location.bin) {
    throw new RuntimeError('runtime_missing', tr('persome command not found. Install the open-source Runtime first.', '没有找到 persome 命令，请先安装开源 Runtime'))
  }
  try {
    const child = spawn(location.bin, ['start'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PERSOME_ROOT: location.root }
    })
    child.unref()
  } catch (error) {
    throw new RuntimeError('runtime_missing', tr(`Starting persome failed: ${(error as Error).message}`, `启动 persome 失败：${(error as Error).message}`))
  }
  await waitForHealth(location.port)
}

export function openOfficialViewer(location: RuntimeLocation): void {
  if (!location.bin) {
    throw new RuntimeError('runtime_missing', tr('persome command not found', '没有找到 persome 命令'))
  }
  const child = spawn(location.bin, ['model', 'open'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PERSOME_ROOT: location.root }
  })
  child.unref()
}
