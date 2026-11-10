// S1-FULL C12–C14 pure units: mic permission gate, recorder state machine, Markdown builder, view-model.
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { createMicArm, micCheckDecision, micPermissionDecision } from '../../src/main/cloud/meetings-mic-gate'
import { buildMeetingMarkdown, chunkIndexOf, formatDuration, formatOffset, speakerLabel } from '../../src/main/cloud/meetings-markdown'
import type { MeetingTranscript } from '../../src/main/cloud/meetings-api'
import { initialRecState, pickMime, step, type RecEffect, type RecEvent, type RecState } from '../../src/renderer/src/components/meetings/recorderMachine'
import { actionsFor, chunkProgress, meetingsGate, runtimeDeleteText, startBlocker, statusLabel } from '../../src/renderer/src/pages/meetingsView'

const isApp = (u: string | undefined | null): boolean => u === 'app://lens/index.html' || u === 'app://lens'

describe('mic permission gate (decision table)', () => {
  const base = { permission: 'media', mediaTypes: ['audio'], requestingUrl: 'app://lens/index.html', isAppUrl: isApp, armed: true }
  it.each([
    ['media + audio-only + app + armed', base, true],
    ['not armed', { ...base, armed: false }, false],
    ['video only', { ...base, mediaTypes: ['video'] }, false],
    ['audio + video', { ...base, mediaTypes: ['audio', 'video'] }, false],
    ['empty mediaTypes', { ...base, mediaTypes: [] }, false],
    ['missing mediaTypes', { ...base, mediaTypes: undefined }, false],
    ['other origin', { ...base, requestingUrl: 'https://evil.example/' }, false],
    ['no url', { ...base, requestingUrl: undefined }, false],
    ['display-capture', { ...base, permission: 'display-capture' }, false],
    ['clipboard-read', { ...base, permission: 'clipboard-read' }, false],
    ['notifications', { ...base, permission: 'notifications' }, false],
    ['isAppUrl throws', { ...base, isAppUrl: () => { throw new Error('x') } }, false]
  ] as const)('request: %s ⇒ %s', (_n, input, want) => {
    expect(micPermissionDecision(input as Parameters<typeof micPermissionDecision>[0])).toBe(want)
  })

  it.each([
    ['audio + app + armed', { permission: 'media', mediaType: 'audio', requestingOrigin: 'app://lens', armed: true }, true],
    ['video', { permission: 'media', mediaType: 'video', requestingOrigin: 'app://lens', armed: true }, false],
    ['unknown', { permission: 'media', mediaType: 'unknown', requestingOrigin: 'app://lens', armed: true }, false],
    ['not armed', { permission: 'media', mediaType: 'audio', requestingOrigin: 'app://lens', armed: false }, false],
    ['foreign origin', { permission: 'media', mediaType: 'audio', requestingOrigin: 'https://x.example', armed: true }, false],
    ['other permission', { permission: 'geolocation', mediaType: 'audio', requestingOrigin: 'app://lens', armed: true }, false]
  ] as const)('check: %s ⇒ %s', (_n, input, want) => {
    expect(micCheckDecision({ ...input, isAppUrl: isApp })).toBe(want)
  })

  it('arming is per meeting and expires', () => {
    let t = 0
    const arm = createMicArm({ now: () => t, ttlMs: 1000 })
    expect(arm.isArmed()).toBe(false)
    arm.arm('m1')
    expect(arm.armedFor()).toBe('m1')
    arm.disarm('other')
    expect(arm.armedFor()).toBe('m1')
    t = 1000
    expect(arm.isArmed()).toBe(false)
    arm.arm('m2')
    arm.disarm()
    expect(arm.armedFor()).toBeNull()
  })
})

function runEvents(events: RecEvent[], s: RecState = initialRecState({ rotateMs: 30_000, maxChunks: 240 })): { state: RecState; effects: RecEffect[] } {
  const effects: RecEffect[] = []
  for (const e of events) {
    const r = step(s, e)
    s = r.state
    effects.push(...r.effects)
  }
  return { state: s, effects }
}

