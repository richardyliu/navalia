import { spawn, type ChildProcess } from 'node:child_process'
import type { BuildState } from '../shared/types'

let child: ChildProcess | null = null
let state: BuildState = { running: false, lines: [] }
const MAX_LINES = 300

function append(line: string): void {
  const trimmed = line.trimEnd()
  if (!trimmed) return
  state.lines.push(trimmed)
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES)
}

export function startBuild(bin: string, root: string): BuildState {
  if (state.running) return state
  state = { running: true, startedAt: Date.now(), lines: [] }
  try {
    const childProcess = spawn(bin, ['model', 'build'], {
      env: { ...process.env, PERSOME_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child = childProcess
    childProcess.stdout.setEncoding('utf8')
    childProcess.stderr.setEncoding('utf8')
    childProcess.stdout.on('data', (chunk: string) => chunk.split('\n').forEach(append))
    childProcess.stderr.on('data', (chunk: string) => chunk.split('\n').forEach(append))
    childProcess.on('exit', (code: number | null) => {
      state.running = false
      state.finishedAt = Date.now()
      state.exitCode = code
      child = null
    })
    childProcess.on('error', (error: Error) => {
      state.running = false
      state.finishedAt = Date.now()
      state.error = error.message
      child = null
    })
  } catch (error) {
    state.running = false
    state.finishedAt = Date.now()
    state.error = (error as Error).message
  }
  return state
}

export function buildStatus(): BuildState {
  return state
}

export function cancelBuild(): boolean {
  if (!state.running || !child) return false
  child.kill('SIGTERM')
  return true
}
