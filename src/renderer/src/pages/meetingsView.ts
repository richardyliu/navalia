// Meetings page view-model (S1-FULL C12–C14): pure functions, tested by vitest (no DOM).
import type { CloudStatus } from '../../../main/cloud/api'
import type { MeetingLocalStatus, MeetingMeta, MeetingRuntimeDeleteResult, MeetingServerStatus, MeetingSummaryRow } from '../../../main/cloud/meetings-api'
import { intlLocale, tr } from '../../../shared/i18n'
import { gateOf, type Gate } from './chatView'

export { consentText, leavesMachineNote } from '../../../main/cloud/meetings-api'

export function serverNotE2eeNote(): string {
  return tr('The cloud server is not end-to-end encrypted: the operator can read the audio and transcript on the server.', '云端服务器不是端到端加密：音频和转写在服务器上可被运营方读取。')
}
export function serverGoneNote(): string {
  return tr(
    'The cloud copy no longer exists (the 7-day retention has passed, or it was deleted elsewhere); the transcript saved on this Mac is still here.',
    '云端副本已不存在（保留期 7 天已过或已在别处删除）；本机保存的转写仍在。'
  )
}
export function speakerNote(): string {
  return tr(
    'Speaker labels are only valid within one audio chunk (about 30 seconds); S1 in different chunks is not necessarily the same person.',
    '说话人标签只在同一段音频（约 30 秒）内有效，不同段的 S1 不一定是同一个人。'
  )
}
export function runtimeDeleteNote(): string {
  return tr(
    'After writing, you can click "Delete from Persome…" here to remove this import from the local Runtime (needs Runtime R10 or newer); memories the Runtime already built from it are not deleted. Deleting the meeting itself only deletes the cloud copy and the copy in Navalia on this Mac.',
    '写入后可以在这里点「从 Persome 删除…」把这份导入从本机 Runtime 删掉（需要 R10 或更新的 Runtime）；Runtime 已经据此生成的记忆不会随之删除。删除会议本身只删除云端和本机 Navalia 的副本。'
  )
}

export function meetingsGate(status: CloudStatus | null | undefined): Gate {
  const g = gateOf(status)
  if (g.state === 'off') return { state: 'off', text: tr('Cloud is off: meeting recording uploads audio chunks to your configured cloud for transcription.', '云端未开启：会议录音需要把音频分片上传到你配置的云端做转写。') }
  return g
}

const LOCAL_LABEL = {
  get recording() {
    return tr('Recording', '录音中')
  },
  get finishing() {
    return tr('Uploading', '上传中')
  },
  get transcribing() {
    return tr('Transcribing', '转写中')
  },
  get ready() {
    return tr('Transcribed', '转写完成')
  },
  get failed() {
    return tr('Failed', '失败')
  }
} satisfies Record<MeetingLocalStatus, string>

const ERROR_LABEL = {
  get no_audio() {
    return tr('No audio was recorded', '没有录到音频')
  },
  get chunks_missing() {
    return tr('The cloud is missing audio chunks, so it cannot transcribe', '云端缺少音频分片，无法转写')
  },
  get chunks_mismatch() {
    return tr('The number of chunks the cloud received does not match this Mac, so it cannot transcribe', '云端收到的分片数与本机不一致，无法转写')
  },
  get expired() {
    return tr('The cloud deleted this meeting after the 7-day retention period; the transcript was not retrieved', '云端已按 7 天保留期删除这场会议，转写没有取回')
  },
  get not_found() {
    return tr('The cloud cannot find this meeting (it may have expired or been deleted)', '云端找不到这场会议（可能已过期或被删除）')
  },
  get transcription_failed() {
    return tr('Cloud transcription failed', '云端转写失败')
  },
  get network() {
    return tr('Cannot reach the cloud; will retry later', '连不上云端，稍后会重试')
  },
  get timeout() {
    return tr('Cloud request timed out', '云端请求超时')
  },
  get unauthorized() {
    return tr('Cloud sign-in has expired', '云端登录已失效')
  },
  get disabled() {
    return tr('Cloud is off', '云端已关闭')
  },
  get stt_unavailable() {
    return tr('Cloud transcription is temporarily unavailable', '云端转写服务暂不可用')
  }
} satisfies Record<string, string>

export function errorLabel(code: string | null): string | null {
  if (!code) return null
  return (ERROR_LABEL as Record<string, string>)[code] ?? tr(`Error (${code})`, `出错（${code}）`)
}

export function statusLabel(m: Pick<MeetingSummaryRow, 'localStatus' | 'serverStatus'>): string {
  const base = LOCAL_LABEL[m.localStatus]
  const server: Partial<Record<MeetingServerStatus, string>> = {
    recording: tr('recording', '录音中'),
    transcribing: tr('transcribing', '转写中'),
    ready: tr('done', '已完成'),
    failed: tr('failed', '失败')
  }
  return m.serverStatus && m.localStatus !== 'ready' && m.localStatus !== 'failed'
    ? tr(`${base} (cloud: ${server[m.serverStatus]})`, `${base}（云端：${server[m.serverStatus]}）`)
    : base
}

