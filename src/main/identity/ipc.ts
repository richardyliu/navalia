import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError, LensResult } from '../../shared/types'
import { tr } from '../../shared/i18n'
import { OwnerAliasListStatusSchema, OwnerAliasSchema, type OwnerAliasDecision } from '../runtime/owner-aliases'
import { IDENTITY_CHANNELS, RESET_CONFIRM } from './api'
import { createIdentityService, type IdentityDeps, type OwnerAliasDeps } from './service'
import { ipcRunner } from '../ipc-result'

const VerifyArgs = z.object({ text: z.string().min(1).max(2_000_000) }).strict()
const NoArgs = z.undefined()
const ResetArgs = z.object({ confirm: z.literal(RESET_CONFIRM) }).strict()
const OwnerAliasListArgs = z.object({ status: OwnerAliasListStatusSchema.optional() }).strict().optional()
// No `note` (security review F4): it would be posted without being shown in the native dialog.
const OwnerAliasDecisionArgs = z.object({ alias: OwnerAliasSchema }).strict()

/** Fixed texts for owner-alias errors: nothing from the request (alias, note) or the Runtime body crosses IPC. */
const OWNER_ALIAS_ERRORS: Partial<Record<LensError['code'], string>> = {
  get unreachable() {
    return tr('Cannot reach the Runtime (127.0.0.1). Start persome first.', '连不上 Runtime（127.0.0.1），请先启动 persome')
  },
  get timeout() {
    return tr('Runtime request timed out', '请求 Runtime 超时')
  },
  get unauthorized() {
    return tr('Local token is invalid. Run persome start again.', '本地 token 无效，请重新运行 persome start')
  },
  get token_unavailable() {
    return tr('Cannot read the Runtime local token', '读不到 Runtime 本地 token')
  },
  get not_found() {
    return tr('This Runtime version has no owner alias endpoint (needs schema 2026-11-05.3 or newer)', '这个 Runtime 版本没有 owner alias 接口（需要 schema 2026-11-05.3 或更新）')
  },
  get schema() {
    return tr('Runtime returned data in an unexpected format', 'Runtime 返回的数据格式与预期不符')
  }
}

function ownerAliasError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr('Invalid arguments: an alias must be 1–160 characters with no control, format (such as bidi override or zero-width) or separator characters', '参数不合法：alias 需为 1–160 个字符，且不含控制、格式（如双向覆盖、零宽）或分隔字符') }
  const code = (error as { code?: unknown } | null)?.code
  const detail = (error as { detail?: unknown } | null)?.detail
  if (typeof code === 'string' && code in OWNER_ALIAS_ERRORS) return { code: code as LensError['code'], message: OWNER_ALIAS_ERRORS[code as LensError['code']]! }
  if (code === 'server') {
    // `detail` is already filtered to a short machine code by RuntimeClient (e.g. unusable_alias).
    const why = detail === 'unusable_alias' ? tr(': this name cannot be an alias (empty, too long, or a generic word like me / user)', '：这个名字不能作为别名（为空、过长或是 me / user 这类通用词）') : ''
    const tag = typeof detail === 'string' ? tr(` (${detail})`, `（${detail}）`) : ''
    return { code: 'server', message: tr(`Runtime rejected the request${tag}${why}`, `Runtime 拒绝了请求${tag}${why}`) }
  }
  if (code === 'alias_unknown') return { code: 'not_found', message: tr('This name is not in the Runtime owner alias list. Nothing was changed.', 'Runtime 的 owner alias 列表里没有这个名字，未做任何更改') }
  if (code === 'alias_already') return { code: 'unknown', message: tr('This name is already in that state. Nothing was changed.', '这个名字已经是目标状态，未做任何更改') }
  if (code === 'owner_aliases_unavailable') return { code: 'unknown', message: tr('The owner alias endpoint is not available in this build', 'owner alias 接口在此构建中不可用') }
  if (code === 'dialog_failed') return { code: 'unknown', message: tr('Could not show the confirmation dialog. Nothing was changed.', '无法显示确认对话框，未做任何更改') }
  return { code: 'unknown', message: tr('Owner alias request failed', 'owner alias 请求失败') }
}

async function runOwnerAlias<T>(fn: () => Promise<T>): Promise<LensResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: ownerAliasError(error) }
  }
}