describe('recorder state machine', () => {
  it('start → 30 s rotation → stop: contiguous seqs, durations, finish after last data', () => {
    const r = runEvents([
      { type: 'start', at: 0 },
      { type: 'tick', at: 10_000 },
      { type: 'tick', at: 30_250 }, // rotate #1
      { type: 'segmentData', bytes: 100 },
      { type: 'tick', at: 60_500 }, // rotate #2
      { type: 'segmentData', bytes: 80 },
      { type: 'stop', at: 70_500 },
      { type: 'segmentData', bytes: 50 }
    ])
    expect(r.effects.filter((e) => e.type === 'startSegment')).toHaveLength(3)
    expect(r.effects.filter((e) => e.type === 'emitChunk')).toEqual([
      { type: 'emitChunk', seq: 0, durationMs: 30_250 },
      { type: 'emitChunk', seq: 1, durationMs: 30_250 },
      { type: 'emitChunk', seq: 2, durationMs: 10_000 }
    ])
    expect(r.effects.slice(-2)).toEqual([{ type: 'releaseTracks' }, { type: 'finish', chunks: 3 }])
    expect(r.state.phase).toBe('stopped')
    expect(r.state.totalMs).toBe(70_500)
  })

  it('pause time is not recorded and does not trigger rotation', () => {
    const r = runEvents([
      { type: 'start', at: 0 },
      { type: 'tick', at: 20_000 },
      { type: 'pause', at: 20_000 },
      { type: 'tick', at: 100_000 },
      { type: 'resume', at: 100_000 },
      { type: 'tick', at: 105_000 }
    ])
    expect(r.state.segmentMs).toBe(25_000)
    expect(r.effects.map((e) => e.type)).toEqual(['startSegment', 'pauseSegment', 'resumeSegment'])
    const r2 = runEvents([{ type: 'tick', at: 110_000 }], r.state)
    expect(r2.effects.map((e) => e.type)).toEqual(['endSegment', 'startSegment'])
  })

  it('stop while paused works; no chunk after stop; repeated stop / start ignored', () => {
    const r = runEvents([
      { type: 'start', at: 0 },
      { type: 'tick', at: 5_000 },
      { type: 'pause', at: 5_000 },
      { type: 'stop', at: 9_000 },
      { type: 'stop', at: 9_500 },
      { type: 'segmentData', bytes: 10 },
      { type: 'segmentData', bytes: 10 }, // a stray late segment
      { type: 'start', at: 10_000 },
      { type: 'tick', at: 99_000 }
    ])
    expect(r.effects.filter((e) => e.type === 'emitChunk')).toEqual([{ type: 'emitChunk', seq: 0, durationMs: 5_000 }])
    expect(r.effects.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', chunks: 1 }])
    expect(r.state.phase).toBe('stopped')
  })

  it('an empty segment does not consume a sequence number', () => {
    const r = runEvents([
      { type: 'start', at: 0 },
      { type: 'tick', at: 30_000 },
      { type: 'segmentData', bytes: 0 },
      { type: 'stop', at: 40_000 },
      { type: 'segmentData', bytes: 7 }
    ])
    expect(r.effects.filter((e) => e.type === 'emitChunk')).toEqual([{ type: 'emitChunk', seq: 0, durationMs: 10_000 }])
    expect(r.effects.at(-1)).toEqual({ type: 'finish', chunks: 1 })
  })

  it('stops by itself at the chunk limit', () => {
    let s = initialRecState({ rotateMs: 1_000, maxChunks: 3 })
    const all: RecEffect[] = []
    for (const e of [
      { type: 'start', at: 0 },
      { type: 'tick', at: 1_000 },
      { type: 'segmentData', bytes: 1 },
      { type: 'tick', at: 2_000 },
      { type: 'segmentData', bytes: 1 },
      { type: 'tick', at: 3_000 }, // third segment = last allowed ⇒ final
      { type: 'tick', at: 4_000 },
      { type: 'segmentData', bytes: 1 }
    ] as RecEvent[]) {
      const r = step(s, e)
      s = r.state
      all.push(...r.effects)
    }
    expect(s.limitReached).toBe(true)
    expect(all.filter((e) => e.type === 'emitChunk').map((e) => (e as { seq: number }).seq)).toEqual([0, 1, 2])
    expect(all.filter((e) => e.type === 'startSegment')).toHaveLength(3)
    expect(all.at(-1)).toEqual({ type: 'finish', chunks: 3 })
  })

  it('pickMime prefers opus/webm and respects both lists', () => {
    const allow = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/wav']
    expect(pickMime(() => true, allow)).toBe('audio/webm;codecs=opus')
    expect(pickMime((m) => m === 'audio/ogg', allow)).toBe('audio/ogg')
    expect(pickMime((m) => m === 'audio/mp4', allow)).toBeNull()
    expect(pickMime(() => true, ['audio/wav'])).toBe('audio/wav')
  })
})

const transcript: MeetingTranscript = {
  meeting_id: 'm_1',
  language: 'zh',
  segments: [
    { start_ms: 65_400, end_ms: 70_000, speaker: 'S1', text: '我的邮箱是 alice@example.com，\n令牌 sk-ant-abcdefghijklmnop1234' },
    { start_ms: 0, end_ms: 3_000, speaker: 'S1', text: '大家好，口令Zq9vWm2p。' },
    { start_ms: 4_501_000, end_ms: 4_502_000, speaker: 'S2', text: '散会。' },
    { start_ms: 5_000, end_ms: 6_000, speaker: null, text: '   ' }
  ],
  text: 'x'
}

describe('meeting Markdown builder', () => {
  it('offsets and durations', () => {
    expect(formatOffset(0)).toBe('00:00')
    expect(formatOffset(65_400)).toBe('01:05')
    expect(formatOffset(4_501_000)).toBe('75:01')
    expect(formatOffset(-5)).toBe('00:00')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
    expect(formatDuration(59_400)).toBe('00:59')
    expect(chunkIndexOf(65_400, [0, 30_000, 60_000])).toBe(2)
    expect(chunkIndexOf(5, [0, 30_000])).toBe(0)
    expect(speakerLabel('S1')).toBe('S1')
    expect(speakerLabel('Alice Smith')).toBeNull()
  })

  it('is deterministic, sorted, redacted; speaker labels are per chunk, never merged', () => {
    const input = { meetingId: 'm_1', title: '周会 /Users/alice/secret', createdAt: '2026-11-05T06:30:00.000Z', durationMs: 4_502_000, transcript, timeZone: 'Asia/Shanghai', knownSecrets: ['口令Zq9vWm2p'], chunkStartsMs: [0, 30_000, 60_000] }
    const a = buildMeetingMarkdown(input)
    expect(buildMeetingMarkdown(input).markdown).toBe(a.markdown)
    const lines = a.markdown.split('\n')
    expect(lines[0]).toBe('# 会议：周会 /Users/[user]/secret')
    expect(a.markdown).toContain('- 日期：2026-11-05 14:30 (Asia/Shanghai)')
    expect(a.markdown).toContain('- 时长：1:15:02')
    expect(a.markdown).toContain('- 语言：zh')
    const body = lines.filter((l) => l.startsWith('['))
    expect(body).toHaveLength(3)
    expect(body[0]).toBe('[00:00] S1@1: 大家好，[redacted]。')
    expect(body[1]).toMatch(/^\[01:05\] S1@3: /)
    expect(a.markdown).toContain('不同段的 S1 不一定是同一个人')
    expect(body[1]).not.toContain('alice@example.com')
    expect(body[1]).not.toContain('sk-ant-abcdefghijklmnop1234')
    expect(body[1]).not.toContain('\n')
    expect(body[2]).toBe('[75:01] S2@3: 散会。')
    const single = buildMeetingMarkdown({ ...input, chunkStartsMs: [0] })
    expect(single.markdown).toContain('[00:00] S1: 大家好')
    expect(a.redactions).toBeGreaterThanOrEqual(4)
    expect(a.lines).toBe(3)
  })
})

describe('meetings view-model', () => {
  const meta = {
    version: 1 as const,
    id: 'm_1',
    title: 't',
    createdAt: '2026-11-05T00:00:00.000Z',
    consent: { version: 1 as const, participantsInformed: true as const, at: '' },
    languageHints: [],
    limits: { maxChunks: 240, chunkMaxBytes: 1, chunkMaxMs: 1 },
    localStatus: 'ready' as const,
    serverStatus: 'ready' as const,
    chunks: [
      { seq: 0, mime: 'audio/webm', durationMs: 1, bytes: 1, sha256: 'a'.repeat(64), uploaded: true, attempts: 1, error: null },
      { seq: 1, mime: 'audio/webm', durationMs: 1, bytes: 1, sha256: 'a'.repeat(64), uploaded: false, attempts: 2, error: 'network' }
    ],
    totalChunks: 2,
    durationMs: 2,
    errorCode: null,
    audioDeleted: true,
    transcript: { language: 'zh', segments: 1, chars: 1, fetchedAt: '' },
    imported: null,
    summary: null,
    updatedAt: ''
  }
  afterEach(() => setLocale('en'))
  it('gate, progress, actions, blockers', () => {
    expect(meetingsGate(null).state).toBe('loading')
    expect(meetingsGate({ enabled: false, baseUrl: null, signedIn: false, accountId: null, expiresAt: null })).toMatchObject({ state: 'off' })
    expect(chunkProgress(meta).text).toBe('Uploaded 1 / 2 chunks, 1 failed and waiting to retry')
    expect(startBlocker('', true, 'ready', false)).toBe('Enter a meeting title')
    expect(statusLabel({ localStatus: 'transcribing', serverStatus: 'transcribing' })).toBe('Transcribing (cloud: transcribing)')
    expect(
      runtimeDeleteText({ import: { status: 'deleted', timelineBlocks: 2, sessions: 2, modeledSessions: 0 }, summary: { status: 'refused', reason: 'r' }, note: 'Note.' })
    ).toBe('Deleted the imported transcript from Persome (timeline blocks 2, sessions 2); The meeting summary was not deleted. Note.')
    setLocale('zh')
    expect(chunkProgress(meta).text).toBe('已上传 1 / 2 段，1 段失败待重试')
    expect(actionsFor(meta, 'ready', false)).toMatchObject({ canImport: true, canSummarize: true, canDelete: true, canRetry: false })
    expect(actionsFor({ ...meta, imported: { at: '', ok: true, exitCode: 0, counts: null, fileName: '', sha256: '' } }, 'off', true)).toMatchObject({ canImport: false, canSummarize: false, canDelete: false })
    const imp = { at: '', ok: true, exitCode: 0, counts: null, fileName: '', sha256: '' }
    expect(actionsFor({ ...meta, imported: imp }, 'off', false)).toMatchObject({ canImport: false, canDeleteFromRuntime: true })
    expect(actionsFor({ ...meta, imported: { ...imp, runtimeDeletedAt: '2026-11-06T00:00:00Z' } }, 'off', false)).toMatchObject({ canImport: true, canDeleteFromRuntime: false })
    expect(actionsFor(meta, 'ready', false).canDeleteFromRuntime).toBe(false)
    expect(
      runtimeDeleteText({ import: { status: 'deleted', timelineBlocks: 2, sessions: 2, modeledSessions: 0 }, summary: { status: 'refused', reason: 'r' }, note: '摘要没有删除' })
    ).toBe('已从 Persome 删除导入的转写（时间线块 2，会话 2）；会议摘要没有删除。摘要没有删除')
    expect(startBlocker('', true, 'ready', false)).toBe('填写会议标题')
    expect(startBlocker('周会', false, 'ready', false)).toBe('先勾选已告知参会者')
    expect(startBlocker('周会', true, 'off', false)).toBe('先开启并登录云端')
    expect(startBlocker('周会', true, 'ready', false)).toBeNull()
    expect(statusLabel({ localStatus: 'transcribing', serverStatus: 'transcribing' })).toBe('转写中（云端：转写中）')
  })
})
