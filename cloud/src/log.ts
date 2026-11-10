// Structured request log. By construction it can only carry the five allowed
// fields; nothing from headers, bodies, tokens, keys or the URL query string
// can reach it. `route` is the matched route TEMPLATE, never the raw path.

export interface RequestLogLine {
  req_id: string
  method: string
  route: string
  status: number
  ms: number
}

export type LogSink = (line: string) => void

export const stdoutSink: LogSink = (line) => {
  process.stdout.write(line + '\n')
}

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

export function safeMethod(m: string | undefined): string {
  return m && KNOWN_METHODS.has(m) ? m : 'OTHER'
}

export function logRequest(sink: LogSink, l: RequestLogLine): void {
  const line: RequestLogLine = {
    req_id: l.req_id,
    method: l.method,
    route: l.route,
    status: l.status,
    ms: Math.round(l.ms * 10) / 10
  }
  sink(JSON.stringify(line))
}
