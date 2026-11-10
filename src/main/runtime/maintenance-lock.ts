/**
 * OG5: one process-wide mutex for operations that stop, start or rewrite the Runtime's data
 * (Recovery start / restart / doctor / rebuild-captures-index, Privacy delete + withdraw, the
 * main-window "启动 Runtime" button). Without it a `persome clean` could run while another plane
 * restarts the Runtime or rebuilds the index. Non-reentrant and non-queuing: a second caller is
 * refused immediately with the holder's name, never made to wait.
 */

import { tr } from '../../shared/i18n'

export class MaintenanceBusyError extends Error {
  readonly holder: string
  constructor(holder: string) {
    super(tr(`"${holder}" is running. Try again when it finishes.`, `正在执行「${holder}」，请等它完成后再试`))
    this.name = 'MaintenanceBusyError'
    this.holder = holder
  }
}

export interface MaintenanceLock {
  /** Name of the running operation, or null when idle. */
  holder(): string | null
  /**
   * Run `fn` while holding the lock. When busy, throws `onBusy(holder)` if given, otherwise a
   * MaintenanceBusyError. The lock is released when `fn` settles, success or failure.
   */
  run<T>(name: string, fn: () => Promise<T>, onBusy?: (holder: string) => Error): Promise<T>
}

export function createMaintenanceLock(): MaintenanceLock {
  let holder: string | null = null
  return {
    holder: () => holder,
    async run<T>(name: string, fn: () => Promise<T>, onBusy?: (holder: string) => Error): Promise<T> {
      if (holder !== null) throw onBusy ? onBusy(holder) : new MaintenanceBusyError(holder)
      holder = name
      try {
        return await fn()
      } finally {
        holder = null
      }
    }
  }
}

/** The shared instance. Services take it as a default; tests may inject their own. */
export const runtimeMaintenanceLock: MaintenanceLock = createMaintenanceLock()
