// S1-FULL C14: transcript → Markdown (deterministic; main only, no network). Every free-text field
// (title, segment text) goes through the same redaction chat context uses: verbatim known-secret
// scrubbing (`mcp/known-secrets.ts`) then `import/redact.ts stripSecrets` (which includes the HET
// redactor: bearer / keys / emails / home paths / long hex…). Line-level, so one env-dump-looking
// segment is dropped on its own instead of the whole document.
import { stripSecrets } from '../import/redact'
import { scrubKnownSecrets } from '../mcp/known-secrets'
import type { MeetingTranscript } from './meetings-api'

export interface MeetingMarkdownInput {
  meetingId: string
  title: string
  /** ISO time the meeting was created. */
  createdAt: string
  durationMs: number
  transcript: MeetingTranscript
  /**
   * Start offset of each uploaded chunk (seq order). The server's speaker labels (`S1`…) are only
   * valid inside one ~30 s chunk, so a label is printed together with its chunk number and never
   * renumbered across chunks.
   */
  chunkStartsMs?: readonly number[]
  /** IANA zone used to print the date (default UTC; main passes the system zone). */
  timeZone?: string
  knownSecrets?: readonly string[]
}

export interface MeetingMarkdown {
  markdown: string
  redactions: number
  /** Transcript lines in the body (after dropping empty segments). */
  lines: number
}

/** `[mm:ss]` with minutes unbounded (a 75-minute offset is `75:03`). */
export function formatOffset(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** `h:mm:ss` / `mm:ss` duration. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function formatDate(iso: string, timeZone = 'UTC'): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d)
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (${timeZone})`
  } catch {
    return d.toISOString()
  }
}

/** Index of the chunk that contains `ms` (last start ≤ ms), or 0. */
export function chunkIndexOf(ms: number, starts: readonly number[]): number {
  let k = 0
  for (let i = 0; i < starts.length; i++) if (starts[i] <= ms) k = i
  return k
}

/** Server label (`S1`, `SPEAKER_00`, …) if it looks like a label; never free text / names. */
export function speakerLabel(v: string | null): string | null {
  const s = v?.trim() ?? ''
  return /^[A-Za-z0-9_-]{1,16}$/.test(s) ? s : null
}

const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

/** Redact one free-text field. */
export function redactField(text: string, known: readonly string[] = []): { text: string; redactions: number } {
  const k = scrubKnownSecrets(text, known)
  const s = stripSecrets(k.text)
  return { text: s.text, redactions: s.redactions + k.count }
}

export function buildMeetingMarkdown(input: MeetingMarkdownInput): MeetingMarkdown {
  const known = input.knownSecrets ?? []
  let redactions = 0
  const title = redactField(oneLine(input.title) || '未命名会议', known)
  redactions += title.redactions
  const starts = input.chunkStartsMs ?? []
  const multi = starts.length > 1
  let labelled = false
  const body: string[] = []
  const segs = [...input.transcript.segments].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
  for (const seg of segs) {
    const raw = oneLine(seg.text)
    if (!raw) continue
    const r = redactField(raw, known)
    redactions += r.redactions
    const label = speakerLabel(seg.speaker)
    if (label) labelled = true
    const who = label ? (multi ? `${label}@${chunkIndexOf(seg.start_ms, starts) + 1}` : label) : null
    body.push(`[${formatOffset(seg.start_ms)}] ${who ? `${who}: ` : ''}${oneLine(r.text)}`)
  }
  const language = input.transcript.language && /^[A-Za-z-]{1,16}$/.test(input.transcript.language) ? input.transcript.language : '未知'
  const lines = [
    `# 会议：${oneLine(title.text)}`,
    '',
    `- 日期：${formatDate(input.createdAt, input.timeZone)}`,
    `- 时长：${formatDuration(input.durationMs)}`,
    `- 语言：${language}`,
    `- 说话人：${
      !labelled ? '未区分' : multi ? '标签只在同一段音频（约 30 秒）内有效：`S1@3` 表示第 3 段里的 S1，不同段的 S1 不一定是同一个人；未识别姓名' : '按转写标签（S1…），未识别姓名'
    }`,
    `- 来源：Navalia 会议录音，云端转写（会议 ${input.meetingId}）`,
    '',
    '## 转写',
    '',
    ...(body.length ? body : ['（转写为空）']),
    ''
  ]
  return { markdown: lines.join('\n'), redactions, lines: body.length }
}
