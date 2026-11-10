import { tr } from '../../shared/i18n'
import type { CloudErrorCode, CloudIpcError } from './api'

const MESSAGES = {
  get disabled() { return tr('Cloud features are off (local mode stays offline)', '云端功能未开启（本地模式不联网）') },
  get network() { return tr('Cannot reach the cloud server', '连不上云端服务器') },
  get timeout() { return tr('Cloud request timed out', '云端请求超时') },
  get unauthorized() { return tr('Cloud sign-in has expired. Please sign in again', '云端登录已失效，请重新登录') },
  get forbidden() { return tr('The cloud refused the request', '云端拒绝了请求') },
  get rate_limited() { return tr('Too many requests. Please try again later', '请求太频繁，请稍后再试') },
  get too_large() { return tr('The cloud returned too much data, so the request was stopped', '云端返回的数据过大，已中止') },
  get bad_response() { return tr('The cloud returned data that could not be read', '云端返回了无法识别的数据') },
  get server() { return tr('Cloud server error', '云端服务器出错') },
  get invalid_args() { return tr('Invalid arguments', '参数不合法') },
  get cancelled() { return tr('Cancelled', '已取消') },
  get no_identity() { return tr('No identity key on this Mac yet. Create an identity first', '还没有本机身份密钥，请先创建身份') },
  get storage() { return tr('Secure storage on this Mac is unavailable, so the sign-in cannot be saved', '本机加密存储不可用，无法保存登录状态') },
  get unknown() { return tr('Cloud operation failed', '云端操作失败') },
  get quota_exceeded() { return tr("Today's cloud quota is used up", '今天的云端用量已用完') },
  get llm_unavailable() { return tr('Cloud model is unavailable (not configured on the server, or temporarily off)', '云端模型暂不可用（服务器未配置或暂时关闭）') },
  get upstream_error() { return tr('The cloud model hit an error. The answer may be incomplete', '云端模型出错，回答可能不完整') },
  get upstream_timeout() { return tr('The cloud model timed out. The answer may be incomplete', '云端模型超时，回答可能不完整') },
  get not_found() { return tr('Not found (it may have expired or been deleted)', '没有找到（可能已过期或已删除）') },
  get runtime() { return tr('The local Persome Runtime is unavailable', '本机 Persome Runtime 不可用') },
  get busy() { return tr('Still working. Please wait', '正在处理中，请稍候') },
  get card_not_owner() { return tr('Cloud refused: this card was not signed by the identity you are signed in with', '云端拒绝：这张卡片不是用当前登录的身份签名的') },
  get card_invalid() { return tr('The cloud says this card is invalid (bad format or signature)', '云端认为这张卡片无效（格式或签名不对）') },
  get letter_not_owner() { return tr('Cloud refused: the weekly letter was not signed by the identity you are signed in with', '云端拒绝：周信的签名者不是当前登录的身份') },
  get letter_invalid() { return tr('The cloud says this weekly letter is invalid (bad format or signature)', '云端认为这封周信无效（格式或签名不对）') },
  get duplicate_issue() { return tr('This issue of the weekly letter was already published', '这一期周信已经发布过了') },
  get signature_invalid() { return tr('Invalid signature, discarded', '签名无效，已丢弃') },
  get wrong_signer() { return tr('The signer does not match the fingerprint you asked for, rejected', '签名者与你请求的指纹不一致，已拒收') },
  get self_card() { return tr('This is your own card, so it is not added to Peers', '这是你自己的卡片，不加入朋友列表') },
  get no_card() { return tr('No Personal Card to publish yet (it must be signed with the current identity). Generate one on the Personal Card page first', '还没有可发布的个人卡片（需要用当前身份签名），请先在「个人卡片」页生成') },
  get consent_required() { return tr('First confirm that every participant knows they are being recorded', '需要先确认已告知所有参会者正在录音') },
  get stt_unavailable() { return tr('Cloud transcription is unavailable (not configured on the server, or temporarily off)', '云端转写服务暂不可用（服务器未配置或暂时关闭）') },
  get chunk_conflict() { return tr('The cloud already has an audio chunk with the same number but different content', '云端已有同一编号但内容不同的音频分片') },
  get meeting_closed() { return tr('This meeting has ended in the cloud and no longer accepts audio', '这场会议在云端已结束，不再接收音频') },
  get checksum_mismatch() { return tr('Audio chunk checksum failed', '音频分片校验失败') },
  get chunks_missing() { return tr('The cloud is missing some audio chunks', '云端缺少部分音频分片') },
  get chunks_mismatch() { return tr('The number of chunks the cloud received does not match what was declared at the end', '云端收到的分片数与结束时声明的不一致') },
  get not_ready() { return tr('Transcription is not finished yet', '转写还没有完成') },
  get mic_denied() { return tr('No microphone permission (System Settings → Privacy & Security → Microphone)', '没有麦克风权限（系统设置 → 隐私与安全性 → 麦克风）') },
  get moment_not_owner() { return tr('Cloud refused: this shared moment was not signed by the identity you are signed in with', '云端拒绝：这条共同经历不是用当前登录的身份签名的') },
  get moment_invalid() { return tr('The cloud says this shared moment is invalid (bad format or signature)', '云端认为这条共同经历无效（格式或签名不对）') },
  get acceptance_invalid() { return tr('The cloud says this confirmation is invalid (bad format or signature)', '云端认为这条确认无效（格式或签名不对）') },
  get not_participant() { return tr('You are not a participant in this shared moment', '你不是这条共同经历的参与者') },
  get moment_conflict() { return tr('This shared moment has changed (it may have been confirmed, declined or deleted). Please refresh', '这条共同经历的状态已经变了（可能已被确认、拒绝或删除），请刷新') },
  get not_friend() { return tr('This person is not in your Peers. Import their card first', '对方不在朋友列表里：先导入 TA 的卡片') },
  get unknown_signer() { return tr('The signer is not in your Peers. Import their card before confirming', '签名者不在朋友列表：先导入 TA 的卡片再确认') }
} satisfies Record<CloudErrorCode, string>

/**
 * The only error type the cloud module throws outward. `message` is a fixed string per code plus
 * an optional caller-chosen detail that must never be derived from tokens, signatures or bodies.
 */
export class CloudError extends Error {
  readonly code: CloudErrorCode
  readonly retryAfterS: number | undefined
  /** HTTP status when the error came from a response (safe to show). */
  readonly status: number | undefined
  /** Only for `chunks_missing`: the chunk numbers the server reported missing (validated ints). */
  readonly missing: number[] | undefined

  constructor(code: CloudErrorCode, opts: { retryAfterS?: number; status?: number; detail?: string; missing?: number[] } = {}) {
    const base = MESSAGES[code]
    const parts = [base]
    if (opts.status !== undefined) parts.push(`HTTP ${opts.status}`)
    if (opts.retryAfterS !== undefined) parts.push(tr(`retry in ${opts.retryAfterS}s`, `${opts.retryAfterS} 秒后可重试`))
    if (opts.detail) parts.push(opts.detail)
    super(parts.join(tr('; ', '；')))
    this.name = 'CloudError'
    this.code = code
    this.retryAfterS = opts.retryAfterS
    this.status = opts.status
    this.missing = opts.missing
  }

  toIpc(): CloudIpcError {
    return this.retryAfterS === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, retryAfterS: this.retryAfterS }
  }
}

export function cloudMessage(code: CloudErrorCode): string {
  return MESSAGES[code]
}
