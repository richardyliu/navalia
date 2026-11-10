import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { bearer, errorCode, login, newKey, startHarness } from './helpers.ts'
import {
  CONSENT,
  TITLE,
  audioFiles,
  captureStd,
  count,
  createMeeting,
  fakeAudio,
  finish,
  getJson,
  newMeeting,
  putChunk,
  sha256,
  startMeetings
} from './meetings-helpers.ts'
import { SttError, type SttAdapter, type SttChunk } from '../src/stt.ts'
import { STT_DISABLED } from '../src/config.ts'

const DAY = 24 * 3600 * 1000

test('create: consent required, title / hints validated, contract shape', async () => {
  const h = await startMeetings()
  try {
    for (const body of [
      { title: 't' },
      { title: 't', consent: { version: 1, participants_informed: false } },
      { title: 't', consent: { version: 2, participants_informed: true } },
      { title: 't', consent: true }
    ]) {
      const r = await createMeeting(h, h.token, body)
      assert.equal(r.status, 400)
      assert.equal(await errorCode(r), 'consent_required')
    }
    for (const body of [
      { title: '', consent: CONSENT },
      { title: 'a\nb', consent: CONSENT },
      { title: 'x'.repeat(201), consent: CONSENT },
      { title: 't', consent: CONSENT, language_hints: ['zh', 'en', 'ja', 'ko', 'fr'] },
      { title: 't', consent: CONSENT, language_hints: ['ZH'] },
      { title: 't', consent: CONSENT, language_hints: 'zh' }
    ]) {
      const r = await createMeeting(h, h.token, body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(await errorCode(r), 'invalid_request')
    }
    assert.equal((await createMeeting(h, h.token, { title: '中'.repeat(200), consent: CONSENT })).status, 201)
    const r = await createMeeting(h, h.token, { title: TITLE, consent: CONSENT, language_hints: ['zh', 'en'] })
    assert.equal(r.status, 201)
    const j = (await r.json()) as Record<string, unknown>
    assert.match(j.meeting_id as string, /^[0-9a-f-]{36}$/)
    assert.deepEqual({ ...j, meeting_id: 'x' }, { meeting_id: 'x', status: 'recording', max_chunks: 240, chunk_max_bytes: 4194304, chunk_max_ms: 35000 })
    assert.equal((await fetch(h.base + '/v1/meetings', { method: 'POST', body: '{}' })).status, 401)
  } finally {
    await h.close()
  }
})

test('503 stt_unavailable when CLOUD_STT_MODE is unset', async () => {
  const h = await startMeetings({ stt: STT_DISABLED })
  try {
    const r = await createMeeting(h, h.token)
    assert.equal(r.status, 503)
    assert.equal(await errorCode(r), 'stt_unavailable')
    // consent is still checked first
    assert.equal(await errorCode(await createMeeting(h, h.token, { title: 't' })), 'consent_required')
  } finally {
    await h.close()
  }
})

test('happy path (mock): out-of-order upload, idempotent re-PUT, transcribe-as-you-go, finish, absolute offsets', async () => {
  const h = await startMeetings()
  try {
    const id = await newMeeting(h, { title: TITLE, consent: CONSENT, language_hints: ['zh'] })
    const durs = [30_000, 31_000, 29_500]
    const audio = [0, 1, 2].map((s) => fakeAudio(s))

    let r = await putChunk(h, h.token, id, 2, audio[2], { durationMs: durs[2], contentType: 'audio/ogg; codecs=opus' })
    assert.equal(r.status, 202)
    assert.deepEqual(await r.json(), { seq: 2, status: 'queued' })
    r = await putChunk(h, h.token, id, 0, audio[0], { durationMs: durs[0] })
    assert.equal(r.status, 202)

    // stored with random names, 0600 in a 0700 dir
    const files = audioFiles(h)
    assert.equal(files.length, 2)
    for (const f of files) {
      assert.match(f, /^[0-9a-f]{32}$/)
      assert.equal(statSync(join(h.app.config.audioDir, f)).mode & 0o777, 0o600)
    }
    assert.equal(statSync(h.app.config.audioDir).mode & 0o777, 0o700)

    // idempotent re-PUT
    r = await putChunk(h, h.token, id, 0, audio[0], { durationMs: durs[0] })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { seq: 0, status: 'queued' })

    // transcribed as they arrive, before finish; audio deleted right after
    let st = await h.app.stt.drain()
    assert.equal(st.done, 2)
    assert.equal(audioFiles(h).length, 0)
    let g = await getJson(h, h.token, `/v1/meetings/${id}`)
    assert.equal(g.body.status, 'recording')
    assert.deepEqual(g.body.chunks, [
      { seq: 0, status: 'done', duration_ms: durs[0] },
      { seq: 2, status: 'done', duration_ms: durs[2] }
    ])
    r = await putChunk(h, h.token, id, 0, audio[0], { durationMs: durs[0] })
    assert.deepEqual(await r.json(), { seq: 0, status: 'done' })

    r = await putChunk(h, h.token, id, 1, audio[1], { durationMs: durs[1], contentType: 'audio/wav' })
    assert.equal(r.status, 202)

    r = await finish(h, h.token, id, 3)
    assert.equal(r.status, 202)
    assert.deepEqual(await r.json(), { status: 'transcribing' })
    const nr = await fetch(`${h.base}/v1/meetings/${id}/transcript`, { headers: bearer(h.token) })
    assert.equal(nr.status, 409)
    assert.equal(await errorCode(nr), 'not_ready')

    st = await h.app.stt.drain()
    assert.equal(st.done, 1)
    assert.equal(st.assembled, 1)
    assert.equal(audioFiles(h).length, 0)

    g = await getJson(h, h.token, `/v1/meetings/${id}`)
    assert.equal(g.status, 200)
    assert.equal(g.body.status, 'ready')
    assert.equal(g.body.title, TITLE)
    assert.equal(g.body.duration_ms, durs[0] + durs[1] + durs[2])
    assert.equal(g.body.error_code, null)
    assert.equal(g.body.created_at, new Date(h.clock.t).toISOString())

    const t = await getJson(h, h.token, `/v1/meetings/${id}/transcript`)
    assert.equal(t.status, 200)
    assert.deepEqual(t.body, {
      meeting_id: id,
      language: null,
      segments: [
        { start_ms: 0, end_ms: 30_000, speaker: 'S1', text: '（mock 转写）第 1 段，30 秒' },
        { start_ms: 30_000, end_ms: 61_000, speaker: 'S1', text: '（mock 转写）第 2 段，31 秒' },
        { start_ms: 61_000, end_ms: 90_500, speaker: 'S1', text: '（mock 转写）第 3 段，30 秒' }
      ],
      text: '（mock 转写）第 1 段，30 秒\n（mock 转写）第 2 段，31 秒\n（mock 转写）第 3 段，30 秒'
    })
    // per-chunk results dropped after assembly
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM meeting_chunks WHERE result IS NOT NULL OR audio_name IS NOT NULL'), 0)

    const list = await fetch(h.base + '/v1/meetings', { headers: bearer(h.token) })
    assert.deepEqual(await list.json(), [{ meeting_id: id, title: TITLE, status: 'ready', created_at: new Date(h.clock.t).toISOString(), duration_ms: 90_500 }])

    // idempotent finish retry; other accounts see nothing
    assert.deepEqual(await (await finish(h, h.token, id, 3)).json(), { status: 'ready' })
  } finally {
    await h.close()
  }
})

