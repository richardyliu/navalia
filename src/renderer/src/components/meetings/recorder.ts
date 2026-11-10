// Browser glue for the meeting recorder (S1-FULL C12). Module-level singleton so a recording keeps
// running when the user navigates to another page (App unmounts pages). The logic lives in the
// pure state machine (recorderMachine.ts); this file only drives getUserMedia / MediaRecorder,
// sends chunks to main over IPC (in order) and updates document.title while recording.
import { MEETING_LIMITS } from '../../../../main/cloud/meetings-api'
import { tr } from '../../../../shared/i18n'
import { formatClock } from '../../pages/meetingsView'
import { initialRecState, pickMime, step, type RecEffect, type RecState } from './recorderMachine'

export interface RecorderSnapshot {
  meetingId: string | null
  title: string
  phase: RecState['phase']
  totalMs: number
  chunksSent: number
  chunksFailed: number
  limitReached: boolean
  error: string | null
  /** Set once main accepted `stop` (uploads / finish continue in main). */
  finished: boolean
}

type Listener = () => void

const IDLE: RecorderSnapshot = { meetingId: null, title: '', phase: 'idle', totalMs: 0, chunksSent: 0, chunksFailed: 0, limitReached: false, error: null, finished: false }

let snapshot: RecorderSnapshot = IDLE
let machine: RecState = initialRecState()
let stream: MediaStream | null = null
let current: MediaRecorder | null = null
let mime = ''
let timer: ReturnType<typeof setInterval> | null = null
let sendChain: Promise<void> = Promise.resolve()
let originalTitle: string | null = null
const listeners = new Set<Listener>()

function emit(patch: Partial<RecorderSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const l of listeners) l()
  updateTitle()
}

export function subscribeRecorder(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function recorderSnapshot(): RecorderSnapshot {
  return snapshot
}

function updateTitle(): void {
  const live = snapshot.phase === 'recording' || snapshot.phase === 'paused' || snapshot.phase === 'finalizing'
  if (live) {
    if (originalTitle === null) originalTitle = document.title
    const mark = snapshot.phase === 'paused' ? tr('⏸ Recording paused', '⏸ 录音已暂停') : tr('● Recording', '● 录音中')
    document.title = `${mark} ${formatClock(snapshot.totalMs)} · ${originalTitle}`
  } else if (originalTitle !== null) {
    document.title = originalTitle
    originalTitle = null
  }
}

function dispatch(ev: Parameters<typeof step>[1], blob?: Blob): void {
  const r = step(machine, ev)
  machine = r.state
  emit({ phase: machine.phase, totalMs: machine.totalMs, limitReached: machine.limitReached })
  for (const eff of r.effects) run(eff, blob)
}

function newSegment(): void {
  if (!stream) return
  const rec = new MediaRecorder(stream, { mimeType: mime })
  const parts: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) parts.push(e.data)
  }
  rec.onstop = () => {
    const blob = new Blob(parts, { type: mime })
    dispatch({ type: 'segmentData', bytes: blob.size }, blob)
  }
  rec.onerror = () => emit({ error: tr('The recording device hit an error and stopped', '录音设备出错，已停止') })
  rec.start() // no timeslice: one self-contained file per segment
  current = rec
}

function run(eff: RecEffect, blob?: Blob): void {
  switch (eff.type) {
    case 'startSegment':
      newSegment()
      break
    case 'endSegment': {
      const rec = current
      current = null
      if (rec && rec.state !== 'inactive') rec.stop()
      if (eff.final && timer) {
        clearInterval(timer)
        timer = null
      }
      break
    }
    case 'pauseSegment':
      if (current?.state === 'recording') current.pause()
      break
    case 'resumeSegment':
      if (current?.state === 'paused') current.resume()
      break
    case 'emitChunk': {
      const meetingId = snapshot.meetingId
      if (!meetingId || !blob) break
      const durationMs = Math.min(MEETING_LIMITS.chunkMaxMs, Math.max(1, eff.durationMs))
      sendChain = sendChain.then(async () => {
        const data = new Uint8Array(await blob.arrayBuffer())
        const r = await window.lens.meetings.chunk({ meetingId, seq: eff.seq, mime, durationMs, data })
        if (r.ok) emit({ chunksSent: snapshot.chunksSent + 1 })
        else emit({ chunksFailed: snapshot.chunksFailed + 1, error: r.error.message })
      })
      break
    }
    case 'releaseTracks':
      releaseTracks()
      break
    case 'finish': {
      const meetingId = snapshot.meetingId
      if (!meetingId) break
      const chunks = eff.chunks
      sendChain = sendChain.then(async () => {
        const r = await window.lens.meetings.stop({ meetingId, chunks })
        if (r.ok) emit({ finished: true })
        else emit({ error: r.error.message, finished: true })
      })
      break
    }
  }
}

function releaseTracks(): void {
  for (const t of stream?.getTracks() ?? []) t.stop()
  stream = null
}

/** Start recording for a meeting main has already armed (after consent + native confirm). */
export async function startRecording(opts: { meetingId: string; title: string; mimeAllowlist: string[]; maxChunks: number }): Promise<string | null> {
  if (snapshot.phase === 'recording' || snapshot.phase === 'paused' || snapshot.phase === 'finalizing') return tr('A recording is already in progress', '已有录音在进行')
  const picked = typeof MediaRecorder === 'undefined' ? null : pickMime((m) => MediaRecorder.isTypeSupported(m), opts.mimeAllowlist)
  if (!picked) return tr('This environment does not support a usable recording format', '这个环境不支持可用的录音格式')
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  } catch {
    stream = null
    return tr('Cannot open the microphone (permission denied or device unavailable)', '无法打开麦克风（权限被拒绝或设备不可用）')
  }
  mime = picked
  machine = initialRecState({ rotateMs: MEETING_LIMITS.rotateMs, maxChunks: opts.maxChunks })
  sendChain = Promise.resolve()
  snapshot = { ...IDLE, meetingId: opts.meetingId, title: opts.title }
  dispatch({ type: 'start', at: Date.now() })
  timer = setInterval(() => dispatch({ type: 'tick', at: Date.now() }), 250)
  return null
}

export function pauseRecording(): void {
  dispatch({ type: 'pause', at: Date.now() })
}

export function resumeRecording(): void {
  dispatch({ type: 'resume', at: Date.now() })
}

export function stopRecording(): void {
  dispatch({ type: 'stop', at: Date.now() })
}

/** Forget a finished recording so the page shows the idle state again. */
export function clearRecorder(): void {
  if (snapshot.phase !== 'stopped' && snapshot.phase !== 'idle') return
  machine = initialRecState()
  emit({ ...IDLE })
}
