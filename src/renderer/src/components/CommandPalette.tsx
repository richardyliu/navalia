import { useEffect } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'
import { NAV_GROUPS } from '../lib/navigation'
import type { Page } from '../lib/nav'
import { tr } from '../lib/i18n'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD_KEY = IS_MAC ? '⌘K' : 'Ctrl K'

/**
 * ⌘K is the escape hatch from a 19-page sidebar: it opens the page you can name, and it keeps
 * the sidebar free to be a quiet index instead of a wall of links.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onNavigate
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNavigate: (page: Page) => void
}) {
  function pick(page: Page): void {
    onNavigate(page)
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-backdrop" />
        <Dialog.Popup className="palette" aria-label={tr('Quick jump', '快速跳转')}>
          <Dialog.Title className="sr-only">{tr('Quick jump', '快速跳转')}</Dialog.Title>
          <Command label={tr('Quick jump', '快速跳转')} loop>
            <div className="palette-search">
              <Search size={15} aria-hidden="true" />
              <Command.Input autoFocus placeholder={tr('Jump to page…', '跳转到页面…')} className="palette-input" />
              <kbd className="palette-kbd">esc</kbd>
            </div>
            <Command.List className="palette-list">
              <Command.Empty className="palette-empty">{tr('No matching pages.', '没有匹配的页面。')}</Command.Empty>
              {NAV_GROUPS.map((group) => (
                <Command.Group key={group.id} heading={group.label} className="palette-group">
                  {group.items.map((item) => {
                    const Icon = item.icon
                    return (
                      <Command.Item
                        key={item.id}
                        value={`${item.label} ${item.id} ${item.hint} ${item.keywords ?? ''}`}
                        onSelect={() => pick(item.id)}
                        className="palette-item"
                      >
                        <Icon size={15} className="palette-icon" aria-hidden="true" />
                        <span className="palette-label">{item.label}</span>
                        <span className="palette-hint">{item.hint}</span>
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              ))}
            </Command.List>
            <footer className="palette-foot">
              <span>
                <kbd className="palette-kbd">↑</kbd>
                <kbd className="palette-kbd">↓</kbd> {tr('Select', '选择')}
              </span>
              <span>
                <kbd className="palette-kbd">↵</kbd> {tr('Open', '打开')}
              </span>
              <span className="palette-foot-right">{tr(`${MOD_KEY} anytime`, `${MOD_KEY} 随时呼出`)}</span>
            </footer>
          </Command>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Global ⌘K / Ctrl+K listener. Registered once by App. */
export function useCommandShortcut(onOpen: () => void): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      onOpen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])
}

/** The sidebar's visible affordance for the shortcut. */
export function CommandHint({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="nav-command" onClick={onClick} aria-label={tr('Quick jump', '快速跳转')}>
      <Search size={13} aria-hidden="true" />
      <span>{tr('Quick jump', '快速跳转')}</span>
      <kbd className="nav-command-kbd">{MOD_KEY}</kbd>
    </button>
  )
}