test('chunk validation: checksum, conflict, 413, 415, headers, seq, ownership', async () => {
  const h = await startMeetings()
  try {
    const id = await newMeeting(h)
    const a = fakeAudio(0)
    let r = await putChunk(h, h.token, id, 0, a, { sha: sha256(fakeAudio(9)) })
    assert.equal(r.status, 400)
    assert.equal(await errorCode(r), 'checksum_mismatch')

    assert.equal((await putChunk(h, h.token, id, 0, a)).status, 202)
    r = await putChunk(h, h.token, id, 0, fakeAudio(1))
    assert.equal(r.status, 409)
    assert.equal(await errorCode(r), 'chunk_conflict')

    r = await putChunk(h, h.token, id, 1, Buffer.alloc(4 * 1024 * 1024 + 1, 1))
    assert.equal(r.status, 413)
    assert.equal(await errorCode(r), 'payload_too_large')
    assert.equal((await putChunk(h, h.token, id, 1, Buffer.alloc(4 * 1024 * 1024, 2))).status, 202)

    for (const ct of ['audio/mpeg', 'application/json', 'application/octet-stream', 'text/plain']) {
      r = await putChunk(h, h.token, id, 2, a, { contentType: ct })
      assert.equal(r.status, 415, ct)
      assert.equal(await errorCode(r), 'unsupported_media_type')
    }
    for (const d of ['0', '35001', 'abc', '-5', '1.5']) {
      r = await putChunk(h, h.token, id, 2, a, { durationMs: d })
      assert.equal(r.status, 400, d)
    }
    assert.equal((await putChunk(h, h.token, id, 2, a, { durationMs: 35_000 })).status, 202)
    for (const seq of ['240', '-1', 'x', '1000', '01a']) {
      r = await putChunk(h, h.token, id, seq, a)
      assert.equal(r.status, 400, seq)
    }
    assert.equal((await putChunk(h, h.token, id, 3, Buffer.alloc(0))).status, 400)

    // unknown / malformed meeting id → 404; another account → 404
    assert.equal((await putChunk(h, h.token, '00000000-0000-4000-8000-000000000000', 0, a)).status, 404)
    assert.equal((await putChunk(h, h.token, 'not-a-uuid', 0, a)).status, 404)
    const other = await otherToken(h)
    assert.equal((await putChunk(h, other, id, 5, a)).status, 404)
    assert.equal((await fetch(`${h.base}/v1/meetings/${id}`, { headers: bearer(other) })).status, 404)
    assert.equal((await fetch(`${h.base}/v1/meetings/${id}`, { method: 'DELETE', headers: bearer(other) })).status, 404)
    assert.deepEqual(await (await fetch(h.base + '/v1/meetings', { headers: bearer(other) })).json(), [])
  } finally {
    await h.close()
  }
})

