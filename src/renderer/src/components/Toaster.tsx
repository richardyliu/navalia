import { Toaster as SonnerToaster, toast } from 'sonner'
import { tr } from '../lib/i18n'

/**
 * Sonner with the app's tokens: it inherits surfaces, ink and radius instead of importing a
 * second visual language. One toast per completed action; errors keep their inline banner
 * because they carry detail the user needs to read, not a 4-second hint.
 */
export function Toaster() {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      offset={16}
      gap={8}
      visibleToasts={3}
      closeButton
      toastOptions={{
        className: 'lens-toast',
        duration: 2600
      }}
    />
  )
}

export function copiedToast(what: string): void {
  toast.success(tr(`Copied${what ? ` ${what}` : ''}`, `已复制${what ? ` ${what}` : ''}`), { duration: 1800 })
}

export function doneToast(message: string): void {
  toast.success(message, { duration: 2200 })
}
