import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LensError, LensResult } from '../../shared/types'
import type { S1Deps } from '../s1/deps'
import { ONBOARDING_CHANNELS, ONBOARDING_STEPS } from './api'
import { finishOnboarding, onboardingStatus, resetOnboarding } from './store'
import { tr } from '../../shared/i18n'

const NoArgs = z.undefined()
const FinishArgs = z.strictObject({
  outcome: z.enum(['completed', 'skipped']),
  lastStep: z.enum(ONBOARDING_STEPS)
})

/** Sanitised: never echo filesystem paths (the Store lives under the user's home). */
function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) {
    return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  }
  const code = (error as NodeJS.ErrnoException | null)?.code
  return { code: 'unknown', message: code ? tr(`Cannot write the onboarding record (${code})`, `无法写入引导记录（${code}）`) : tr('Cannot read or write the onboarding record', '无法读写引导记录') }
}

async function run<T>(fn: () => T): Promise<LensResult<T>> {
  try {
    return { ok: true, data: fn() }
  } catch (error) {
    return { ok: false, error: toLensError(error) }
  }
}

/** Register `lens:onboarding:*` channels. Every payload is zod-validated; no network, no LLM. */
export function registerOnboardingIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: Pick<S1Deps, 'storeRoot'>): void {
  ipcMain.handle(ONBOARDING_CHANNELS.status, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return onboardingStatus(deps.storeRoot)
    })
  )
  ipcMain.handle(ONBOARDING_CHANNELS.finish, (_e, raw: unknown) =>
    run(() => finishOnboarding(deps.storeRoot, FinishArgs.parse(raw)))
  )
  ipcMain.handle(ONBOARDING_CHANNELS.reset, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      return resetOnboarding(deps.storeRoot)
    })
  )
}