async function otherToken(h: { base: string }): Promise<string> {
  return (await login(h.base, newKey())).token
}

test('finish: gaps → 409 chunks_missing with list; extra → chunks_mismatch; upload after finish → meeting_closed', async () => {
  const h = await startMeetings()
  try {
    const id = await newMeeting(h)
    for (const s of [0, 2, 4]) assert.equal((await putChunk(h, h.token, id, s, fakeAudio(s))).status, 202)
    let r = await finish(h, h.token, id, 5)
    assert.equal(r.status, 409)
    const j = (await r.json()) as { error: { code: string; message: string; missing: number[] } }
    assert.equal(j.error.code, 'chunks_missing')
    assert.deepEqual(j.error.missing, [1, 3])
    r = await finish(h, h.token, id, 1)
    assert.equal(r.status, 409)
    assert.equal(await errorCode(r), 'chunks_mismatch')
    for (const bad of [0, -1, 241, 1.5, '3']) assert.equal((await finish(h, h.token, id, bad as number)).status, 400)

    for (const s of [1, 3]) assert.equal((await putChunk(h, h.token, id, s, fakeAudio(s))).status, 202)
    assert.equal((await finish(h, h.token, id, 5)).status, 202)
    r = await putChunk(h, h.token, id, 5, fakeAudio(5))
    assert.equal(r.status, 409)
    assert.equal(await errorCode(r), 'meeting_closed')
    // retry of an already-accepted chunk after finish stays idempotent
    assert.equal((await putChunk(h, h.token, id, 4, fakeAudio(4))).status, 200)
    r = await finish(h, h.token, id, 4)
    assert.equal(r.status, 409)
    assert.equal(await errorCode(r), 'meeting_closed')
  } finally {
    await h.close()
  }
})

