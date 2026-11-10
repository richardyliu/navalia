// Minimal Chrome DevTools Protocol client (zero dependencies: Node >= 22 global WebSocket).
// Drives the renderer of a Lens instance started with --remote-debugging-port=0.
// Evaluation happens inside the app document, so the main-process IPC sender
// guard sees the real app frame; nothing here bypasses it.
import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Chromium writes "<port>\n<browser ws path>" into <user-data-dir>/DevToolsActivePort. */
export async function waitForDevToolsPort(userDataDir, timeoutMs = 20000) {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const [port] = fs.readFileSync(file, 'utf8').split('\n')
      if (/^\d+$/.test(port)) return Number(port)
    } catch {
      // not written yet
    }
    await sleep(200)
  }
  throw new Error(`DevToolsActivePort not written in ${timeoutMs} ms (${file})`)
}

export async function waitForPage(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      // file://…/renderer/index.html today; app://lens/index.html once the custom protocol lands.
      const page = list.find(
        (t) => t.type === 'page' && (t.url.endsWith('/renderer/index.html') || t.url.startsWith('app://lens/'))
      )
      if (page) return page
    } catch {
      // DevTools HTTP endpoint not up yet
    }
    await sleep(250)
  }
  throw new Error('renderer page target not found')
}

export async function connectPage(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    const waiter = msg.id != null ? pending.get(msg.id) : undefined
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  /** Evaluate an async expression in the page and return its JSON value. */
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result.value
  }

  /** Poll until `expression` is truthy. */
  async function waitFor(expression, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await evaluate(expression).catch((e) => e.message)
      if (last) return last
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${expression} (last=${JSON.stringify(last)})`)
  }

  return { send, evaluate, waitFor, close: () => ws.close() }
}
