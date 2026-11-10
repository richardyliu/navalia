// Meeting recorder state machine (S1-FULL C12). Pure: no DOM, no timers. The browser glue
// (recorder.ts) feeds it events and executes the returned effects.
//
// Chunks are SELF-CONTAINED: instead of MediaRecorder timeslices (whose pieces are not
// independently decodable), each segment is a full MediaRecorder start → stop. A segment is ended
// after `rotateMs` of recorded (not paused) time and a new one starts on the same stream. Sequence
// numbers are assigned when a segment's data arrives and is non-empty, so they stay contiguous
// even if a segment produced no bytes. After `stop`, the last pending segment is delivered, then
// the machine is `stopped` and ignores everything (no chunk after stop).

export type RecPhase = 'idle' | 'recording' | 'paused' | 'finalizing' | 'stopped'

export interface RecState {
  phase: RecPhase
  /** Next sequence number to assign. Equals the number of chunks emitted so far. */
  nextSeq: number
  /** Recorded ms in the current segment (pauses excluded). */
  segmentMs: number
  /** Recorded ms overall (pauses excluded). */
  totalMs: number
  /** Timestamp of the last accounted moment while recording. */
  lastAt: number | null
  /** Segments that were ended but whose data has not arrived yet. */
  awaiting: number
  /** Durations of ended segments, in end order (data arrives in the same order). */
  endedDurations: number[]
  /** True when the chunk limit forced the stop. */
  limitReached: boolean
  rotateMs: number
  maxChunks: number
}

export type RecEvent =
  | { type: 'start'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  | { type: 'stop'; at: number }
  /** A segment's recorder stopped and delivered its data (`bytes` may be 0). */
  | { type: 'segmentData'; bytes: number }

export type RecEffect =
  | { type: 'startSegment' }
  | { type: 'endSegment'; final: boolean }
  | { type: 'pauseSegment' }
  | { type: 'resumeSegment' }
  /** Send this segment's bytes as chunk `seq`. */
  | { type: 'emitChunk'; seq: number; durationMs: number }
  | { type: 'releaseTracks' }
  /** All chunks have been emitted: call `meetings.stop({chunks})`. */
  | { type: 'finish'; chunks: number }

export function initialRecState(opts: { rotateMs?: number; maxChunks?: number } = {}): RecState {
  return {
    phase: 'idle',
    nextSeq: 0,
    segmentMs: 0,
    totalMs: 0,
    lastAt: null,
    awaiting: 0,
    endedDurations: [],
    limitReached: false,
    rotateMs: opts.rotateMs ?? 30_000,
    maxChunks: opts.maxChunks ?? 240
  }
}

function account(s: RecState, at: number): RecState {
  if (s.phase !== 'recording' || s.lastAt === null) return s
  const d = Math.max(0, at - s.lastAt)
  return { ...s, segmentMs: s.segmentMs + d, totalMs: s.totalMs + d, lastAt: at }
}

/** Segments already started (emitted + awaiting + the current one). */
function segmentsUsed(s: RecState): number {
  return s.nextSeq + s.awaiting + 1
}

function endCurrent(s: RecState, final: boolean): { state: RecState; effects: RecEffect[] } {
  const dur = Math.max(1, Math.round(s.segmentMs))
  const state: RecState = { ...s, segmentMs: 0, awaiting: s.awaiting + 1, endedDurations: [...s.endedDurations, dur] }
  return { state, effects: [{ type: 'endSegment', final }] }
}

export function step(state: RecState, ev: RecEvent): { state: RecState; effects: RecEffect[] } {
  const s = state
  switch (ev.type) {
    case 'start': {
      if (s.phase !== 'idle') return { state: s, effects: [] }
      return { state: { ...s, phase: 'recording', lastAt: ev.at }, effects: [{ type: 'startSegment' }] }
    }
    case 'tick': {
      if (s.phase !== 'recording') return { state: s, effects: [] }
      const a = account(s, ev.at)
      if (a.segmentMs < a.rotateMs) return { state: a, effects: [] }
      if (segmentsUsed(a) >= a.maxChunks) {
        // The current segment is the last one allowed: stop recording.
        const e = endCurrent(a, true)
        return { state: { ...e.state, phase: 'finalizing', lastAt: null, limitReached: true }, effects: e.effects }
      }
      const e = endCurrent(a, false)
      return { state: e.state, effects: [...e.effects, { type: 'startSegment' }] }
    }
    case 'pause': {
      if (s.phase !== 'recording') return { state: s, effects: [] }
      const a = account(s, ev.at)
      return { state: { ...a, phase: 'paused', lastAt: null }, effects: [{ type: 'pauseSegment' }] }
    }
    case 'resume': {
      if (s.phase !== 'paused') return { state: s, effects: [] }
      return { state: { ...s, phase: 'recording', lastAt: ev.at }, effects: [{ type: 'resumeSegment' }] }
    }
    case 'stop': {
      if (s.phase !== 'recording' && s.phase !== 'paused') return { state: s, effects: [] }
      const a = account(s, ev.at)
      const e = endCurrent(a, true)
      return { state: { ...e.state, phase: 'finalizing', lastAt: null }, effects: e.effects }
    }
    case 'segmentData': {
      if (s.phase === 'idle' || s.phase === 'stopped' || s.awaiting === 0) return { state: s, effects: [] }
      const [dur, ...rest] = s.endedDurations
      let next: RecState = { ...s, awaiting: s.awaiting - 1, endedDurations: rest }
      const effects: RecEffect[] = []
      if (ev.bytes > 0 && next.nextSeq < next.maxChunks) {
        effects.push({ type: 'emitChunk', seq: next.nextSeq, durationMs: dur ?? 1 })
        next = { ...next, nextSeq: next.nextSeq + 1 }
      }
      if (next.phase === 'finalizing' && next.awaiting === 0) {
        next = { ...next, phase: 'stopped' }
        effects.push({ type: 'releaseTracks' }, { type: 'finish', chunks: next.nextSeq })
      }
      return { state: next, effects }
    }
  }
}

/** Pick the first MIME both `MediaRecorder` and main accept (opus/webm preferred). */
export function pickMime(isSupported: (mime: string) => boolean, allow: readonly string[]): string | null {
  const prefs = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/wav']
  for (const m of prefs) {
    if (!allow.includes(m)) continue
    try {
      if (isSupported(m)) return m
    } catch {
      // treat as unsupported
    }
  }
  return null
}
