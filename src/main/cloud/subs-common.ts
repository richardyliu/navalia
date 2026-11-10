// Shared helpers for S1-FULL C8 (cards.ts) and C10 (subs.ts). Main only; no network here.
import { randomBytes } from 'node:crypto'
import type { CloudErrorCode } from './api'
import type { CloudClient } from './client'
import { CloudError } from './errors'
import type { CloudConfirm } from './service'

export const HEX32_RE = /^[0-9a-f]{32}$/

/** The subset of CloudService that C8 / C10 use (tests pass the real service). */
export interface CloudHandle {
  client: CloudClient
  status(): { enabled: boolean; baseUrl: string | null; signedIn: boolean }
}

/** Fail before any dialog or request: OFF ⇒ `disabled`, no session ⇒ `unauthorized`. */
export function requireReady(cloud: CloudHandle): string {
  const st = cloud.status()
  if (!st.enabled || !st.baseUrl) throw new CloudError('disabled')
  if (!st.signedIn) throw new CloudError('unauthorized')
  return st.baseUrl
}

/**
 * Map a client error by HTTP status to a feature code (the client only exposes the status of a
 * 4xx; it never surfaces body text). Anything else is rethrown unchanged.
 */
export function mapStatus(error: unknown, map: Partial<Record<number, CloudErrorCode>>): never {
  if (error instanceof CloudError && error.status !== undefined) {
    const code = map[error.status]
    if (code) throw new CloudError(code, { status: error.status })
  }
  throw error
}

export async function confirmOrCancel(confirm: CloudConfirm | undefined, sender: unknown, opts: { message: string; detail: string; confirmLabel: string }): Promise<void> {
  if (!confirm) throw new CloudError('cancelled')
  if (!(await confirm(sender, opts))) throw new CloudError('cancelled')
}

/** Bounded, single-use, TTL'd parking of what the user previewed. */
export interface PreviewStore<T> {
  put(value: T): { id: string; expiresAt: string }
  get(id: string): T | null
  delete(id: string): boolean
}

export function createPreviewStore<T>(opts: { ttlMs: number; max: number; now: () => Date; randomHex?: (bytes: number) => string }): PreviewStore<T> {
  const hex = opts.randomHex ?? ((n: number) => randomBytes(n).toString('hex'))
  const items = new Map<string, { value: T; expires: number }>()
  function sweep(): void {
    const t = opts.now().getTime()
    for (const [k, v] of items) if (v.expires <= t) items.delete(k)
  }
  return {
    put(value) {
      sweep()
      const id = hex(16)
      const expires = opts.now().getTime() + opts.ttlMs
      items.set(id, { value, expires })
      while (items.size > opts.max) items.delete(items.keys().next().value as string)
      return { id, expiresAt: new Date(expires).toISOString() }
    },
    get(id) {
      sweep()
      return items.get(id)?.value ?? null
    },
    delete: (id) => items.delete(id)
  }
}
