// S1-FULL C12–C14 meetings service + IPC against an in-test fake server (helpers.ts auth fake +
// /v1/meetings routes). Temp dirs: mkdtemp `lens-meet-*`, removed with a basename-prefix guard.
// No real microphone, STT key, ~/.persome or Lens Store; the import CLI is a fake exec.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloudPaths, writeCloudConfig } from '../../src/main/cloud/config'
import { createCloudService, type CloudService } from '../../src/main/cloud/service'
import { createMeetingsService, IMPORT_TMP_PREFIX, removeGuarded, type MeetingsDeps, type MeetingsService } from '../../src/main/cloud/meetings'
import { registerMeetingsHandlers } from '../../src/main/cloud/meetings-ipc'
import { MEETINGS_CHANNELS } from '../../src/main/cloud/meetings-api'
import type { ExecFn } from '../../src/main/import/cli'
import { RuntimeError, type RuntimeClient } from '../../src/main/runtime/client'
import type { OwnerDeleteResult } from '../../src/main/runtime/owner-delete'
import { errBody, fakeBox, fakeIpc, LOOPBACK, startFakeServer, testIdentity, type FakeServer } from './helpers'

const PREFIX = 'lens-meet-'
const roots: string[] = []

function meetTemp(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${label}-`))
  roots.push(dir)
  return dir
}

function cleanup(): void {
  for (const d of roots.splice(0)) {
    if (!path.basename(d).startsWith(PREFIX)) throw new Error(`refusing to delete ${d}`)
    if (path.resolve(d) === path.resolve(os.tmpdir())) throw new Error('refusing to delete tmpdir')
    fs.rmSync(d, { recursive: true, force: true })
  }
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

interface MeetingSrv {
  calls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>
  /** seq → body received (utf8; tests only send ASCII). */
  chunks: Map<string, Map<number, { sha: string; body: string }>>
  /** Fail the next N PUTs of a given seq with this status/code. */
  failPut: Map<number, { times: number; status: number; code: string }>
  /** Pretend these seqs are missing at the first finish (forget them). */
  forgetOnFinish: number[]
  statusSeq: Array<'transcribing' | 'ready' | 'failed'>
  transcript: unknown
  createStatus: { status: number; code: string } | null
  deleted: string[]
}

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

function installMeetingRoutes(server: FakeServer): MeetingSrv {
  const st: MeetingSrv = { calls: [], chunks: new Map(), failPut: new Map(), forgetOnFinish: [], statusSeq: [], transcript: null, createStatus: null, deleted: [] }
  let n = 0
  server.override = (req, res, body) => {
    const url = req.url ?? ''
    const method = req.method ?? ''
    if (!url.startsWith('/v1/meetings')) return false
    st.calls.push({ method, url, headers: req.headers, body })
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!bearer || !server.issued.includes(bearer)) return (json(res, 401, errBody('unauthorized', 'x')), true)
    let m: RegExpExecArray | null
    if (method === 'POST' && url === '/v1/meetings') {
      if (st.createStatus) return (json(res, st.createStatus.status, errBody(st.createStatus.code, 'secret body text /Users/x')), true)
      const b = JSON.parse(body) as { consent?: { version?: number; participants_informed?: boolean } }
      if (b.consent?.version !== 1 || b.consent.participants_informed !== true) return (json(res, 400, errBody('consent_required', 'no')), true)
      const id = `m_${++n}`
      st.chunks.set(id, new Map())
      return (json(res, 201, { meeting_id: id, status: 'recording', max_chunks: 240, chunk_max_bytes: 4194304, chunk_max_ms: 35000 }), true)
    }
    if (method === 'PUT' && (m = /^\/v1\/meetings\/([^/]+)\/chunks\/(\d+)$/.exec(url))) {
      const seq = Number(m[2])
      const f = st.failPut.get(seq)
      if (f && f.times > 0) {
        f.times--
        return (json(res, f.status, errBody(f.code, 'x')), true)
      }
      if (!/^audio\/(webm|ogg|wav)/.test(String(req.headers['content-type']))) return (json(res, 400, errBody('bad_type', 'x')), true)
      const got = sha(Buffer.from(body, 'utf8'))
      if (req.headers['x-chunk-sha256'] !== got) return (json(res, 400, errBody('checksum_mismatch', 'x')), true)
      if (!/^\d+$/.test(String(req.headers['x-chunk-duration-ms']))) return (json(res, 400, errBody('bad_duration', 'x')), true)
      const map = st.chunks.get(m[1])!
      const prev = map.get(seq)
      if (prev && prev.sha !== got) return (json(res, 409, errBody('chunk_conflict', 'x')), true)
      map.set(seq, { sha: got, body })
      return (json(res, prev ? 200 : 202, { seq, status: 'queued' }), true)
    }
    if (method === 'POST' && (m = /^\/v1\/meetings\/([^/]+)\/finish$/.exec(url))) {
      const map = st.chunks.get(m[1])!
      for (const s of st.forgetOnFinish.splice(0)) map.delete(s)
      const want = (JSON.parse(body) as { chunks: number }).chunks
      const missing = [...Array(want).keys()].filter((i) => !map.has(i))
      if (missing.length) return (json(res, 409, { error: { code: 'chunks_missing', message: 'x', missing } }), true)
      return (json(res, 202, { status: 'transcribing' }), true)
    }
    if (method === 'GET' && (m = /^\/v1\/meetings\/([^/]+)\/transcript$/.exec(url))) {
      if (st.transcript) return (json(res, 200, { ...(st.transcript as object), meeting_id: m[1] }), true)
      return (json(res, 200, { meeting_id: m[1], language: 'zh', segments: [{ start_ms: 0, end_ms: 1000, speaker: 'A', text: '你好' }], text: '你好' }), true)
    }
    if (method === 'GET' && (m = /^\/v1\/meetings\/([^/]+)$/.exec(url))) {
      const status = st.statusSeq.length > 1 ? st.statusSeq.shift()! : (st.statusSeq[0] ?? 'transcribing')
      return (json(res, 200, { meeting_id: m[1], title: 't', status, created_at: new Date().toISOString(), duration_ms: 61_000, chunks: [], error_code: status === 'failed' ? 'stt_failed' : null }), true)
    }
    if (method === 'GET' && url === '/v1/meetings') {
      return (json(res, 200, { meetings: [...st.chunks.keys()].map((id) => ({ meeting_id: id, title: 't', status: 'transcribing', created_at: '', duration_ms: 0, chunks: [], error_code: null })) }), true)
    }
    if (method === 'DELETE' && (m = /^\/v1\/meetings\/([^/]+)$/.exec(url))) {
      st.deleted.push(m[1])
      res.writeHead(204)
      res.end()
      return true
    }
    return (json(res, 404, errBody('not_found', 'x')), true)
  }
  return st
}

let server: FakeServer
let srv: MeetingSrv
let cloud: CloudService
let store: string
let tmpRoot: string
let confirms: Array<{ message: string; detail: string }>
let answer: boolean
let execCalls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; staged: Record<string, string> }>

const fakeExec: ExecFn = async (file, args, opts) => {
  const dir = args[args.indexOf('--path') + 1]
  const staged: Record<string, string> = {}
  for (const f of fs.readdirSync(dir)) staged[f] = fs.readFileSync(path.join(dir, f), 'utf8')
  execCalls.push({ file, args, env: opts.env, staged })
  return { code: 0, signal: null, stdout: '✓ Imported 1 new/changed document(s); 0 unchanged, 0 skipped.\n', stderr: '' }
}

function make(over: Partial<MeetingsDeps> = {}): MeetingsService {
  return createMeetingsService({
    storeRoot: store,
    cloud,
    nativeConfirm: async (_s, o) => {
      confirms.push(o)
      return answer
    },
    askForMediaAccess: async () => true,
    runtimeRoot: () => path.join(tmpRoot, 'no-runtime'),
    persomeBin: () => '/fake/bin/persome',
    exec: fakeExec,
    tmpRoot,
    timeZone: 'UTC',
    sleep: async () => undefined,
    pollInitialMs: 1,
    pollMaxMs: 1,
    pollMaxAttempts: 20,
    ...over
  })
}

beforeEach(async () => {
  confirms = []
  answer = true
  execCalls = []
  server = await startFakeServer()
  srv = installMeetingRoutes(server)
  const base = meetTemp('store')
  store = path.join(base, 'store')
  tmpRoot = meetTemp('tmp')
  const id = testIdentity()
  writeCloudConfig(cloudPaths(store).configFile, { enabled: true, baseUrl: server.origin }, LOOPBACK)
  cloud = createCloudService({ storeRoot: store, box: fakeBox(), sign: id.sign, getPublicIdentity: id.getPublicIdentity, allowInsecureLoopback: true })
  await cloud.signIn()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await server.close()
  cleanup()
})

const chunkArgs = (meetingId: string, seq: number, text = `chunk-${seq}-data`) => ({ meetingId, seq, mime: 'audio/webm;codecs=opus', durationMs: 30_000, data: bytes(text) })
const mode = (p: string): number => fs.statSync(p).mode & 0o777

async function recorded(svc: MeetingsService, n: number): Promise<string> {
  const { meetingId } = await svc.start({ title: '周会', participantsInformed: true })
  for (let i = 0; i < n; i++) svc.chunk(chunkArgs(meetingId, i))
  return meetingId
}

describe('C12 consent + arming', () => {
  it('start: confirm → mic access → POST with consent → armed; files 0600 / dirs 0700', async () => {
    const ask = vi.fn(async () => true)
    const svc = make({ askForMediaAccess: ask })
    const r = await svc.start({ title: '  周会  ', participantsInformed: true, languageHints: ['zh'] })
    expect(confirms).toHaveLength(1)
    expect(confirms[0].detail).toContain('I have told every participant')
    expect(ask).toHaveBeenCalledWith('microphone')
    const post = srv.calls.find((c) => c.method === 'POST' && c.url === '/v1/meetings')!
    expect(JSON.parse(post.body)).toEqual({ title: '周会', consent: { version: 1, participants_informed: true }, language_hints: ['zh'] })
    expect(svc.micArm.armedFor()).toBe(r.meetingId)
    const dir = path.join(store, 'meetings', r.meetingId)
    expect(mode(dir)).toBe(0o700)
    expect(mode(path.join(dir, 'audio'))).toBe(0o700)
    expect(mode(path.join(dir, 'meeting.json'))).toBe(0o600)
    expect(r.limits).toEqual({ maxChunks: 240, chunkMaxBytes: 4194304, chunkMaxMs: 35000 })
  })

  it('declined confirm / denied mic / no confirm dep ⇒ no request, not armed', async () => {
    answer = false
    await expect(make().start({ title: 't', participantsInformed: true })).rejects.toMatchObject({ code: 'cancelled' })
    answer = true
    await expect(make({ askForMediaAccess: async () => false }).start({ title: 't', participantsInformed: true })).rejects.toMatchObject({ code: 'mic_denied' })
    await expect(make({ nativeConfirm: undefined }).start({ title: 't', participantsInformed: true })).rejects.toMatchObject({ code: 'cancelled' })
    expect(srv.calls).toHaveLength(0)
  })

  it('server errors map to fixed codes without body text', async () => {
    srv.createStatus = { status: 503, code: 'stt_unavailable' }
    const svc = make()
    const e = await svc.start({ title: 't', participantsInformed: true }).catch((x) => x)
    expect(e.code).toBe('stt_unavailable')
    expect(String(e.message)).not.toContain('/Users')
    expect(svc.micArm.isArmed()).toBe(false)
    srv.createStatus = { status: 429, code: 'quota_exceeded' }
    expect(await svc.start({ title: 't', participantsInformed: true }).catch((x) => x.code)).toBe('quota_exceeded')
    srv.createStatus = { status: 400, code: 'consent_required' }
    expect(await svc.start({ title: 't', participantsInformed: true }).catch((x) => x.code)).toBe('consent_required')
  })

  it('chunks are refused without arming (no consent) and after stop', async () => {
    const svc = make()
    expect(() => svc.chunk(chunkArgs('m_404', 0))).toThrow(expect.objectContaining({ code: 'consent_required' }))
    const id = await recorded(svc, 1)
    svc.stop({ meetingId: id, chunks: 1 })
    expect(svc.micArm.isArmed()).toBe(false)
    expect(() => svc.chunk(chunkArgs(id, 1))).toThrow(expect.objectContaining({ code: 'consent_required' }))
    await svc.idle(id)
  })
})

describe('IPC zod validation', () => {
  it('oversize, bad mime, bad seq / duration, missing consent flag, extra fields ⇒ invalid_args', async () => {
    const svc = make()
    const ipc = fakeIpc()
    registerMeetingsHandlers(ipc, svc)
    expect(ipc.channels().sort()).toEqual(Object.values(MEETINGS_CHANNELS).sort())
    const big = new Uint8Array(4 * 1024 * 1024 + 1)
    const bad = [
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), data: big }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), data: new Uint8Array(0) }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), mime: 'video/webm' }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), mime: 'audio/mpeg' }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), seq: 240 }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), durationMs: 35_001 }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), data: 'not bytes' }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('../x', 0) }],
      [MEETINGS_CHANNELS.chunk, { ...chunkArgs('m_1', 0), sha256: 'x' }],
      [MEETINGS_CHANNELS.start, { title: 't' }],
      [MEETINGS_CHANNELS.start, { title: 't', participantsInformed: false }],
      [MEETINGS_CHANNELS.start, { title: 't', participantsInformed: true, consent: true }],
      [MEETINGS_CHANNELS.summarySend, { previewId: 'a'.repeat(32), includeIds: [], text: 'inject' }],
      [MEETINGS_CHANNELS.importToRuntime, { previewId: 'a'.repeat(32), markdown: '# x' }]
    ] as const
    for (const [ch, args] of bad) expect(await ipc.invoke(ch, args), JSON.stringify(Object.keys(args))).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(srv.calls).toHaveLength(0)
    expect(confirms).toHaveLength(0)
    // Valid shape but not armed ⇒ refused by the service.
    expect(await ipc.invoke(MEETINGS_CHANNELS.chunk, chunkArgs('m_1', 0))).toMatchObject({ ok: false, error: { code: 'consent_required' } })
    // The codecs param is normalized.
    const r = (await ipc.invoke(MEETINGS_CHANNELS.start, { title: 'x', participantsInformed: true })) as { ok: true; data: { meetingId: string } }
    expect(await ipc.invoke(MEETINGS_CHANNELS.chunk, { ...chunkArgs(r.data.meetingId, 0), mime: 'audio/webm; codecs=opus' })).toMatchObject({ ok: true })
    await ipc.invoke(MEETINGS_CHANNELS.stop, { meetingId: r.data.meetingId, chunks: 1 })
    await svc.idle(r.data.meetingId)
  })
})

describe('C13 upload queue', () => {
  it('stores 0600 audio, uploads with correct sha256 + duration headers, finishes, polls, stores transcript, deletes audio', async () => {
    srv.statusSeq = ['transcribing', 'transcribing', 'ready']
    const svc = make()
    const id = await recorded(svc, 3)
    const audio = path.join(store, 'meetings', id, 'audio')
    expect(mode(path.join(audio, '0.webm'))).toBe(0o600)
    expect(fs.readFileSync(path.join(audio, '1.webm'), 'utf8')).toBe('chunk-1-data')
    svc.stop({ meetingId: id, chunks: 3 })
    await svc.idle(id)
    const puts = srv.calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(3)
    for (const p of puts) {
      const seq = Number(/chunks\/(\d+)$/.exec(p.url)![1])
      expect(p.headers['x-chunk-sha256']).toBe(sha(`chunk-${seq}-data`))
      expect(p.headers['x-chunk-duration-ms']).toBe('30000')
      expect(p.headers['content-type']).toBe('audio/webm;codecs=opus')
    }
    const finish = srv.calls.filter((c) => c.url.endsWith('/finish'))
    expect(finish.map((c) => JSON.parse(c.body))).toEqual([{ chunks: 3 }])
    // Polling: exactly until ready, then transcript, then stops.
    const gets = srv.calls.filter((c) => c.method === 'GET' && c.url === `/v1/meetings/${id}`)
    expect(gets).toHaveLength(3)
    expect(srv.calls.at(-1)!.url).toBe(`/v1/meetings/${id}/transcript`)
    const tfile = path.join(store, 'meetings', id, 'transcript.json')
    expect(mode(tfile)).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(tfile, 'utf8')).segments[0]).toMatchObject({ text: '你好', speaker: 'A' })
    expect(fs.existsSync(audio)).toBe(false)
    const d = svc.get(id)
    expect(d.meta).toMatchObject({ localStatus: 'ready', serverStatus: 'ready', audioDeleted: true, durationMs: 61_000 })
    expect(d.transcript?.text).toBe('你好')
    const before = srv.calls.length
    await new Promise((r) => setTimeout(r, 20))
    expect(srv.calls.length).toBe(before) // no further polling
  })

  it('out-of-order chunks, retry with backoff on 5xx / network-ish, idempotent re-PUT', async () => {
    srv.statusSeq = ['ready']
    srv.failPut.set(1, { times: 2, status: 503, code: 'server_busy' })
    const sleeps: number[] = []
    const svc = make({ sleep: async (ms) => void sleeps.push(ms), backoffMs: [5, 10, 20] })
    const { meetingId: id } = await svc.start({ title: 't', participantsInformed: true })
    svc.chunk(chunkArgs(id, 2))
    svc.chunk(chunkArgs(id, 0))
    svc.chunk(chunkArgs(id, 1))
    // Re-sending the same seq + bytes is idempotent locally; different bytes conflict.
    expect(svc.chunk(chunkArgs(id, 0))).toEqual({ seq: 0, stored: true })
    expect(() => svc.chunk(chunkArgs(id, 0, 'other-bytes'))).toThrow(expect.objectContaining({ code: 'chunk_conflict' }))
    svc.stop({ meetingId: id, chunks: 3 })
    await svc.idle(id)
    const putsFor1 = srv.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/chunks/1'))
    expect(putsFor1).toHaveLength(3)
    expect(sleeps.slice(0, 2)).toEqual([5, 10])
    const meta = svc.get(id).meta
    expect(meta.chunks.map((c) => c.seq)).toEqual([0, 1, 2])
    expect(meta.chunks.find((c) => c.seq === 1)).toMatchObject({ attempts: 3, error: null, uploaded: true })
    expect(meta.localStatus).toBe('ready')
  })

  it('a non-retryable chunk error is not retried', async () => {
    srv.failPut.set(0, { times: 5, status: 409, code: 'meeting_closed' })
    const svc = make()
    const id = await recorded(svc, 1)
    // Stop polling before ready so we can inspect the upload state.
    svc.stop({ meetingId: id, chunks: 1 })
    await svc.idle(id)
    const puts = srv.calls.filter((c) => c.method === 'PUT')
    // First upload attempt + one per finish round (finish re-enqueues not-uploaded chunks): no backoff loop.
    expect(puts.length).toBeLessThanOrEqual(3)
    expect(svc.get(id).meta.chunks[0].error).toBe('meeting_closed')
  })

  it('finish with chunks_missing ⇒ re-uploads exactly the missing chunks, then finishes', async () => {
    srv.statusSeq = ['ready']
    srv.forgetOnFinish = [0, 2]
    const svc = make()
    const id = await recorded(svc, 3)
    svc.stop({ meetingId: id, chunks: 3 })
    await svc.idle(id)
    const urls = srv.calls.filter((c) => c.method === 'PUT' || c.url.endsWith('/finish')).map((c) => `${c.method} ${c.url.replace(`/v1/meetings/${id}`, '')}`)
    expect(urls.slice(3).sort()).toEqual(['POST /finish', 'POST /finish', 'PUT /chunks/0', 'PUT /chunks/2'].sort())
    expect(urls.at(-1)).toBe('POST /finish')
    expect(svc.get(id).meta.localStatus).toBe('ready')
  })

  it('polling stops on failed, and does not run while cloud is off', async () => {
    srv.statusSeq = ['transcribing', 'failed']
    const svc = make()
    const id = await recorded(svc, 1)
    svc.stop({ meetingId: id, chunks: 1 })
    await svc.idle(id)
    expect(svc.get(id).meta).toMatchObject({ localStatus: 'failed', errorCode: 'stt_failed' })
    expect(srv.calls.filter((c) => c.method === 'GET')).toHaveLength(2)

    // A second meeting stuck in transcribing: turning cloud off stops polling with zero requests.
    srv.statusSeq = ['transcribing']
    const id2 = await recorded(svc, 1)
    svc.stop({ meetingId: id2, chunks: 1 })
    await svc.idle(id2)
    expect(svc.get(id2).meta.localStatus).toBe('transcribing')
    const n = srv.calls.length
    writeCloudConfig(cloudPaths(store).configFile, { enabled: false, baseUrl: server.origin }, LOOPBACK)
    svc.list()
    await svc.idle(id2)
    expect(srv.calls.length).toBe(n)
  })

  it('polling is bounded (max attempts) even if the server never finishes', async () => {
    srv.statusSeq = ['transcribing']
    const svc = make({ pollMaxAttempts: 4 })
    const id = await recorded(svc, 1)
    svc.stop({ meetingId: id, chunks: 1 })
    await svc.idle(id)
    expect(srv.calls.filter((c) => c.method === 'GET' && c.url === `/v1/meetings/${id}`)).toHaveLength(4)
  })

  it('stop with 0 chunks marks no_audio without any upload / finish', async () => {
    const svc = make()
    const id = await recorded(svc, 0)
    expect(svc.stop({ meetingId: id, chunks: 0 })).toMatchObject({ localStatus: 'failed', errorCode: 'no_audio' })
    expect(() => svc.stop({ meetingId: id, chunks: 0 })).not.toThrow()
    expect(srv.calls.filter((c) => c.method !== 'POST' || c.url !== '/v1/meetings')).toHaveLength(0)
  })
})

describe('cloud disabled ⇒ zero fetch', () => {
  it('start / refresh / retry / summary send / delete refuse before any request or dialog', async () => {
    writeCloudConfig(cloudPaths(store).configFile, { enabled: false, baseUrl: server.origin }, LOOPBACK)
    const f = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', f)
    const svc = make()
    expect(await svc.start({ title: 't', participantsInformed: true }).catch((e) => e.code)).toBe('disabled')
    expect(await svc.refresh().catch((e) => e.code)).toBe('disabled')
    expect(svc.list()).toEqual([])
    expect(f).not.toHaveBeenCalled()
    expect(srv.calls).toHaveLength(0)
    expect(confirms).toHaveLength(0)
  })
})

async function readyMeeting(svc: MeetingsService, transcript?: unknown): Promise<string> {
  srv.statusSeq = ['ready']
  if (transcript) srv.transcript = transcript
  const id = await recorded(svc, 1)
  svc.stop({ meetingId: id, chunks: 1 })
  await svc.idle(id)
  expect(svc.get(id).meta.localStatus).toBe('ready')
  return id
}

describe('C14 Markdown → persome import-data', () => {
  it('preview → confirm → temp folder → runner args → temp removed → recorded; refuses a second import', async () => {
    const svc = make()
    const id = await readyMeeting(svc, {
      meeting_id: 'm_1',
      language: 'zh',
      segments: [
        { start_ms: 0, end_ms: 1000, speaker: 'S1', text: '联系 bob@example.com' },
        { start_ms: 61_000, end_ms: 62_000, speaker: 'S2', text: '好的' }
      ],
      text: '…'
    })
    const p = svc.markdownPreview(id)
    expect(p.markdown).toContain('[00:00] S1: 联系 [email]')
    expect(p.markdown).toContain('[01:01] S2: 好的')
    expect(p.redactions).toBeGreaterThan(0)
    const r = await svc.importToRuntime(p.previewId)
    expect(r).toEqual({ ok: true, exitCode: 0, counts: { imported: 1, unchanged: 0, skipped: 0 }, stderr: '' })
    expect(execCalls).toHaveLength(1)
    const c = execCalls[0]
    expect(c.file).toBe('/fake/bin/persome')
    const dir = c.args[4]
    expect(c.args).toEqual(['import-data', '--source', 'folder', '--path', dir, '--no-build'])
    expect(path.dirname(dir)).toBe(path.resolve(tmpRoot))
    expect(path.basename(dir).startsWith(IMPORT_TMP_PREFIX)).toBe(true)
    expect(c.staged).toEqual({ [`meeting-${id}.md`]: p.markdown })
    expect(c.env.PERSOME_ROOT).toBe(path.join(tmpRoot, 'no-runtime'))
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.readdirSync(tmpRoot)).toEqual([])
    expect(confirms.at(-1)!.detail).toContain('Delete from Persome')
    expect(svc.get(id).meta.imported).toMatchObject({ ok: true, fileName: `meeting-${id}.md`, sha256: sha(p.markdown) })
    // Preview is single use; a new preview for an imported meeting is refused at import.
    expect(await svc.importToRuntime(p.previewId).catch((e) => e.code)).toBe('not_found')
    const p2 = svc.markdownPreview(id)
    expect(await svc.importToRuntime(p2.previewId).catch((e) => e.code)).toBe('invalid_args')
    expect(execCalls).toHaveLength(1)
  })

  it('declined confirm ⇒ nothing written / run; CLI failure ⇒ ok:false and temp still removed', async () => {
    const svc = make({
      exec: async (file, args, opts) => {
        await fakeExec(file, args, opts)
        return { code: 1, signal: null, stdout: '', stderr: 'boom at /Users/alice/x token=abc' }
      }
    })
    const id = await readyMeeting(svc)
    answer = false
    expect(await svc.importToRuntime(svc.markdownPreview(id).previewId).catch((e) => e.code)).toBe('cancelled')
    expect(execCalls).toHaveLength(0)
    answer = true
    const r = await svc.importToRuntime(svc.markdownPreview(id).previewId)
    expect(r.ok).toBe(false)
    expect(r.stderr).not.toContain('/Users/alice')
    expect(fs.readdirSync(tmpRoot)).toEqual([])
    expect(svc.get(id).meta.imported?.ok).toBe(false)
  })

  it('no persome CLI ⇒ runtime error before the dialog', async () => {
    const svc = make({ persomeBin: () => null })
    const id = await readyMeeting(svc)
    const n = confirms.length
    expect(await svc.importToRuntime(svc.markdownPreview(id).previewId).catch((e) => e.code)).toBe('runtime')
    expect(confirms.length).toBe(n)
  })

  it('removeGuarded refuses the parent itself, non-children and wrong prefixes', () => {
    const parent = meetTemp('guard')
    const child = fs.mkdtempSync(path.join(parent, IMPORT_TMP_PREFIX))
    const other = fs.mkdtempSync(path.join(parent, 'keep-'))
    const ok = (b: string): boolean => b.startsWith(IMPORT_TMP_PREFIX)
    expect(removeGuarded(parent, parent, ok)).toBe(false)
    expect(removeGuarded(other, parent, ok)).toBe(false)
    expect(removeGuarded(child, path.dirname(parent), ok)).toBe(false)
    expect(fs.existsSync(child) && fs.existsSync(other)).toBe(true)
    expect(removeGuarded(child, parent, ok)).toBe(true)
    expect(fs.existsSync(child)).toBe(false)
  })
})

describe('C14 optional summary', () => {
  function sse(events: Array<[string, unknown]>): string {
    return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  }

  it('preview items are redacted transcript slices (kind recent, ≤ 60000 chars); send streams via chat completions; remember after confirm', async () => {
    const svc = make({ ossTool: async (name, args) => (name === 'remember' && String(args.content).includes('来源：Navalia 会议') ? JSON.stringify({ entry_id: 'mem-42' }) : '{}') })
    const id = await readyMeeting(svc, {
      meeting_id: 'x',
      language: 'zh',
      segments: Array.from({ length: 3000 }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 900, speaker: 'a', text: `第 ${i} 句 ${'内容'.repeat(20)} carol@example.com` })),
      text: '…'
    })
    const p = svc.summaryPreview(id)
    expect(p.items.length).toBeGreaterThan(1)
    expect(p.items.every((i) => i.kind === 'recent' && i.chars <= 8000 && /^ctx-\d+$/.test(i.id))).toBe(true)
    expect(p.totalChars).toBeLessThanOrEqual(60_000)
    expect(p.warnings.join()).toContain('Transcript is too long')
    expect(p.items.map((i) => i.text).join('\n')).not.toContain('carol@example.com')

    let sent: { messages: unknown[]; context: { items: Array<{ id: string; text: string }> }; task: string } | null = null
    const prev = server.override!
    server.override = (req, res, body) => {
      if (req.url === '/v1/chat/completions') {
        sent = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse([['delta', { text: '要点：' }], ['delta', { text: '发布 [ctx-1]' }], ['usage', { prompt_tokens: 1, completion_tokens: 1, model: 'm-x' }], ['done', { finish_reason: 'stop' }]]))
        return true
      }
      return prev(req, res, body)
    }
    const s = await svc.summarySend({ previewId: p.previewId, includeIds: ['ctx-1', 'ctx-2'] })
    expect(s).toMatchObject({ text: '要点：发布 [ctx-1]', status: 'complete', model: 'm-x', rememberedEntryId: null })
    expect(sent!.task).toBe('chat')
    expect(sent!.context.items.map((i) => i.id)).toEqual(['ctx-1', 'ctx-2'])
    expect(sent!.context.items[0].text).toBe(p.items[0].text)
    expect(await svc.summarySend({ previewId: p.previewId, includeIds: ['ctx-1'] }).catch((e) => e.code)).toBe('not_found')

    const r = await svc.rememberSummary(id)
    expect(r).toEqual({ entryId: 'mem-42' })
    expect(confirms.at(-1)!.message).toContain('meeting summary')
    expect(svc.get(id).meta.summary?.rememberedEntryId).toBe('mem-42')
    expect(await svc.rememberSummary(id).catch((e) => e.code)).toBe('invalid_args')
  })
})

describe('delete', () => {
  it('server DELETE + local folder removed; honest note about what stays in the Runtime', async () => {
    const svc = make()
    const id = await readyMeeting(svc)
    await svc.importToRuntime(svc.markdownPreview(id).previewId)
    const dir = path.join(store, 'meetings', id)
    expect(fs.existsSync(dir)).toBe(true)
    const r = await svc.delete({ meetingId: id })
    expect(srv.deleted).toEqual([id])
    expect(r).toMatchObject({ serverDeleted: true, localDeleted: true, runtimeRemains: true })
    expect(r.runtimeNote).toContain(`Imported folder note: meeting-${id}.md`)
    expect(confirms.at(-1)!.detail).toContain('is not deleted')
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(path.join(store, 'meetings'))).toBe(true)
    expect(svc.list()).toEqual([])
  })

  it('declined ⇒ nothing deleted; localOnly works while cloud is off (zero requests)', async () => {
    const svc = make()
    const id = await recorded(svc, 1)
    svc.stop({ meetingId: id, chunks: 1 })
    await svc.idle(id)
    answer = false
    expect(await svc.delete({ meetingId: id }).catch((e) => e.code)).toBe('cancelled')
    expect(srv.deleted).toEqual([])
    answer = true
    writeCloudConfig(cloudPaths(store).configFile, { enabled: false, baseUrl: server.origin }, LOOPBACK)
    expect(await svc.delete({ meetingId: id }).catch((e) => e.code)).toBe('disabled')
    const n = srv.calls.length
    const r = await svc.delete({ meetingId: id, localOnly: true })
    expect(r).toMatchObject({ serverDeleted: false, localDeleted: true, runtimeRemains: false, runtimeNote: null })
    expect(srv.calls.length).toBe(n)
    expect(fs.existsSync(path.join(store, 'meetings', id))).toBe(false)
  })

  it('deleting while recording disarms the mic gate and drops later chunks', async () => {
    const svc = make()
    const id = await recorded(svc, 1)
    await svc.delete({ meetingId: id })
    expect(svc.micArm.isArmed()).toBe(false)
    expect(() => svc.chunk(chunkArgs(id, 1))).toThrow(expect.objectContaining({ code: 'consent_required' }))
    await svc.idle(id)
    expect(fs.existsSync(path.join(store, 'meetings', id))).toBe(false)
  })
})

describe('real-server behaviours (C13 server as finished)', () => {
  function wrap(fn: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => boolean): void {
    const prev = server.override!
    server.override = (req, res, body) => fn(req, res, body) || prev(req, res, body)
  }

  it('finish → 409 chunks_mismatch ⇒ failed, no retry loop', async () => {
    let finishes = 0
    wrap((req, res) => (req.url?.endsWith('/finish') ? (finishes++, json(res, 409, errBody('chunks_mismatch', 'x')), true) : false))
    const svc = make()
    const id = await recorded(svc, 2)
    svc.stop({ meetingId: id, chunks: 2 })
    await svc.idle(id)
    expect(svc.get(id).meta).toMatchObject({ localStatus: 'failed', errorCode: 'chunks_mismatch' })
    expect(finishes).toBe(1)
  })

  it('idempotent finish returning ready ⇒ transcript fetched via the next status GET', async () => {
    wrap((req, res) => (req.url?.endsWith('/finish') ? (json(res, 202, { status: 'ready' }), true) : false))
    srv.statusSeq = ['ready']
    const svc = make()
    const id = await recorded(svc, 1)
    svc.stop({ meetingId: id, chunks: 1 })
    await svc.idle(id)
    expect(svc.get(id).meta.localStatus).toBe('ready')
    expect(svc.get(id).transcript?.text).toBe('你好')
  })

  it('server failure (any failed chunk) ⇒ failed with the server error_code, no transcript request', async () => {
    srv.statusSeq = ['failed']
    const svc = make()
    const id = await recorded(svc, 1)
    svc.stop({ meetingId: id, chunks: 1 })
    await svc.idle(id)
    expect(svc.get(id).meta).toMatchObject({ localStatus: 'failed', errorCode: 'stt_failed' })
    expect(srv.calls.some((c) => c.url.endsWith('/transcript'))).toBe(false)
  })

  it('404 on status (retention expiry) ⇒ expired + serverGone; DELETE 404 = success', async () => {
    const svc = make()
    const id = await recorded(svc, 1)
    wrap((req, res) => (req.method === 'GET' && req.url === `/v1/meetings/${id}` ? (json(res, 404, errBody('not_found', 'x')), true) : false))
    svc.stop({ meetingId: id, chunks: 1 })
    await svc.idle(id)
    expect(svc.get(id).meta).toMatchObject({ localStatus: 'failed', errorCode: 'expired', serverGone: true, serverStatus: null })

    const id2 = await readyMeeting(svc)
    wrap((req, res) => (req.url?.startsWith(`/v1/meetings/${id2}`) ? (json(res, 404, errBody('not_found', 'x')), true) : false))
    const r = await svc.delete({ meetingId: id2 })
    expect(r).toMatchObject({ serverDeleted: true, localDeleted: true })
  })
})

describe('R10 delete from Runtime (per-item)', () => {
  const res = (kind: OwnerDeleteResult['kind'], o: Partial<OwnerDeleteResult> = {}): OwnerDeleteResult => ({
    kind,
    deleted: {},
    deleted_ids: [],
    already_deleted: [],
    missing: [],
    refused: [],
    ...o
  })
  function fakeRuntime(over: Partial<Pick<RuntimeClient, 'deleteImports' | 'deleteMemoryEntries'>> = {}) {
    const calls: Array<[string, unknown[]]> = []
    const client = {
      deleteImports: async (by: string, ids: string[]) => {
        calls.push(['imports', [by, ids]])
        return over.deleteImports ? over.deleteImports(by as 'content_sha256', ids) : res('import', { deleted_ids: ids, deleted: { sources: 1, sessions: 1, timeline_blocks: 1 }, modeled_sessions: 0 })
      },
      deleteMemoryEntries: async (ids: string[]) => {
        calls.push(['memory', [ids]])
        return over.deleteMemoryEntries ? over.deleteMemoryEntries(ids) : res('memory_entry', { deleted_ids: ids, deleted: { entries: 1 } })
      }
    } as unknown as RuntimeClient
    return { client, calls }
  }

  async function importedMeeting(svc: MeetingsService): Promise<{ id: string; markdown: string }> {
    const id = await readyMeeting(svc)
    const p = svc.markdownPreview(id)
    await svc.importToRuntime(p.previewId)
    return { id, markdown: p.markdown }
  }

  it('native confirm → /imports/delete by content_sha256 → recorded; re-import allowed; delete note no longer claims it stays', async () => {
    const rt = fakeRuntime()
    const svc = make({ runtime: () => rt.client })
    const { id, markdown } = await importedMeeting(svc)
    const before = confirms.length
    const r = await svc.deleteFromRuntime(id)
    expect(confirms.length).toBe(before + 1)
    expect(confirms.at(-1)!.message).toContain('Delete what this meeting wrote to Persome')
    expect(confirms.at(-1)!.detail).toContain('are not deleted')
    expect(rt.calls).toEqual([['imports', ['content_sha256', [sha(markdown)]]]])
    expect(r).toEqual({ import: { status: 'deleted', timelineBlocks: 1, sessions: 1, modeledSessions: 0 }, summary: { status: 'none', reason: null }, note: null })
    const meta = svc.get(id).meta
    expect(meta.imported?.runtimeDeletedAt).toEqual(expect.any(String))
    // Nothing left to delete → refused before any dialog / request.
    expect(await svc.deleteFromRuntime(id).catch((e) => e.code)).toBe('invalid_args')
    expect(rt.calls).toHaveLength(1)
    // Re-import is allowed again after a Runtime delete.
    const again = await svc.importToRuntime(svc.markdownPreview(id).previewId)
    expect(again.ok).toBe(true)
    const del = await svc.delete({ meetingId: id, localOnly: true })
    expect(del.runtimeNote ?? '').toContain('Imported folder note')
  })

  it('declined confirm ⇒ zero Runtime calls; no runtime dep ⇒ runtime error before the dialog', async () => {
    const rt = fakeRuntime()
    const svc = make({ runtime: () => rt.client })
    const { id } = await importedMeeting(svc)
    answer = false
    expect(await svc.deleteFromRuntime(id).catch((e) => e.code)).toBe('cancelled')
    expect(rt.calls).toHaveLength(0)
    expect(svc.get(id).meta.imported?.runtimeDeletedAt ?? null).toBeNull()
    answer = true
    const n = confirms.length
    const noDep = make()
    expect(await noDep.deleteFromRuntime(id).catch((e) => e.code)).toBe('runtime')
    expect(confirms.length).toBe(n)
  })

  it('remembered summary is erased too; refusal and modeled sessions are reported honestly', async () => {
    const rt = fakeRuntime({
      deleteImports: async (_by, ids) => res('import', { deleted_ids: ids, deleted: { sources: 1, sessions: 2, timeline_blocks: 2 }, modeled_sessions: 2 }),
      deleteMemoryEntries: async (ids) => res('memory_entry', { refused: ids.map((id) => ({ id, reason: 'not_agent_written' })) })
    })
    const svc = make({ runtime: () => rt.client, ossTool: async () => JSON.stringify({ entry_id: 'mem-7' }) })
    const { id } = await importedMeeting(svc)
    const meetingFile = path.join(store, 'meetings', id, 'meeting.json')
    const meta = JSON.parse(fs.readFileSync(meetingFile, 'utf8'))
    meta.summary = { text: 's', at: new Date().toISOString(), status: 'complete', model: null, rememberedEntryId: 'mem-7' }
    fs.writeFileSync(meetingFile, JSON.stringify(meta))
    const r = await svc.deleteFromRuntime(id)
    expect(rt.calls.map((c) => c[0])).toEqual(['imports', 'memory'])
    expect(r.import).toMatchObject({ status: 'deleted', modeledSessions: 2 })
    expect(r.summary.status).toBe('refused')
    expect(r.note).toContain('derived memories are not deleted')
    expect(r.note).toContain('Meeting summary was not deleted')
    expect(svc.get(id).meta.summary?.rememberedEntryId).toBe('mem-7')
  })

  it('Runtime without the R10 route ⇒ runtime error, nothing recorded as deleted', async () => {
    const rt = fakeRuntime({
      deleteImports: async () => {
        throw new RuntimeError('not_found', 'Runtime 还不支持按条删除（需要 R10 或更新的 Runtime）', 404, 'endpoint_missing')
      }
    })
    const svc = make({ runtime: () => rt.client })
    const { id } = await importedMeeting(svc)
    const err = await svc.deleteFromRuntime(id).catch((e) => e)
    expect(err).toMatchObject({ code: 'runtime' })
    expect(String(err.message)).toContain('R10')
    expect(svc.get(id).meta.imported?.runtimeDeletedAt ?? null).toBeNull()
  })

  it('IPC: deleteFromRuntime takes only a meeting id', async () => {
    const svc = make({ runtime: () => fakeRuntime().client })
    const ipc = fakeIpc()
    registerMeetingsHandlers(ipc, svc)
    expect(await ipc.invoke(MEETINGS_CHANNELS.deleteFromRuntime, { meetingId: 'm_1', sha256: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await ipc.invoke(MEETINGS_CHANNELS.deleteFromRuntime, { meetingId: '../x' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(confirms).toHaveLength(0)
  })
})
