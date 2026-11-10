// S1-FULL C15 ↔ cloud server: Lens cloud Workflow extraction against the REAL `cloud/` server in mock
// LLM mode (CLOUD_LLM_MODE=mock), spawned like tests/cloud/e2e-chat-real-server.test.ts. Temp DB,
// temp Lens Store, synthetic session, throwaway identity. Only our own child process is stopped.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCloudService } from '../../src/main/cloud/service'
import { createCloudExtractService } from '../../src/main/workflows/cloud-extract'
import { createWorkflowService } from '../../src/main/workflows/service'
import { createSessionSource } from '../../src/main/workflows/sessions'
import { fakeBox, testIdentity } from '../cloud/helpers'
import { KNOWN_SECRET, TMP_PREFIX, writeSession } from './cloud-helpers'

let child: ChildProcess | undefined
let origin: string
let dir: string
let serverOut = ''

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}e2e-`))
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve('cloud'),
    env: { PATH: process.env.PATH, PORT: String(port), CLOUD_DB_PATH: path.join(dir, 'db', 'cloud.db'), CLOUD_PUBLIC_ORIGIN: origin, CLOUD_LLM_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b) => (serverOut += String(b)))
  child.stderr?.on('data', (b) => (serverOut += String(b)))
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`cloud server did not start:\n${serverOut}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}, 20_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 200))
  if (path.basename(dir).startsWith(`${TMP_PREFIX}e2e-`) && path.dirname(dir) === path.resolve(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
})

describe('C15 e2e: cloud extraction ↔ real cloud server (mock LLM)', () => {
  it('preview → send 2 selected items → mock ```json → draft with real steps → save cloud_extracted', async () => {
    const store = path.join(dir, 'store')
    const claude = path.join(dir, 'claude')
    writeSession(claude, [
      { user: `Prepare the release checklist, token ${KNOWN_SECRET}`, assistant: 'Drafted RELEASE.md.', write: '/Users/alice/app/RELEASE.md' },
      { user: 'Run the test suite', assistant: 'All tests pass.' },
      { user: 'Tag and publish', assistant: 'Tagged v1.2.0.' }
    ])
    const id = testIdentity()
    const cloud = createCloudService({ storeRoot: store, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true, nativeConfirm: async () => true })
    await cloud.configure({ enabled: true, baseUrl: origin, confirm: true })
    await cloud.signIn()
    const workflows = createWorkflowService({ storeRoot: store, runtimeRoot: () => path.join(dir, 'no-runtime') })
    const svc = createCloudExtractService({
      workflows,
      cloud,
      sessions: createSessionSource({ claudeRoot: claude, codexRoot: null }),
      sources: { claudeCode: true, codex: false },
      knownSecrets: () => [KNOWN_SECRET]
    })
    expect(svc.status()).toMatchObject({ signedIn: true, reason: null })
    const p = svc.preview(svc.sessions().sessions[0].key)
    expect(p.items).toHaveLength(3)
    const r = await svc.run(p.previewId, ['ctx-1', 'ctx-3'])
    // Server mock: one step per sent item (≤3), detail = the item text on one line, cites = [that id].
    expect(r.draft.steps).toHaveLength(2)
    expect(r.draft.steps.map((s) => s.cites)).toEqual([['ctx-1'], ['ctx-3']])
    expect(r.draft.steps[0].detail).toContain('RELEASE.md')
    expect(r.draft.steps[0].detail).not.toContain(KNOWN_SECRET)
    const saved = await svc.save(r.extractionId, r.draft)
    const w = workflows.store.latest(saved.item.id)!
    expect(w.steps).toHaveLength(2)
    expect(w.provenance.extraction).toMatchObject({ source: 'cloud_extracted', sent_ids: ['ctx-1', 'ctx-3'], edited_fields: [] })
    expect(JSON.stringify(w)).not.toContain(KNOWN_SECRET)
  }, 20_000)
})
