import { useMutation, useQuery } from '@tanstack/react-query'
import type { CardVerifyView } from '../../../../main/identity/api'
import type { SwipeQr } from '../../../../main/identity/swipe-schema'
import { unwrap } from '../../lib/api'

export function useSwipeQr(enabled: boolean) {
  return useQuery<SwipeQr | null>({ queryKey: ['identity', 'swipe-qr'], queryFn: () => unwrap(window.lens.swipe.qr()), enabled })
}

export function useExport() {
  return useMutation({
    mutationFn: async (arg: { kind: 'card' | 'qr' } | { kind: 'png'; el: Element }): Promise<{ saved: string | null }> => {
      if (arg.kind !== 'png') return unwrap(window.lens.swipe.exportFile(arg.kind))
      arg.el.scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 120))
      const b = arg.el.getBoundingClientRect()
      const rect = { x: Math.max(0, Math.floor(b.left)), y: Math.max(0, Math.floor(b.top)), width: Math.ceil(b.width), height: Math.ceil(b.height) }
      return unwrap(window.lens.swipe.exportPng(rect))
    }
  })
}

export type ImportResult = (CardVerifyView & { file: string }) | null

export function useImport() {
  return useMutation({
    mutationFn: async (arg: { text: string; name: string } | null): Promise<ImportResult> => {
      if (!arg) return unwrap(window.lens.swipe.importFile())
      const v = await unwrap(window.lens.card.verify(arg.text))
      return { ...v, file: arg.name }
    }
  })
}