function needOwnerAliases(deps: IdentityDeps): OwnerAliasDeps {
  if (!deps.ownerAliases) throw Object.assign(new Error('unavailable'), { code: 'owner_aliases_unavailable' })
  return deps.ownerAliases
}

/**
 * User gesture: the alias must exist in the Runtime's list and not already be in the target state
 * (security review F4); then a main-owned native dialog; Cancel (or a dialog failure) posts nothing.
 */
async function decideOwnerAlias(deps: IdentityDeps, decision: 'confirm' | 'reject', alias: string, sender: unknown): Promise<OwnerAliasDecision> {
  const oa = needOwnerAliases(deps)
  const target = decision === 'confirm' ? 'active' : 'rejected'
  const listed = (await oa.client().ownerAliases('all')).aliases.find((row) => row.alias === alias)
  if (!listed) throw Object.assign(new Error('unknown alias'), { code: 'alias_unknown' })
  if (listed.status === target) throw Object.assign(new Error('already decided'), { code: 'alias_already' })
  let yes: boolean
  try {
    yes = (await oa.confirmDecision(decision, alias, sender)) === true
  } catch {
    throw Object.assign(new Error('dialog'), { code: 'dialog_failed' })
  }
  if (!yes) return { decided: false, alias, status: null }
  const client = oa.client()
  const state = decision === 'confirm' ? await client.confirmOwnerAlias(alias) : await client.rejectOwnerAlias(alias)
  return { decided: true, alias: state.alias, status: state.status }
}

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) {
    return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((issue) => issue.message).join('; ')}`, `参数不合法：${error.issues.map((issue) => issue.message).join('; ')}`) }
  }
  // Messages from this plane never embed key material; only the message string crosses IPC.
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (code === 'unreachable' || code === 'timeout' || code === 'unauthorized' || code === 'token_unavailable') {
      return { code, message: error.message }
    }
    return { code: 'unknown', message: error.message }
  }
  return { code: 'unknown', message: String(error) }
}

const run = ipcRunner(toLensError)

/** Register Identity Plane channels. Returns the service so main can reuse it (e.g. Broker card_get). */
export function registerIdentityIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: IdentityDeps) {
  const service = createIdentityService(deps)

  ipcMain.handle(IDENTITY_CHANNELS.status, (_event, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.status()
    })
  )
  ipcMain.handle(IDENTITY_CHANNELS.init, (_event, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.init()
    })
  )
  ipcMain.handle(IDENTITY_CHANNELS.reset, (_event, raw: unknown) =>
    run(() => {
      ResetArgs.parse(raw)
      return service.reset()
    })
  )
  ipcMain.handle(IDENTITY_CHANNELS.cardCreate, (_event, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.createCard()
    })
  )
  ipcMain.handle(IDENTITY_CHANNELS.cardLatest, (_event, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return service.latest()
    })
  )
  ipcMain.handle(IDENTITY_CHANNELS.cardVerify, (_event, raw: unknown) =>
    run(() => service.verify(VerifyArgs.parse(raw).text))
  )

  // Runtime owner-alias review (REST proxied by main; the renderer never talks to the Runtime).
  ipcMain.handle(IDENTITY_CHANNELS.ownerAliasesList, (_event, raw: unknown) =>
    runOwnerAlias(async () => {
      const args = OwnerAliasListArgs.parse(raw)
      return needOwnerAliases(deps).client().ownerAliases(args?.status ?? 'pending')
    })
  )
  ipcMain.handle(IDENTITY_CHANNELS.ownerAliasesConfirm, (event, raw: unknown) =>
    runOwnerAlias(async () => {
      const args = OwnerAliasDecisionArgs.parse(raw)
      return decideOwnerAlias(deps, 'confirm', args.alias, (event as { sender?: unknown } | undefined)?.sender)
    })
  )
  ipcMain.handle(IDENTITY_CHANNELS.ownerAliasesReject, (event, raw: unknown) =>
    runOwnerAlias(async () => {
      const args = OwnerAliasDecisionArgs.parse(raw)
      return decideOwnerAlias(deps, 'reject', args.alias, (event as { sender?: unknown } | undefined)?.sender)
    })
  )

  return service
}