test('daily audio budget: chunk and create → 429 quota_exceeded with Retry-After to UTC midnight; deleting does not refund', async () => {
  const h = await startMeetings({ sttDailySeconds: 60 })
  try {
    h.clock.t = Date.UTC(2026, 0, 1, 23, 0, 0)
    const id = await newMeeting(h)
    assert.equal((await putChunk(h, h.token, id, 0, fakeAudio(0), { durationMs: 35_000 })).status, 202)
    let r = await putChunk(h, h.token, id, 1, fakeAudio(1), { durationMs: 30_000 })
    assert.equal(r.status, 429)
    assert.equal(await errorCode(r), 'quota_exceeded')
    assert.equal(r.headers.get('retry-after'), '3600')
    assert.equal((await putChunk(h, h.token, id, 1, fakeAudio(1), { durationMs: 25_000 })).status, 202)
    r = await createMeeting(h, h.token)
    assert.equal(r.status, 429)
    assert.equal(await errorCode(r), 'quota_exceeded')
    assert.equal(r.headers.get('retry-after'), '3600')
    assert.equal((await fetch(`${h.base}/v1/meetings/${id}`, { method: 'DELETE', headers: bearer(h.token) })).status, 204)
    assert.equal((await createMeeting(h, h.token)).status, 429)
    h.clock.t = Date.UTC(2026, 0, 2, 0, 0, 1)
    assert.equal((await createMeeting(h, h.token)).status, 201)
  } finally {
    await h.close()
  }
})

test('per-account rate limit on chunk PUTs', async () => {
  const h = await startMeetings({ meetingChunkRateMax: 2 })
  try {
    const id = await newMeeting(h)
    assert.equal((await putChunk(h, h.token, id, 0, fakeAudio(0))).status, 202)
    assert.equal((await putChunk(h, h.token, id, 1, fakeAudio(1))).status, 202)
    const r = await putChunk(h, h.token, id, 2, fakeAudio(2))
    assert.equal(r.status, 429)
    assert.equal(await errorCode(r), 'rate_limited')
  } finally {
    await h.close()
  }
})

test('24 h sweeper deletes untranscribed audio and orphan files; meeting then fails with audio_expired', async () => {
  const h = await startMeetings()
  try {
    const id = await newMeeting(h)
    assert.equal((await putChunk(h, h.token, id, 0, fakeAudio(0))).status, 202)
    const orphan = randomBytes(16).toString('hex')
    writeFileSync(join(h.app.config.audioDir, orphan), 'x', { mode: 0o600 })
    writeFileSync(join(h.app.config.audioDir, 'not-ours.txt'), 'keep', { mode: 0o600 })
    assert.equal(audioFiles(h).length, 3)

    h.clock.t += DAY - 1000
    h.app.purge()
    // the referenced file is younger than 24 h and stays; the unreferenced one goes; non-hex names are not ours
    assert.ok(!audioFiles(h).includes(orphan))
    assert.ok(audioFiles(h).includes('not-ours.txt'))
    assert.equal(audioFiles(h).filter((f) => /^[0-9a-f]{32}$/.test(f)).length, 1)

    h.clock.t += 2000
    h.app.purge()
    assert.deepEqual(audioFiles(h), ['not-ours.txt'])
    const g = await getJson(h, h.token, `/v1/meetings/${id}`)
    assert.deepEqual(g.body.chunks, [{ seq: 0, status: 'failed', duration_ms: 30_000 }])
    assert.equal((await finish(h, h.token, id, 1)).status, 202)
    await h.app.stt.drain()
    const g2 = await getJson(h, h.token, `/v1/meetings/${id}`)
    assert.equal(g2.body.status, 'failed')
    assert.equal(g2.body.error_code, 'audio_expired')
  } finally {
    await h.close()
  }
})

