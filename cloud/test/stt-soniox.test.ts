// Soniox adapter against an in-test fake HTTP server modelled on docs.soniox.com (read 2026-11-05).
// No network beyond 127.0.0.1; the key is a fake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearer } from './helpers.ts'
import {
  SONIOX_KEY,
  TITLE,
  audioFiles,
  captureStd,
  fakeAudio,
  finish,
  getJson,
  newMeeting,
  putChunk,
  sonioxConfig,
  startFakeSoniox,
  startMeetings
} from './meetings-helpers.ts'
import { SttError, sonioxStt, tokensToResult } from '../src/stt.ts'
import { ConfigError, SONIOX_DEFAULT_BASE_URL, SONIOX_DEFAULT_MODEL, loadConfig } from '../src/config.ts'

test('soniox happy path: upload → create → poll → transcript → cleanup; auth header on every call; diarized segments', async () => {
  const fake = await startFakeSoniox({ pollsBeforeDone: 2 })
  const h = await startMeetings({ stt: sonioxConfig(fake.base) })
  try {
    const { out } = await captureStd(async () => {
      const id = await newMeeting(h, { title: TITLE, consent: { version: 1, participants_informed: true }, language_hints: ['zh', 'en'] })
      const a0 = fakeAudio(0)
      assert.equal((await putChunk(h, h.token, id, 0, a0, { durationMs: 10_000 })).status, 202)
      assert.equal((await putChunk(h, h.token, id, 1, fakeAudio(1), { durationMs: 8_000, contentType: 'audio/ogg' })).status, 202)
      assert.equal((await finish(h, h.token, id, 2)).status, 202)
      const st = await h.app.stt.drain()
      assert.equal(st.done, 2)
      assert.equal(audioFiles(h).length, 0)

      for (const r of fake.reqs) assert.equal(r.authorization, `Bearer ${SONIOX_KEY}`, `${r.method} ${r.path}`)
      const uploads = fake.reqs.filter((r) => r.method === 'POST' && r.path === '/v1/files')
      assert.equal(uploads.length, 2)
      assert.match(uploads[0].contentType ?? '', /^multipart\/form-data; boundary=/)
      const up0 = uploads.find((u) => u.body.includes(a0))
      assert.ok(up0, 'audio bytes are in a multipart upload')
      assert.ok(up0.body.includes(Buffer.from('name="file"')))
      assert.ok(!up0.body.includes(Buffer.from('TITLE-SECRET')), 'title never sent to Soniox')
      const creates = fake.reqs.filter((r) => r.method === 'POST' && r.path === '/v1/transcriptions').map((r) => JSON.parse(r.body.toString('utf8')) as Record<string, unknown>)
      assert.equal(creates.length, 2)
      for (const c of creates) {
        assert.equal(c.model, 'stt-async-v6')
        assert.match(c.file_id as string, /^[0-9a-f-]{36}$/)
        assert.deepEqual(c.language_hints, ['zh', 'en'])
        assert.equal(c.enable_speaker_diarization, true)
        assert.equal(c.enable_language_identification, true)
        assert.equal(c.audio_url, undefined)
      }
      const polls = fake.reqs.filter((r) => r.method === 'GET' && /^\/v1\/transcriptions\/[0-9a-f-]+$/.test(r.path))
      assert.equal(polls.length, 6) // 2 × (2 processing + 1 completed)
      assert.equal(fake.reqs.filter((r) => r.method === 'GET' && r.path.endsWith('/transcript')).length, 2)
      const dels = fake.reqs.filter((r) => r.method === 'DELETE')
      assert.equal(dels.filter((d) => d.path.startsWith('/v1/files/')).length, 2)
      assert.equal(dels.filter((d) => d.path.startsWith('/v1/transcriptions/')).length, 2)

      const t = await getJson(h, h.token, `/v1/meetings/${id}/transcript`)
      assert.equal(t.status, 200)
      assert.equal(t.body.language, 'zh')
      assert.deepEqual(t.body.segments, [
        { start_ms: 100, end_ms: 600, speaker: 'S1', text: '大家好' },
        { start_ms: 1000, end_ms: 1800, speaker: 'S2', text: 'Hello team' },
        { start_ms: 5000, end_ms: 5600, speaker: 'S1', text: '开始' },
        { start_ms: 10_100, end_ms: 10_600, speaker: 'S1', text: '大家好' },
        { start_ms: 11_000, end_ms: 11_800, speaker: 'S2', text: 'Hello team' },
        { start_ms: 15_000, end_ms: 15_600, speaker: 'S1', text: '开始' }
      ])
    })
    const all = out + h.logs.join('\n')
    for (const s of [SONIOX_KEY, 'TITLE-SECRET', '大家好', 'Hello team']) assert.ok(!all.includes(s), s)
  } finally {
    await h.close()
    await fake.close()
  }
})

