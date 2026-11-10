import type { ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { tr } from '../lib/i18n'

/**
 * The one dialog primitive. Base UI supplies the behavior we kept re-implementing by hand:
 * focus trap, Escape, outside-press dismissal, scroll lock and focus restoration.
 *
 * Every `<Modal>` is mount → open, so `open` stays true and unmounting is the close. Focus starts
 * on the first tabbable element, preferring a text field for input dialogs; pass
 * `initialFocusRef` when a different control should win.
 */
export function Modal({
  title,
  children,
  onClose,
  footer,
  initialFocusRef,
  className
}: {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  initialFocusRef?: React.RefObject<HTMLElement | null>
  className?: string
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup
          className={className ? `modal ${className}` : 'modal'}
          initialFocus={initialFocusRef}
          aria-label={title}
        >
          <header className="modal-head">
            <Dialog.Title className="modal-title">{title}</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label={tr('Close', '关闭')}>
              ✕
            </Dialog.Close>
          </header>
          <div className="modal-body">{children}</div>
          {footer ? (
            <footer className="modal-foot">
              {footer}
              {/* Base UI wants a Close inside the popup so touch screen readers can dismiss it. */}
              <Dialog.Close className="sr-only">{tr('Close', '关闭')}</Dialog.Close>
            </footer>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