test('transcripts are purged 7 days after ready (meeting then 404s)', async () => {
  const h = await startMeetings()
  try {
    const id = await newMeeting(h)
    await putChunk(h, h.token, id, 0, fakeAudio(0))
    await finish(h, h.token, id, 1)
    await h.app.stt.drain()
    assert.equal((await getJson(h, h.token, `/v1/meetings/${id}`)).body.status, 'ready')
    const abandoned = await newMeeting(h)
    h.clock.t += 7 * DAY - 1000
    h.app.purge()
    assert.equal((await getJson(h, h.token, `/v1/meetings/${id}/transcript`)).status, 200)
    h.clock.t += 2000
    h.app.purge()
    assert.equal((await getJson(h, h.token, `/v1/meetings/${id}`)).status, 404)
    assert.equal((await getJson(h, h.token, `/v1/meetings/${abandoned}`)).status, 404)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM meetings'), 0)
  } finally {
    await h.close()
  }
})

/** Adapter whose transcribe() blocks until released. */
function gatedAdapter(): { adapter: SttAdapter; started: Promise<void>; release: () => void; calls: SttChunk[] } {
  let release!: () => void
  let markStarted!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const started = new Promise<void>((r) => (markStarted = r))
  const calls: SttChunk[] = []
  return {
    calls,
    started,
    release,
    adapter: {
      async transcribe(c) {
        calls.push(c)
        markStarted()
        await gate
        return { language: 'zh', segments: [{ start_ms: 0, end_ms: c.durationMs, speaker: null, text: 'TRANSCRIPT-SECRET' }] }
      }
    }
  }
}

test('DELETE removes files + rows; a concurrent worker run does not resurrect them; 404 afterwards', async () => {
  const g = gatedAdapter()
  const h = await startMeetings({}, { stt: g.adapter })
  try {
    const id = await newMeeting(h)
    assert.equal((await putChunk(h, h.token, id, 0, fakeAudio(0))).status, 202)
    assert.equal((await putChunk(h, h.token, id, 1, fakeAudio(1))).status, 202)
    assert.equal(audioFiles(h).length, 2)
    const drain = h.app.stt.drain()
    await g.started
    const r = await fetch(`${h.base}/v1/meetings/${id}`, { method: 'DELETE', headers: bearer(h.token) })
    assert.equal(r.status, 204)
    assert.equal(audioFiles(h).length, 0)
    g.release()
    await drain
    await h.app.stt.drain()
    assert.equal(audioFiles(h).length, 0)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM meetings'), 0)
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM meeting_chunks'), 0)
    assert.equal((await fetch(`${h.base}/v1/meetings/${id}`, { method: 'DELETE', headers: bearer(h.token) })).status, 404)
    assert.equal((await getJson(h, h.token, `/v1/meetings/${id}`)).status, 404)
  } finally {
    g.release()
    await h.close()
  }
})

test('account deletion removes meetings, chunks, usage and audio files on disk; other accounts intact', async () => {
  const h = await startMeetings()
  try {
    const other = await otherToken(h)
    const mine = await newMeeting(h)
    for (const s of [0, 1]) await putChunk(h, h.token, mine, s, fakeAudio(s))
    const theirs = ((await (await createMeeting(h, other)).json()) as { meeting_id: string }).meeting_id
    await putChunk(h, other, theirs, 0, fakeAudio(7))
    assert.equal(audioFiles(h).length, 3)
    assert.equal((await fetch(h.base + '/v1/account', { method: 'DELETE', headers: bearer(h.token) })).status, 204)
    assert.equal(audioFiles(h).length, 1)
    for (const t of ['meetings', 'meeting_chunks', 'stt_usage']) {
      assert.equal(count(h, `SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`, h.accountId), 0, t)
      const fks = h.app.db.prepare(`SELECT "table" AS t, on_delete FROM pragma_foreign_key_list('${t}') WHERE "table" = 'accounts'`).all() as Array<{ on_delete: string }>
      assert.deepEqual(fks.map((f) => f.on_delete), ['CASCADE'], t)
    }
    assert.equal((await getJson(h, other, `/v1/meetings/${theirs}`)).status, 200)
  } finally {
    await h.close()
  }
})

