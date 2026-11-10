import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Capture } from './pages/Capture'
import { Card } from './pages/Card'
import { Connections } from './pages/Connections'
import { Het } from './pages/Het'
import { Import } from './pages/Import'
import { Connectors } from './pages/Connectors'
import { Library } from './pages/Library'
import { Home } from './pages/Home'
import { Today } from './pages/Today'
import { Model } from './pages/Model'
import { Overview } from './pages/Overview'
import { Peers } from './pages/Peers'
import { Playbook } from './pages/Playbook'
import { Rewind } from './pages/Rewind'
import { Search } from './pages/Search'
import { Settings } from './pages/Settings'
import { Recovery } from './pages/Recovery'
import { Swipe } from './pages/Swipe'
import { Ask } from './pages/Ask'
import { Chat } from './pages/Chat'
import { Subscriptions } from './pages/Subscriptions'
import { Meetings } from './pages/Meetings'
import { Performance } from './pages/Performance'
import { RecordingBanner } from './components/meetings/RecordingBanner'
import { Onboarding } from './pages/Onboarding'
import { NavContext, type NavParams, type NavState, type Page } from './lib/nav'
import { NAV_GROUPS } from './lib/navigation'
import { CommandHint, CommandPalette, useCommandShortcut } from './components/CommandPalette'
import { Toaster } from './components/Toaster'
import type { QuickOpenPage } from '../../main/shell/api'
import { useBudget, useDiscover, useStatus } from './lib/queries'
import { intlLocale, tr } from './lib/i18n'

function resetLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return tr('tomorrow 00:00', '明天 00:00')
  return new Intl.DateTimeFormat(intlLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

// Survives the LocaleBoundary remount, so switching language keeps the current page.
let lastNav: { page: Page; params: NavParams } = { page: 'home', params: {} }

export default function App() {
  const [nav, setNavState] = useState<{ page: Page; params: NavParams }>(lastNav)
  const setNav = useCallback((next: { page: Page; params: NavParams }) => {
    lastNav = next
    setNavState(next)
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const page = nav.page
  const setPage = (next: Page): void => setNav({ page: next, params: {} })
  const navState = useMemo<NavState>(
    () => ({ page: nav.page, params: nav.params, go: (p, params) => setNav({ page: p, params: params ?? {} }) }),
    [nav]
  )
  // OG-04: Quick Box / tray "快速打开" → main asks this window to navigate.
  useEffect(
    () =>
      window.lens.shell.onNavigate((target: QuickOpenPage) => {
        const next: Page = target // compile-time check: QuickOpenPage ⊆ Page
        setNav({ page: next, params: {} })
      }),
    []
  )
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  useCommandShortcut(openPalette)

  const queryClient = useQueryClient()
  const status = useStatus()
  const discover = useDiscover()
  const budget = useBudget()
  // S1-FULL C23: cloud is opt-in, so the badge must not say 无登录 unconditionally. Local IPC only.
  const cloudMode = useQuery({
    queryKey: ['app', 'cloud-mode'],
    queryFn: async () => {
      const r = await window.lens.cloud.status()
      return r.ok ? r.data.enabled && Boolean(r.data.baseUrl) : null
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false
  })
  const running = status.isSuccess

  const budgetTone = budget.data
    ? !budget.data.enabled
      ? 'warn'
      : budget.data.exhausted
        ? 'bad'
        : budget.data.remaining <= Math.max(1, Math.round(budget.data.limit * 0.2))
          ? 'warn'
          : 'ok'
    : 'subtle'

  function refreshAll(): void {
    void queryClient.invalidateQueries()
  }

  return (
    <NavContext.Provider value={navState}>
    <Onboarding />
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◐</span>
          <div className="brand-text">
            <strong>Navalia</strong>
            <span>local model viewer</span>
          </div>
        </div>

        <nav className="nav" aria-label={tr('Pages', '页面')}>
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.id} data-nav-group={group.id}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon
                const active = page === item.id
                return (
                  <button
                    key={item.id}
                    data-page={item.id}
                    className={`nav-item ${active ? 'active' : ''}`}
                    title={item.hint}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setPage(item.id)}
                  >
                    <Icon size={15} className="nav-icon" aria-hidden="true" />
                    <span className="nav-label">{item.label}</span>
                    <span className="nav-hint">{item.hint}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <CommandHint onClick={openPalette} />

        <div className="sidebar-foot">
          <span className={`dot ${running ? 'ok' : 'bad'}`} />
          <div className="sidebar-foot-text">
            <span>{running ? tr('Runtime running', 'Runtime 运行中') : tr('Runtime not connected', 'Runtime 未连接')}</span>
            <span className="mono tiny ellipsis">{discover.data?.root ?? '~/.persome'}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        {page !== 'meetings' ? <RecordingBanner onOpen={() => setPage('meetings')} /> : null}
        <div className="topbar">
          <button className="btn ghost small" onClick={refreshAll} title={tr('Reload Runtime status and model', '重新读取 Runtime 状态与模型')}>
            ↻ {tr('Refresh', '刷新')}
          </button>
          <span className={`chip ${budgetTone}`}>
            {budget.data
              ? budget.data.enabled
                ? `LLM ${budget.data.used}/${budget.data.limit}`
                : tr('LLM not configured', 'LLM 未配置')
              : 'LLM —'}
          </span>
          <span className={`chip ${running ? 'ok' : 'bad'}`}>
            {running ? `127.0.0.1:${discover.data?.port ?? '—'}` : 'offline'}
          </span>
          <span className="muted tiny" data-testid="topbar-mode">
            {cloudMode.data === true
              ? tr('Cloud on', '云端已开启')
              : cloudMode.data === false
                ? tr('Local', '本地')
                : tr('Local · cloud status unknown', '本地 · 云端状态未知')}
          </span>
        </div>

        {budget.data?.exhausted ? (
          <div className="limit-bar">
            <strong>
              {tr(
                `LLM quota used up (${budget.data.used}/${budget.data.limit})`,
                `LLM 额度已用尽（${budget.data.used}/${budget.data.limit}）`
              )}
            </strong>
            <span>
              {tr(
                `Capture continues; memory and model updates pause until ${resetLabel(budget.data.resetAt)}. Search and reading are unaffected.`,
                `采集继续；记忆与模型更新会暂停到 ${resetLabel(budget.data.resetAt)}。搜索与读取不受影响。`
              )}
            </span>
          </div>
        ) : null}

        {page === 'home' ? <Home /> : null}
        {page === 'today' ? <Today /> : null}
        {page === 'library' ? <Library /> : null}
        {page === 'import' ? <Import /> : null}
        {page === 'connectors' ? <Connectors /> : null}
        {page === 'peers' ? <Peers /> : null}
        {page === 'overview' ? <Overview /> : null}
        {page === 'model' ? <Model /> : null}
        {page === 'search' ? <Search /> : null}
        {page === 'playbook' ? <Playbook /> : null}
        {page === 'capture' ? <Capture /> : null}
        {page === 'rewind' ? <Rewind /> : null}
        {page === 'card' ? <Card /> : null}
        {page === 'swipe' ? <Swipe /> : null}
        {page === 'connections' ? <Connections /> : null}
        {page === 'het' ? <Het /> : null}
        {page === 'performance' ? <Performance /> : null}
        {page === 'settings' ? <Settings /> : null}
        {page === 'recovery' ? <Recovery /> : null}
        {page === 'ask' ? <Ask /> : null}
        {page === 'chat' ? <Chat /> : null}
        {page === 'subscriptions' ? <Subscriptions /> : null}
        {page === 'meetings' ? <Meetings /> : null}
      </main>
    </div>
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNavigate={setPage} />
    <Toaster />
    </NavContext.Provider>
  )
}
