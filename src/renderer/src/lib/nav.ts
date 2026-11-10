// In-app navigation (S2, lead-owned). Pages have no router; App owns the current page and exposes
// `go(page, params)` through context so pages can deep-link (e.g. Library → Playbook workflow).
import { createContext, useContext } from 'react'

export type Page =
  | 'home'
  | 'today'
  | 'ask'
  | 'chat'
  | 'subscriptions'
  | 'meetings'
  | 'library'
  | 'import'
  | 'connectors'
  | 'peers'
  | 'overview'
  | 'model'
  | 'search'
  | 'playbook'
  | 'capture'
  | 'rewind'
  | 'card'
  | 'swipe'
  | 'connections'
  | 'het'
  | 'performance'
  | 'settings'
  | 'recovery'

/** Optional string params for the target page, e.g. `{ workflowId: 'rt-foo' }` for Playbook. */
export type NavParams = Record<string, string>

export interface NavState {
  page: Page
  params: NavParams
  go(page: Page, params?: NavParams): void
}

export const NavContext = createContext<NavState>({ page: 'overview', params: {}, go: () => undefined })

export function useNav(): NavState {
  return useContext(NavContext)
}
