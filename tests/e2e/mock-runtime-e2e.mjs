// [mock] Persome Runtime for the E2E harness. Speaks only the routes Lens main calls:
// GET /health, GET /model/share-card, GET /model/graph (synthetic fixture
// tests/e2e/fixtures/model-graph.json; `graph: false` -> 404, which Lens treats as absent),
// GET /model/evidence, POST /captures/ingest. Frames are counted, never persisted:
// only trigger/app/bundle metadata is kept, AX text and screenshots are dropped.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEMO = path.resolve(HERE, '../fixtures/demo')

export async function startMockRuntime({ token, graph = true }) {
  const shareCard = JSON.parse(fs.readFileSync(path.join(DEMO, 'share-card.json'), 'utf8'))
  const modelGraph = graph ? JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/model-graph.json'), 'utf8')) : null
  const frames = []
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push(`${req.method} ${url.pathname}`)
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${token}`) return send(401, { detail: 'unauthorized' })
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok' })
    if (req.method === 'GET' && url.pathname === '/model/share-card') return send(200, shareCard)
    if (req.method === 'GET' && url.pathname === '/model/graph' && modelGraph) return send(200, modelGraph)
    if (req.method === 'GET' && url.pathname === '/model/evidence') {
      return send(200, { reference: url.searchParams.get('ref'), status: 'not_found', sources: [], context: [], history: [] })
    }
    if (req.method === 'POST' && url.pathname === '/captures/ingest') {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size <= 32 * 1024 * 1024) chunks.push(c)
      })
      req.on('end', () => {
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return send(400, { detail: 'bad json' })
        }
        const meta = body.window_meta ?? {}
        frames.push({
          at: Date.now(),
          trigger: body.trigger?.event_type ?? null,
          app_name: meta.app_name ?? null,
          bundle_id: meta.bundle_id ?? null,
          has_screenshot: Boolean(body.screenshot)
        })
        send(200, { data: { id: `cap-${frames.length}`, deduped: false, skipped: false } })
      })
      return
    }
    send(404, { detail: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    frames,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
