import { ipcRenderer } from 'electron'
import { ONBOARDING_CHANNELS, type OnboardingApi } from '../main/onboarding/api'

// Preload bridge fragment for S2-01 onboarding. Owned by the onboard-ask agent.
export const onboardingBridge: OnboardingApi = {
  onboarding: {
    status: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.status),
    finish: (input) => ipcRenderer.invoke(ONBOARDING_CHANNELS.finish, { outcome: input.outcome, lastStep: input.lastStep }),
    reset: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.reset)
  }
}
