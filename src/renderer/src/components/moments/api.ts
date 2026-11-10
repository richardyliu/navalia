// Renderer access to the `moments` namespace of the cloud bridge (S1-FULL C18). IPC only.
import type { CloudResult } from '../../../../main/cloud/api'
import type { MomentsApiFragment } from '../../../../main/cloud/moments-api'

export const momentsApi = (): MomentsApiFragment['moments'] => (window.lens as unknown as MomentsApiFragment).moments

export async function unwrapCloud<T>(p: Promise<CloudResult<T>>): Promise<T> {
  const r = await p
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
