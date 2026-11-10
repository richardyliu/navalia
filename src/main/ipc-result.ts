// Shared IPC result helpers: every handler returns `{ ok, data } | { ok, error }` and never throws to the renderer.

/** Build a `run(fn)` that captures thrown errors through the given mapper (which decides what text may leave main). */
export function ipcRunner<E>(toError: (error: unknown) => E) {
  return async function run<T>(fn: () => T | Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: E }> {
    try {
      return { ok: true, data: await fn() }
    } catch (error) {
      return { ok: false, error: toError(error) }
    }
  }
}

/** The IPC event's `sender` (WebContents), or null; used to parent native dialogs. */
export const senderOf = (e: unknown): unknown => (e as { sender?: unknown } | undefined)?.sender ?? null
