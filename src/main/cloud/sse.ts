// Minimal `text/event-stream` parser (WHATWG SSE line rules) over a byte ReadableStream.
// Handles CR / LF / CRLF (including a CRLF split across chunks), UTF-8 split across chunks,
// comments, multi-line `data:`, `event:` / `id:`, a `[DONE]` sentinel, a per-event size bound
// and an AbortSignal. No network access here: the caller hands in the body stream.
import { CloudError } from './errors'

export interface SseEvent {
  /** `event:` field, default `message`. */
  event: string
  /** `data:` lines joined with `\n`. */
  data: string
  /** Last seen `id:` (persists across events, per spec), or null. */
  id: string | null
}

export interface SseOptions {
  /** Max UTF-8 bytes of one event (data + event name) and of one pending line. Default 256 KiB. */
  maxEventBytes?: number
  signal?: AbortSignal
  /** Data payload that ends the stream without being yielded. Default `[DONE]`; null disables. */
  doneSentinel?: string | null
}

export const DEFAULT_MAX_EVENT_BYTES = 256 * 1024

export async function* parseSse(stream: ReadableStream<Uint8Array>, opts: SseOptions = {}): AsyncGenerator<SseEvent, void, undefined> {
  const max = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
  const done = opts.doneSentinel === undefined ? '[DONE]' : opts.doneSentinel
  const signal = opts.signal
  if (signal?.aborted) throw signal.reason
  const reader = stream.getReader()
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const decoder = new TextDecoder('utf-8') // strips a leading BOM
  let buf = ''
  let dataLines: string[] = []
  let dataBytes = 0
  let eventName = ''
  let lastId: string | null = null
  let finished = false

  /** Process one complete line; returns an event to dispatch, 'done', or null. */
  const line = (l: string): SseEvent | 'done' | null => {
    if (l === '') {
      if (dataLines.length === 0) {
        eventName = ''
        return null
      }
      const ev: SseEvent = { event: eventName || 'message', data: dataLines.join('\n'), id: lastId }
      dataLines = []
      dataBytes = 0
      eventName = ''
      if (done !== null && ev.data === done) return 'done'
      return ev
    }
    if (l.startsWith(':')) return null
    const colon = l.indexOf(':')
    const field = colon === -1 ? l : l.slice(0, colon)
    let value = colon === -1 ? '' : l.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      dataBytes += Buffer.byteLength(value, 'utf8') + 1
      if (dataBytes + Buffer.byteLength(eventName, 'utf8') > max) throw new CloudError('too_large')
      dataLines.push(value)
    } else if (field === 'event') {
      eventName = value
      if (dataBytes + Buffer.byteLength(eventName, 'utf8') > max) throw new CloudError('too_large')
    } else if (field === 'id') {
      if (!value.includes('\0')) lastId = value
    }
    // `retry` and unknown fields are ignored.
    return null
  }

  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read()
      if (signal?.aborted) throw signal.reason
      if (streamDone) {
        buf += decoder.decode()
        finished = true
      } else {
        buf += decoder.decode(value, { stream: true })
      }
      let pos = 0
      for (;;) {
        let i = pos
        while (i < buf.length && buf[i] !== '\n' && buf[i] !== '\r') i++
        if (i >= buf.length) break
        let next = i + 1
        if (buf[i] === '\r') {
          if (i === buf.length - 1 && !finished) break // a CRLF may be split across chunks
          if (buf[i + 1] === '\n') next = i + 2
        }
        const out = line(buf.slice(pos, i))
        pos = next
        if (out === 'done') return
        if (out) yield out
        if (signal?.aborted) throw signal.reason
      }
      buf = buf.slice(pos)
      if (Buffer.byteLength(buf, 'utf8') > max) throw new CloudError('too_large')
      if (finished) {
        // Spec: an event without a terminating blank line at EOF is discarded.
        return
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