export function isTerminal(s: MeetingLocalStatus): boolean {
  return s === 'ready' || s === 'failed'
}

export function chunkProgress(meta: Pick<MeetingMeta, 'chunks' | 'totalChunks'>): { uploaded: number; total: number; failed: number; text: string } {
  const total = meta.totalChunks ?? meta.chunks.length
  const uploaded = meta.chunks.filter((c) => c.uploaded).length
  const failed = meta.chunks.filter((c) => !c.uploaded && c.error !== null).length
  return { uploaded, total, failed, text: tr(
      `Uploaded ${uploaded} / ${total} chunks${failed ? `, ${failed} failed and waiting to retry` : ''}`,
      `已上传 ${uploaded} / ${total} 段${failed ? `，${failed} 段失败待重试` : ''}`
    ) }
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export interface MeetingActions {
  canRetry: boolean
  canMarkdown: boolean
  canImport: boolean
  canSummarize: boolean
  canRememberSummary: boolean
  canDelete: boolean
  /** R10: something this meeting wrote is still in the Runtime (import or remembered summary). */
  canDeleteFromRuntime: boolean
}

export function actionsFor(meta: MeetingMeta, gate: Gate['state'], recordingThis: boolean): MeetingActions {
  const ready = meta.localStatus === 'ready' && meta.transcript !== null
  return {
    canRetry: gate === 'ready' && (meta.localStatus === 'finishing' || meta.localStatus === 'transcribing'),
    canMarkdown: ready,
    canImport: ready && !importLive(meta),
    canSummarize: ready && gate === 'ready',
    canRememberSummary: !!meta.summary?.text && !meta.summary.rememberedEntryId,
    canDelete: !recordingThis,
    canDeleteFromRuntime: !recordingThis && (importLive(meta) || !!meta.summary?.rememberedEntryId)
  }
}

/** The imported transcript is (as far as Lens knows) still in the Runtime. */
function importLive(meta: Pick<MeetingMeta, 'imported'>): boolean {
  return meta.imported?.ok === true && !meta.imported.runtimeDeletedAt
}

/** One-line result of 「从 Persome 删除」 (counts and states only). */
export function runtimeDeleteText(r: MeetingRuntimeDeleteResult): string {
  const parts: string[] = []
  const imp = r.import
  if (imp.status === 'deleted') parts.push(tr(`Deleted the imported transcript from Persome (timeline blocks ${imp.timelineBlocks}, sessions ${imp.sessions})`, `已从 Persome 删除导入的转写（时间线块 ${imp.timelineBlocks}，会话 ${imp.sessions}）`))
  else if (imp.status === 'already_deleted') parts.push(tr('The imported transcript was already deleted', '导入的转写之前已经删除'))
  else if (imp.status === 'not_found') parts.push(tr('The imported transcript was not found in the Runtime', 'Runtime 里没有找到导入的转写'))
  if (r.summary.status === 'erased') parts.push(tr('Deleted the meeting summary written to memory', '已删除写入记忆的会议摘要'))
  else if (r.summary.status === 'already_deleted') parts.push(tr('The meeting summary was already deleted', '会议摘要之前已经删除'))
  else if (r.summary.status === 'not_found') parts.push(tr('The meeting summary was not found in the Runtime', 'Runtime 里没有找到会议摘要'))
  else if (r.summary.status === 'refused') parts.push(tr('The meeting summary was not deleted', '会议摘要没有删除'))
  const head = parts.length ? tr(`${parts.join('; ')}.`, `${parts.join('；')}。`) : ''
  return tr(head && r.note ? `${head} ${r.note}` : `${head}${r.note ?? ''}`, `${head}${r.note ?? ''}`)
}

/** Start-form validation: title + consent checkbox. */
export function startBlocker(title: string, consent: boolean, gate: Gate['state'], recording: boolean): string | null {
  if (recording) return tr('A meeting is already recording', '已有一场会议在录音')
  if (gate !== 'ready') return tr('Turn on and sign in to Cloud first', '先开启并登录云端')
  if (!title.trim()) return tr('Enter a meeting title', '填写会议标题')
  if (!consent) return tr('First tick that participants have been told', '先勾选已告知参会者')
  return null
}

export function importResultText(r: {
  ok: boolean
  exitCode: number | null
  counts: { imported: number; unchanged: number; skipped: number } | null
  runtimeDeletedAt?: string | null
}): string {
  if (r.ok && r.runtimeDeletedAt) {
    const at = new Date(r.runtimeDeletedAt).toLocaleString(intlLocale())
    return tr(`Written, later deleted from Persome (${at}).`, `已写入，之后已从 Persome 删除（${at}）。`)
  }
  if (r.ok && r.counts)
    return tr(
      `Written: ${r.counts.imported} new, ${r.counts.unchanged} unchanged, ${r.counts.skipped} skipped. The Runtime builds memories on its next build.`,
      `已写入：新增 ${r.counts.imported} 篇，未变化 ${r.counts.unchanged}，跳过 ${r.counts.skipped}。Runtime 下次构建时会生成记忆。`
    )
  return tr(`Write failed (exit code ${r.exitCode ?? 'none'})`, `写入失败（退出码 ${r.exitCode ?? '无'}）`)
}
