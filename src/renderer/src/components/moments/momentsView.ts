// S1-FULL C18 shared moments: pure view-model (vitest has no DOM; the .tsx files stay thin).
// Nothing here writes text about a moment: prompts are fixed questions, the user writes the answer.
import {
  deleteNote,
  MOMENT_LIMITS,
  MOMENT_PROMPTS,
  VISIBILITY_LABEL,
  type MomentRejectReason,
  type MomentView,
  type RejectedLocalMoment
} from '../../../../main/cloud/moments-api'
import { tr } from '../../lib/i18n'

export { deleteNote, MOMENT_PROMPTS, VISIBILITY_LABEL }

// UI text: functions so the locale is read at render time, not at import.
export function noInferenceNote(): string {
  return tr(
    'A shared moment can only be proposed by you and confirmed by the other person. Navalia never infers shared moments from your memory or keyword overlap. Both sides sign with their own keys, and every moment is re-verified on this Mac before it is shown.',
    '共同经历只能由你亲自发起、对方亲自确认：Navalia 不会从你的记忆或关键词重合里推断共同经历。双方都用自己的密钥签名，每次显示前都在本机重新验签。'
  )
}
export function unknownSignerText(): string {
  return tr('Signer is not in your Peers list', '签名者不在朋友列表')
}
export function helpExpressNote(): string {
  return tr(
    'Below are a few fixed questions to help you think about what to write; Navalia never writes anything for you. What you write stays on this Mac and is never uploaded; it is only attached when you tick it in a weekly letter.',
    '下面是几个固定的问题，帮你想想要写什么；Navalia 不会替你写任何内容。你写的话只保存在本机，不会上传；只有你在周信里勾选时才会附上。'
  )
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s
}

export function friendLabel(m: Pick<MomentView, 'friendName' | 'friendFingerprint'>): string {
  return m.friendName?.trim() || tr(`Peer (${m.friendFingerprint.slice(0, 8)})`, `朋友（${m.friendFingerprint.slice(0, 8)}）`)
}

export function dateText(m: Pick<MomentView, 'start' | 'end'>): string {
  return m.start === m.end ? m.start : tr(`${m.start} to ${m.end}`, `${m.start} 至 ${m.end}`)
}

export interface ProposeForm {
  title: string
  start: string
  end: string
  place: string
  note: string
  visibility: 'private' | 'letters'
}

export function emptyForm(today: string): ProposeForm {
  return { title: '', start: today, end: today, place: '', note: '', visibility: 'private' }
}

/** First problem with the form (in the UI language), or null. Main validates again. */
export function formProblem(f: ProposeForm): string | null {
  const t = f.title.trim()
  if (!t) return tr('Write a title', '请写一个标题')
  if (t.length > MOMENT_LIMITS.maxTitleChars) return tr('Title can be at most 200 characters', '标题最多 200 字')
  if (/[\r\n]/.test(f.title)) return tr('Title must be one line', '标题只能一行')
  if (!isDate(f.start) || !isDate(f.end)) return tr('Dates must be YYYY-MM-DD', '日期格式是 YYYY-MM-DD')
  if (f.start > f.end) return tr('Start date cannot be after end date', '开始日期不能晚于结束日期')
  if (f.place.length > MOMENT_LIMITS.maxPlaceChars) return tr('Place can be at most 200 characters', '地点最多 200 字')
  if (f.note.length > MOMENT_LIMITS.maxNoteChars) return tr('Note can be at most 4000 characters', '附言最多 4000 字')
  return null
}

/** IPC args from the form (place blank ⇒ null). */
export function proposeArgs(friendFingerprint: string, f: ProposeForm) {
  return {
    friendFingerprint,
    title: f.title.trim(),
    start: f.start,
    end: f.end,
    place: f.place.trim() ? f.place.trim() : null,
    note: f.note,
    visibility: f.visibility
  }
}

/** Insert a fixed prompt as a heading line into the user's own text (no generated content). */
export function insertPrompt(text: string, prompt: string): string {
  if (!MOMENT_PROMPTS.includes(prompt)) return text
  const head = `「${prompt}」`
  if (text.includes(head)) return text
  const sep = text && !text.endsWith('\n') ? '\n\n' : text ? '\n' : ''
  return `${text}${sep}${head}\n`
}

export const REJECT_TEXT: Record<MomentRejectReason | 'unreadable', string> = {
  get parse() {
    return tr('Not valid JSON', '不是有效的 JSON')
  },
  get schema() {
    return tr('Wrong format', '格式不对')
  },
  get fingerprint() {
    return tr('Public key and fingerprint do not match', '公钥和指纹不一致')
  },
  get signature() {
    return tr('Invalid signature', '签名无效')
  },
  get not_participant() {
    return tr('You are not a participant (or the signer is not)', '你不是参与者（或签名者不是参与者）')
  },
  get mismatch() {
    return tr('Confirmation does not match the moment (different ID or digest)', '确认和共同经历对不上（编号或摘要不同）')
  },
  get self_accept() {
    return tr('The confirmer is the proposer', '确认者就是发起者')
  },
  get file_name() {
    return tr('File name does not match the ID', '文件名和编号不一致')
  },
  get unreadable() {
    return tr('Cannot read', '无法读取')
  }
}

export function rejectedBanner(rejected: RejectedLocalMoment[]): string | null {
  if (!rejected.length) return null
  return tr(
    `${rejected.length} shared moment(s) on this Mac failed signature verification and were ignored: ${rejected.map((r) => `${r.file} (${REJECT_TEXT[r.reason]})`).join('; ')}`,
    `本机有 ${rejected.length} 条共同经历没有通过验签，已忽略：${rejected.map((r) => `${r.file}（${REJECT_TEXT[r.reason]}）`).join('；')}`
  )
}

export function droppedText(n: number): string | null {
  return n ? tr(`${n} shared moment(s) from the Cloud failed local signature verification and were dropped.`, `云端返回的 ${n} 条共同经历没有通过本机验签，已丢弃。`) : null
}

/**
 * C11: tick / untick the user's own note under its moment line in the letter markdown. Returns null
 * when the moment line is no longer in the text (the user edited it).
 */
export function toggleNote(markdown: string, line: string | null, noteLine: string | null, on: boolean): string | null {
  if (!line || !noteLine) return null
  const lines = markdown.split('\n')
  const i = lines.indexOf(line)
  if (i < 0) return null
  const has = lines[i + 1] === noteLine
  if (on && !has) lines.splice(i + 1, 0, noteLine)
  if (!on && has) lines.splice(i + 1, 1)
  return lines.join('\n')
}

export function localToday(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
