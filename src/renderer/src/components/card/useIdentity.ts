import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RESET_CONFIRM, type IdentityStatus, type IssuedCard } from '../../../../main/identity/api'
import { unwrap } from '../../lib/api'

export function useIdentityStatus() {
  return useQuery<IdentityStatus>({
    queryKey: ['identity', 'status'],
    queryFn: () => unwrap(window.lens.identity.status()),
    staleTime: 10_000
  })
}

export function useLatestCard() {
  return useQuery<IssuedCard | null>({
    queryKey: ['identity', 'card'],
    queryFn: () => unwrap(window.lens.card.latest()),
    staleTime: 10_000
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['identity'] })
}

export function useCreateCard() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: () => unwrap(window.lens.card.create()), onSuccess: invalidate })
}

export function useResetIdentity() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: () => unwrap(window.lens.identity.reset(RESET_CONFIRM)), onSuccess: invalidate })
}

export async function copyText(text: string): Promise<void> {
  await unwrap(window.lens.app.copy(text))
}