test('soniox transcription status "error" → chunk failed (no retry) → meeting failed with error_code; cleanup still runs; key never leaks', async () => {
  const fake = await startFakeSoniox({ finalStatus: 'error', pollsBeforeDone: 1 })
  const h = await startMeetings({ stt: sonioxConfig(fake.base) })
  try {
    const { out } = await captureStd(async () => {
      const id = await newMeeting(h)
      await putChunk(h, h.token, id, 0, fakeAudio(0))
      await finish(h, h.token, id, 1)
      const st = await h.app.stt.drain()
      assert.deepEqual([st.failed, st.retried], [1, 0])
      assert.equal(audioFiles(h).length, 0)
      const g = await getJson(h, h.token, `/v1/meetings/${id}`)
      assert.equal(g.body.status, 'failed')
      assert.equal(g.body.error_code, 'stt_failed')
      assert.deepEqual(g.body.chunks, [{ seq: 0, status: 'failed', duration_ms: 30_000 }])
      assert.ok(!JSON.stringify(g.body).includes(SONIOX_KEY))
      const t = await fetch(`${h.base}/v1/meetings/${id}/transcript`, { headers: bearer(h.token) })
      assert.equal(t.status, 409)
      assert.ok(!(await t.text()).includes(SONIOX_KEY))
      assert.equal(fake.reqs.filter((r) => r.method === 'DELETE').length, 2)
      const errCodes = h.app.db.prepare('SELECT error_code FROM meeting_chunks').all() as Array<{ error_code: string }>
      assert.deepEqual(errCodes.map((e) => e.error_code), ['stt_failed'])
    })
    assert.ok(!(out + h.logs.join('\n')).includes(SONIOX_KEY))
  } finally {
    await h.close()
    await fake.close()
  }
})

test('soniox 5xx on upload: retried exactly once after backoff, then failed (retry bound, no tight loop)', async () => {
  const fake = await startFakeSoniox({ uploadStatus: 503 })
  const h = await startMeetings({ stt: sonioxConfig(fake.base) })
  try {
    const id = await newMeeting(h)
    await putChunk(h, h.token, id, 0, fakeAudio(0))
    await finish(h, h.token, id, 1)
    const uploads = (): number => fake.reqs.filter((r) => r.path === '/v1/files').length
    let st = await h.app.stt.drain()
    assert.deepEqual([st.retried, uploads()], [1, 1])
    await h.app.stt.drain()
    assert.equal(uploads(), 1)
    h.clock.t += 30_000
    st = await h.app.stt.drain()
    assert.deepEqual([st.failed, uploads()], [1, 2])
    h.clock.t += 3600_000
    await h.app.stt.drain()
    assert.equal(uploads(), 2)
    const g = await getJson(h, h.token, `/v1/meetings/${id}`)
    assert.equal(g.body.status, 'failed')
    assert.equal(g.body.error_code, 'stt_unavailable')
    assert.equal(audioFiles(h).length, 0)
  } finally {
    await h.close()
    await fake.close()
  }
})

test('soniox 401 / 402 / 400 are permanent (one attempt)', async () => {
  for (const [status, code] of [
    [401, 'stt_auth'],
    [402, 'stt_quota'],
    [400, 'stt_rejected']
  ] as const) {
    const fake = await startFakeSoniox({ createStatus: status })
    const h = await startMeetings({ stt: sonioxConfig(fake.base) })
    try {
      const id = await newMeeting(h)
      await putChunk(h, h.token, id, 0, fakeAudio(0))
      const st = await h.app.stt.drain()
      assert.deepEqual([st.failed, st.retried], [1, 0], String(status))
      const row = h.app.db.prepare('SELECT status, error_code FROM meeting_chunks').get() as { status: string; error_code: string }
      assert.deepEqual({ ...row }, { status: 'failed', error_code: code })
      // the uploaded file is still deleted at Soniox
      assert.equal(fake.reqs.filter((r) => r.method === 'DELETE' && r.path.startsWith('/v1/files/')).length, 1)
    } finally {
      await h.close()
      await fake.close()
    }
  }
})

test('adapter errors never carry the key or upstream bodies (upstream echoes the key)', async () => {
  const fake = await startFakeSoniox({ uploadStatus: 500 })
  try {
    const a = sonioxStt(sonioxConfig(fake.base))
    await assert.rejects(
      a.transcribe({ audio: fakeAudio(0), contentType: 'audio/webm', durationMs: 1000, seq: 0, languageHints: [] }, new AbortController().signal),
      (e: unknown) => {
        assert.ok(e instanceof SttError)
        assert.equal(e.code, 'stt_unavailable')
        assert.ok(!e.message.includes(SONIOX_KEY) && !(e.stack ?? '').includes(SONIOX_KEY))
        assert.ok(!e.message.includes('127.0.0.1'))
        return true
      }
    )
    // unreachable upstream → transient
    const dead = sonioxStt({ ...sonioxConfig('http://127.0.0.1:1'), timeoutMs: 2000 })
    await assert.rejects(dead.transcribe({ audio: fakeAudio(0), contentType: 'audio/webm', durationMs: 1000, seq: 0, languageHints: [] }, new AbortController().signal), (e: unknown) => {
      assert.ok(e instanceof SttError && e.code === 'stt_unavailable' && !e.permanent)
      return true
    })
  } finally {
    await fake.close()
  }
})