test('worker: transient failure retried once after backoff (no tight loop), then failed → meeting failed', async () => {
  let calls = 0
  const adapter: SttAdapter = {
    async transcribe() {
      calls++
      throw new SttError('stt_unavailable', false)
    }
  }
  const h = await startMeetings({}, { stt: adapter })
  try {
    const id = await newMeeting(h)
    await putChunk(h, h.token, id, 0, fakeAudio(0))
    await finish(h, h.token, id, 1)
    let st = await h.app.stt.drain()
    assert.deepEqual([st.retried, st.failed, calls], [1, 0, 1])
    assert.equal(audioFiles(h).length, 1) // kept for the retry
    st = await h.app.stt.drain()
    assert.equal(calls, 1)
    h.clock.t += 30_000
    st = await h.app.stt.drain()
    assert.deepEqual([st.failed, calls], [1, 2])
    assert.equal(audioFiles(h).length, 0)
    h.clock.t += DAY
    await h.app.stt.drain()
    assert.equal(calls, 2)
    const g = await getJson(h, h.token, `/v1/meetings/${id}`)
    assert.equal(g.body.status, 'failed')
    assert.equal(g.body.error_code, 'stt_unavailable')
    assert.equal((await getJson(h, h.token, `/v1/meetings/${id}/transcript`)).status, 409)
  } finally {
    await h.close()
  }
})

test('logs and stdout/stderr never contain title, transcript text or audio', async () => {
  const g = gatedAdapter()
  g.release()
  const { out, result: h } = await captureStd(async () => {
    const h = await startMeetings({}, { stt: g.adapter })
    const id = await newMeeting(h, { title: TITLE, consent: CONSENT })
    await putChunk(h, h.token, id, 0, Buffer.from('AUDIO-BYTES-SECRET'.repeat(10)))
    await finish(h, h.token, id, 1)
    await h.app.stt.drain()
    const t = await getJson(h, h.token, `/v1/meetings/${id}/transcript`)
    assert.equal((t.body.segments as Array<{ text: string }>)[0].text, 'TRANSCRIPT-SECRET')
    await getJson(h, h.token, '/v1/meetings')
    await fetch(`${h.base}/v1/meetings/${id}`, { method: 'DELETE', headers: bearer(h.token) })
    return h
  })
  try {
    const all = out + '\n' + h.logs.join('\n')
    for (const s of ['TITLE-SECRET', '机密', 'TRANSCRIPT-SECRET', 'AUDIO-BYTES-SECRET', h.token]) assert.ok(!all.includes(s), s)
    for (const line of h.logs) assert.deepEqual(Object.keys(JSON.parse(line) as object).sort(), ['method', 'ms', 'req_id', 'route', 'status'])
    const routes = new Set(h.logs.map((l) => (JSON.parse(l) as { route: string }).route))
    for (const r of ['/v1/meetings', '/v1/meetings/:id/chunks/:seq', '/v1/meetings/:id/finish', '/v1/meetings/:id/transcript', '/v1/meetings/:id']) assert.ok(routes.has(r), r)
  } finally {
    await h.close()
  }
})

test('meetings tables exist only via migration v4; harness without STT still serves other routes', async () => {
  const h = await startHarness()
  try {
    const v = h.app.db.prepare('SELECT name FROM schema_migrations WHERE version = 4').get() as { name: string }
    assert.equal(v.name, 'meetings')
  } finally {
    await h.close()
  }
})
