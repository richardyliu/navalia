import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tr } from '../../shared/i18n'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  method?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class McpError extends Error {
  readonly code = 'mcp_unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'McpError'
  }
}

const PROTOCOL_VERSION = '2024-11-05'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Minimal MCP stdio client. Persome's MCP server speaks newline-delimited
 * JSON-RPC 2.0, so we do not need the full SDK in the Electron main process.
 */
export class PersomeMcp {
  private readonly bin: string
  private readonly root: string
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private startPromise: Promise<void> | null = null
  private stderrTail: string[] = []

  constructor(bin: string, root: string) {
    this.bin = bin
    this.root = root
  }

  get key(): string {
    return `${this.bin}|${this.root}`
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.start()
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
    }
    const text = result?.content?.find((item) => item.type === 'text')?.text ?? ''
    if (result?.isError) throw new McpError(text || `MCP tool ${name} failed`)
    return text
  }

  private async start(): Promise<void> {
    if (this.child && !this.child.killed) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.spawnAndInitialize().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async spawnAndInitialize(): Promise<void> {
    const child = spawn(this.bin, ['mcp'], {
      env: { ...process.env, PERSOME_ROOT: this.root },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        this.stderrTail.push(line)
        if (this.stderrTail.length > 40) this.stderrTail.shift()
      }
    })
    child.on('exit', () => this.onExit())
    child.on('error', () => this.onExit())

    const init = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'navalia', version: '0.1.0' }
    })) as { protocolVersion?: string }
    if (!init?.protocolVersion) throw new McpError(tr('MCP initialize returned no protocolVersion', 'MCP initialize 没有返回 protocolVersion'))
    this.notify('notifications/initialized')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id) as Pending
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new McpError(message.error.message || 'MCP error'))
      else pending.resolve(message.result)
      return
    }
    // Server-initiated request: answer with an error instead of hanging.
    if (typeof message.id === 'number' && message.method) {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported' } })
    }
  }

  private onExit(): void {
    this.child = null
    this.startPromise = null
    const error = new McpError(
      this.stderrTail.length
        ? tr(`persome mcp exited: ${this.stderrTail.slice(-3).join(' ')}`, `persome mcp 退出：${this.stderrTail.slice(-3).join(' ')}`)
        : tr('persome mcp exited', 'persome mcp 退出')
    )
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private notify(method: string): void {
    this.write({ jsonrpc: '2.0', method })
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child) return Promise.reject(new McpError(tr('persome mcp is not running', 'persome mcp 没有启动')))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(tr(`MCP request timed out: ${method}`, `MCP 请求超时：${method}`)))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  close(): void {
    this.child?.kill()
    this.child = null
  }
}