test('adapter polling timeout → stt_timeout (transient) and cleanup attempted', async () => {
  const fake = await startFakeSoniox({ pollsBeforeDone: 1_000_000 })
  try {
    const a = sonioxStt({ ...sonioxConfig(fake.base), pollIntervalMs: 10, timeoutMs: 1000 })
    await assert.rejects(a.transcribe({ audio: fakeAudio(0), contentType: 'audio/wav', durationMs: 1000, seq: 0, languageHints: [] }, new AbortController().signal), (e: unknown) => {
      assert.ok(e instanceof SttError)
      assert.equal(e.code, 'stt_timeout')
      assert.equal(e.permanent, false)
      return true
    })
    assert.ok(fake.reqs.some((r) => r.method === 'DELETE' && r.path.startsWith('/v1/files/')))
  } finally {
    await fake.close()
  }
})

test('tokensToResult: groups by speaker / gap, clamps to chunk, ignores junk and translation tokens', () => {
  const r = tokensToResult(
    [
      { text: 'a', start_ms: 0, end_ms: 100, speaker: '1', language: 'en' },
      { text: 'b', start_ms: 100, end_ms: 200, speaker: '1', language: 'en' },
      { text: 'c', start_ms: 3000, end_ms: 3100, speaker: '1', language: 'en' },
      { text: 'x', start_ms: 3100, end_ms: 3200, speaker: '1', translation_status: 'translation' },
      { text: 'd', start_ms: 3200, end_ms: 99_999, speaker: '2', language: 'fr' },
      { text: 7, start_ms: 1, end_ms: 2 },
      { text: 'e', start_ms: 'no', end_ms: 2 }
    ],
    5000
  )
  assert.equal(r.language, 'en')
  assert.deepEqual(r.segments, [
    { start_ms: 0, end_ms: 200, speaker: 'S1', text: 'ab' },
    { start_ms: 3000, end_ms: 3100, speaker: 'S1', text: 'c' },
    { start_ms: 3200, end_ms: 5000, speaker: 'S2', text: 'd' }
  ])
  assert.deepEqual(tokensToResult([], 1000), { language: null, segments: [] })
})

test('config: CLOUD_STT_MODE / Soniox env parsing', () => {
  const d = loadConfig({})
  assert.equal(d.stt.mode, null)
  assert.equal(d.sttDailySeconds, 7200)
  assert.equal(d.audioDir, './data/audio')
  assert.equal(loadConfig({ CLOUD_STT_MODE: 'mock' }).stt.mode, 'mock')
  const s = loadConfig({ CLOUD_STT_MODE: 'soniox', CLOUD_SONIOX_API_KEY: 'k'.repeat(20) })
  assert.equal(s.stt.sonioxBaseUrl, SONIOX_DEFAULT_BASE_URL)
  assert.equal(s.stt.sonioxModel, SONIOX_DEFAULT_MODEL)
  assert.equal(SONIOX_DEFAULT_BASE_URL, 'https://api.soniox.com')
  const o = loadConfig({ CLOUD_STT_MODE: 'soniox', CLOUD_SONIOX_API_KEY: 'k', CLOUD_SONIOX_BASE_URL: 'https://eu.example.com/', CLOUD_SONIOX_MODEL: 'stt-async-v5', CLOUD_STT_DAILY_SECONDS: '60', CLOUD_AUDIO_DIR: '/data/audio' })
  assert.equal(o.stt.sonioxBaseUrl, 'https://eu.example.com')
  assert.equal(o.stt.sonioxModel, 'stt-async-v5')
  assert.equal(o.sttDailySeconds, 60)
  assert.equal(o.audioDir, '/data/audio')
  for (const env of [
    { CLOUD_STT_MODE: 'whisper' },
    { CLOUD_STT_MODE: 'soniox' },
    { CLOUD_STT_MODE: 'soniox', CLOUD_SONIOX_API_KEY: 'k', CLOUD_SONIOX_BASE_URL: 'ftp://x' },
    { CLOUD_STT_MODE: 'soniox', CLOUD_SONIOX_API_KEY: 'k', CLOUD_SONIOX_BASE_URL: 'https://u:p@x.example' },
    { CLOUD_STT_DAILY_SECONDS: '-1' }
  ]) {
    assert.throws(() => loadConfig(env), (e: unknown) => {
      assert.ok(e instanceof ConfigError)
      assert.ok(!e.message.includes('k'.repeat(20)))
      return true
    })
  }
})
